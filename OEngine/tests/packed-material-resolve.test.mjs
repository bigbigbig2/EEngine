import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
globalThis.GPUBufferUsage ??= { COPY_DST: 1 << 3, UNIFORM: 1 << 6, STORAGE: 1 << 7, INDIRECT: 1 << 8 };
globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 1 << 2, RENDER_ATTACHMENT: 1 << 4 };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { FrameGraph } = await import("../.test-dist/framegraph/FrameGraph.js");
const {
  PACKED_SURFACE_FLAGS_FORMAT,
  PackedMaterialResolvePass
} = await import("../.test-dist/render/passes/PackedMaterialResolvePass.js");
const { PACKED_MATERIAL_RESOLVE_WGSL } = await import(
  "../.test-dist/shaders/packed_material_resolve.js"
);

function fakeGraphics(buffers = []) {
  return {
    device: {
      createBuffer: (descriptor) => {
        const buffer = { ...descriptor, destroy() {} };
        buffers.push(buffer);
        return buffer;
      },
      createSampler: (descriptor) => ({ descriptor }),
      createShaderModule: (descriptor) => ({ descriptor }),
      createBindGroupLayout: (descriptor) => ({ descriptor }),
      createPipelineLayout: (descriptor) => ({ descriptor }),
      createComputePipeline: (descriptor) => ({ descriptor })
    }
  };
}

test("classified Material Resolve declares a bounded specialized Surface pass", () => {
  const buffers = [];
  const pass = new PackedMaterialResolvePass(fakeGraphics(buffers));
  const graph = new FrameGraph("R4-B Single Resolve");
  const visibilityKey = graph.import_resource(
    "visibility-key",
    { kind: "imported", label: "visibility-key" },
    {}
  );
  const view = graph.import_resource("view", { kind: "imported", label: "view" }, {});
  const outputs = pass.addToGraph(
    graph,
    {
      runtime: {},
      assets: {},
      scene: {},
      visibility: {},
      width: 1280,
      height: 720,
      currentCamera: {},
      previousCamera: {}
    },
    { visibilityKey, view }
  );
  const sink = graph.add("R4-B sink", {}, () => {});
  for (const resource of [
    outputs.gPbr,
    outputs.gNormal,
    outputs.gAlbedo,
    outputs.gEmissive,
    outputs.velocity,
    outputs.surfaceFlags
  ]) sink.read(resource);
  sink.make_side_effect();
  graph.compile();

  assert.equal(pass.surfaceBytesPerPixel, 26);
  assert.equal(buffers.length, 1);
  assert.equal(buffers[0].size, 64);
  assert.deepEqual(
    [
      outputs.gPbr,
      outputs.gNormal,
      outputs.gAlbedo,
      outputs.gEmissive,
      outputs.velocity,
      outputs.surfaceFlags
    ].map((id) => graph.getDescriptor(id).format),
    ["rg8unorm", "rgba16uint", "rgba8unorm", "r32uint", "rg16float", "r32uint"]
  );
  assert.equal(graph.getDescriptor(outputs.surfaceFlags).format, PACKED_SURFACE_FLAGS_FORMAT);
  assert.deepEqual(
    graph.listExecutablePasses().map(({ name }) => name),
    ["Material Resolve/classified visible pixels", "R4-B sink"]
  );
  assert.deepEqual(graph.exportToJson().passes[0].reads, [visibilityKey, view]);
  pass.destroy();
});

test("velocity feature-off allocates no attachment and freezes a 22 B/pixel Surface", () => {
  const pass = new PackedMaterialResolvePass(fakeGraphics());
  const graph = new FrameGraph("Material Resolve velocity off");
  const visibilityKey = graph.import_resource(
    "visibility-key",
    { kind: "imported", label: "visibility-key" },
    {}
  );
  const view = graph.import_resource("view", { kind: "imported", label: "view" }, {});
  const outputs = pass.addToGraph(
    graph,
    {
      runtime: {},
      assets: {},
      scene: {},
      visibility: {},
      width: 1921,
      height: 913,
      currentCamera: {},
      previousCamera: {}
    },
    { visibilityKey, view },
    { velocity: false }
  );
  const sink = graph.add("velocity-off sink", {}, () => {});
  for (const resource of [
    outputs.gPbr,
    outputs.gNormal,
    outputs.gAlbedo,
    outputs.gEmissive,
    outputs.surfaceFlags
  ]) sink.read(resource);
  sink.make_side_effect();
  graph.compile();

  assert.equal(outputs.velocity, null);
  assert.equal(pass.surfaceBytesPerPixel, 22);
  assert.doesNotMatch(
    JSON.stringify(graph.exportToJson()),
    /surface\/velocity/
  );
  pass.destroy();
});

test("specialized shader uses direct canonical streams and analytic UV0/UV1/UV2 gradients", () => {
  assert.doesNotMatch(PACKED_MATERIAL_RESOLVE_WGSL, /vec2f\(read_u(?:8|16)\(/);
  for (const lookup of [
    "raster_work.opaque_header.written",
    "raster_work.mask_header.written",
    "raster_slot - raster_work.opaque_header.capacity < mask_written",
    "work.meshlet_record_index >= arrayLength(&meshlets)",
    "work.instance_record_index >= arrayLength(&instances)",
    "work.geometry_record_index >= arrayLength(&geometries)",
    "work.material_handle >= arrayLength(&materials)",
    "!oengine_instance_active(instance)",
    "instance.geometry_record_index != work.geometry_record_index",
    "instance.material_handle != work.material_handle",
    "work.meshlet_record_index - geometry.meshlet_begin >= geometry.meshlet_count",
    "triangle_index >= meshlet.triangle_count"
  ]) assert.match(PACKED_MATERIAL_RESOLVE_WGSL, new RegExp(lookup.replace(/[&()]/g, "\\$&")));

  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /textureSampleGrad\(material_textures/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /textureSampleGrad\(high_resolution_material_textures/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /geometry\.uv1_byte_offset/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /geometry\.uv2_byte_offset/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /geometry\.normal_byte_offset/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /geometry\.normal_stride/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /geometry\.normal_format/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /geometry\.tangent_byte_offset/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /geometry\.tangent_format/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /geometry\.color_byte_offset/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /geometry\.color_normalized/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /fn read_normal_direct/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /fn read_tangent_direct/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /fn read_color_direct/);
  assert.doesNotMatch(PACKED_MATERIAL_RESOLVE_WGSL, /fn find_stream/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /fn reconstruct_material_uv/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /reconstruct_material_uv\(material_info, 0u/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /reconstruct_material_uv\(material_info, 1u/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /reconstruct_material_uv\(material_info, 2u/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /reconstruct_material_uv\(material_info, 3u/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /perspective_barycentric_with_derivatives/);
  assert.doesNotMatch(PACKED_MATERIAL_RESOLVE_WGSL, /\bdpdx\b|\bdpdy\b/);
  assert.doesNotMatch(PACKED_MATERIAL_RESOLVE_WGSL, /mat4_inverse|inverse\s*\(/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /instance\.previous_from_current/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /override OENGINE_VELOCITY_ENABLED: bool/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /if OENGINE_VELOCITY_ENABLED &&/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /OENGINE_SURFACE_FLAG_GRADIENT_FALLBACK \| OENGINE_SURFACE_FLAG_REACTIVE/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /surface_flags \|= OENGINE_SURFACE_FLAG_MOTION_VALID/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /surface_flags \|= OENGINE_SURFACE_FLAG_NORMAL_TEXTURE/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /surface_flags \|= OENGINE_SURFACE_FLAG_ORM_TEXTURE/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /surface_flags \|= OENGINE_SURFACE_FLAG_EMISSIVE_TEXTURE/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /surface_flags \|= OENGINE_SURFACE_FLAG_UNLIT/);
  assert.match(
    PACKED_MATERIAL_RESOLVE_WGSL,
    /sampled_normal = vec3f\([\s\S]*sampled_normal\.xy \* material_info\.pbr_factors\.z,[\s\S]*sampled_normal\.z[\s\S]*\);/
  );
  assert.match(
    PACKED_MATERIAL_RESOLVE_WGSL,
    /if is_unlit \{[\s\S]*output\.albedo = vec4f\(vec3f\(0\.0\), 1\.0\);[\s\S]*output\.emissive = rgbe9995_encode\(albedo\)/
  );
  assert.match(
    PACKED_MATERIAL_RESOLVE_WGSL,
    /output\.metadata = oengine_surface_pack\(work\.material_handle, surface_flags\)/
  );
});

test("Packed runtime has bounded kernel indirect draws and no material-count loop", () => {
  const passSource = readFileSync(
    path.join(root, "src/render/passes/PackedMaterialResolvePass.ts"),
    "utf8"
  );
  const rendererSource = readFileSync(path.join(root, "src/render/Renderer.ts"), "utf8");
  assert.match(
    passSource,
    /binding: 1,[\s\S]*?visibility: GPUShaderStage\.VERTEX \| GPUShaderStage\.FRAGMENT/
  );
  assert.equal((passSource.match(/pass\.drawIndirect\(/g) ?? []).length, 1);
  assert.match(passSource, /kernelClass < GPU_MATERIAL_KERNEL_CLASS_COUNT/);
  assert.doesNotMatch(passSource, /for\s*\([^)]*material|for\s*\([^)]*materials/);
  assert.doesNotMatch(rendererSource, /PackedMaterialExpandPass|PackedVelocityPass/);
  const initializeRenderPasses = rendererSource.slice(
    rendererSource.indexOf("private initializeRenderPasses("),
    rendererSource.indexOf("private obtainLegacyMaterialExpand(")
  );
  assert.doesNotMatch(initializeRenderPasses, /new MaterialExpandPass|new VelocityPass/);
  assert.match(rendererSource, /packedResolveOut \?\? this\.obtainLegacyMaterialExpand\(\)/);
  assert.match(rendererSource, /: this\.obtainLegacyVelocity\(\)\.addToGraph/);
  for (const retired of [
    "src/render/passes/PackedMaterialExpandPass.ts",
    "src/render/passes/PackedVelocityPass.ts",
    "src/shaders/packed_material_expand.ts",
    "src/shaders/packed_velocity.ts"
  ]) assert.equal(existsSync(path.join(root, retired)), false, retired);
});

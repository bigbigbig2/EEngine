import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
globalThis.GPUBufferUsage ??= { COPY_DST: 1 << 3, UNIFORM: 1 << 6, STORAGE: 1 << 7 };
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

test("R4-B Single Resolve owns one fullscreen pass and the frozen 26 B/pixel Surface", () => {
  const buffers = [];
  const pass = new PackedMaterialResolvePass({
    device: {
      createBuffer: (descriptor) => {
        const buffer = { ...descriptor, destroy() {} };
        buffers.push(buffer);
        return buffer;
      },
      createSampler: (descriptor) => ({ descriptor })
    }
  });
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
    ["R4-B Single Material Resolve", "R4-B sink"]
  );
  assert.deepEqual(graph.exportToJson().passes[0].reads, [visibilityKey, view]);
  pass.destroy();
});

test("R4-B shader performs the complete key lookup and one analytic-gradient material sample path", () => {
  for (const lookup of [
    "raster_slot >= min(raster_work.header.written, raster_work.header.capacity)",
    "work.visible_cluster_slot >= min(visible_clusters.header.written, visible_clusters.header.capacity)",
    "work.meshlet_record_index >= arrayLength(&meshlets)",
    "visible.instance_record_index >= arrayLength(&instances)",
    "visible.geometry_record_index >= arrayLength(&geometries)",
    "visible.material_handle >= arrayLength(&materials)",
    "!oengine_instance_active(instance)",
    "instance.geometry_record_index != visible.geometry_record_index",
    "instance.material_handle != visible.material_handle",
    "visible.cluster_record_index - geometry.cluster_begin >= geometry.cluster_count",
    "work.meshlet_record_index - geometry.meshlet_begin >= geometry.meshlet_count",
    "triangle_index >= meshlet.triangle_count"
  ]) assert.match(PACKED_MATERIAL_RESOLVE_WGSL, new RegExp(lookup.replace(/[&()]/g, "\\$&")));

  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /textureSampleGrad\(material_textures/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /material_info\.uv_set > 1u/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /const SEMANTIC_UV1: u32 = 0x00317675u/);
  assert.match(
    PACKED_MATERIAL_RESOLVE_WGSL,
    /select\(SEMANTIC_UV0, SEMANTIC_UV1, material_info\.uv_set == 1u\)/
  );
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /perspective_barycentric_with_derivatives/);
  assert.doesNotMatch(PACKED_MATERIAL_RESOLVE_WGSL, /\bdpdx\b|\bdpdy\b/);
  assert.doesNotMatch(PACKED_MATERIAL_RESOLVE_WGSL, /mat4_inverse|inverse\s*\(/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /instance\.previous_from_current/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /SURFACE_GRADIENT_FALLBACK \| SURFACE_REACTIVE/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /surface_flags \|= SURFACE_MOTION_VALID/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /surface_flags \|= SURFACE_NORMAL_TEXTURE/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /surface_flags \|= SURFACE_ORM_TEXTURE/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /surface_flags \|= SURFACE_EMISSIVE_TEXTURE/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /surface_flags \|= SURFACE_UNLIT/);
  assert.match(PACKED_MATERIAL_RESOLVE_WGSL, /sampled_normal\.xy \*= material_info\.pbr_factors\.z/);
  assert.match(
    PACKED_MATERIAL_RESOLVE_WGSL,
    /if is_unlit \{[\s\S]*output\.albedo = vec4f\(vec3f\(0\.0\), 1\.0\);[\s\S]*output\.emissive = rgbe9995_encode\(albedo\)/
  );
  assert.match(
    PACKED_MATERIAL_RESOLVE_WGSL,
    /output\.flags = \(visible\.material_handle & 0x00ffffffu\) \| \(surface_flags << 24u\)/
  );
});

test("R4-B Packed runtime has no material-count draw loop or retired Packed passes", () => {
  const passSource = readFileSync(
    path.join(root, "src/render/passes/PackedMaterialResolvePass.ts"),
    "utf8"
  );
  const rendererSource = readFileSync(path.join(root, "src/render/Renderer.ts"), "utf8");
  assert.equal((passSource.match(/pass\.draw\(3, 1, 0, 0\)/g) ?? []).length, 1);
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

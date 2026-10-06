import { TextureResidency } from "../../.test-dist/gpu/TextureResidency.js";
import { GpuAppearancePublication } from "../../.test-dist/gpu/GpuAppearancePublication.js";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { ShadeTransparencyMode } from "../../.test-dist/material/enums.js";
import {
  AppearanceGraphBuilder,
  snapshotAppearanceTexture
} from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import {
  writeEncodedTextureAssetPackageV2,
  openTextureAssetPackageV2
} from "../../.test-dist/assets/TextureAssetPackage.js";
import { PipelineLayoutCache, BindGroupCache } from "../../.test-dist/gpu/GPUDescriptorCaches.js";
import { GPUSamplerCache } from "../../.test-dist/gpu/GPUSamplerCache.js";
import { coverageRasterResourceGroups } from "../../.test-dist/render/CoverageRasterBindings.js";
import {
  rasterCoverageFragmentWgsl,
  COVERAGE_VERTEX_VARYINGS
} from "../../.test-dist/shaders/raster_coverage_fragment.js";
import { PACKED_CAMERA_TYPE } from "../../.test-dist/shaders/packed_camera.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../../.test-dist/gpu/GpuInstanceAbi.js";
import {
  GPU_FRAME_INSTANCE_WGSL,
  GPU_FRAME_INSTANCE_STRIDE
} from "../../.test-dist/gpu/GpuFrameInstanceAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../../.test-dist/gpu/GpuVisibilityKeyAbi.js";
import { GPU_SHADING_MATERIAL_WGSL } from "../../.test-dist/gpu/GpuShadingMaterialAbi.js";
import { AppearanceProgramRegistry } from "../../.test-dist/gpu/AppearanceProgramRegistry.js";
import { GPUBufferAllocator } from "../../.test-dist/gpu/GPUBufferAllocator.js";
import { GPUStagingBufferAllocator } from "../../.test-dist/gpu/GPUStagingBufferAllocator.js";
import { GPUTextureAllocator } from "../../.test-dist/gpu/GPUTextureAllocator.js";
import { FrameProfiler } from "../../.test-dist/debug/FrameProfiler.js";

export async function runSurfaceCoverageValueGpuOracle(device) {
  const graphics = {
    device,
    profiler: new FrameProfiler({ enabled: false }),
    buffer_allocator_main: new GPUBufferAllocator(device),
    buffer_allocator_staging: new GPUStagingBufferAllocator(device),
    allocator_textures: new GPUTextureAllocator(device)
  };
  const registry = new AppearanceProgramRegistry(device);
  try {
    return await checkSurfaceCoverageValues(device, graphics, registry);
  } finally {
    registry.destroy();
    graphics.buffer_allocator_main.destroy();
    graphics.buffer_allocator_staging.destroy();
    graphics.allocator_textures.destroy();
  }
}

/** The fixture supplies a plane; the production fragment, alpha compiler,
 * binding resolver, publication transaction and mip-residency owner are real.
 * This checks the changed Coverage value boundary, not meshlet culling or VSM. */
export async function checkSurfaceCoverageValues(device, graphics, registry) {
  const retained = [];
  const layouts = new PipelineLayoutCache(device);
  const coverageGraphics = {
    ...graphics,
    bind_groups: new BindGroupCache(device, layouts),
    samplers: new GPUSamplerCache(device),
    textures: {
      mipmaps: {
        flush() {}, // Cooked packages do not use the uncooked mip generator.
        generateMipmap() {
          throw new Error("Coverage fixture must use cooked mips");
        }
      }
    }
  };
  const residency = new TextureResidency(coverageGraphics, 256);
  let publication;
  const makeBuffer = (data, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST) => {
    const buffer = device.createBuffer({ size: data.byteLength, usage });
    device.queue.writeBuffer(buffer, 0, data);
    retained.push(buffer);
    return buffer;
  };
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  try {
    // Authored mips have a known alpha step below mip 6 and a constant tail.
    // Every sampled texel is away from the step; no filter-tolerance oracle.
    const mips = Array.from({ length: 9 }, (_, level) => {
      const size = Math.max(1, 256 >> level);
      const payload = new Uint8Array(size * size * 4);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          payload.set([128, 128, 128, level >= 6 ? 160 : x < size / 2 ? 255 : 64], (y * size + x) * 4);
        }
      }
      return {
        level,
        logicalWidth: size,
        logicalHeight: size,
        physicalWidth: size,
        physicalHeight: size,
        payload
      };
    });
    const asset = await openTextureAssetPackageV2(
      await writeEncodedTextureAssetPackageV2(
        {
          width: 256,
          height: 256,
          rgba8: mips[0].payload,
          semantic: "base-color-srgb",
          sourceUri: "fixture://coverage-residency-values"
        },
        [
          {
            profile: "portable-rgba8",
            semantic: "base-color-srgb",
            format: "rgba8unorm-srgb",
            blockWidth: 1,
            blockHeight: 1,
            bytesPerBlock: 4,
            codecId: "independent-authored-mips",
            codecRevision: "v1",
            codecBinaryHash: "1".repeat(64),
            mips
          }
        ]
      )
    );
    const texture = ShadeTexture.fromAssetPackageV2(asset);
    const material = new StandardShadeMaterial();
    material.texture_albedo = texture;
    material.transparency_mode = ShadeTransparencyMode.AlphaTested;
    material.alpha_cutoff = 0.75;
    material.appearance_inputs.set("coverageGain", [1]);
    const graph = new AppearanceGraphBuilder();
    const uv = graph.input("uv0", 2, "surface", undefined, "uv0");
    const sampled = graph.texture(snapshotAppearanceTexture(texture, "srgb-rgb"), uv);
    graph.output(
      "alpha",
      graph.operation("multiply", graph.swizzle(sampled, [3]), graph.parameter("coverageGain", 1))
    );
    graph.output("baseColor", graph.swizzle(sampled, [0, 1, 2]));
    const uniformSample = graph.texture(
      snapshotAppearanceTexture(texture, "linear-rgb"),
      graph.constant([0.25, 0.5])
    );
    graph.output("roughness", graph.swizzle(uniformSample, [3]));
    const stageCommand = ShadeGPUCommandContext.create(coverageGraphics, "Renderer/visibility-frame");
    const stage = residency.stage([material], stageCommand);
    publication = new GpuAppearancePublication(
      device,
      registry,
      [
        {
          material,
          materialSlot: 0,
          textureBindingSetId: stage.materialBindingSetIds.get(material),
          program: compileAppearanceGraph(graph.build()),
          textureRefs: stage.materialTextureRoutingRefs.get(material)
        }
      ],
      stageCommand,
      stage.textureMipRanges,
      stage.surfacePublications
    );
    await publication.ready;
    stageCommand.finish();
    await stageCommand.gpuDone;
    const live = stage.surfacePublications.get(texture);
    check(live.currentMinimumMip === 6, "real cooked package starts at mip 6");
    const coverage = publication.entries[0].coverage;
    const source = `${PACKED_CAMERA_TYPE.wgsl_declaration}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_FRAME_INSTANCE_WGSL}
${GPU_VISIBILITY_KEY_WGSL}
${GPU_SHADING_MATERIAL_WGSL}
@group(0) @binding(0) var<uniform> meshlet_camera: CommandEncoder;
@group(0) @binding(1) var<storage,read> meshlet_instances: array<OEngineFrameInstanceRecord>;
struct PlaneOutput {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) instance: u32,
  @location(2) @interpolate(flat) triangle: u32,
  @location(3) uv0: vec2f, @location(4) uv1: vec2f, @location(5) uv2: vec2f,
  @location(7) @interpolate(flat) material: u32,
  @location(8) @interpolate(flat) work: u32,
${COVERAGE_VERTEX_VARYINGS}
}
@vertex fn plane(@builtin(vertex_index) vertex: u32) -> PlaneOutput {
  let coordinates = array<vec2f,3>(vec2f(-1.0,-1.0),vec2f(3.0,-1.0),vec2f(-1.0,3.0));
  var output: PlaneOutput;
  output.position = vec4f(coordinates[vertex],0.5,1.0);
  output.uv0 = coordinates[vertex] * vec2f(0.5,-0.5) + vec2f(0.5);
  output.uv1 = output.uv0; output.uv2 = output.uv0;
  output.local_normal = vec4f(0.0,0.0,1.0,0.0);
  output.local_tangent = vec4f(1.0,0.0,0.0,1.0);
  output.vertex_color = vec4f(1.0);
  output.local_position = vec3f(coordinates[vertex],0.0);
  return output;
}
${rasterCoverageFragmentWgsl(false, false, false, coverage)}`;
    const group0 = layouts.obtainBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        ...[1, 22, 23, 24, 25].map((binding) => ({
          binding,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "read-only-storage" }
        }))
      ]
    });
    const groups = coverageRasterResourceGroups(
      coverageGraphics,
      { materialResources: { bindingSets: stage.bindings.bindingSets } },
      coverage
    );
    const layout = device.createPipelineLayout({
      bindGroupLayouts: [
        group0,
        ...coverage.kernel.descriptor.groups
          .slice(1)
          .map((entries) => layouts.obtainBindGroupLayout({ entries }))
      ]
    });
    const module = device.createShaderModule({
      label: "Coverage production fragment value boundary",
      code: source
    });
    const pipeline = await device.createRenderPipelineAsync({
      layout,
      vertex: { module, entryPoint: "plane" },
      fragment: { module, entryPoint: "write_visibility", targets: [{ format: "r32uint" }] },
      primitive: { topology: "triangle-list" }
    });
    const camera = makeBuffer(
      new Float32Array(PACKED_CAMERA_TYPE.size / 4),
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    );
    const instances = makeBuffer(new Uint32Array(GPU_FRAME_INSTANCE_STRIDE / 4));
    const temporary = device.createBuffer({
      size: publication.exactDagScratchBytes,
      usage: GPUBufferUsage.STORAGE
    });
    retained.push(temporary);
    const bind = device.createBindGroup({
      layout: group0,
      entries: [
        [0, camera],
        [1, instances],
        [22, publication.constants],
        [23, publication.routes],
        [24, publication.runtimeInputs],
        [25, publication.coverageDirectory]
      ].map(([binding, buffer]) => ({ binding, resource: { buffer } }))
    });
    const output = device.createTexture({
      size: [16, 16],
      format: "r32uint",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
    });
    retained.push(output);
    const reports = [];
    async function render(label, expected, abort = false, expectedDirty = false) {
      const command = ShadeGPUCommandContext.create(coverageGraphics, "Renderer/visibility-frame");
      const dirty = publication.syncRuntime(command);
      check(dirty === expectedDirty, `${label}: actual alpha caster invalidation`);
      publication.encodeWorkPublication(command, temporary, reports.length + 1, camera, [
        stage.bindings.bindingSets[0].textureBanks
      ]);
      const pass = command.gpu_encoder.beginRenderPass({
        colorAttachments: [
          {
            view: output.createView(),
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: 4294967295, g: 0, b: 0, a: 0 }
          }
        ]
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      groups.forEach((group, index) => pass.setBindGroup(index + 1, group));
      pass.draw(3);
      pass.end();
      if (abort) {
        command.abort(new Error("controlled Coverage unsubmitted frame"));
        return;
      }
      const readback = device.createBuffer({
        size: 16 * 256 + publication.surfaceMetadata.size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      command.gpu_encoder.copyTextureToBuffer(
        { texture: output },
        { buffer: readback, bytesPerRow: 256 },
        [16, 16]
      );
      command.gpu_encoder.copyBufferToBuffer(
        publication.surfaceMetadata,
        0,
        readback,
        16 * 256,
        publication.surfaceMetadata.size
      );
      command.finish();
      await command.gpuDone;
      await readback.mapAsync(GPUMapMode.READ);
      const actual = new Uint32Array(readback.getMappedRange().slice(0));
      readback.unmap();
      readback.destroy();
      let covered = 0;
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const wanted = expected(x) ? 0 : 0xffffffff;
          check(
            actual[y * 64 + x] === wanted,
            `${label}: independent alpha coverage at ${x},${y}: ${actual[y * 64 + x]} != ${wanted}`
          );
          if (wanted === 0) covered++;
        }
      }
      const roughnessAt = publication.surfaceMetadataOffsets.constantFields + 4 + 3 * 4;
      const uniformAlpha = new Float32Array(actual.buffer, 16 * 256)[roughnessAt];
      const expectedUniform = live.currentMinimumMip === 6 ? 160 / 255 : 1;
      check(
        Math.abs(uniformAlpha - expectedUniform) <= 1e-6,
        `${label}: real Surface update query reads committed mip: ${uniformAlpha} != ${expectedUniform}`
      );
      reports.push({
        label,
        covered,
        minimumMip: live.currentMinimumMip,
        revision: live.currentRevision,
        uniformAlpha,
        casterDirty: dirty
      });
    }
    await render("resident tail", () => false);
    const abortedPromotion = ShadeGPUCommandContext.create(coverageGraphics, "Renderer/visibility-frame");
    residency.promote([texture], abortedPromotion, 0);
    abortedPromotion.abort(new Error("controlled mip promotion abort"));
    check(live.currentMinimumMip === 6, "aborted promotion retains actual tail");
    await render("aborted promotion", () => false);
    const promotion = ShadeGPUCommandContext.create(coverageGraphics, "Renderer/visibility-frame");
    residency.promote([texture], promotion, 0);
    promotion.finish();
    await promotion.gpuDone;
    check(live.currentMinimumMip === 0, "committed promotion exposes uploaded fine mips");
    await render("aborted route frame", (x) => x < 8, true, true);
    await render("fine route retry", (x) => x < 8, false, true);
    await render("stable fine route", (x) => x < 8);
    material.appearance_inputs.set("coverageGain", [0.5]);
    await render("aborted parameter frame", () => false, true, true);
    await render("parameter retry", () => false, false, true);
    await render("stable parameter", () => false);
    material.alpha_cutoff = 0.1;
    await render("cutoff change", () => true, false, true);
    await render("stable cutoff", () => true);
    return {
      passed: true,
      scope: "real residency/upload/publication → production alpha/discard/visibility fragment",
      reports
    };
  } finally {
    publication?.destroy();
    residency.destroy();
    retained.forEach((resource) => resource.destroy());
    coverageGraphics.bind_groups.clear();
    layouts.clear();
  }
}

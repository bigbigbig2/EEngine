import { TextureResidency } from "../../.test-dist/gpu/TextureResidency.js";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";
import { GraphicsContext } from "../../.test-dist/gpu/GraphicsContext.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { ShadeImage } from "../../.test-dist/texture/ShadeImage.js";
import {
  prepareMaterialTextureProducts,
  MATERIAL_TEXTURE_PROPERTIES,
  materialTextureSemantic,
} from "../../.test-dist/assets/PcMaterialTextures.js";
import { compileCanonicalMaterial } from "../../.test-dist/material/CanonicalMaterial.js";
import { nativeSurfacePublicationDescriptors } from "../../.test-dist/shaders/native_surface.js";
import { AppearanceProgramRegistry } from "../../.test-dist/gpu/AppearanceProgramRegistry.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { ShadeTransparencyMode } from "../../.test-dist/material/enums.js";
import { AppearanceMaterialDefinition } from "../../.test-dist/material/AppearanceMaterialDefinition.js";
import {
  AppearanceGraphBuilder,
  snapshotAppearanceTexture,
} from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { lowerNativeMaterial } from "../../.test-dist/shaders/native_material.js";
import { createNativeMaterialBindings } from "../../.test-dist/gpu/NativeMaterialBindings.js";
import { initializePcTextureCodecs, cookPcTextureRgba } from "../../.test-dist/assets/codec/PcTextureCook.js";
import { writeTextureProductPlane } from "../../.test-dist/assets/TextureProduct.js";
import { check } from "./texture-test-utils.mjs";

export async function runPcTextureResidencyGpuOracle(device) {
  const graphics = new GraphicsContext(device),
    residency = new TextureResidency(graphics),
    references = [],
    buffers = [];
  const codecs = await initializePcTextureCodecs(),
    materials = [],
    cases = [];
  let maxError = 0,
    samples = 0;
  try {
    for (const [semantic, w, h, exact, channel] of [
      ["base-color-srgb", 17, 9, true, 0],
      ["normal-linear", 20, 12, false, 0],
      ["occlusion-linear", 24, 16, false, 2],
    ]) {
      const rgba = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          rgba.set([80 + (x % 40), 90 + (y % 40), 120 + (x % 50), (x + y) % 2 ? 127 : 128], (y * w + x) * 4);
      const { product } = await cookPcTextureRgba(codecs, rgba, w, h, {
        semantic,
        exactAlpha: exact,
        channel,
        sourceUri: "fixture://residency",
      });
      const texture = ShadeTexture.fromProduct(product),
        material = new StandardShadeMaterial();
      if (semantic === "normal-linear") material.texture_normal = texture;
      else if (semantic === "occlusion-linear") {
        material.is_unlit = true;
        const g = new AppearanceGraphBuilder(),
          uv = g.input("uv0", 2, "surface", undefined, "uv0");
        const q = g.texture(snapshotAppearanceTexture(texture, "linear-rgb"), uv);
        g.output("baseColor", g.swizzle(q, [channel, channel, channel]));
        g.output("alpha", g.constant(1));
        material.appearance_definition = new AppearanceMaterialDefinition(g.build());
      } else {
        material.texture_albedo = texture;
        material.transparency_mode = ShadeTransparencyMode.AlphaTested;
      }
      materials.push(material);
      cases.push({ semantic, texture, material, product });
    }
    const canvas = new OffscreenCanvas(8, 8),
      context = canvas.getContext("2d");
    context.fillStyle = "rgba(120,160,80,0.5)";
    context.fillRect(0, 0, 8, 8);
    const png = await canvas.convertToBlob({ type: "image/png" }),
      raw = new StandardShadeMaterial();
    raw.texture_albedo = ShadeTexture.from(ShadeImage.fromEncodedImage(await png.arrayBuffer(), "image/png"));
    raw.transparency_mode = ShadeTransparencyMode.AlphaTested;
    const WorkerClass = globalThis.Worker;
    let workerCount = 0;
    globalThis.Worker = class extends WorkerClass {
      constructor(...args) {
        super(...args);
        workerCount++;
      }
    };
    try {
      await prepareMaterialTextureProducts([raw]);
      check(workerCount === 1, "Raw image preparation did not use the bounded cold Worker");
      await prepareMaterialTextureProducts([raw]);
      check(workerCount === 1, "Cooked Product unexpectedly initialized a codec Worker");
    } finally {
      globalThis.Worker = WorkerClass;
    }
    materials.push(raw);
    cases.push({
      semantic: "base-color-srgb",
      texture: raw.texture_albedo,
      material: raw,
      product: raw.texture_albedo.texture_product,
    });
    const upload = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    const stage = residency.stage(materials, upload);
    upload.finish();
    await upload.gpuDone;
    const abort = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    residency.promote(materials, abort);
    abort.abort(new Error("controlled promotion abort"));
    check(
      stage.surfacePublications.get(cases[1].texture).currentMinimumMip > 0,
      "Aborted promotion changed clamp",
    );
    const promotion = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    residency.promote(materials, promotion);
    promotion.finish();
    await promotion.gpuDone;
    for (const item of cases) {
      const builder = new AppearanceGraphBuilder(),
        uv = builder.input("uv0", 2, "surface", undefined, "uv0");
      const query = builder.texture(
        snapshotAppearanceTexture(
          item.texture,
          item.semantic === "base-color-srgb" ? "srgb-rgb" : "linear-rgb",
        ),
        uv,
      );
      builder.output(
        "rgba",
        item.semantic === "occlusion-linear"
          ? builder.swizzle(query, [item.product.metadata.channel])
          : query,
      );
      const graph = compileAppearanceGraph(builder.build()),
        binding = createNativeMaterialBindings({
          graph,
          program: lowerNativeMaterial(graph),
          group: 1,
          bindingSet: stage.bindings.bindingSets.find(
            (set) => set.id === stage.materialBindingSetIds.get(item.material),
          ),
          textureRoutingRefs: stage.materialTextureRoutingRefs.get(item.material),
          textureMipRanges: stage.textureMipRanges,
          texturePublications: stage.surfacePublications,
          obtainSampler: (d) => graphics.samplers.obtain(d),
        });
      // Independently upload identical immutable blocks to layer 1. The reference
      // has no native route, segment selection, channel glue or coverage glue.
      const refs = item.product.metadata.planes.map((plane, index) => {
        const t = device.createTexture({
          size: [item.product.metadata.storageWidth, item.product.metadata.storageHeight, 2],
          format: plane.format,
          mipLevelCount: plane.mips.length,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        references.push(t);
        writeTextureProductPlane(device, item.product, index, t, 1);
        return t;
      });
      const constants = device.createBuffer({
        size: binding.program.constants.length * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(constants, 0, new Float32Array(binding.program.constants));
      buffers.push(constants);
      const count = item.product.metadata.planes[0].mips.length;
      const output = device.createBuffer({
        size: count * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      const read = device.createBuffer({
        size: count * 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      buffers.push(output, read);
      const expected =
        item.semantic === "occlusion-linear"
          ? "vec4f(color.r,0.0,0.0,0.0)"
          : refs.length === 2
            ? "vec4f(color.rgb,textureSampleGrad(coverage,reference_sampler,uv,1,dx,dy).r)"
            : "color";
      const shader = device.createShaderModule({
        code: `
@group(0) @binding(0) var<storage,read> constants:array<f32>;
@group(0) @binding(1) var<storage,read_write> output:array<vec4f>;
@group(2) @binding(0) var primary:texture_2d_array<f32>;
@group(2) @binding(1) var reference_sampler:sampler;
${refs.length === 2 ? "@group(2) @binding(2) var coverage:texture_2d_array<f32>;" : ""}
fn native_material_constant(base:u32,slot:u32)->f32{return constants[base+slot];}
${binding.program.source}
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) id:vec3u){
  let uv=vec2f(0.37,0.61);
  let dx=vec2f(exp2(f32(id.x))/${item.product.metadata.storageWidth}.0,0.0);
  let dy=vec2f(0.0,exp2(f32(id.x))/${item.product.metadata.storageHeight}.0);
  var inputs:NativeMaterialInputs;
  inputs.center[0]=vec4f(uv,0.0,0.0);
  inputs.x[0]=vec4f(uv+dx,0.0,0.0);
  inputs.y[0]=vec4f(uv+dy,0.0,0.0);
  let result=native_material_evaluate(0u,inputs);
  let color=textureSampleGrad(primary,reference_sampler,uv,1,dx,dy);
  output[id.x]=${item.semantic === "occlusion-linear" ? "vec4f(result[0],0.0,0.0,0.0)" : "vec4f(result[0],result[1],result[2],result[3])"}-${expected};
}`,
      });
      const layouts = [
        device.createBindGroupLayout({
          entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
          ],
        }),
        device.createBindGroupLayout({ entries: binding.layoutEntries }),
        device.createBindGroupLayout({
          entries: [
            {
              binding: 0,
              visibility: GPUShaderStage.COMPUTE,
              texture: { sampleType: "float", viewDimension: "2d-array" },
            },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
            ...(refs.length === 2
              ? [
                  {
                    binding: 2,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: { sampleType: "float", viewDimension: "2d-array" },
                  },
                ]
              : []),
          ],
        }),
      ];
      const pipeline = await device.createComputePipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
        compute: { module: shader, entryPoint: "main" },
      });
      const groups = [
        device.createBindGroup({
          layout: layouts[0],
          entries: [
            { binding: 0, resource: { buffer: constants } },
            { binding: 1, resource: { buffer: output } },
          ],
        }),
        device.createBindGroup({ layout: layouts[1], entries: binding.entries }),
        device.createBindGroup({
          layout: layouts[2],
          entries: [
            { binding: 0, resource: refs[0].createView({ dimension: "2d-array" }) },
            {
              binding: 1,
              resource: graphics.samplers.obtain({
                addressModeU: "repeat",
                addressModeV: "repeat",
                minFilter: "linear",
                magFilter: "linear",
                mipmapFilter: "linear",
              }),
            },
            ...(refs.length === 2
              ? [{ binding: 2, resource: refs[1].createView({ dimension: "2d-array" }) }]
              : []),
          ],
        }),
      ];
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      groups.forEach((g, i) => pass.setBindGroup(i, g));
      pass.dispatchWorkgroups(count);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, read, 0, count * 16);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      for (const error of new Float32Array(read.getMappedRange())) {
        check(
          Number.isFinite(error) && Math.abs(error) <= 0.0001,
          "Native BC/R8 route differs from independent block sampling",
        );
        maxError = Math.max(maxError, Math.abs(error));
        samples++;
      }
      read.unmap();
    }
    const before = residency.evidence(),
      release = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    residency.release(materials, release);
    release.finish();
    await release.gpuDone;
    await Promise.resolve();
    await Promise.resolve();
    const after = residency.evidence();
    check(
      after.allocatedBytes === 0 &&
        after.residentTextureCount === 0 &&
        after.retiringTextureCount === 0 &&
        after.bindingSetCount === 0,
      "Residency ledger failed to clear",
    );
    const capacity = await verifyCapacity(device, graphics, residency, codecs);
    return {
      status: "passed",
      samples,
      maxError,
      tolerance: 0.0001,
      npot: true,
      exactCoverage: true,
      bc4Channel: 2,
      promotionAbortRetry: true,
      rawWorkerCount: workerCount,
      cookedWorkerCount: 0,
      capacity,
      before,
      after,
    };
  } finally {
    await device.queue.onSubmittedWorkDone();
    residency.destroy();
    references.forEach((t) => t.destroy());
    buffers.forEach((b) => b.destroy());
    graphics.destroy();
  }
}

async function verifyCapacity(device, graphics, residency, codecs) {
  const full = new StandardShadeMaterial();
  full.clearcoat_factor = 1;
  full.clearcoat_roughness_factor = 0.3;
  full.emissive_factor.set(1, 1, 1);
  full.transparency_mode = ShadeTransparencyMode.AlphaTested;
  const singles = [];
  for (let i = 0; i < 20; i++) {
    const extent = 8 + i * 4,
      bytes = new Uint8Array(extent * extent * 4);
    for (let p = 0; p < bytes.length; p += 4) bytes.set([128, 160, 240, 220], p);
    const property = MATERIAL_TEXTURE_PROPERTIES[i % 10];
    const product = (
      await cookPcTextureRgba(codecs, bytes, extent, extent, {
        semantic: materialTextureSemantic(property),
        exactAlpha: property === "texture_albedo",
        sourceUri: `fixture://capacity/${i}`,
      })
    ).product;
    const texture = ShadeTexture.fromProduct(product);
    if (i < 10) full[property] = texture;
    const material = new StandardShadeMaterial();
    const g = new AppearanceGraphBuilder(),
      uv = g.input("uv0", 2, "surface", undefined, "uv0");
    const q = g.texture(
      snapshotAppearanceTexture(
        texture,
        product.metadata.planes[0].format.endsWith("-srgb") ? "srgb-rgb" : "linear-rgb",
      ),
      uv,
    );
    g.output("baseColor", g.swizzle(q, [0, 0, 0]));
    g.output("alpha", g.constant(1));
    material.is_unlit = true;
    material.appearance_definition = new AppearanceMaterialDefinition(g.build());
    singles.push(material);
  }
  const command = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
  const stage = residency.stage([...singles, full], command);
  const materialStore = graphics.material_store;
  const materialStage = materialStore.stage(
    [...singles, full].map((material) => ({
      material,
      programId: 2,
      textureBindingSetId: stage.materialBindingSetIds.get(material),
    })),
    stage.materialTextureRoutingRefs,
    command,
    stage.textureMipRanges,
    stage.surfacePublications,
  );
  command.finish();
  await command.gpuDone;
  check(
    residency.evidence().segmentCount > 16 && residency.evidence().bindingSetCount > 16,
    "Global segment or tuple identity was truncated",
  );
  const graph = compileCanonicalMaterial(full).appearance;
  const binding = createNativeMaterialBindings({
    graph,
    program: lowerNativeMaterial(graph),
    group: 3,
    bindingSet: stage.bindings.bindingSets.find((s) => s.id === stage.materialBindingSetIds.get(full)),
    textureRoutingRefs: stage.materialTextureRoutingRefs.get(full),
    textureMipRanges: stage.textureMipRanges,
    texturePublications: stage.surfacePublications,
    obtainSampler: (d) => graphics.samplers.obtain(d),
  });
  const { descriptor, continuation } = nativeSurfacePublicationDescriptors(
    binding.program,
    binding.layoutEntries,
    { compact: false, productGeometry: false, unlit: false, reactive: true, physicalSun: true },
    device.limits,
  );
  check(!continuation, "Full ten-map profile unexpectedly needed a sun continuation");
  const sampled = descriptor.groups.flat().filter((e) => e.texture).length;
  check(sampled > 16 && sampled <= 19, "Full ten-map sampled descriptor was not exercised");
  const registry = new AppearanceProgramRegistry(device);
  const lease = registry.acquire(descriptor);
  try {
    const compiled = await lease.ready;
    device.createBindGroup({ layout: compiled.layouts[3], entries: binding.entries });
  } finally {
    lease.release();
    registry.destroy();
  }
  const before = residency.evidence(),
    release = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
  residency.release([...singles, full], release);
  materialStore.release(materialStage.handle, release);
  release.finish();
  await release.gpuDone;
  await Promise.resolve();
  await Promise.resolve();
  check(residency.evidence().allocatedBytes === 0, "Capacity fixture failed fenced teardown");
  return {
    segments: before.segmentCount,
    tuples: before.bindingSetCount,
    tenMaps: 10,
    sampledTextures: sampled,
    nativeSurfaceCompiled: true,
    materialPublication: true,
    fencedBytes: 0,
  };
}

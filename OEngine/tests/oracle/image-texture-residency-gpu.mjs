import assert from "node:assert/strict";
import { ImageTextureSource } from "../../.test-dist/assets/ImageTextureSource.js";
import { imageTextureHash } from "../../.test-dist/assets/ImageTextureProduct.js";
import { CookedAssetPreparation } from "../../.test-dist/assets/codec/CookedAssetPreparation.js";
import { ImageTextureTranscoder } from "../../.test-dist/gpu/ImageTextureTranscoder.js";
import { TextureResidency } from "../../.test-dist/gpu/TextureResidency.js";
import { VirtualTextureResidency } from "../../.test-dist/gpu/VirtualTextureResidency.js";
import { GraphicsContext } from "../../.test-dist/gpu/GraphicsContext.js";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { createNativeMaterialBindings } from "../../.test-dist/gpu/NativeMaterialBindings.js";
import { AppearanceGraphBuilder, snapshotAppearanceTexture } from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { lowerNativeMaterial } from "../../.test-dist/shaders/native_material.js";
import { checkLogicalImageSampling } from "./image-texture-sampling-gpu.mjs";
import { checkVirtualImageDemand } from "./image-texture-demand-gpu.mjs";

const local = "/.local/extreme-web-asset/";
async function openSource(preparation, path) {
  const url = new URL(local + path + "/directory.json", location.href).href;
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  return ImageTextureSource.open(url, await imageTextureHash(bytes), bytes.length, undefined, preparation);
}

export async function runImageTextureResidencyGpu(device) {
  document.body.prepend(Object.assign(document.createElement("p"), {
    textContent: "Powered by spark.js - local evaluation; https://ludicon.com/sparkjs/eula.html"
  }));
  const identity = await (await fetch(local + "sources.json")).json();
  const shaders = {};
  for (const [variant, name] of Object.entries({
    "bc7-rgb": "spark_bc7_rgb.wgsl", "bc7-rgba": "spark_bc7_rgba.wgsl",
    "bc5-rg": "spark_bc5_rg.wgsl", "bc4-r": "spark_bc4_r.wgsl", utils: "utils.wgsl"
  })) {
    const bytes = new Uint8Array(await (await fetch(local + "sources/spark/src/shaders/" + name)).arrayBuffer());
    assert.equal(await imageTextureHash(bytes), identity.sources.spark.files["src/shaders/" + name]);
    shaders[variant] = new TextDecoder().decode(bytes);
  }
  const kernels = { revision: identity.sources.spark.revision, scope: "local-evaluation", shaders };
  const graphics = new GraphicsContext(device, undefined, {}, undefined, undefined, kernels);
  const preparation = new CookedAssetPreparation({ maxWorkers: 2 });
  const residency = new TextureResidency(graphics);
  const sources = [];
  const batch = async (record) => {
    const command = ShadeGPUCommandContext.create(graphics, "Renderer/hidden-image-batch");
    try {
      record(command);
      command.finish();
      await command.gpuDone;
    } catch (error) {
      if (!command.closed) command.abort(error);
      throw error;
    }
  };
  let samples = 0;
  try {
    const logicalSampling = await checkLogicalImageSampling(device);
    await residency.prepare();
    let webImports = 0;
    for (const [semantic, exactAlpha] of [["color-rgba", true], ["normal-xy", true], ["data-rgb", false]]) {
      const rgba = new Uint8Array(7 * 5 * 4);
      for (let at = 0; at < rgba.length; at += 4) {
        rgba.set(semantic === "normal-xy" ? [128, 128, 255, at & 255] : [at & 255, 67, 193, at & 255], at);
      }
      const { source } = await ImageTextureSource.importWeb({
        input: rgba.buffer, width: 7, height: 5, semantic, exactAlpha,
        addressU: "repeat", addressV: "repeat"
      }, undefined, preparation);
      assert.equal(preparation.evidence().credit.used.total, 0);
      assert.ok(preparation.evidence().localImageReplayBytes > 0);
      const material = new StandardShadeMaterial();
      if (semantic === "normal-xy") material.texture_normal = ShadeTexture.fromImageSource(source);
      else if (semantic === "data-rgb") material.texture_orm = ShadeTexture.fromImageSource(source);
      else material.texture_albedo = ShadeTexture.fromImageSource(source);
      const publication = ShadeGPUCommandContext.create(graphics, "Renderer/GpuRenderWorld/residency-transaction");
      residency.stage([material], publication);
      await residency.uploadImages([material], publication, batch);
      publication.finish();
      await publication.gpuDone;
      const release = ShadeGPUCommandContext.create(graphics, "Renderer/GpuRenderWorld/residency-transaction");
      residency.release([material], release);
      release.finish(); await release.gpuDone;
      source.close();
      assert.equal(preparation.evidence().localImageReplayBytes, 0);
      assert.equal(preparation.evidence().credit.used.total, 0);
      webImports++;
    }
    const encodedInputs = [];
    const canvas = new OffscreenCanvas(7, 5);
    const context = canvas.getContext("2d");
    context.fillStyle = "rgb(67, 123, 193)";
    context.fillRect(0, 0, 7, 5);
    for (const mime of ["image/png", "image/jpeg", "image/webp"]) {
      const blob = await canvas.convertToBlob({ type: mime, quality: 0.9 });
      assert.equal(blob.type, mime);
      encodedInputs.push({ mime, input: await blob.arrayBuffer() });
    }
    for (const file of ["uastc-zstd.ktx2", "rgba-64x64-mipmap-etc1s.ktx2", "luminance-alpha-32x32-uastc.ktx2"]) {
      const response = await fetch("/OEngine/tests/fixtures/texture-codec/" + file);
      assert.ok(response.ok);
      encodedInputs.push({ mime: "image/ktx2", input: await response.arrayBuffer() });
    }
    for (const input of encodedInputs) {
      const { source } = await ImageTextureSource.importWeb({
        ...input, width: 0, height: 0, semantic: "color-rgba", exactAlpha: true,
        addressU: "repeat", addressV: "mirror-repeat"
      }, undefined, preparation);
      const material = new StandardShadeMaterial();
      material.texture_albedo = ShadeTexture.fromImageSource(source);
      material.texture_albedo.wrapT = 2;
      const publication = ShadeGPUCommandContext.create(graphics, "Renderer/GpuRenderWorld/residency-transaction");
      residency.stage([material], publication);
      await residency.uploadImages([material], publication, batch);
      publication.finish(); await publication.gpuDone;
      const release = ShadeGPUCommandContext.create(graphics, "Renderer/GpuRenderWorld/residency-transaction");
      residency.release([material], release);
      release.finish(); await release.gpuDone;
      source.close();
      assert.equal(preparation.evidence().localImageReplayBytes, 0);
      assert.equal(preparation.evidence().credit.used.total, 0);
      webImports++;
    }
    const paths = ["e1-fixtures/normal-xy-high", "e1-fixtures/data-rgb-high", "e1-fixtures/color-rgba-high"];
    for (const path of paths) {
      const source = await openSource(preparation, path);
      sources.push(source);
      const texture = ShadeTexture.fromImageSource(source);
      const material = new StandardShadeMaterial();
      material.texture_albedo = texture;
      const publication = ShadeGPUCommandContext.create(graphics, "Renderer/GpuRenderWorld/residency-transaction");
      const stage = residency.stage([material], publication);
      await residency.uploadImages([material], publication, batch);
      publication.finish();
      await publication.gpuDone;
      const builder = new AppearanceGraphBuilder();
      const uv = builder.input("uv0", 2, "surface", undefined, "uv0");
      const sampled = builder.texture(snapshotAppearanceTexture(texture, "linear-rgb"), uv);
      builder.output("value", sampled);
      const graph = compileAppearanceGraph(builder.build());
      const bindings = createNativeMaterialBindings({
        graph, program: lowerNativeMaterial(graph),
        bindingSet: stage.bindings.bindingSets.find((set) => set.id === stage.materialBindingSetIds.get(material)),
        textureRoutingRefs: stage.materialTextureRoutingRefs.get(material),
        textureMipRanges: stage.textureMipRanges, texturePublications: stage.surfacePublications,
        obtainSampler: (descriptor) => device.createSampler(descriptor), group: 1
      });
      const module = device.createShaderModule({ code: `
@group(0) @binding(0) var<storage, read> constants: array<f32>;
@group(0) @binding(1) var<storage, read_write> output: array<vec4f>;
fn native_material_constant(base: u32, slot: u32) -> f32 { return constants[base + slot]; }
${bindings.program.source}
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let uv = vec2f(f32(id.x) * 0.1875 - 0.125, 0.37);
  output[id.x] = native_material_sample_0(0u, uv, vec2f(0.23, 0.07), vec2f(0.01, 0.012));
}` });
      const info = await module.getCompilationInfo();
      assert.deepEqual(info.messages.filter((message) => message.type === "error"), []);
      const first = device.createBindGroupLayout({ entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
      ] });
      const second = device.createBindGroupLayout({ entries: bindings.layoutEntries });
      const pipeline = await device.createComputePipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [first, second] }),
        compute: { module, entryPoint: "main" }
      });
      const constants = device.createBuffer({ size: bindings.program.constants.length * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(constants, 0, new Float32Array(bindings.program.constants));
      const output = device.createBuffer({ size: 8 * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const readback = device.createBuffer({ size: 8 * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const command = ShadeGPUCommandContext.create(graphics, "Renderer/GpuRenderWorld/residency-transaction");
      const pass = command.gpu_encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({ layout: first, entries: [
        { binding: 0, resource: { buffer: constants } }, { binding: 1, resource: { buffer: output } }
      ] }));
      pass.setBindGroup(1, device.createBindGroup({ layout: second, entries: bindings.entries }));
      pass.dispatchWorkgroups(8);
      pass.end();
      command.gpu_encoder.copyBufferToBuffer(output, 0, readback, 0, 128);
      command.finish();
      await command.gpuDone;
      await readback.mapAsync(GPUMapMode.READ);
      const values = new Float32Array(readback.getMappedRange());
      for (const value of values) assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
      if (source.directory.planes[0].semantic === "normal-xy") {
        for (let i = 0; i < values.length; i += 4) {
          const xyz = [...values.subarray(i, i + 3)].map((value) => value * 2 - 1);
          assert.ok(Math.abs(Math.hypot(...xyz) - 1) < 0.015);
          assert.ok(xyz[2] >= 0);
        }
      }
      samples += 8;
      readback.unmap();
      readback.destroy(); output.destroy(); constants.destroy();
      const retained = residency.retainQuery([material]);
      const release = ShadeGPUCommandContext.create(graphics, "Renderer/GpuRenderWorld/residency-transaction");
      residency.release([material], release);
      release.finish(); await release.gpuDone;
      assert.equal(retained.valid, true);
      retained.release();
      await device.queue.onSubmittedWorkDone();
    }
    const virtualSource = await openSource(preparation, "e2-page-fixtures/npot-385-repeat");
    sources.push(virtualSource);
    // Abort while a hidden writer owns a tail destination. The reservation must
    // remain unavailable until that callback exits, even if no submit occurred.
    const cancelledOwner = new VirtualTextureResidency(graphics, await graphics.prepareImageTranscoder());
    await cancelledOwner.ready;
    const cancelledPublication = ShadeGPUCommandContext.create(graphics, "Renderer/GpuRenderWorld/residency-transaction");
    cancelledOwner.stage(virtualSource, cancelledPublication);
    let enter;
    let resume;
    const entered = new Promise((resolve) => { enter = resolve; });
    const resumed = new Promise((resolve) => { resume = resolve; });
    const cancelledBootstrap = cancelledOwner.bootstrap(virtualSource, cancelledPublication, async (record) => {
      enter();
      await resumed;
      await batch(record);
    });
    const cancelled = cancelledBootstrap.then(
      () => { throw new Error("Cancelled bootstrap unexpectedly published"); },
      (error) => { assert.ok(/cancelled/.test(String(error))); }
    );
    await entered;
    cancelledPublication.abort(new Error("deliberate publication cancellation"));
    assert.equal(cancelledOwner.sourceCount, 1, "in-flight tail destination remains quarantined");
    resume();
    await cancelled;
    await cancelledOwner.release(virtualSource, Promise.resolve());
    assert.equal(cancelledOwner.sourceCount, 0);
    const retryPublication = ShadeGPUCommandContext.create(graphics, "Renderer/GpuRenderWorld/residency-transaction");
    cancelledOwner.stage(virtualSource, retryPublication);
    await cancelledOwner.bootstrap(virtualSource, retryPublication, batch);
    retryPublication.finish(); await retryPublication.gpuDone;
    assert.equal(cancelledOwner.evidence().pinned, 2);
    await cancelledOwner.release(virtualSource, retryPublication.gpuDone);
    cancelledOwner.destroy();
    const material = new StandardShadeMaterial();
    material.texture_orm = ShadeTexture.fromImageSource(virtualSource);
    const publication = ShadeGPUCommandContext.create(graphics, "Renderer/GpuRenderWorld/residency-transaction");
    const stage = residency.stage([material], publication);
    await residency.uploadImages([material], publication, batch);
    publication.finish(); await publication.gpuDone;
    const route = stage.surfacePublications.get(material.texture_orm).virtual;
    assert.equal(route.tailFirst, 3);
    assert.equal(residency.virtualTextures.evidence().pinned, 2);
    assert.equal(preparation.evidence().credit.used.total, 0);
    const fineDemand = await checkVirtualImageDemand(graphics, residency.virtualTextures, route);
    return { logicalSampling, fineDemand, webImports, nativeSamples: samples, protectedTailLevels: 12, formats: ["bc7", "bc5", "r8"],
      residency: residency.evidence(), scope: "actual production owners, local evaluation kernels" };
  } finally {
    residency.destroy();
    for (const source of sources) source.close();
    preparation.dispose();
    graphics.destroy();
  }
}

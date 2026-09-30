import assert from "node:assert/strict";
import { SurfaceMaterialPass } from "../../.test-dist/render/surface/SurfaceMaterialPass.js";
import { FrameGraph, FrameGraphContext, FrameGraphResourceManager } from "../../.test-dist/framegraph/FrameGraph.js";
import { surfaceSampleCapacity, SURFACE_SAMPLE_COUNTER } from "../../.test-dist/render/surface/SurfaceSampleAbi.js";
import { DIRECTIONAL_LIGHT_DESCRIPTOR, DIRECTIONAL_LIGHT_RECORD_TYPE } from "../../.test-dist/gpu/LightDatabase.js";
import { writeWgslValue } from "../../.test-dist/core/WgslBufferIO.js";
import { BinaryReader } from "../../.test-dist/loaders/BinaryReader.js";
import { halfToFloat } from "../../.test-dist/loaders/float16.js";
import { GPU_SHADING_MATERIAL_RECORD_STRIDE, GPU_SHADING_MATERIAL_HEADER_STRIDE,
  GPU_SHADING_MATERIAL_HEADER_OFFSETS } from "../../.test-dist/gpu/GpuShadingMaterialAbi.js";
import { GPU_MATERIAL_VISIBILITY_RECORD_STRIDE } from "../../.test-dist/gpu/GpuMaterialVisibilityAbi.js";
export async function surfacePhaseTwoGpuOracle(fixture) {
  const { device, resources, buffer, visibility, depth, work, instance, metadata, page, dummy,
    stage, residency, identity, viewSource, probeBudget, materialSlot, keys } = fixture;
  const lightBytes = new ArrayBuffer(65536);
  const lightWords = new Uint32Array(lightBytes); lightWords.fill(0xffffffff, 0, 8192);
  lightWords[DIRECTIONAL_LIGHT_DESCRIPTOR.page_lookup_address] = 8192;
  lightWords[8192] = 1; lightWords[8193] = 1;
  const writer = new BinaryReader(); writer.position = 0;
  writeWgslValue({ direction: [0, 0, -1], color: [2, 1.5, 1], disk_radius: 0,
    flags: 0, near_clip_distance: 0, shadow_id: 0xffffffff }, writer, DIRECTIONAL_LIGHT_RECORD_TYPE);
  new Uint8Array(lightBytes).set(new Uint8Array(writer.data, 0, DIRECTIONAL_LIGHT_RECORD_TYPE.size),
    (8192 + DIRECTIONAL_LIGHT_DESCRIPTOR.page_header_words) * 4);
  const lights = buffer(lightBytes), lookup = buffer(new Uint32Array(24 * 4));
  const lightData = buffer(new Uint32Array(9)), lightParams = buffer(new Float32Array([1, 1, 1, 0]), GPUBufferUsage.UNIFORM);
  const bank = device.createTexture({ size: [2, 2, 2], format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }); resources.push(bank);
  device.queue.writeTexture({ texture: bank, origin: [0, 0, 1] }, new Uint8Array([
    128, 128, 128, 255, 129, 128, 128, 255, 128, 128, 128, 255, 129, 128, 128, 255
  ]), { bytesPerRow: 8 }, [2, 2, 1]);
  const bankView = bank.createView({ dimension: "2d-array" });
  const budget = { ...probeBudget, lightingPosition: 0.3, lightingView: 0.3, minimumRoughness: 0.8 };
  let surfaceOwner; resources.push({ destroy: () => surfaceOwner?.destroy() });
  async function execute(options = {}) {
    device.pushErrorScope("validation");
    const surface = surfaceOwner ??= new SurfaceMaterialPass(device, budget);
    const graph = new FrameGraph("Surface phase two GPU oracle");
    const importResource = (name, resource) => graph.import_resource(name, { kind: "imported", label: name }, resource);
    const frame = { runtime: { materialResources: { materialCapacity: 65536 },
      materialGeneration: stage.materialGeneration, textureGeneration: stage.textureGeneration,
      materialPublicationRevision: stage.publicationRevision }, assets: { sparseShading: viewSource.assets },
      view: { camera: { camera: { transform: { matrix: Object.assign(identity.slice(), { 14: 2 }) } },
        view_projection_matrix: options.moving ? Object.assign(identity.slice(), { 12: 0.03 }) : identity },
        gpu_previous_camera_state: { view_projection_matrix: identity } }, frameIndex: 1,
      outputWidth: options.width ?? 8, outputHeight: options.height ?? 8, preExposure: { multiplier: 1 } };
    const output = surface.addToGraph(graph, { width: options.width ?? 8, height: options.height ?? 8,
      frame, activeSets: [0], textureBankMask: 1, hasLit: true, virtualGeometry: true,
      preExposureBuffer: importResource("pre-exposure", buffer(new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]), GPUBufferUsage.UNIFORM)),
      visibilityKey: importResource("keys", options.visibility ?? visibility), depth: importResource("depth", options.depth ?? depth),
      meshletWork: importResource("meshlet work", work), instances: importResource("instances", instance),
      materialRecords: importResource("materials", stage.bindings.materialRecords),
      geometryMetadata: importResource("geometry", dummy), vertexPayload: importResource("vertices", dummy),
      virtualMetadata: importResource("Product metadata", metadata), virtualBanks: [importResource("Product page", page)],
      textureRoutes: importResource("routes", stage.bindings.textureRouteRecords),
      textureResidencyVersions: importResource("residency", residency), textureBanks: [[importResource("bank", bankView)]],
      lightRecords: importResource("lights", lights), lightLookup: importResource("clusters", lookup),
      lightData: importResource("light data", lightData), lightParams: importResource("light parameters", lightParams) });
    const width = options.width ?? 8, height = options.height ?? 8;
    const capacity = surfaceSampleCapacity(width, height, device.limits);
    const readback = device.createBuffer({ size: height * 256 + 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const sink = graph.add("Surface GPU readback sink", {}, (_data, graphResources, context) => {
      context.encoder.gpu_encoder.copyTextureToBuffer({ texture: graphResources.get(output.radiance) },
        { buffer: readback, bytesPerRow: 256 }, [width, height]);
      context.encoder.gpu_encoder.copyBufferToBuffer(graphResources.get(output.work), 0, readback, height * 256, 256);
    }); sink.read(output.radiance); sink.read(output.work); sink.make_side_effect();
    const encoder = device.createCommandEncoder();
    const temporary = [];
    let passOpen = false;
    const trackPass = pass => {
      assert.equal(passOpen, false, "GPU passes must not overlap");
      passOpen = true;
      const end = pass.end.bind(pass);
      pass.end = () => { end(); passOpen = false; };
      return pass;
    };
    const upload = (bytes, usage) => {
      assert.equal(passOpen, false, "Surface uploads must be prepared before opening a GPU pass");
      const resource = device.createBuffer({ size: Math.max(16, bytes.byteLength), mappedAtCreation: true,
        usage: usage | GPUBufferUsage.COPY_SRC });
      const mapped = resource.getMappedRange(); new Uint8Array(mapped).set(new Uint8Array(bytes));
      if (options.full && bytes.byteLength === 32) new Float32Array(mapped).fill(0);
      resource.unmap(); temporary.push(resource); return resource;
    };
    const command = { device, gpu_encoder: encoder,
      beginRenderPass(descriptor) { return trackPass(encoder.beginRenderPass(descriptor)); },
      beginComputePass(descriptor) {
        if (descriptor.label === "Surface/tile Work Builder" && options.rates) {
          const bytes = new Uint32Array(256);
          options.rates.forEach((rate, index) => { bytes[Math.floor(index / 4) * 64 + index % 4] = rate; });
          encoder.copyBufferToTexture({ buffer: upload(bytes.buffer, GPUBufferUsage.COPY_SRC), bytesPerRow: 256 },
            { texture: graph.getResourceEntry(output.probeCandidates).resource }, [4, 4]);
        }
        return trackPass(encoder.beginComputePass(descriptor));
      },
      clearBuffer(target) { encoder.clearBuffer(target); },
      allocateTransientBufferAndLoad(bytes, usage) { return upload(bytes, usage); },
      writeBuffer(target, offset, bytes, begin, size) {
        const copy = bytes.slice(begin, begin + size);
        if (size === 256 && target.size === capacity.workBytes) {
          const words = new Uint32Array(copy);
          if (options.recordOverflow) words[4] = 0;
          if (options.resultOverflow) words[5] = 0;
          if (options.twoDimensional) words[6] = 1;
        }
        encoder.copyBufferToBuffer(upload(copy, GPUBufferUsage.COPY_SRC), 0, target, offset, size);
      } };
    const manager = new FrameGraphResourceManager(device);
    manager.release = () => {};
    try {
      const compiled = graph.compile();
      const names = compiled.dump().passes.filter(pass => !pass.culled).map(pass => pass.name);
      assert.ok(names.indexOf("Surface/tile Work Builder") < names.indexOf("Surface/finalize sample indirect"));
      assert.ok(names.indexOf("Surface/finalize sample indirect") < names.indexOf("Surface/material and lighting samples"));
      assert.ok(names.indexOf("Surface/material and lighting samples") < names.indexOf("Surface/coarse sample Resolve"));
      console.log("Surface GPU executing", JSON.stringify(options));
      compiled.execute(new FrameGraphContext({ device, encoder: command, resource_manager: manager }));
      device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
      const bytes = readback.getMappedRange();
      const hdr = Array.from({ length: width * height * 4 }, (_, index) =>
        new Uint16Array(bytes)[Math.floor(index / (width * 4)) * 128 + index % (width * 4)]);
      const counts = Array.from(new Uint32Array(bytes, height * 256, 64));
      readback.unmap();
      const error = await device.popErrorScope(); assert.equal(error, null, error?.message);
      console.log("Surface GPU counts", counts.slice(16, 28));
      return { hdr, counts };
    } finally { readback.destroy(); for (const resource of temporary) resource.destroy(); manager.destroy(); }
  }
  const full = await execute({ full: true });
  const coarse = await execute();
  assert.equal(full.counts[SURFACE_SAMPLE_COUNTER.material], 64);
  assert.equal(full.counts[SURFACE_SAMPLE_COUNTER.lighting], 64);
  assert.equal(coarse.counts[SURFACE_SAMPLE_COUNTER.material], 16);
  assert.equal(coarse.counts[SURFACE_SAMPLE_COUNTER.lighting], 16);
  assert.equal(coarse.counts[SURFACE_SAMPLE_COUNTER.records], 0);
  assert.equal(coarse.counts[SURFACE_SAMPLE_COUNTER.implicit], 1);
  assert.ok(coarse.hdr.some((value, index) => index % 4 !== 3 && value > 0x3000));
  const error = Math.max(...coarse.hdr.map((value, index) => Math.abs(halfToFloat(value) - halfToFloat(full.hdr[index]))));
  assert.ok(error < 0.04, "coarse PBR radiance error " + error);
  for (const rate of [1, 2]) {
    const directional = await execute({ rates: Array(16).fill(rate) });
    assert.equal(directional.counts[SURFACE_SAMPLE_COUNTER.material], 32);
    assert.equal(directional.counts[SURFACE_SAMPLE_COUNTER.records], 0);
  }
  const mixedRates = [0, 1, 2, 3, ...Array(12).fill(3)];
  const mixed = await execute({ rates: mixedRates, twoDimensional: true });
  assert.equal(mixed.counts[SURFACE_SAMPLE_COUNTER.mixed], 1);
  assert.equal(mixed.counts[SURFACE_SAMPLE_COUNTER.material], 21);
  assert.equal(mixed.counts[SURFACE_SAMPLE_COUNTER.coarse], 17);
  assert.equal(mixed.counts[SURFACE_SAMPLE_COUNTER.full], 4);
  assert.ok(Math.max(...mixed.hdr.map((value, index) => Math.abs(halfToFloat(value) - halfToFloat(full.hdr[index])))) < 0.04);
  const recordFailure = await execute({ rates: mixedRates, recordOverflow: true });
  assert.equal(recordFailure.counts[SURFACE_SAMPLE_COUNTER.recordOverflow], 1);
  assert.deepEqual(recordFailure.hdr, full.hdr);
  const bothFailure = await execute({ rates: mixedRates, recordOverflow: true, resultOverflow: true });
  assert.equal(bothFailure.counts[SURFACE_SAMPLE_COUNTER.resultOverflow], 1);
  assert.deepEqual(bothFailure.hdr, full.hdr);
  const partialFailure = await execute({ rates: mixedRates, resultOverflow: true });
  assert.ok(partialFailure.counts[SURFACE_SAMPLE_COUNTER.records] > 0);
  assert.deepEqual(partialFailure.hdr, full.hdr);
  const overflow = await execute({ resultOverflow: true });
  assert.equal(overflow.counts[SURFACE_SAMPLE_COUNTER.fallback], 1);
  assert.equal(overflow.counts[SURFACE_SAMPLE_COUNTER.resultOverflow], 1);
  assert.equal(overflow.counts[SURFACE_SAMPLE_COUNTER.material], 64);
  assert.deepEqual(overflow.hdr, full.hdr);
  device.queue.writeBuffer(lightData, 16, new Uint32Array([1]));
  const punctualRisk = await execute();
  assert.equal(punctualRisk.counts[SURFACE_SAMPLE_COUNTER.lighting], 64);
  assert.equal(punctualRisk.counts[SURFACE_SAMPLE_COUNTER.lightingRejected], 16);
  assert.deepEqual(punctualRisk.hdr, full.hdr);
  device.queue.writeBuffer(lightData, 16, new Uint32Array([0]));
  device.queue.writeBuffer(residency, 4, new Uint32Array([2]));
  const stale = await execute(); assert.equal(stale.counts[SURFACE_SAMPLE_COUNTER.material], 64);
  assert.deepEqual(stale.hdr, full.hdr);
  device.queue.writeBuffer(residency, 4, new Uint32Array([1]));
  const moving = await execute({ moving: true }); assert.equal(moving.counts[SURFACE_SAMPLE_COUNTER.lighting], 16);
  const tail = await execute({ width: 7, height: 5, recordOverflow: true });
  assert.equal(tail.counts[SURFACE_SAMPLE_COUNTER.fallback], 1);
  assert.equal(tail.counts[SURFACE_SAMPLE_COUNTER.material], 35);
  assert.equal(tail.counts[SURFACE_SAMPLE_COUNTER.recordOverflow], 1);
  const tallKeys = new Uint32Array(128);
  for (let row = 0; row < 16; row++) for (let column = 0; column < 8; column++)
    tallKeys[row * 8 + column] = column * 2 <= row ? 0 : 1 << 24;
  const tallVisibility = device.createTexture({ size: [8, 16], format: "r32uint",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  const tallDepth = device.createTexture({ size: [8, 16], format: "depth32float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
  resources.push(tallVisibility, tallDepth);
  device.queue.writeTexture({ texture: tallVisibility }, tallKeys, { bytesPerRow: 32 }, [8, 16]);
  const setup = device.createCommandEncoder(); const clear = setup.beginRenderPass({ colorAttachments: [],
    depthStencilAttachment: { view: tallDepth.createView(), depthClearValue: 0.5, depthLoadOp: "clear", depthStoreOp: "store" } });
  clear.end(); device.queue.submit([setup.finish()]);
  const twoDimensional = await execute({ width: 8, height: 16, visibility: tallVisibility, depth: tallDepth, twoDimensional: true });
  assert.equal(twoDimensional.counts[SURFACE_SAMPLE_COUNTER.implicit], 2);
  assert.equal(twoDimensional.counts[SURFACE_SAMPLE_COUNTER.material], 32);
  assert.equal(twoDimensional.counts[SURFACE_SAMPLE_COUNTER.lighting], 32);
  assert.ok(twoDimensional.hdr.every(value => value > 0));
  const recordOffset = materialSlot * GPU_SHADING_MATERIAL_RECORD_STRIDE;
  const coatOffset = recordOffset + GPU_SHADING_MATERIAL_HEADER_STRIDE + GPU_MATERIAL_VISIBILITY_RECORD_STRIDE + 8;
  device.queue.writeBuffer(stage.bindings.materialRecords, recordOffset + GPU_SHADING_MATERIAL_HEADER_OFFSETS.family, new Uint32Array([2]));
  device.queue.writeBuffer(stage.bindings.materialRecords, coatOffset, new Float32Array([1, 0.4]));
  const coated = await execute();
  assert.equal(coated.counts[SURFACE_SAMPLE_COUNTER.material], 64);
  assert.equal(coated.counts[SURFACE_SAMPLE_COUNTER.lighting], 64);
  assert.notDeepEqual(coated.hdr, full.hdr);
  device.queue.writeBuffer(stage.bindings.materialRecords, recordOffset + GPU_SHADING_MATERIAL_HEADER_OFFSETS.family, new Uint32Array([1]));
  device.queue.writeBuffer(stage.bindings.materialRecords, coatOffset, new Float32Array([0, 0]));
  device.queue.writeTexture({ texture: visibility }, new Uint32Array(64).fill(0xffffffff), { bytesPerRow: 32 }, [8, 8]);
  const background = await execute();
  assert.equal(background.counts[SURFACE_SAMPLE_COUNTER.material], 0);
  assert.ok(Math.abs(halfToFloat(background.hdr[0]) - 0.025) < 0.0001);
  device.queue.writeTexture({ texture: visibility }, new Uint32Array(64).fill(500), { bytesPerRow: 32 }, [8, 8]);
  const invalid = await execute();
  assert.equal(invalid.counts[SURFACE_SAMPLE_COUNTER.material], 0);
  assert.equal(invalid.counts[SURFACE_SAMPLE_COUNTER.full], 64);
  assert.ok(halfToFloat(invalid.hdr[0]) > 0.6);
  device.queue.writeTexture({ texture: visibility }, keys, { bytesPerRow: 32 }, [8, 8]);
  return { execute, full, coarse };
}

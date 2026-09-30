import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import "../webgpu-test-globals.mjs";
import { cookSurfacePlane } from "../fixtures/surface-phase-one.mjs";

const gpuModule = process.env.OENGINE_TEST_WEBGPU_MODULE;
test("production SurfaceProbe consumes cooked textured Standard PBR and fails full on stale residency", {
  skip: !gpuModule && "Set OENGINE_TEST_WEBGPU_MODULE to a Dawn node-webgpu module for actual GPU execution"
}, async () => {
  const { create, globals } = await import(pathToFileURL(gpuModule).href);
  Object.assign(globalThis, globals);
  const gpu = create(["backend=d3d12", "enable-dawn-features=allow_unsafe_apis"]);
  const adapter = await gpu.requestAdapter(); assert.ok(adapter);
  assert.ok(adapter.features.has("texture-formats-tier1"));
  const device = await adapter.requestDevice({ requiredFeatures: ["texture-formats-tier1"], requiredLimits: { maxStorageBuffersPerShaderStage: 16,
    maxStorageTexturesPerShaderStage: 3, maxBindingsPerBindGroup: 16 } });
  const resources = [];
  try {
    const { surfaceProbeWgsl } = await import("../../.test-dist/shaders/surface_probe.js");
    const abi = await import("../../.test-dist/gpu/GeometryProductGpuAbiV1.js");
    const { packGpuInstanceRecord } = await import("../../.test-dist/gpu/GpuInstanceAbi.js");
    const { packGpuSparseShadingView } = await import("../../.test-dist/gpu/GpuSparseShadingFrameAbi.js");
    const { GpuMaterialStore } = await import("../../.test-dist/gpu/GpuMaterialStore.js");
    const { StandardShadeMaterial } = await import("../../.test-dist/material/StandardShadeMaterial.js");
    const { ShadeTexture, ShadeImage } = await import("../../.test-dist/texture/ShadeTexture.js");
    const { decodedTextureVariation } = await import("../../.test-dist/gpu/TextureVariation.js");
    const { packSurfaceProbeBudget, surfaceProbeCellReference } = await import("../../.test-dist/render/surface/SurfaceProbe.js");
    const { TEMPORAL_FACTS_WGSL } = await import("../../.test-dist/shaders/temporal_facts.js");
    const { PACKED_CAMERA_TYPE } = await import("../../.test-dist/shaders/packed_camera.js");
    const cooked = await cookSurfacePlane();
    const buffer = (bytes, usage = GPUBufferUsage.STORAGE) => {
      const result = device.createBuffer({ size: Math.max(16, (bytes.byteLength + 3) & ~3),
        usage: usage | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(result, 0, bytes); resources.push(result); return result;
    };
    const texture = (format, width = 8, height = 8, usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST) => {
      const result = device.createTexture({ size: [width, height], format, usage }); resources.push(result); return result;
    };
    const offsets = { productCount: 1, productCapacity: 1, totalWords: 120, productTableWordOffset: 16,
      assetReferenceWordOffset: 32, assetRecordWordOffset: 36, rootNodeIdWordOffset: 68,
      hierarchyWordOffset: 72, groupDirectoryWordOffset: 108, pageLocationWordOffset: 112, vertexFormatWordOffset: 116 };
    const heap = new Uint8Array(120 * 4);
    heap.set(abi.packGeometryProductMetadataHeapHeaderV1(offsets));
    heap.set(abi.packGeometryProductTableRecordV1({ productGeneration: 1, flags: 1,
      assetBegin: 0, assetCount: 1, rootBegin: 0, rootCount: 1, hierarchyBegin: 0, hierarchyCount: 3,
      groupBegin: 0, groupCount: 1, pageBegin: 0, pageCount: 1, vertexFormatBegin: 0, vertexFormatCount: 1 }), 64);
    heap.set(abi.packGeometryProductAssetReferenceV1({ productTableSlot: 0, productGeneration: 1, assetRecordIndex: 0, flags: 0 }), 128);
    heap.set(cooked.sections.assetRecords, 144); heap.set(new Uint8Array(cooked.sections.rootNodeIds.buffer), 272);
    heap.set(cooked.sections.hierarchyNodes, 288); heap.set(cooked.sections.groupDirectory, 432);
    heap.set(abi.encodeGeometryProductGpuLocationV1({ bankIndex: 0, slotIndex: 0, productGeneration: 1, flags: 1 }), 448);
    heap.set(cooked.sections.vertexFormats, 464);
    const metadata = buffer(heap), page = buffer(cooked.page);
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const instanceSource = { geometryRecordIndex: 0, geometryGeneration: 1, materialHandle: 0,
      instanceSetGeneration: 1, flags: 129, debugId: 1, boundsSphere: [0, 0, 0.5, 2], boundsMin: [-1, -1, 0.5],
      boundsMax: [1, 1, 0.5], currentObjectToWorld: identity, previousObjectToWorld: identity };
    const instance = buffer(packGpuInstanceRecord(instanceSource));
    const material = new StandardShadeMaterial();
    material.texture_albedo = ShadeTexture.from(ShadeImage.fromArrayBuffer(new Uint8Array([
      128, 128, 128, 255, 129, 128, 128, 255, 128, 128, 128, 255, 129, 128, 128, 255
    ]), 4, "uint8", 2, 2)); material.texture_albedo.image.color_space = 2;
    const store = new GpuMaterialStore(device); resources.push({ destroy: () => store.destroy() });
    const command = { device, onFinished: { addOne(callback) { callback(); } },
      onAborted: { addOne() {} }, gpuDone: Promise.resolve(),
      writeBuffer(target, offset, data, begin, size) { device.queue.writeBuffer(target, offset, data, begin, size); } };
    const stage = store.stage([{ material, programId: 15, textureBindingSetId: 0 }],
      new Map([[material, new Map([[material.texture_albedo, 0x10000001]])]]), command,
      new Map([[material.texture_albedo, [0, 0]]]), new Map([[material.texture_albedo, {
        slot: 1, revision: 1, variation: decodedTextureVariation(material.texture_albedo)
      }]]));
    const materialSlot = stage.associationSlots[0];
    const work = buffer(new Uint32Array([1, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, materialSlot, 15 << 8, 3]));
    const viewSource = { width: 8, height: 8, materialCount: 65536,
      materialGeneration: stage.materialGeneration, textureGeneration: stage.textureGeneration,
      publicationRevision: stage.publicationRevision, frameIndex: 1, preExposure: 1, upscaleRatio: [1, 1],
      cameraPosition: [0, 0, 2], currentViewProjection: identity, previousViewProjection: identity,
      assets: { schemaVersion: 1, epoch: 1, geometryCount: 1, geometryWordBase: 0, meshletWordBase: 0, geometryGenerationWordBase: 0,
        meshletVertexWordBase: 0, meshletTriangleWordBase: 0, vertexDataWordBase: 0 } };
    const view = buffer(packGpuSparseShadingView(viewSource), GPUBufferUsage.UNIFORM);
    const dummy = buffer(new Uint32Array(64)), residency = buffer(new Uint32Array([0, 1]));
    const probeBudget = { color: 0.02, parameter: 0, normal: 0.00001, depth: 0, uv: 0.25 };
    const budget = buffer(packSurfaceProbeBudget(probeBudget), GPUBufferUsage.UNIFORM);
    const visibility = texture("r32uint");
    const keys = new Uint32Array(64);
    for (let row = 0; row < 8; row++) for (let column = 0; column < 8; column++) keys[row * 8 + column] = column <= row ? 0 : 1 << 24;
    device.queue.writeTexture({ texture: visibility }, keys, { bytesPerRow: 32 }, [8, 8]);
    const depth = texture("depth32float", 8, 8, GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT);
    const encoder = device.createCommandEncoder(); const clear = encoder.beginRenderPass({ colorAttachments: [],
      depthStencilAttachment: { view: depth.createView(), depthClearValue: 0.5, depthLoadOp: "clear", depthStoreOp: "store" } });
    clear.end(); device.queue.submit([encoder.finish()]);
    const output = texture("r32uint", 4, 4, GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC);
    const counters = buffer(new Uint32Array(16), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    device.pushErrorScope("validation");
    const module = device.createShaderModule({ code: surfaceProbeWgsl(true, 1) });
    assert.deepEqual((await module.getCompilationInfo()).messages.filter(message => message.type === "error"), []);
    const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "probe" } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: visibility.createView() }, { binding: 1, resource: depth.createView() },
      ...[work, stage.bindings.materialRecords, instance, view, dummy, dummy, stage.bindings.textureRouteRecords,
        residency, budget].map((resource, index) => ({ binding: index + 2, resource: { buffer: resource } })),
      { binding: 11, resource: output.createView() }, { binding: 12, resource: { buffer: counters } }
    ] });
    const geometryGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: [
      { binding: 0, resource: { buffer: metadata } }, { binding: 1, resource: { buffer: page } }
    ] });
    const execute = async (width = 4, height = 4) => {
      const readback = device.createBuffer({ size: 1088, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const encoder = device.createCommandEncoder(); encoder.clearBuffer(counters);
      const pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.setBindGroup(1, geometryGroup);
      pass.dispatchWorkgroups(1); pass.end();
      encoder.copyTextureToBuffer({ texture: output }, { buffer: readback, bytesPerRow: 256 }, [width, height]);
      encoder.copyBufferToBuffer(counters, 0, readback, 1024, 64);
      device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
      const values = new Uint32Array(readback.getMappedRange());
      const rates = Array.from({ length: width * height }, (_, index) => values[Math.floor(index / width) * 64 + index % width]);
      const counts = Array.from(values.slice(256));
      readback.unmap(); readback.destroy(); return { rates, counts };
    };
    const baseline = await execute();
    const variation = decodedTextureVariation(material.texture_albedo);
    const colorRange = Math.max(...variation.high.map((value, index) => value - variation.low[index]));
    const cpuRates = Array.from({ length: 16 }, (_, cell) => {
      const origin = [(cell % 4) * 2, Math.floor(cell / 4) * 2];
      return surfaceProbeCellReference(Array.from({ length: 4 }, (_, corner) => {
        const pixel = [origin[0] + corner % 2, origin[1] + Math.floor(corner / 2)];
        return { valid: true, instance: 0, material: materialSlot, geometry: 0, representation: 3, domain: 1,
          primitive: keys[pixel[1] * 8 + pixel[0]] >>> 24, depth: 0.5, normal: [0, 0, 1], color: [1, 1, 1],
          uv: [(pixel[0] + 0.5) / 8, 1 - (pixel[1] + 0.5) / 8], risk: 0, variation: colorRange,
          parameterVariation: 0, residencyValid: true };
      }), probeBudget);
    });
    assert.deepEqual(cpuRates, Array(16).fill(3)); assert.deepEqual(baseline.rates, cpuRates);
    assert.equal(baseline.counts[0], 16); assert.equal(baseline.counts[1], 64);
    assert.equal(baseline.counts[5], 16); assert.ok(baseline.counts[14] > 0);
    assert.equal(baseline.counts[15], 64);
    device.queue.writeBuffer(residency, 4, new Uint32Array([2]));
    const stale = await execute();
    assert.deepEqual(stale.rates, Array(16).fill(0)); assert.equal(stale.counts[10], 64);
    device.queue.writeBuffer(residency, 4, new Uint32Array([1]));
    const { GPU_SHADING_TEXTURE_ROUTE_STRIDE, GPU_SHADING_TEXTURE_ROUTES_PER_MATERIAL,
      GPU_SHADING_MATERIAL_RECORD_STRIDE } = await import("../../.test-dist/gpu/GpuShadingMaterialAbi.js");
    const routeOffset = materialSlot * GPU_SHADING_TEXTURE_ROUTES_PER_MATERIAL * GPU_SHADING_TEXTURE_ROUTE_STRIDE;
    for (const high of [[1, 1, 1, 1], [NaN, 1, 1, 1]]) {
      device.queue.writeBuffer(stage.bindings.textureRouteRecords, routeOffset + 48, new Float32Array(high));
      const rejected = await execute();
      assert.deepEqual(rejected.rates, Array(16).fill(0)); assert.equal(rejected.counts[11], 64);
    }
    device.queue.writeBuffer(stage.bindings.textureRouteRecords, routeOffset + 48,
      new Float32Array(decodedTextureVariation(material.texture_albedo).high));
    device.queue.writeBuffer(stage.bindings.materialRecords, materialSlot * GPU_SHADING_MATERIAL_RECORD_STRIDE + 24,
      new Uint32Array([2]));
    assert.deepEqual((await execute()).rates, Array(16).fill(0));
    device.queue.writeBuffer(stage.bindings.materialRecords, materialSlot * GPU_SHADING_MATERIAL_RECORD_STRIDE + 24,
      new Uint32Array([1]));
    device.queue.writeTexture({ texture: visibility }, new Uint32Array(64).fill(0xffffffff), { bytesPerRow: 32 }, [8, 8]);
    assert.deepEqual((await execute()).rates, Array(16).fill(0));
    device.queue.writeBuffer(view, 0, packGpuSparseShadingView({ ...viewSource, width: 7, height: 5 }));
    const oddKeys = new Uint32Array(64).fill(0xffffffff);
    for (let row = 0; row < 5; row++) for (let column = 0; column < 7; column++)
      oddKeys[row * 8 + column] = (column + 0.5) / 7 <= (row + 0.5) / 5 ? 0 : 1 << 24;
    device.queue.writeTexture({ texture: visibility }, oddKeys, { bytesPerRow: 32 }, [8, 8]);
    const odd = await execute(4, 3);
    assert.deepEqual(odd.rates, [3, 3, 3, 0, 3, 3, 3, 0, 0, 0, 0, 0]);
    assert.equal(odd.counts[0], 12); assert.equal(odd.counts[15], 35);
    device.queue.writeBuffer(view, 0, packGpuSparseShadingView(viewSource));
    device.queue.writeTexture({ texture: visibility }, keys, { bytesPerRow: 32 }, [8, 8]);
    assert.equal(await device.popErrorScope(), null);
    const motionModule = device.createShaderModule({ code: TEMPORAL_FACTS_WGSL });
    assert.deepEqual((await motionModule.getCompilationInfo()).messages.filter(message => message.type === "error"), []);
    const motionPipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module: motionModule, entryPoint: "main" } }).catch(error => { throw new Error(error.message, { cause: error }); });
    const cameraBytes = new ArrayBuffer(PACKED_CAMERA_TYPE.size);
    const cameraFloats = new Float32Array(cameraBytes);
    for (let matrix = 0; matrix < 8; matrix++) cameraFloats.set(identity, matrix * 16);
    const currentCamera = buffer(cameraBytes, GPUBufferUsage.UNIFORM);
    cameraFloats[2 * 16 + 12] = 0.125;
    const previousCamera = buffer(cameraBytes, GPUBufferUsage.UNIFORM);
    const facts = buffer(new Uint32Array([8, 8, 0, 0]), GPUBufferUsage.UNIFORM);
    const previousIdentity = texture("rgba32uint");
    const motion = texture("rg16float", 8, 8, GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC);
    const mask = texture("rgba8unorm", 8, 8, GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC);
    const identityOutput = texture("rgba32uint", 8, 8, GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC);
    const motionGroup = device.createBindGroup({ layout: motionPipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: visibility.createView() }, { binding: 2, resource: depth.createView() },
      { binding: 3, resource: previousIdentity.createView() },
      ...[work, instance, stage.bindings.materialRecords, currentCamera, previousCamera, facts]
        .map((resource, index) => ({ binding: index + 4, resource: { buffer: resource } })),
      { binding: 10, resource: motion.createView() }, { binding: 11, resource: mask.createView() },
      { binding: 12, resource: identityOutput.createView() },
      { binding: 13, resource: { buffer: stage.bindings.textureRouteRecords } },
      { binding: 14, resource: { buffer: residency } }
    ] });
    const executeMotion = async () => {
      const readback = device.createBuffer({ size: 6144, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const encoder = device.createCommandEncoder(); const pass = encoder.beginComputePass();
      pass.setPipeline(motionPipeline); pass.setBindGroup(0, motionGroup); pass.dispatchWorkgroups(1); pass.end();
      for (const [index, texture] of [motion, mask, identityOutput].entries())
        encoder.copyTextureToBuffer({ texture }, { buffer: readback, offset: index * 2048, bytesPerRow: 256 }, [8, 8]);
      device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
      const bytes = readback.getMappedRange();
      const result = { motion: Array.from(new Uint16Array(bytes, 3 * 256 + 3 * 4, 2)),
        mask: Array.from(new Uint8Array(bytes, 2048 + 3 * 256 + 3 * 4, 4)),
        identity: Array.from(new Uint32Array(bytes, 4096 + 3 * 256 + 3 * 16, 4)) };
      readback.unmap(); readback.destroy(); return result;
    };
    const cameraMotion = await executeMotion();
    assert.deepEqual(cameraMotion.motion, [0xac00, 0]);
    assert.equal(cameraMotion.mask[1], 255); assert.equal(cameraMotion.identity[0], 1);
    device.queue.writeBuffer(residency, 4, new Uint32Array([2]));
    const residencyChange = await executeMotion();
    assert.notEqual(residencyChange.identity[2], cameraMotion.identity[2]);
    assert.deepEqual(residencyChange.motion, cameraMotion.motion);
    const previousObject = identity.slice(); previousObject[12] = 0.25;
    device.queue.writeBuffer(instance, 0, packGpuInstanceRecord({ ...instanceSource, previousObjectToWorld: previousObject }));
    assert.deepEqual((await executeMotion()).motion, [0xb200, 0]);
    const { GPU_INSTANCE_RECORD_OFFSETS, GPU_INSTANCE_FLAGS } = await import("../../.test-dist/gpu/GpuInstanceAbi.js");
    device.queue.writeBuffer(instance, GPU_INSTANCE_RECORD_OFFSETS.motion_flags, new Uint32Array([GPU_INSTANCE_FLAGS.MotionInvalid]));
    const invalidMotion = await executeMotion();
    assert.deepEqual(invalidMotion.motion, [0, 0]); assert.equal(invalidMotion.mask[1], 0);
  } finally {
    for (const resource of resources.reverse()) resource.destroy(); device.destroy();
  }
});

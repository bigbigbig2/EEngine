import assert from "node:assert/strict";
import { streamingProductFixture } from "../helpers/geometry-product-fixture.mjs";
import { GeometryProductMultiRuntimeV1 } from "../../.test-dist/gpu/GeometryProductMultiRuntime.js";
import { GeometryProductSlotPool } from "../../.test-dist/gpu/GeometryProductSlotPool.js";
import { selectGeometryProductResidencyProfileV1 } from "../../.test-dist/gpu/GeometryProductResidencyProfile.js";
import { GeometryPageStreamingRuntimeV1 } from "../../.test-dist/gpu/GeometryPageStreamingRuntime.js";
import {
  GEOMETRY_PRODUCT_GPU_WGSL_V1,
  encodeGeometryProductGpuLocationV1
} from "../../.test-dist/gpu/GeometryProductGpuAbiV1.js";
import { HierarchicalWorkGenerator } from "../../.test-dist/render/HierarchicalWorkGenerator.js";
import { VirtualGeometryMeshletWorkCandidate } from "../../.test-dist/render/MeshletWorkCandidate.js";
import { ShadowGeometryWork } from "../../.test-dist/render/ShadowGeometryWork.js";
import { FrameInstanceTransforms } from "../../.test-dist/render/FrameInstanceTransforms.js";
import { PACKED_CAMERA_TYPE } from "../../.test-dist/shaders/packed_camera.js";
import { unpackGeometryPageDemandV1 } from "../../.test-dist/gpu/GeometryPageDemandAbiV1.js";
import {
  GPU_INSTANCE_ABI_VERSION,
  GPU_INSTANCE_FLAGS,
  packGpuInstanceRecord
} from "../../.test-dist/gpu/GpuInstanceAbi.js";
import { GPU_GEOMETRY_ABI_VERSION } from "../../.test-dist/gpu/GpuGeometryAbi.js";
import { GPU_COUNTER_BYTE_SIZE } from "../../.test-dist/debug/GpuFrameCounters.js";
const MiB = 1024 * 1024;
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

async function checkPendingDemandDeviceLoss() {
  const results = [];
  for (const [shadow, queued] of [[false, false], [true, false], [false, true], [true, true]]) {
    const adapter = await navigator.gpu.requestAdapter();
    assert.ok(adapter, "Demand cancellation adapter unavailable");
    const device = await adapter.requestDevice();
    const errors = [];
    device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
    // This isolated check exercises only the real readback/loss owner; no
    // residency uploads are needed to cancel a committed demand copy.
    const streaming = new GeometryPageStreamingRuntimeV1(device, { evidence: () => ({}) }, {
      readback: { slotCount: 2, bytesPerSlot: 64 }
    });
    const source = device.createBuffer({
      label: "Geometry cancellation demand",
      size: 32,
      usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    });
    try {
      const encoder = device.createCommandEncoder();
      const finished = [];
      const command = {
        gpu_encoder: encoder,
        onFinished: { addOne: (callback) => finished.push(callback) },
        onAborted: { addOne() {} }
      };
      if (shadow) streaming.encodeShadowDemandReadback(command, source, 1);
      else streaming.encodeDemandReadback(command, source, 1);
      device.queue.submit([encoder.finish()]);
      finished.forEach((callback) => callback());
      await device.queue.onSubmittedWorkDone();
      const poll = queued
        ? streaming.consumeAfterCompletion(1, Promise.resolve())
        : streaming.consumeCompleted(2);
      if (!queued) await Promise.resolve();
      device.destroy();
      assert.equal((await poll).cancelled, true, "Loss must revoke the pending map");
      await device.lost;
      const evidence = streaming.evidence();
      assert.equal(evidence.lastError, null);
      assert.equal(evidence.readback.inUse, 0);
      if (shadow) assert.equal(evidence.shadowReadback.inUse, 0);
      assert.deepEqual(errors, []);
      results.push({ shadow, queued, cancelled: true, evidence });
    } finally {
      streaming.destroy();
      source.destroy();
      device.destroy();
    }
  }
  return results;
}

export async function runGeometryBudgetedResidencyGpuOracle(device) {
  const pendingDemandDeviceLoss = await checkPendingDemandDeviceLoss();
  const boundaries = [];
  const shader = device.createShaderModule({
    code: `${GEOMETRY_PRODUCT_GPU_WGSL_V1}
    @group(0) @binding(0) var<storage, read> heap: array<u32>;
    @group(0) @binding(1) var<storage, read> bank: array<u32>;
    @group(0) @binding(2) var<storage, read_write> output: array<u32>;
    @compute @workgroup_size(1) fn main() {
      let asset = OEngineGeometryProductResolvedAssetV1(
        true, 0u, 19u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 16u, 1u, 0u, 0u);
      let location = oengine_geometry_product_lookup_page_heap_v1(&heap, asset, 0u);
      output[0] = select(0u, 1u, location.valid);
      output[1] = location.byte_offset;
      output[2] = location.resident_word;
      output[3] = 0u;
      if (location.valid) { output[3] = bank[location.resident_word]; }
    }`
  });
  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module: shader, entryPoint: "main" }
  });
  for (const profile of ["auto", "Portable", "Balanced", "HighEnd"]) {
    const plan = selectGeometryProductResidencyProfileV1(device.limits, { requestedProfile: profile });
    const pool = GeometryProductSlotPool.retainWithProfile(device, plan);
    const locations = device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    const output = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const read = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const heapHeader = new Uint32Array(16);
    heapHeader[12] = plan.slotsPerBank;
    device.queue.writeBuffer(locations, 0, heapHeader);
    try {
      for (const slot of new Set([
        0,
        Math.min(511, plan.slotsPerBank - 1),
        Math.min(512, plan.slotsPerBank - 1),
        Math.min(767, plan.slotsPerBank - 1),
        plan.slotsPerBank - 1
      ])) {
        device.queue.writeBuffer(
          locations,
          64,
          encodeGeometryProductGpuLocationV1({
            bankIndex: 3,
            slotIndex: slot,
            residentBankIndex: 2,
            residentSlotIndex: slot,
            productGeneration: 19,
            flags: 1
          })
        );
        const marker = 0x12340000 + slot;
        device.queue.writeBuffer(pool.banks[2], slot * 262144, new Uint32Array([marker]));
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(
          0,
          device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: locations } },
              { binding: 1, resource: { buffer: pool.banks[2] } },
              { binding: 2, resource: { buffer: output } }
            ]
          })
        );
        pass.dispatchWorkgroups(1);
        pass.end();
        encoder.copyBufferToBuffer(output, 0, read, 0, 16);
        device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const words = new Uint32Array(read.getMappedRange().slice(0));
        read.unmap();
        assert.deepEqual([...words], [1, slot * 262144, slot * 65536, marker]);
        boundaries.push({ profile: plan.profile, capacityBytes: plan.capacityBytes, slot, marker: words[3] });
      }
    } finally {
      await device.queue.onSubmittedWorkDone();
      pool.releaseOwner();
      locations.destroy();
      output.destroy();
      read.destroy();
    }
  }

  // Eight physical slots; two pinned coarse pages use four. Six fine pages
  // require twelve more slots, so the real residency must evict and retry.
  const runtime = new GeometryProductMultiRuntimeV1(device, {
    metadataBytes: 64 * 1024,
    residency: { configuredCapacityBytes: 2 * MiB }
  });
  const hierarchy = new HierarchicalWorkGenerator(device);
  const candidate = new VirtualGeometryMeshletWorkCandidate(device);
  const frameInstances = new FrameInstanceTransforms(device);
  await frameInstances.ready;
  const shadowOwner = new ShadowGeometryWork({ device, frame_instances: frameInstances });
  const buffers = [];
  const buffer = (
    size,
    usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
  ) => {
    const result = device.createBuffer({ size, usage });
    buffers.push(result);
    return result;
  };
  let streaming;
  const frames = [];
  try {
    const fixtures = [await streamingProductFixture(), await streamingProductFixture()];
    const handles = [];
    for (const fixture of fixtures) handles.push(await runtime.load(fixture.source));
    streaming = new GeometryPageStreamingRuntimeV1(device, handles[0].residency, {
      schedulerOptions: {
        maxConcurrentReads: 2,
        maxInFlightBytes: 2 * 262144,
        maxUploadBytesPerFrame: MiB,
        adaptive: false
      }
    });
    for (const [index, handle] of handles.entries())
      streaming.registerProduct(fixtures[index].source, handle.residency);
    const records = handles.map((handle, index) =>
      packGpuInstanceRecord({
        geometryRecordIndex: handle.assetReferenceBegin,
        geometryGeneration: handle.productGeneration,
        materialHandle: 0,
        flags:
          GPU_INSTANCE_FLAGS.Active | GPU_INSTANCE_FLAGS.VirtualGeometry | GPU_INSTANCE_FLAGS.CastsShadow,
        debugId: index,
        boundsSphere: [0, 0, 0, 1],
        boundsMin: [-1, -1, -1],
        boundsMax: [1, 1, 1],
        currentObjectToWorld: identity,
        previousObjectToWorld: identity
      })
    );
    const instances = buffer(2 * 176);
    records.forEach((record, index) => device.queue.writeBuffer(instances, index * 176, record));
    const scene = { abiVersion: GPU_INSTANCE_ABI_VERSION, instances, highWaterCount: 2 };
    const placeholder = buffer(256),
      counters = buffer(GPU_COUNTER_BYTE_SIZE);
    const h = hierarchy.prepare(
      {
        assets: {
          abiVersion: GPU_GEOMETRY_ABI_VERSION,
          geometryRecords: placeholder,
          clusterRecords: placeholder,
          clusterChildren: placeholder
        },
        scene,
        instanceBegin: 0,
        instanceCount: 2,
        maxHierarchyDepth: 0,
        traversalWorkCapacity: 8,
        visibleClusterCapacity: 8,
        rasterWorkCapacity: 8,
        counterBuffer: counters,
        virtualGeometry: runtime.bindings()
      },
      { sseThreshold: 1, countersEnabled: true, diagnosticsEnabled: true, rasterExpansionEnabled: false }
    );
    const work = candidate.prepare({
      virtualGeometry: runtime.bindings(),
      visibleClusters: h.generated.visibleClusters,
      viewUniform: h.generated.viewUniform,
      visibleClusterCapacity: 8,
      capacity: 8,
      counterBuffer: counters,
      countersEnabled: true,
      scene
    });
    const read = buffer(work.queue.size, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const view = {
      kind: "perspective",
      cameraPosition: [0, 0, 4],
      viewportHeight: 720,
      verticalFovRadians: Math.PI / 3,
      nearPlane: 0.1,
      frustumPlanes: Array.from({ length: 6 }, () => [0, 0, 0, 1])
    };
    const camera = buffer(PACKED_CAMERA_TYPE.size, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const shadowJob = {
      assets: {
        abiVersion: GPU_GEOMETRY_ABI_VERSION,
        geometryRecords: placeholder,
        clusterRecords: placeholder,
        clusterChildren: placeholder
      },
      scene,
      runtime: {
        instanceBegin: 0,
        instanceCount: 2,
        hierarchyMaxDepth: 0,
        hierarchyTraversalCapacity: 8,
        hierarchyVisibleClusterCapacity: 8,
        hierarchyRasterWorkCapacity: 8,
        counterSink: counters
      },
      virtualGeometry: runtime.bindings(),
      streamingRuntime: streaming,
      shadowFrame: { generation: 1, lightView: identity, clipOriginExtent: [[-2, -2, 4, 1]] }
    };
    const shadowPrepared = shadowOwner.prepare(
      shadowJob,
      {
        key: { traversalCapacity: 8, meshletWorkCandidateCapacity: 8 }
      },
      camera,
      {
        destroyAfterGpuDone() {
          throw new Error("No prior shadow allocation may retire");
        }
      }
    );
    const shadowRead = buffer(
      shadowPrepared.work.queue.size,
      GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    );
    const demandRead = buffer(
      shadowPrepared.hierarchy.generated.pageDemand.size,
      GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    );
    let shadowDemandRecords = 0;
    let aborted = false;
    try {
      for (let frame = 0; frame < 24; frame++) {
        const encoder = device.createCommandEncoder();
        const callbacks = [],
          aborts = [];
        const command = {
          gpu_encoder: encoder,
          onFinished: {
            addOne(callback) {
              callbacks.push(callback);
            }
          },
          onAborted: {
            addOne(callback) {
              aborts.push(callback);
            }
          }
        };
        hierarchy.encode(encoder, h, view, { coneEnabled: false, demandFrameRevisionLow: frame });
        candidate.encode(command, work);
        streaming.encodeDemandReadback(command, h.generated.pageDemand, frame);
        shadowOwner.encode(
          { ...shadowJob, demandFrameIndex: frame, demandFrameRevisionLow: frame },
          shadowPrepared,
          command
        );
        encoder.copyBufferToBuffer(work.queue, 0, read, 0, work.queue.size);
        encoder.copyBufferToBuffer(shadowPrepared.work.queue, 0, shadowRead, 0, shadowRead.size);
        encoder.copyBufferToBuffer(
          shadowPrepared.hierarchy.generated.pageDemand,
          0,
          demandRead,
          0,
          demandRead.size
        );
        if (frame === 0 && !aborted) {
          encoder.finish();
          aborts.forEach((callback) => callback());
          assert.equal(streaming.evidence().readback.inUse, 0);
          assert.equal(
            streaming.evidence().shadowReadback.inUse,
            0,
            "Abort must cancel independent shadow demand"
          );
          aborted = true;
          frame--;
          continue; // Retry the exact same frame with a new command.
        }
        device.queue.submit([encoder.finish()]);
        callbacks.forEach((callback) => callback());
        await read.mapAsync(GPUMapMode.READ);
        const words = new Uint32Array(read.getMappedRange().slice(0));
        read.unmap();
        await Promise.all([shadowRead.mapAsync(GPUMapMode.READ), demandRead.mapAsync(GPUMapMode.READ)]);
        const shadowWords = new Uint32Array(shadowRead.getMappedRange().slice(0));
        const demandBytes = demandRead.getMappedRange().slice(0),
          demandWords = new Uint32Array(demandBytes);
        shadowRead.unmap();
        demandRead.unmap();
        assert.equal(shadowWords[4] + shadowWords[6], 0, "Shadow work must retain complete resident cut");
        const shadowCounts = [0, 0];
        for (let index = 0; index < shadowWords[1]; index++) shadowCounts[shadowWords[8 + index * 6]]++;
        assert.ok(
          shadowCounts.every((count) => count >= 1),
          "Shadow missing pages cannot erase coarse coverage"
        );
        assert.equal(demandWords[2], 0, "Shadow demand cannot overflow this fixture");
        for (let index = 0; index < Math.min(demandWords[0], demandWords[1]); index++) {
          const demand = unpackGeometryPageDemandV1(new Uint8Array(demandBytes, 16 + index * 16, 16));
          assert.equal(demand.shadow, true, "Independent shadow producer must tag feedback");
          assert.equal(demand.priority, 65535);
          shadowDemandRecords++;
        }
        assert.equal(words[4] + words[6], 0, "pressure produced invalid/overflow work");
        const counts = [0, 0];
        for (let index = 0; index < words[1]; index++) counts[words[8 + index * 6]]++;
        assert.ok(
          counts.every((count) => count >= 1),
          "coarse coverage lost an accepted instance"
        );
        if (frame === 0) {
          const sameFrame = await streaming.consumeCompleted(frame, performance.now());
          assert.equal(sameFrame.consumedReadbacks, 0, "Neither view may consume same-frame feedback");
        }
        await streaming.consumeAfterCompletion(frame, device.queue.onSubmittedWorkDone(), performance.now());
        await streaming.scheduler.drainReads();
        const evidence = streaming.evidence();
        assert.ok(evidence.scheduler.verifiedBytes + evidence.scheduler.inFlightBytes <= 2 * 262144);
        assert.ok(evidence.products.every((product) => product.pinnedPages === 1));
        frames.push({
          frame,
          counts,
          shadowCounts,
          uploads: evidence.scheduler.uploadedBytes,
          verifiedBytes: evidence.scheduler.verifiedBytes,
          pending: evidence.scheduler.pending,
          residents: evidence.products.map((product) => product.residentPages)
        });
      }
    } finally {
      candidate.release(work);
      hierarchy.release(h);
    }
    const evidence = streaming.evidence();
    assert.ok(
      evidence.products.every((product) => product.evictedPages > 0),
      "one Product starved pressure eviction"
    );
    assert.ok(
      evidence.products.every(
        (product) => product.residentPages > product.pinnedPages || product.evictedPages > 0
      )
    );
    assert.ok(
      evidence.scheduler.uploadedBytes > 2 * MiB,
      "pressure uploads failed to progress beyond capacity"
    );
    assert.equal(evidence.scheduler.failed, 0);
    assert.equal(evidence.lastError, null);
    assert.ok(shadowDemandRecords > 0, "Real missing shadow pages must produce delayed feedback");
    assert.ok(evidence.shadowReadback.submitted > 1);
    await device.queue.onSubmittedWorkDone();
    const retirements = [],
      retirement = {
        destroyAfterGpuDone(resource) {
          retirements.push(resource);
        }
      };
    const beforeReplacement = frameInstances.allocatedBytes;
    const replaced = shadowOwner.prepare(
      shadowJob,
      { key: { traversalCapacity: 8, meshletWorkCandidateCapacity: 8 } },
      camera,
      retirement
    );
    assert.notEqual(replaced, shadowPrepared);
    assert.equal(retirements.length, 1);
    assert.equal(
      frameInstances.allocatedBytes,
      beforeReplacement * 2,
      "Old view resources remain live until retirement"
    );
    retirements[0].destroy();
    retirements[0].destroy();
    assert.equal(
      frameInstances.allocatedBytes,
      beforeReplacement,
      "Repeated retirement cannot destroy the current view"
    );
    shadowOwner.release(shadowJob.runtime, retirement);
    assert.equal(
      frameInstances.allocatedBytes,
      beforeReplacement,
      "Release must respect the last-reader completion"
    );
    shadowOwner.destroy();
    for (const resource of retirements) resource.destroy();
    assert.equal(
      frameInstances.allocatedBytes,
      0,
      "Teardown and pending callbacks cannot double release or leak"
    );
    return {
      pendingDemandDeviceLoss,
      boundaries,
      frames,
      evidence,
      shadowDemandRecords,
      physicalCapacityBytes: 2 * MiB,
      logicalFinePageBytes: 6 * 2 * 262144,
      limitations: ["Small correctness/pressure fixture; not G2.4 scene-scale performance"]
    };
  } finally {
    await device.queue.onSubmittedWorkDone();
    streaming?.destroy();
    shadowOwner.destroy();
    frameInstances.destroy();
    hierarchy.destroy();
    candidate.destroy();
    runtime.destroy();
    buffers.forEach((item) => item.destroy());
  }
}

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
import {
  GPU_INSTANCE_ABI_VERSION,
  GPU_INSTANCE_FLAGS,
  packGpuInstanceRecord
} from "../../.test-dist/gpu/GpuInstanceAbi.js";
import { GPU_GEOMETRY_ABI_VERSION } from "../../.test-dist/gpu/GpuGeometryAbi.js";
import { GPU_COUNTER_BYTE_SIZE } from "../../.test-dist/debug/GpuFrameCounters.js";
const MiB = 1024 * 1024;
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export async function runGeometryBudgetedResidencyGpuOracle(device) {
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
        flags: GPU_INSTANCE_FLAGS.Active | GPU_INSTANCE_FLAGS.VirtualGeometry,
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
        encoder.copyBufferToBuffer(work.queue, 0, read, 0, work.queue.size);
        if (frame === 0 && !aborted) {
          encoder.finish();
          aborts.forEach((callback) => callback());
          assert.equal(streaming.evidence().readback.inUse, 0);
          aborted = true;
          frame--;
          continue; // Retry the exact same frame with a new command.
        }
        device.queue.submit([encoder.finish()]);
        callbacks.forEach((callback) => callback());
        await read.mapAsync(GPUMapMode.READ);
        const words = new Uint32Array(read.getMappedRange().slice(0));
        read.unmap();
        assert.equal(words[4] + words[6], 0, "pressure produced invalid/overflow work");
        const counts = [0, 0];
        for (let index = 0; index < words[1]; index++) counts[words[8 + index * 6]]++;
        assert.ok(
          counts.every((count) => count >= 1),
          "coarse coverage lost an accepted instance"
        );
        await streaming.consumeAfterCompletion(frame, device.queue.onSubmittedWorkDone(), performance.now());
        await streaming.scheduler.drainReads();
        const evidence = streaming.evidence();
        assert.ok(evidence.scheduler.verifiedBytes + evidence.scheduler.inFlightBytes <= 2 * 262144);
        assert.ok(evidence.products.every((product) => product.pinnedPages === 1));
        frames.push({
          frame,
          counts,
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
    return {
      boundaries,
      frames,
      evidence,
      physicalCapacityBytes: 2 * MiB,
      logicalFinePageBytes: 6 * 2 * 262144,
      limitations: ["Small correctness/pressure fixture; not G2.4 scene-scale performance"]
    };
  } finally {
    await device.queue.onSubmittedWorkDone();
    streaming?.destroy();
    hierarchy.destroy();
    candidate.destroy();
    runtime.destroy();
    buffers.forEach((item) => item.destroy());
  }
}

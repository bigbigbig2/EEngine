import assert from "node:assert/strict";
import test from "node:test";

import { planBoundedGpuWorkStream } from "../../.test-dist/gpu/BoundedGpuWorkProtocol.js";
import {
  GPU_MESHLET_RASTER_WORK_RECORD_STRIDE,
  GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE,
  gpuMeshletWorkQueueByteLength
} from "../../.test-dist/gpu/GpuMeshletRasterWorkAbi.js";
import {
  GPU_SHADING_BIN_RECORDS_OFFSET,
  GPU_SHADING_BIN_RECORD_STRIDE,
  preflightGpuShadingBinSizing
} from "../../.test-dist/gpu/GpuShadingBinAbi.js";

const limits = { maxBufferBytes: 1 << 20, maxStorageBindingBytes: 1 << 20 };

test("MeshletWork and ShadingBin retain distinct ABIs under one bounded control protocol", () => {
  const meshlet = planBoundedGpuWorkStream({
    name: "MeshletWork", producer: "GPU generation", gpuConsumer: "GPU raster",
    elementAbi: "meshlet/v1", capacity: 37,
    elementBytes: GPU_MESHLET_RASTER_WORK_RECORD_STRIDE,
    prefixBytes: GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE,
    counters: ["attempted", "written", "overflow", "consumed", "invalid"],
    overflow: "suppress-indirect-output", execution: "draw-indirect", ...limits
  });
  assert.equal(meshlet.bufferBytes, gpuMeshletWorkQueueByteLength(37));
  assert.equal(meshlet.execution, "draw-indirect");

  const shading = preflightGpuShadingBinSizing(64, 64, [0, 1], 1, {
    maxTextureDimension2D: 1024,
    maxBufferSize: limits.maxBufferBytes,
    maxStorageBufferBindingSize: limits.maxStorageBindingBytes,
    maxComputeWorkgroupsPerDimension: 65535
  });
  assert.equal(shading.heapBytes,
    GPU_SHADING_BIN_RECORDS_OFFSET +
    2 * shading.microtileCount * GPU_SHADING_BIN_RECORD_STRIDE);
  assert.notEqual(shading.layouts[0].capacity, meshlet.capacity);
  assert.equal(shading.layouts[2].capacity, 0);
});

test("bounded stream rejects missing GPU closure and unsafe capacity", () => {
  const base = {
    name: "test", producer: "GPU producer", gpuConsumer: "GPU consumer",
    elementAbi: "test/v1", capacity: 8, elementBytes: 4, prefixBytes: 16,
    counters: ["attempted", "written", "overflow"],
    overflow: "suppress-indirect-output", execution: "dispatch-indirect", ...limits
  };
  assert.throws(() => planBoundedGpuWorkStream({ ...base, gpuConsumer: "" }), /gpuConsumer/);
  assert.throws(() => planBoundedGpuWorkStream({ ...base, counters: ["written", "overflow"] }), /attempted/);
  assert.throws(() => planBoundedGpuWorkStream({ ...base, capacity: 1 << 20 }), /maxBufferSize/);
});

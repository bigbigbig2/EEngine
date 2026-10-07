import assert from "node:assert/strict";
import test from "node:test";

import { planBoundedGpuWorkStream } from "../../.test-dist/gpu/BoundedGpuWorkProtocol.js";
import {
  GPU_MESHLET_RASTER_WORK_RECORD_STRIDE,
  GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE,
  gpuMeshletWorkQueueByteLength
} from "../../.test-dist/gpu/GpuMeshletRasterWorkAbi.js";
const limits = { maxBufferBytes: 1 << 20, maxStorageBindingBytes: 1 << 20 };

test("MeshletWork retains its bounded GPU control and exact capacity contract", () => {
  const meshlet = planBoundedGpuWorkStream({
    name: "MeshletWork",
    producer: "GPU generation",
    gpuConsumer: "GPU raster",
    elementAbi: "meshlet/v1",
    capacity: 37,
    elementBytes: GPU_MESHLET_RASTER_WORK_RECORD_STRIDE,
    prefixBytes: GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE,
    counters: ["attempted", "written", "overflow", "consumed", "invalid"],
    overflow: "suppress-indirect-output",
    execution: "draw-indirect",
    ...limits
  });
  assert.equal(meshlet.bufferBytes, gpuMeshletWorkQueueByteLength(37));
  assert.equal(meshlet.execution, "draw-indirect");
});

test("bounded stream rejects missing GPU closure and unsafe capacity", () => {
  const base = {
    name: "test",
    producer: "GPU producer",
    gpuConsumer: "GPU consumer",
    elementAbi: "test/v1",
    capacity: 8,
    elementBytes: 4,
    prefixBytes: 16,
    counters: ["attempted", "written", "overflow"],
    overflow: "suppress-indirect-output",
    execution: "dispatch-indirect",
    ...limits
  };
  assert.throws(() => planBoundedGpuWorkStream({ ...base, gpuConsumer: "" }), /gpuConsumer/);
  assert.throws(() => planBoundedGpuWorkStream({ ...base, counters: ["written", "overflow"] }), /attempted/);
  assert.throws(() => planBoundedGpuWorkStream({ ...base, capacity: 1 << 20 }), /maxBufferSize/);
});

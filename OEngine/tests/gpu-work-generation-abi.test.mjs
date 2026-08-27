import test from "node:test";
import assert from "node:assert/strict";

import {
  GPU_DISPATCH_INDIRECT_ARGS_SIZE,
  GPU_DRAW_INDIRECT_ARGS_SIZE,
  GPU_RASTER_WORK_SCHEMA,
  GPU_TRAVERSAL_WORK_SCHEMA,
  GPU_VISIBLE_CLUSTER_RECORD_SCHEMA,
  GPU_WORK_GENERATION_WGSL,
  GPU_WORK_QUEUE_HEADER_SCHEMA,
  GPU_WORK_QUEUE_INVALID_OFFSET,
  createWorkQueueReservationState,
  packDispatchIndirectArgs,
  packDrawIndirectArgs,
  packRasterWork,
  packTraversalWork,
  packVisibleClusterRecord,
  packWorkQueueHeader,
  reserveWorkQueueGroupReference
} from "../.test-dist/gpu/GpuWorkGenerationAbi.js";

test("R3-A Work Generation TS and WGSL share the frozen queue ABI", () => {
  assert.equal(GPU_TRAVERSAL_WORK_SCHEMA.stride, 8);
  assert.deepEqual(GPU_TRAVERSAL_WORK_SCHEMA.offsets, {
    instance_record_index: 0,
    cluster_record_index: 4
  });
  assert.equal(GPU_VISIBLE_CLUSTER_RECORD_SCHEMA.stride, 16);
  assert.deepEqual(GPU_VISIBLE_CLUSTER_RECORD_SCHEMA.offsets, {
    instance_record_index: 0,
    geometry_record_index: 4,
    cluster_record_index: 8,
    material_handle: 12
  });
  assert.equal(GPU_RASTER_WORK_SCHEMA.stride, 8);
  assert.deepEqual(GPU_RASTER_WORK_SCHEMA.offsets, {
    visible_cluster_slot: 0,
    meshlet_record_index: 4
  });
  assert.equal(GPU_WORK_QUEUE_HEADER_SCHEMA.stride, 32);
  assert.deepEqual(GPU_WORK_QUEUE_HEADER_SCHEMA.offsets, {
    written: 0,
    attempted: 4,
    peak: 8,
    overflow: 12,
    fallback: 16,
    capacity: 20,
    _pad0: 24,
    _pad1: 28
  });
  assert.match(GPU_WORK_GENERATION_WGSL, /written: atomic<u32>/);
  assert.match(GPU_WORK_GENERATION_WGSL, /atomicCompareExchangeWeak/);
  assert.match(GPU_WORK_GENERATION_WGSL, /OENGINE_WORK_QUEUE_INVALID_OFFSET/);
});

test("R3-A packers write record indices and complete indirect arguments", () => {
  const traversal = new DataView(packTraversalWork({
    instanceRecordIndex: 17,
    clusterRecordIndex: 23
  }).buffer);
  assert.equal(traversal.getUint32(0, true), 17);
  assert.equal(traversal.getUint32(4, true), 23);

  const visible = new DataView(packVisibleClusterRecord({
    instanceRecordIndex: 1,
    geometryRecordIndex: 2,
    clusterRecordIndex: 3,
    materialHandle: 4
  }).buffer);
  assert.deepEqual(
    Array.from({ length: 4 }, (_, index) => visible.getUint32(index * 4, true)),
    [1, 2, 3, 4]
  );

  const raster = new DataView(packRasterWork({
    visibleClusterSlot: 5,
    meshletRecordIndex: 6
  }).buffer);
  assert.equal(raster.getUint32(0, true), 5);
  assert.equal(raster.getUint32(4, true), 6);

  const dispatch = new Uint32Array(packDispatchIndirectArgs(7, 2, 1).buffer);
  assert.equal(dispatch.byteLength, GPU_DISPATCH_INDIRECT_ARGS_SIZE);
  assert.deepEqual([...dispatch], [7, 2, 1]);

  const draw = new Uint32Array(packDrawIndirectArgs({
    vertexCount: 384,
    instanceCount: 9,
    firstVertex: 0,
    firstInstance: 0
  }).buffer);
  assert.equal(draw.byteLength, GPU_DRAW_INDIRECT_ARGS_SIZE);
  assert.deepEqual([...draw], [384, 9, 0, 0]);

  const header = new Uint32Array(packWorkQueueHeader({
    capacity: 64,
    written: 3,
    attempted: 5,
    peak: 3,
    overflow: 1,
    fallback: 1
  }).buffer);
  assert.deepEqual([...header], [3, 5, 3, 1, 1, 64, 0, 0]);
});

test("R3-A bounded reservation never publishes partial children", () => {
  const state = createWorkQueueReservationState(4);
  assert.equal(reserveWorkQueueGroupReference(state, 3), 0);
  assert.equal(reserveWorkQueueGroupReference(state, 2), GPU_WORK_QUEUE_INVALID_OFFSET);
  assert.deepEqual(state, {
    capacity: 4,
    written: 3,
    attempted: 5,
    peak: 3,
    overflow: 1,
    fallback: 1
  });
});

test("R3-A bounded reservation validates u32 inputs and saturates evidence", () => {
  const state = createWorkQueueReservationState(1);
  state.attempted = 0xfffffffe;
  assert.equal(reserveWorkQueueGroupReference(state, 1), 0);
  assert.equal(reserveWorkQueueGroupReference(state, 2), GPU_WORK_QUEUE_INVALID_OFFSET);
  assert.equal(state.written, 1);
  assert.equal(state.attempted, 0xffffffff);
  assert.equal(state.overflow, 1);
  assert.equal(state.fallback, 1);
  assert.throws(() => reserveWorkQueueGroupReference(state, 0), /positive u32/);
  assert.throws(() => createWorkQueueReservationState(0x1_0000_0000), /u32/);
});

test("R3-A bounded reservation preserves capacity for deterministic random sequences", () => {
  for (let seed = 1; seed <= 64; seed++) {
    const random = mulberry32(seed);
    const capacity = 1 + Math.floor(random() * 32);
    const state = createWorkQueueReservationState(capacity);
    let expectedWritten = 0;
    let expectedAttempted = 0;
    for (let index = 0; index < 128; index++) {
      const count = 1 + Math.floor(random() * 8);
      const before = state.written;
      const offset = reserveWorkQueueGroupReference(state, count);
      expectedAttempted = Math.min(0xffffffff, expectedAttempted + count);
      if (count <= capacity - expectedWritten) {
        assert.equal(offset, expectedWritten, `seed ${seed}, reservation ${index}`);
        expectedWritten += count;
      } else {
        assert.equal(offset, GPU_WORK_QUEUE_INVALID_OFFSET, `seed ${seed}, reservation ${index}`);
        assert.equal(state.written, before, "failed group must not publish a partial range");
      }
      assert.equal(state.written, expectedWritten);
      assert.equal(state.attempted, expectedAttempted);
      assert.ok(state.written <= state.capacity);
      assert.ok(state.peak <= state.capacity);
    }
  }
});

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

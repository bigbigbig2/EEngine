import test from "node:test";
import assert from "node:assert/strict";

globalThis.GPUShaderStage ??= { COMPUTE: 1 };

const {
  GPU_LIST_COUNTER_WGSL,
  GPU_LIST_COUNTER_WORKGROUP_SIZE,
  gpuListElementCapacity
} = await import("../.test-dist/debug/GpuListCounterAccumulator.js");
const {
  GPU_QUEUE_OVERFLOW_BITS,
  counterByteOffset
} = await import("../.test-dist/debug/GpuFrameCounters.js");

test("GPU list accumulator targets dynamic counter ABI slots and submitted triangles", () => {
  assert.equal(GPU_LIST_COUNTER_WORKGROUP_SIZE, 1);
  assert.match(GPU_LIST_COUNTER_WGSL, /source\[0\]/);
  assert.match(
    GPU_LIST_COUNTER_WGSL,
    /safe_count \* params\.triangles_per_element/
  );
  assert.match(GPU_LIST_COUNTER_WGSL, /atomicAdd\(&frame_counters\[params\.primary_index\]/);
  assert.match(
    GPU_LIST_COUNTER_WGSL,
    /atomicOr\(\s*&frame_counters\[params\.overflow_index\]/
  );
  assert.equal(counterByteOffset("queueOverflowMask") % 4, 0);
});

test("GPU queue overflow bits are unique powers of two", () => {
  const bits = Object.values(GPU_QUEUE_OVERFLOW_BITS);
  assert.equal(new Set(bits).size, bits.length);
  for (const bit of bits) {
    assert.ok(bit > 0 && (bit & (bit - 1)) === 0);
  }
});

test("GPU list capacity excludes its aligned header", () => {
  assert.equal(gpuListElementCapacity(16, 16, 8), 0);
  assert.equal(gpuListElementCapacity(24, 16, 8), 1);
  assert.equal(gpuListElementCapacity(80, 16, 8), 8);
  assert.throws(() => gpuListElementCapacity(15, 16, 8), /bufferSize/);
  assert.throws(() => gpuListElementCapacity(16, 12, 8), /headerBytes/);
});

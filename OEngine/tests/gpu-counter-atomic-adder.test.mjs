import test from "node:test";
import assert from "node:assert/strict";

globalThis.GPUShaderStage ??= { COMPUTE: 1 };
globalThis.GPUBufferUsage ??= { UNIFORM: 1 };

const {
  GpuCounterAtomicAdder,
  GPU_COUNTER_ATOMIC_ADD_WGSL
} = await import("../.test-dist/debug/GpuCounterAtomicAdder.js");
const { counterByteOffset } = await import(
  "../.test-dist/debug/GpuFrameCounters.js"
);

test("atomic adder writes an exact CPU-known GPU work count", () => {
  assert.match(GPU_COUNTER_ATOMIC_ADD_WGSL, /atomicAdd/);
  assert.match(GPU_COUNTER_ATOMIC_ADD_WGSL, /@workgroup_size\(1\)/);
  const counters = { size: 256, usage: 0, words: new Uint32Array(64) };
  const adder = new GpuCounterAtomicAdder();
  adder.encode(fakeCommandContext(), counters, "activeMaterials", 7);
  assert.equal(counters.words[counterByteOffset("activeMaterials") / 4], 7);
  assert.throws(
    () => adder.encode(fakeCommandContext(), counters, "activeMaterials", -1),
    /non-negative u32/
  );
});

function fakeCommandContext() {
  return {
    allocateTransientBufferAndLoad(data) {
      return {
        size: data.byteLength,
        usage: 0,
        words: new Uint32Array(data.slice(0))
      };
    },
    constructComputePass({ bindings }) {
      return {
        dispatchWorkgroups() {
          const counters = bindings[0][0].buffer.words;
          const params = bindings[0][1].buffer.words;
          counters[params[0]] += params[1];
        },
        end() {}
      };
    }
  };
}

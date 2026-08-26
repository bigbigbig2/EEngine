import test from "node:test";
import assert from "node:assert/strict";

globalThis.GPUShaderStage ??= { COMPUTE: 1 };
globalThis.GPUBufferUsage ??= { UNIFORM: 1 };

const {
  addGpuListCounterPass,
  GPU_LIST_COUNTER_WGSL,
  GPU_LIST_COUNTER_WORKGROUP_SIZE,
  gpuListElementCapacity
} = await import("../.test-dist/debug/GpuListCounterAccumulator.js");
const {
  GPU_QUEUE_OVERFLOW_BITS,
  counterByteOffset
} = await import("../.test-dist/debug/GpuFrameCounters.js");
const {
  FrameGraph,
  FrameGraphContext
} = await import("../.test-dist/framegraph/FrameGraph.js");

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
  assert.equal(gpuListElementCapacity(12, 4, 4), 2);
  assert.throws(() => gpuListElementCapacity(15, 16, 8), /bufferSize/);
  assert.throws(() => gpuListElementCapacity(16, 2, 8), /headerBytes/);
});

test("FrameGraph list counters cover both LightCluster queues", () => {
  const graph = new FrameGraph("light-list-counter-test");
  const candidate = fakeBuffer(12);
  candidate.words[0] = 5;
  const filtered = fakeBuffer(12);
  filtered.words[0] = 1;
  const counters = fakeBuffer(256);
  const candidateResource = graph.import_resource(
    "candidate light list",
    { kind: "imported" },
    candidate
  );
  const filteredResource = graph.import_resource(
    "filtered light list",
    { kind: "imported" },
    filtered
  );
  const counterResource = graph.import_resource(
    "frame counters",
    { kind: "imported" },
    counters
  );
  const afterCandidate = addGpuListCounterPass(
    graph,
    candidateResource,
    counterResource,
    {
      overflowBit: GPU_QUEUE_OVERFLOW_BITS.lightList,
      headerBytes: 4,
      elementBytes: 4
    }
  );
  addGpuListCounterPass(graph, filteredResource, afterCandidate, {
    primary: "activeLights",
    overflowBit: GPU_QUEUE_OVERFLOW_BITS.lightList,
    headerBytes: 4,
    elementBytes: 4
  });
  graph.compile();
  graph.execute(new FrameGraphContext({ encoder: fakeCommandContext() }));

  assert.equal(
    counters.words[counterByteOffset("activeLights") / 4],
    1
  );
  assert.equal(
    counters.words[counterByteOffset("queueOverflowMask") / 4],
    GPU_QUEUE_OVERFLOW_BITS.lightList
  );
});

function fakeBuffer(size) {
  return { size, usage: 0, words: new Uint32Array(size / 4) };
}

function fakeCommandContext() {
  return {
    gpu_encoder: {},
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
          const source = bindings[0][0].buffer.words;
          const counters = bindings[0][1].buffer.words;
          const params = bindings[0][2].buffer.words;
          const safeCount = Math.min(source[0], params[5]);
          if (params[0] !== 0xffffffff) counters[params[0]] += safeCount;
          if (params[1] !== 0xffffffff) counters[params[1]] += safeCount;
          if (params[2] !== 0xffffffff) {
            counters[params[2]] += safeCount * params[6];
          }
          if (source[0] > params[5]) counters[params[3]] |= params[4];
        },
        end() {}
      };
    }
  };
}

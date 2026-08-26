import test from "node:test";
import assert from "node:assert/strict";

globalThis.GPUShaderStage ??= { COMPUTE: 1 };

const {
  createMeshletHzbCullWgsl,
  createMeshletHzbCullSecondWgsl
} = await import("../.test-dist/shaders/meshlet_hzb_cull.js");
const { createMeshletHzbCullDualWgsl } = await import(
  "../.test-dist/shaders/meshlet_hzb_cull_dual.js"
);
const { counterByteOffset } = await import(
  "../.test-dist/debug/GpuFrameCounters.js"
);
const {
  BENCHMARK_FEATURE_SET_EVIDENCE,
  BENCHMARK_GPU_COUNTER_EVIDENCE
} = await import("../.test-dist/debug/BenchmarkCapabilityEvidence.js");

const rejectedHzbIndex = counterByteOffset("rejectedHzb") / 4;

test("HZB shader variants count only actual depth-query rejection branches", () => {
  const variants = [
    createMeshletHzbCullWgsl({ counterGroup: 2, rejectedHzbIndex }),
    createMeshletHzbCullSecondWgsl({ counterGroup: 3, rejectedHzbIndex }),
    createMeshletHzbCullDualWgsl({ counterGroup: 2, rejectedHzbIndex })
  ];

  for (const source of variants) {
    assert.match(source, new RegExp(`frame_counters\\[${rejectedHzbIndex}u\\]`));
    assert.equal(
      source.match(/atomicAdd\(&frame_counters\[[0-9]+u\], 1u\)/g)?.length,
      1
    );
    assert.ok(
      source.indexOf("visibility_query_depth_from_screen_space_bb") <
        source.indexOf("atomicAdd(&frame_counters")
    );
  }
});

test("non-sampled HZB shaders keep counter bindings and atomics out", () => {
  assert.doesNotMatch(createMeshletHzbCullWgsl(), /frame_counters/);
  assert.doesNotMatch(createMeshletHzbCullSecondWgsl(), /frame_counters/);
  assert.doesNotMatch(createMeshletHzbCullDualWgsl(), /frame_counters/);
});

test("HZB evidence is a separate feature contract from hardware raster", () => {
  assert.deepEqual(
    BENCHMARK_FEATURE_SET_EVIDENCE["hzb-culling"].requiredGpuCounters,
    ["rejectedHzb"]
  );
  assert.equal(BENCHMARK_GPU_COUNTER_EVIDENCE.rejectedHzb.status, "supported");
  assert.equal(
    BENCHMARK_FEATURE_SET_EVIDENCE["hardware-visibility"].requiredGpuCounters.includes("rejectedHzb"),
    false
  );
});

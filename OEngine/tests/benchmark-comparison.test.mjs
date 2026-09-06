import test from "node:test";
import assert from "node:assert/strict";

import { compareBenchmarkResults } from "../.test-dist/debug/BenchmarkComparison.js";

const series = (p50, count = 10) => ({
  count,
  mean: p50,
  min: p50,
  max: p50,
  p50,
  p95: p50,
  p99: p50
});

function result(id, frameP50, sampleFrames = 10, includeGpuFrame = false) {
  return {
    environment: { run: { sampleFrames } },
    case: { id },
    summary: {
      cpuMs: { frame: series(frameP50, sampleFrames) },
      gpuMs: {},
      gpuPhaseMs: includeGpuFrame ? { frame: series(1, sampleFrames) } : {},
      surfacePhaseMs: {},
      counters: {},
      gpuCounters: {},
      submits: series(1, sampleFrames),
      readbacks: series(0, sampleFrames),
      uploadBytes: series(0, sampleFrames)
    }
  };
}

test("benchmark comparison reports absolute and percentage deltas", () => {
  const comparison = compareBenchmarkResults(result("base", 10), [result("full", 12)]);
  const delta = comparison.variants[0].deltas.find((entry) => entry.metric === "cpuMs.frame");
  assert.equal(delta.status, "available");
  assert.equal(delta.p50Absolute, 2);
  assert.equal(delta.p50Percent, 20);
  assert.equal(delta.baselineCoverage, 1);
  assert.equal(delta.variantCoverage, 1);
});

test("benchmark comparison marks missing metrics instead of inventing zeros", () => {
  const comparison = compareBenchmarkResults(result("base", 10, 10, true), [result("variant", 10)]);
  const delta = comparison.variants[0].deltas.find((entry) => entry.metric === "gpuPhaseMs.frame");
  assert.equal(delta.status, "variant-missing");
  assert.equal(delta.p50Absolute, null);
  assert.equal(delta.p50Percent, null);
});

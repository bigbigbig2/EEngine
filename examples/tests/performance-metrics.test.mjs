import assert from "node:assert/strict";
import test from "node:test";
import { distribution, frameSeries, gpuRows, sparseRatios } from "../demos/14-integrated/shared/PerformanceMetrics.ts";

function frame(index, segments, counters = {}) {
  return {
    frameIndex: index, cpuMs: { frame: 3 }, counters: { "frame.rafIntervalMs": 16.7 },
    submits: { count: 1 }, uploads: { bytes: 0 }, readbacks: { bytes: 0 },
    gpu: { available: true, sampled: true, pending: false, segments }, gpuValid: true,
    gpuCounters: { sampled: true, pending: false, dropped: false, values: counters }
  };
}

test("percentiles sum repeated passes within a frame before aggregating", () => {
  const segment = (ms) => ({ label: "resolve", phase: "material-resolve", durationMs: ms });
  const frames = [frame(1, [segment(1), segment(9)]), frame(2, [segment(9), segment(1)])];
  assert.deepEqual(gpuRows(frames, "pass").get("resolve"), { count: 2, p50: 10, p95: 10, mean: 10, max: 10 });
  assert.deepEqual(frameSeries(frames, "gpu"), [10, 10]);
});

test("late replacement does not duplicate samples; invalid GPU samples and absent passes are excluded", () => {
  const samples = new Map();
  const pending = frame(1, []); pending.gpu.pending = true; pending.gpuValid = false;
  samples.set(1, pending);
  samples.set(1, frame(1, [{ label: "resolve", phase: "material-resolve", durationMs: 5 }]));
  const invalid = frame(2, []); invalid.gpuValid = false;
  samples.set(2, invalid);
  samples.set(3, frame(3, [{ label: "shadow", phase: "shadow", durationMs: 2 }]));
  assert.equal(gpuRows([...samples.values()], "pass").get("resolve").count, 1);
  assert.deepEqual(frameSeries([...samples.values()], "gpu"), [5, 2]);
  assert.equal(distribution([]), null);
  assert.equal(distribution([1, NaN, Infinity, 2]).count, 2);
});

test("amplification uses complete same-frame queue evidence and includes dispatch padding", () => {
  const values = { geometryVisiblePixels: 100, shadingBinWritten: 4, shadingBinIndirectWorkgroups: 6, shadingBinFrameFlags: 0, shadingBinErrors: 0, shadingBinOverflow: 0 };
  const sample = frame(4, [], values);
  assert.deepEqual(sparseRatios(sample), { pixels: 100, records: 4, workgroups: 6, invocations: 384, amplification: 3.84, padding: 1.5 });
  sample.gpuCounters.pending = true;
  assert.equal(sparseRatios(sample), null);
  sample.gpuCounters.pending = false;
  values.shadingBinOverflow = 1;
  assert.equal(sparseRatios(sample), null);
  values.shadingBinOverflow = 0;
  values.geometryVisiblePixels = 0;
  assert.equal(sparseRatios(sample), null);
  delete values.shadingBinErrors;
  assert.equal(sparseRatios(sample), null);
});

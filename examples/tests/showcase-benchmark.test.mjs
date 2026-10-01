import assert from "node:assert/strict";
import test from "node:test";
import { summarizeCapture, compareCaptures, validGpuFrame } from "../demos/14-integrated/next-renderer-showcase/BenchmarkMetrics.ts";

function frame(frameIndex, durations, extra = {}) {
  return { frameIndex, cpuMs: { frame: 2 }, counters: {}, submits: { count: 1 }, uploads: { bytes: 0 }, readbacks: { bytes: 0 },
    gpu: { available: true, sampled: true, pending: false, segments: durations.map(durationMs => ({ label: "Renderer/Surface/worker", phase: "material", durationMs })) },
    gpuCounters: { sampled: false, pending: false, dropped: false, values: {} }, gpuValid: true, ...extra };
}
test("fixed capture aggregates repeated intervals per frame and retains long tails", () => {
  const result = summarizeCapture([frame(1, [1, 9]), frame(2, [90, 10])]);
  assert.equal(result.gpuPassSumMs.p50, 10);
  assert.equal(result.gpuPassSumMs.p95, 100);
  assert.equal(result.passes[0].p95, 100);
  assert.deepEqual(result.slowFrames, [2]);
});
test("late patches replace by frame id; missing timestamp results remain explicit", () => {
  const pending = frame(1, []); pending.gpu.pending = true;
  const result = summarizeCapture([pending, frame(1, [4]), frame(2, [])]);
  assert.equal(result.submitted, 2); assert.equal(result.completedGpu, 1);
  assert.deepEqual(result.invalidGpuFrameIds, [2]);
  assert.equal(validGpuFrame(frame(3, [0])), false);
  assert.equal(validGpuFrame(frame(3, [NaN])), false);
});
test("counters require completed readback; absent values never become zero", () => {
  const complete = frame(1, [4]); complete.gpuCounters = { sampled: true, pending: false, dropped: false, values: { surfaceMaterialSamples: 100 } };
  const pending = frame(2, [4]); pending.gpuCounters = { ...complete.gpuCounters, pending: true, values: { surfaceMaterialSamples: 0 } };
  const result = summarizeCapture([complete, pending]);
  assert.equal(result.counters.surfaceMaterialSamples.count, 1);
  assert.equal(result.counters.surfaceMaterialSamples.min, 100);
  assert.equal(result.counters.surfaceLightingSamples, undefined);
});
test("condition drift and incomplete GPU measurements forbid comparison", () => {
  const a = { conditions: { camera: [1, 2], extent: [1280, 720] }, frames: [frame(1, [10])] };
  assert.throws(() => compareCaptures(a, { ...a, conditions: { camera: [1, 3] } }), /conditions differ/);
  assert.throws(() => compareCaptures(a, { ...a, frames: [frame(2, [])] }), /Incomplete/);
  assert.equal(compareCaptures(a, { ...a, frames: [frame(2, [5])] }).p50Ratio, 0.5);
});

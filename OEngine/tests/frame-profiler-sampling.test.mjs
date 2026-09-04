import test from "node:test";
import assert from "node:assert/strict";

import { FrameProfiler } from "../.test-dist/debug/FrameProfiler.js";

test("frame profiler modes keep cadence and counter instrumentation explicit", () => {
  const profiler = new FrameProfiler({
    enabled: true,
    gpuSampleInterval: 2,
    gpuCounterSampleInterval: 3,
    gpuTimestampAvailable: true
  });
  profiler.attachGpuDevice({
    features: new Set(),
    lost: new Promise(() => {}),
    addEventListener() {},
    removeEventListener() {}
  });

  profiler.setMode("live");
  assert.equal(profiler.mode, "live");
  assert.equal(profiler.gpuSampleInterval, 4);
  profiler.beginFrame(4);
  const live = profiler.endFrame();
  assert.equal(live.gpu.sampled, true);
  assert.equal(live.gpuCounters.sampled, false);

  profiler.setMode("record");
  profiler.beginFrame(6);
  const record = profiler.endFrame();
  assert.equal(record.gpu.sampled, true);
  assert.equal(record.gpuCounters.sampled, true);

  profiler.setMode("deep-capture");
  profiler.beginFrame(7);
  const deep = profiler.endFrame();
  assert.equal(deep.gpu.sampled, true);
  assert.equal(deep.gpuCounters.sampled, true);
});


test("recordMetric keeps unavailable samples out of numeric counters", () => {
  const profiler = new FrameProfiler({ enabled: true });
  profiler.registerMetric({
    id: "gpu.testCounter",
    label: "Test counter",
    group: "gpu",
    unit: "count",
    source: "gpu-counter",
    measurement: "counted",
    cost: "instrumented",
    scope: "frame",
    aggregation: "last",
    description: "Test-only counter"
  });
  profiler.beginFrame(1);
  profiler.recordMetric("gpu.testCounter", 0, "unsupported");
  const frame = profiler.endFrame();
  const sample = profiler.historyStore.get(1).samples["gpu.testCounter"];
  assert.equal(frame.counters["gpu.testCounter"], undefined);
  assert.deepEqual(sample, {
    metricId: "gpu.testCounter",
    value: null,
    availability: "unsupported",
    sourceFrameIndex: 1,
    resolvedAtFrameIndex: null,
    instrumented: true
  });
});

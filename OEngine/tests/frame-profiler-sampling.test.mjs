import test from "node:test";
import assert from "node:assert/strict";

import { FrameProfiler } from "../.test-dist/debug/FrameProfiler.js";
import { createPerformanceCapture } from "../.test-dist/debug/profiling/PerformanceCapture.js";

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
  profiler.recordMetric("gpu.testCounter", null, "unsupported");
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

test("mode changes start a new epoch and mark the configured warm-up frames", () => {
  const profiler = new FrameProfiler({ enabled: true, warmupFrames: 2 });

  profiler.setMode("record");
  assert.equal(profiler.epoch, 1);
  assert.equal(profiler.warmupRemaining, 2);

  profiler.beginFrame(10);
  profiler.endFrame();
  profiler.beginFrame(11);
  profiler.endFrame();
  profiler.beginFrame(12);
  profiler.endFrame();

  assert.equal(profiler.historyStore.get(10).epoch, 1);
  assert.equal(profiler.historyStore.get(10).warmup, true);
  assert.equal(profiler.historyStore.get(11).warmup, true);
  assert.equal(profiler.historyStore.get(12).warmup, false);
});

test("metric samples enforce value and availability consistency", () => {
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
  assert.throws(
    () => profiler.recordMetric("gpu.testCounter", null, "available"),
    /available metric.*number/i
  );
  assert.throws(
    () => profiler.recordMetric("gpu.testCounter", 1, "pending"),
    /unavailable metric.*null/i
  );
  profiler.endFrame();
});

test("counter APIs reject metric IDs that were not registered", () => {
  const profiler = new FrameProfiler({ enabled: true });
  profiler.beginFrame(1);
  assert.throws(() => profiler.recordCounter("unknown.counter", 1), /Unknown metric/);
  assert.throws(() => profiler.addCounter("unknown.counter", 1), /Unknown metric/);
  profiler.endFrame();
});

test("renderer material counters are registered in the profiler catalog", () => {
  const profiler = new FrameProfiler({ enabled: true });
  const ids = new Set(profiler.metricCatalog.map(({ id }) => id));
  assert.equal(ids.has("packed.material.kernelDraws"), true);
  assert.equal(ids.has("legacy.material.fullscreenDraws"), true);
  profiler.beginFrame(1);
  assert.doesNotThrow(() => profiler.recordCounter("packed.material.kernelDraws", 1));
  assert.doesNotThrow(() => profiler.recordCounter("legacy.material.fullscreenDraws", 1));
  profiler.endFrame();
});

test("profiler catalog covers named CPU section samples for capture export", () => {
  const profiler = new FrameProfiler({ enabled: true });
  profiler.beginFrame(1);
  const finish = profiler.beginCpuSection("graphics-update");
  finish();
  profiler.endFrame();
  assert.doesNotThrow(() => createPerformanceCapture({
    sampling: {
      mode: "live",
      warmupFrames: 0,
      timestampInterval: profiler.gpuSampleInterval,
      counterInterval: profiler.gpuCounterSampleInterval,
      historyCapacity: 2048
    },
    metricCatalog: profiler.metricCatalog,
    frames: profiler.historyStore.values()
  }));
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyFrame,
  frameStatusColor,
  FrameChartModel
} from "../.test-dist/addons/inspector/charts/FrameChart.js";
import {
  SeriesChartModel,
  metricStatusCode
} from "../.test-dist/addons/inspector/charts/SeriesChart.js";
import {
  buildOverviewStats
} from "../.test-dist/addons/inspector/panels/OverviewPanel.js";

function frame(frameIndex, cpuMs, gpuMs, availability = "available", options = {}) {
  return {
    schemaVersion: 1,
    frameIndex,
    epoch: 0,
    warmup: false,
    visibilityState: "visible",
    samples: {
      "cpu.frameMs": {
        metricId: "cpu.frameMs",
        value: cpuMs,
        availability,
        sourceFrameIndex: frameIndex,
        resolvedAtFrameIndex: frameIndex,
        instrumented: false
      },
      "gpu.passSumMs": {
        metricId: "gpu.passSumMs",
        value: gpuMs,
        availability,
        sourceFrameIndex: frameIndex,
        resolvedAtFrameIndex: frameIndex,
        instrumented: options.instrumented ?? false
      }
    },
    spans: [],
    gpuCounterSchemaVersion: 1,
    timestampInstrumented: options.instrumented ?? false,
    counterInstrumented: options.instrumented ?? false,
    complete: availability === "available"
  };
}

test("FrameChart classifies budget, instrumentation and unavailable states", () => {
  assert.equal(classifyFrame(frame(0, 8, 4), 16.667), "normal");
  assert.equal(classifyFrame(frame(1, 20, 4), 16.667), "over-budget");
  assert.equal(classifyFrame(frame(2, 8, 4, "pending"), 16.667), "pending");
  const gpuPending = frame(2, 8, 4);
  gpuPending.samples["gpu.passSumMs"].availability = "pending";
  assert.equal(classifyFrame(gpuPending, 16.667), "pending");
  assert.equal(classifyFrame(frame(3, 8, 4, "invalid"), 16.667), "invalid");
  assert.equal(classifyFrame(frame(4, 8, 4, "dropped"), 16.667), "dropped");
  assert.equal(classifyFrame(frame(5, 8, 4, "unsupported"), 16.667), "unsupported");
  assert.equal(classifyFrame(frame(6, 8, 4, "available", { instrumented: true }), 16.667), "instrumented");
  assert.equal(frameStatusColor("over-budget"), "#f97316");
});

test("FrameChart and SeriesChart keep bounded typed-array storage", () => {
  const chart = new FrameChartModel(3);
  chart.setFrames([
    frame(0, 1, 1),
    frame(1, 2, 2),
    frame(2, 3, 3),
    frame(3, 4, 4)
  ], 16.667);
  assert.equal(chart.count, 3);
  assert.ok(chart.values instanceof Float32Array);
  assert.ok(chart.statuses instanceof Uint8Array);

  const series = new SeriesChartModel(2);
  series.setFrames([
    frame(0, 1, 1),
    frame(1, 2, 2),
    frame(2, 3, 3, "pending")
  ], "cpu.frameMs");
  assert.equal(series.count, 2);
  assert.ok(series.values instanceof Float32Array);
  assert.ok(series.availability instanceof Uint8Array);
  assert.equal(metricStatusCode("pending"), 1);
});

test("overview statistics honor selected range and nearest-rank percentiles", () => {
  const frames = [
    frame(10, 1, 2),
    frame(11, 2, 4),
    frame(12, 3, 6),
    frame(13, 4, 8),
    frame(14, 100, 10)
  ];
  const stats = buildOverviewStats(frames, [10, 13]);
  assert.deepEqual(stats.cpu, {
    count: 4,
    min: 1,
    max: 4,
    mean: 2.5,
    p50: 2,
    p95: 4,
    p99: 4
  });
  assert.equal(stats.gpu?.p95, 8);
  assert.equal(stats.frameCount, 4);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  createPerformanceCapture,
  parsePerformanceCapture,
  serializePerformanceCapture
} from "../.test-dist/debug/profiling/PerformanceCapture.js";
import {
  summarizeMetricCoverage,
  summarizeProfileSeries
} from "../.test-dist/debug/profiling/MetricRegistry.js";

const cpuDescriptor = {
  id: "cpu.frameMs",
  label: "CPU frame",
  group: "cpu",
  unit: "ms",
  source: "cpu-clock",
  measurement: "measured",
  cost: "low",
  scope: "frame",
  aggregation: "last",
  description: "CPU frame duration"
};

function sample(frameIndex, value, availability = "available") {
  return {
    metricId: "cpu.frameMs",
    value,
    availability,
    sourceFrameIndex: frameIndex,
    resolvedAtFrameIndex: availability === "available" ? frameIndex : null,
    instrumented: false
  };
}

function frame(frameIndex, value, overrides = {}) {
  return {
    schemaVersion: 1,
    frameIndex,
    epoch: 1,
    warmup: false,
    visibilityState: "visible",
    samples: { "cpu.frameMs": sample(frameIndex, value) },
    spans: [],
    gpuCounterSchemaVersion: 12,
    timestampInstrumented: false,
    counterInstrumented: false,
    complete: true,
    ...overrides
  };
}

const sampling = {
  mode: "record",
  warmupFrames: 0,
  timestampInterval: 1,
  counterInterval: 4,
  historyCapacity: 8
};

test("performance capture matches the canonical schema golden file", async () => {
  const capture = createPerformanceCapture({
    createdAt: "2026-09-05T00:00:00.000Z",
    engine: { version: "0.0.0", commit: "test" },
    environment: { z: 2, adapter: { vendor: "test", architecture: "fake" } },
    sampling,
    metricCatalog: [cpuDescriptor],
    frames: [frame(1, 2)],
    diagnostics: { validationErrorCount: 0 }
  });
  const golden = await readFile(
    new URL("fixtures/performance-capture-v1.golden.json", import.meta.url),
    "utf8"
  );
  assert.equal(serializePerformanceCapture(capture), golden.replaceAll("\r\n", "\n"));
});

test("capture canonicalization is byte stable and strips unknown schema fields", () => {
  const capture = createPerformanceCapture({
    createdAt: "2026-09-05T00:00:00.000Z",
    engine: { z: 1, a: { y: 2, x: 1 } },
    environment: {},
    sampling,
    metricCatalog: [{ ...cpuDescriptor, unknownDescriptorField: "drop" }],
    frames: [{
      ...frame(2, 3),
      unknownFrameField: true,
      samples: {
        "cpu.frameMs": { ...sample(2, 3), unknownSampleField: "drop" }
      },
      spans: [
        { id: 2, parentId: null, frameIndex: 2, name: "b", category: "cpu", clockDomain: "cpu-main", start: 2, duration: 1, availability: "available", instrumented: false },
        { id: 1, parentId: null, frameIndex: 2, name: "a", category: "cpu", clockDomain: "cpu-main", start: 1, duration: 1, availability: "available", instrumented: false, unknownSpanField: 1 }
      ]
    }],
    diagnostics: { z: 2, a: 1 }
  });
  const withUnknownRoot = JSON.parse(serializePerformanceCapture(capture));
  withUnknownRoot.unknownRootField = { ignored: true };
  const imported = parsePerformanceCapture(JSON.stringify(withUnknownRoot));
  const once = serializePerformanceCapture(imported);
  const twice = serializePerformanceCapture(parsePerformanceCapture(once));

  assert.equal(once, twice);
  assert.deepEqual(Object.keys(imported.engine), ["a", "z"]);
  assert.deepEqual(imported.frames[0].spans.map(({ id }) => id), [1, 2]);
  assert.equal("unknownRootField" in imported, false);
  assert.equal("unknownFrameField" in imported.frames[0], false);
  assert.equal("unknownDescriptorField" in imported.metricCatalog[0], false);
  assert.ok(Object.isFrozen(imported.frames[0].samples["cpu.frameMs"]));
});

test("capture import preserves metric statistics and availability coverage", () => {
  const capture = createPerformanceCapture({
    sampling,
    metricCatalog: [cpuDescriptor],
    frames: [
      frame(1, 2),
      frame(2, 4),
      frame(3, null, { samples: { "cpu.frameMs": sample(3, null, "dropped") }, complete: false })
    ]
  });
  const imported = parsePerformanceCapture(serializePerformanceCapture(capture));
  const before = capture.frames.map((item) => item.samples["cpu.frameMs"]);
  const after = imported.frames.map((item) => item.samples["cpu.frameMs"]);
  assert.deepEqual(
    summarizeProfileSeries(after.filter(({ value }) => value !== null).map(({ value }) => value)),
    summarizeProfileSeries(before.filter(({ value }) => value !== null).map(({ value }) => value))
  );
  assert.deepEqual(summarizeMetricCoverage(after), summarizeMetricCoverage(before));
});

test("capture rejects future schemas, non-finite values and invalid frame order", () => {
  const valid = createPerformanceCapture({ sampling, metricCatalog: [cpuDescriptor], frames: [frame(1, 2)] });
  const parsed = JSON.parse(serializePerformanceCapture(valid));
  assert.throws(() => parsePerformanceCapture(JSON.stringify({ ...parsed, schemaVersion: 99 })), /schema/);
  assert.throws(() => parsePerformanceCapture(serializePerformanceCapture(valid).replace('"value": 2', '"value": 1e400')), /finite/);
  assert.throws(
    () => createPerformanceCapture({ sampling, metricCatalog: [cpuDescriptor], frames: [frame(1, 2), frame(1, 3)] }),
    /strictly increasing/
  );
  assert.throws(
    () => createPerformanceCapture({ sampling, metricCatalog: [cpuDescriptor], frames: [frame(2, 2), frame(1, 3)] }),
    /strictly increasing/
  );
  assert.throws(
    () => createPerformanceCapture({ sampling, metricCatalog: [cpuDescriptor], frames: [frame(1, Number.NaN)] }),
    /finite/
  );
});

test("capture validates every metric descriptor field and rejects runtime objects", () => {
  assert.throws(
    () => createPerformanceCapture({ sampling, metricCatalog: [{ ...cpuDescriptor, unit: "seconds" }], frames: [] }),
    /unit/
  );
  assert.throws(
    () => createPerformanceCapture({ sampling, metricCatalog: [{ ...cpuDescriptor, description: "" }], frames: [] }),
    /description/
  );
  assert.throws(
    () => createPerformanceCapture({ sampling, metricCatalog: [], frames: [frame(1, 2)] }),
    /catalog/
  );
  class GpuLikeObject { destroy() {} }
  assert.throws(
    () => createPerformanceCapture({ engine: { device: new GpuLikeObject() }, sampling, metricCatalog: [], frames: [] }),
    /plain JSON object/
  );
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  createPerformanceCapture,
  parsePerformanceCapture,
  serializePerformanceCapture
} from "../.test-dist/debug/profiling/PerformanceCapture.js";

const base = {
  frameIndex: 1,
  epoch: 1,
  warmup: false,
  visibilityState: "visible",
  samples: {
    "cpu.frameMs": {
      metricId: "cpu.frameMs",
      value: 2,
      availability: "available",
      sourceFrameIndex: 1,
      resolvedAtFrameIndex: 1,
      instrumented: false
    }
  },
  spans: [],
  gpuCounterSchemaVersion: 1,
  timestampInstrumented: false,
  counterInstrumented: false,
  complete: true
};

test("performance capture round trips deterministically and rejects invalid schema", () => {
  const capture = createPerformanceCapture({
    engine: { commit: "test", dirty: false },
    environment: { frame: { canvasWidth: 1, canvasHeight: 1 } },
    sampling: { mode: "record", warmupFrames: 1, timestampInterval: 1, counterInterval: 4, historyCapacity: 8 },
    metricCatalog: [],
    frames: [base],
    diagnostics: { validationErrorCount: 0 }
  });
  const serialized = serializePerformanceCapture(capture);
  assert.deepEqual(parsePerformanceCapture(serialized), capture);
  assert.throws(() => parsePerformanceCapture(serialized.replace('"schemaVersion": 1', '"schemaVersion": 99')), /schema/);
});

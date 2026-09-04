import test from "node:test";
import assert from "node:assert/strict";

import { exportChromeTrace } from "../.test-dist/debug/profiling/ChromeTraceExporter.js";

test("trace exporter keeps CPU and GPU clock domains separate", () => {
  const trace = exportChromeTrace({
    frames: [{
      frameIndex: 3,
      spans: [
        { id: 1, parentId: null, frameIndex: 3, name: "frame", category: "cpu", clockDomain: "cpu-main", start: 10, duration: 2, availability: "available", instrumented: false },
        { id: 2, parentId: null, frameIndex: 3, name: "pass", category: "gpu", clockDomain: "gpu-device", start: null, duration: 1, availability: "available", instrumented: true }
      ],
      samples: {
        "gpu.passSumMs": { metricId: "gpu.passSumMs", value: 1, availability: "available", sourceFrameIndex: 3, resolvedAtFrameIndex: 4, instrumented: true }
      }
    }]
  });
  assert.equal(trace.metadata.cpuGpuClockAligned, false);
  assert.equal(trace.traceEvents.some((event) => event.name === "pass" && event.ph === "C"), true);
  assert.equal(trace.traceEvents.some((event) => event.name === "frame" && event.tid === "cpu-main"), true);
});

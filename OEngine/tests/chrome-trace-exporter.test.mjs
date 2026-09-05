import test from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";

import * as traceExporter from "../.test-dist/debug/profiling/ChromeTraceExporter.js";

const { exportChromeTrace } = traceExporter;

test("trace exporter keeps CPU and GPU clock domains separate", () => {
  const trace = exportChromeTrace({
    frames: [{
      frameIndex: 3,
      spans: [
        { id: 1, parentId: null, frameIndex: 3, name: "frame", category: "cpu", clockDomain: "cpu-main", start: 10, duration: 2, availability: "available", instrumented: false },
        { id: 2, parentId: null, frameIndex: 3, name: "pass", category: "gpu", clockDomain: "gpu-device", start: null, duration: 1, availability: "available", instrumented: true }
      ],
      samples: {
        "gpu.passSumMs": { metricId: "gpu.passSumMs", value: 1, availability: "available", sourceFrameIndex: 3, resolvedAtFrameIndex: 4, instrumented: true },
        "gpu.pendingMs": { metricId: "gpu.pendingMs", value: null, availability: "pending", sourceFrameIndex: 3, resolvedAtFrameIndex: null, instrumented: true }
      }
    }]
  });
  assert.equal(trace.metadata.cpuGpuClockAligned, false);
  assert.equal(trace.traceEvents.some((event) => event.name === "pass" && event.ph === "C"), true);
  assert.equal(trace.traceEvents.some((event) => event.name === "frame" && event.tid === "cpu-main"), true);
  assert.deepEqual(
    trace.traceEvents.find((event) => event.name === "gpu.pendingMs")?.args,
    {
      value: null,
      frameIndex: 3,
      sourceFrameIndex: 3,
      resolvedAtFrameIndex: null,
      instrumented: true,
      availability: "pending"
    }
  );
});

test("trace exporter supports deterministic chunked serialization", () => {
  assert.equal(typeof traceExporter.streamChromeTrace, "function");
  assert.equal(typeof traceExporter.serializeChromeTrace, "function");

  const input = {
    frames: [{
      frameIndex: 3,
      spans: [
        { id: 2, parentId: null, frameIndex: 3, name: "pass", category: "gpu", clockDomain: "gpu-device", start: null, duration: 1, availability: "available", instrumented: true },
        { id: 1, parentId: null, frameIndex: 3, name: "frame", category: "cpu", clockDomain: "cpu-main", start: 10, duration: 2, availability: "available", instrumented: false }
      ],
      samples: {
        "gpu.pendingMs": { metricId: "gpu.pendingMs", value: null, availability: "pending", sourceFrameIndex: 3, resolvedAtFrameIndex: null, instrumented: true },
        "gpu.passSumMs": { metricId: "gpu.passSumMs", value: 1, availability: "available", sourceFrameIndex: 3, resolvedAtFrameIndex: 4, instrumented: true }
      }
    }]
  };
  const serialized = traceExporter.serializeChromeTrace(input);
  assert.equal(serialized, [...traceExporter.streamChromeTrace(input)].join(""));
  assert.equal(serialized, traceExporter.serializeChromeTrace(input));
  assert.equal(
    serialized,
    fs.readFileSync(new URL("./fixtures/chrome-trace-v1.golden.json", import.meta.url), "utf8")
  );
});

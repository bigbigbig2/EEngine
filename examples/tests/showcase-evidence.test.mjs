import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const sourceUrl = new URL("../integrated-showcase/evidence.ts", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022
  },
  fileName: sourceUrl.pathname
}).outputText;
const evidence = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);

const {
  ShowcaseEvidenceWindow,
  classifyShowcaseGpuDomain,
  percentiles
} = evidence;

function frame(frameIndex, {
  cpuMs = frameIndex,
  gpuSegments = [],
  counterSampled = false,
  counterValues = {},
  commands = {}
} = {}) {
  return {
    frameIndex,
    cpuMs: { frame: cpuMs },
    submits: { count: 1, labels: {} },
    readbacks: { count: 0, bytes: 0, labels: {} },
    uploads: { writes: 0, bytes: 0, labels: {} },
    graph: { builds: 0, compiles: 0, executes: 1, cacheHits: 1, cacheMisses: 0, cacheEvictions: 0 },
    counters: commands,
    gpu: {
      available: true,
      sampled: gpuSegments.length > 0,
      pending: false,
      segments: gpuSegments
    },
    gpuCounters: {
      available: true,
      sampled: counterSampled,
      pending: false,
      dropped: false,
      schemaVersion: 10,
      values: counterValues
    }
  };
}

function segment(label, phase, durationMs, type = "compute") {
  return { label, phase, durationMs, type };
}

test("native material-resolve phase wins over a misleading velocity label", () => {
  assert.equal(classifyShowcaseGpuDomain(segment(
    "Material Resolve/specialized Surface",
    "material-resolve",
    12.26,
    "render"
  )), "Surface");
});

test("counter-instrumented timestamp frames do not contaminate the production GPU baseline", () => {
  const window = new ShowcaseEvidenceWindow(32);
  window.registerFrame(1, { rafIntervalMs: 20 });
  window.update(frame(1, {
    gpuSegments: [segment("resolve", "material-resolve", 4, "render")]
  }));
  window.registerFrame(2, { rafIntervalMs: 22 });
  window.update(frame(2, {
    gpuSegments: [
      segment("resolve", "material-resolve", 40, "render"),
      segment("counter", "observability", 3)
    ],
    counterSampled: true,
    counterValues: { shadedPixels: 123 }
  }));

  const summary = window.summarize();
  assert.equal(summary.timestampSampleCount, 1);
  assert.equal(summary.counterInstrumentedTimestampSampleCount, 1);
  assert.equal(summary.gpuPassSum.p50, 4);
  assert.equal(summary.gpuPhases.get("material-resolve").p50, 4);
  assert.equal(summary.observability.p50, 3);
  assert.equal(summary.latestCounterFrame, 2);
});

test("a new epoch rejects warm-up frames and delayed evidence from the old epoch", () => {
  const window = new ShowcaseEvidenceWindow(32);
  window.beginEpoch("camera-a", 1);
  window.registerFrame(1, { rafIntervalMs: 30 });
  window.update(frame(1, { gpuSegments: [segment("resolve", "material-resolve", 30)] }));
  window.registerFrame(2, { rafIntervalMs: 20 });
  window.update(frame(2, { gpuSegments: [segment("resolve", "material-resolve", 20)] }));

  window.beginEpoch("camera-b", 1);
  window.registerFrame(3, { rafIntervalMs: 40 });
  window.update(frame(3, { gpuSegments: [segment("resolve", "material-resolve", 40)] }));
  window.registerFrame(4, { rafIntervalMs: 16 });
  window.update(frame(4, { cpuMs: 2, gpuSegments: [segment("resolve", "material-resolve", 4)] }));

  // Simulate a delayed timestamp notification replacing an old frame after the epoch changed.
  window.update(frame(2, { gpuSegments: [segment("resolve", "material-resolve", 200)] }));

  const summary = window.summarize();
  assert.equal(summary.sampleKey, "camera-b");
  assert.equal(summary.timestampSampleCount, 1);
  assert.equal(summary.gpuPassSum.p50, 4);
  assert.equal(summary.frameInterval.p50, 16);
  assert.equal(summary.cpuFrame.p50, 2);
  assert.equal(summary.warmupFramesRemaining, 0);
});

test("frame, CPU and GPU distributions retain independent sample counts and nearest-rank percentiles", () => {
  const window = new ShowcaseEvidenceWindow(32);
  for (let index = 1; index <= 4; index++) {
    window.registerFrame(index, { rafIntervalMs: index * 10 });
    window.update(frame(index, {
      cpuMs: index,
      gpuSegments: index % 2 === 0
        ? [segment("resolve", "material-resolve", index * 2, "render")]
        : []
    }));
  }

  const summary = window.summarize();
  assert.deepEqual(summary.frameInterval, { p50: 20, p95: 40, p99: 40, sampleCount: 4 });
  assert.deepEqual(summary.cpuFrame, { p50: 2, p95: 4, p99: 4, sampleCount: 4 });
  assert.deepEqual(summary.gpuPassSum, { p50: 4, p95: 8, p99: 8, sampleCount: 2 });
  assert.deepEqual(percentiles([1, 2, 3, 4]), { p50: 2, p95: 4, p99: 4, sampleCount: 4 });
});

test("a per-frame sample key change starts a new coherent measurement epoch", () => {
  const window = new ShowcaseEvidenceWindow(32);
  window.registerFrame(1, { sampleKey: "1920x1080|taa-off", rafIntervalMs: 16 });
  window.update(frame(1, { gpuSegments: [segment("resolve", "material-resolve", 8)] }));
  window.registerFrame(2, { sampleKey: "1280x720|taa-off", rafIntervalMs: 12 });
  window.update(frame(2, { gpuSegments: [segment("resolve", "material-resolve", 3)] }));

  const summary = window.summarize();
  assert.equal(summary.sampleKey, "1280x720|taa-off");
  assert.equal(summary.timestampSampleCount, 1);
  assert.equal(summary.gpuPassSum.p50, 3);
  assert.equal(summary.frameInterval.p50, 12);
});

import assert from "node:assert/strict";
import test from "node:test";
import { GPUFrameTimingRing } from "../../.test-dist/framegraph/GPUFrameTiming.js";
import {
  GPUPerformanceTimer,
  GPUStatisticsHistory,
} from "../../.test-dist/framegraph/GPUPerformanceTimer.js";
import { summarizeGpuTimingCost } from "../../.test-dist/debug/GpuTimingCost.js";
import { ResourceAccounting } from "../../.test-dist/debug/profiling/ResourceAccounting.js";
import { FrameProfiler } from "../../.test-dist/debug/FrameProfiler.js";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";
import { BenchmarkHarness } from "../../.test-dist/debug/BenchmarkHarness.js";
import {
  SURFACE_DIAGNOSTICS_BYTE_SIZE,
  SURFACE_DIAGNOSTICS_HEADER_WORDS,
  SURFACE_DIAGNOSTICS_COUNTERS as C,
  SURFACE_DIAGNOSTIC_DESCRIPTORS,
  decodeSurfaceDiagnostics,
  writeSurfaceDiagnosticsHeader,
} from "../../.test-dist/gpu/SurfaceDiagnosticsAbi.js";
globalThis.GPUBufferUsage = { QUERY_RESOLVE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8 };
globalThis.GPUMapMode = { READ: 1 };
function fixture() {
  let tick = 100n,
    creates = 0;
  const pending = [];
  const device = {
    features: new Set(["timestamp-query"]),
    createQuerySet: (d) => ({ ...d, values: new BigUint64Array(d.count), destroy() {} }),
    createBuffer(d) {
      creates++;
      const bytes = new ArrayBuffer(d.size);
      return {
        ...d,
        bytes,
        destroy() {},
        mapAsync() {
          return new Promise((resolve) => pending.push(resolve));
        },
        getMappedRange(o, s) {
          return bytes.slice(o, o + s);
        },
        unmap() {},
      };
    },
  };
  const encoder = {
    beginComputePass({ timestampWrites: w }) {
      if (w) w.querySet.values[w.beginningOfPassWriteIndex] = tick++;
      return { end() {} };
    },
    resolveQuerySet(q, start, n, b) {
      new BigUint64Array(b.bytes).set(q.values.subarray(start, start + n));
    },
    copyBufferToBuffer(a, ao, b, bo, n) {
      new Uint8Array(b.bytes, bo, n).set(new Uint8Array(a.bytes, ao, n));
    },
  };
  return {
    device,
    encoder,
    pending,
    get creates() {
      return creates;
    },
  };
}
test("pending mapping cannot reuse a ring slot; abort and out-of-order completion preserve labels", async () => {
  const f = fixture(),
    ledger = new ResourceAccounting(),
    ring = new GPUFrameTimingRing(f.device, 2, 8, ledger);
  const first = ring.acquire("coarse"),
    second = ring.acquire("coarse");
  first.begin(f.encoder);
  first.resolve(f.encoder);
  const a = first.download();
  second.begin(f.encoder);
  second.resolve(f.encoder);
  const b = second.download();
  assert.equal(ring.acquire("coarse"), null);
  assert.equal(ring.evidence().dropped, 1);
  f.pending[1]();
  assert.equal((await b)[0].scope, "span");
  const replacement = ring.acquire("full");
  replacement.abort();
  f.pending[0]();
  assert.equal((await a)[0].start, 100n);
  assert.equal(f.creates, 4, "two slots reuse their two buffers");
  ring.destroy();
  assert.equal(ledger.snapshot().totalBytes, 0);
});
test("production and unsupported timestamp devices allocate nothing; bounded stages report truncation", () => {
  const f = fixture(),
    ring = new GPUFrameTimingRing(f.device, 1, 4);
  assert.equal(ring.acquire("production"), null);
  assert.equal(f.creates, 0);
  f.device.features.clear();
  assert.equal(ring.acquire("full"), null);
  assert.equal(f.creates, 0);
  f.device.features.add("timestamp-query");
  const s = ring.acquire("stage");
  s.begin(f.encoder);
  for (let i = 0; i < 100; i++) s.enterStage(f.encoder, "stage" + i);
  s.resolve(f.encoder);
  assert.equal(s.evidence().queries, 8);
  assert.equal(s.evidence().truncated, true);
  s.abort();
  ring.destroy();
});
test("destroy while mapping defers physical destruction and resolves one sample", async () => {
  const f = fixture(),
    ledger = new ResourceAccounting(),
    ring = new GPUFrameTimingRing(f.device, 1, 4, ledger);
  const s = ring.acquire("coarse");
  s.begin(f.encoder);
  s.resolve(f.encoder);
  const p = s.download();
  ring.destroy();
  assert.ok(ledger.snapshot().totalBytes > 0);
  f.pending[0]();
  await p;
  assert.equal(ledger.snapshot().totalBytes, 0);
});
test("same-frame costs separate scopes and independent management/evaluation arithmetic", () => {
  const result = summarizeGpuTimingCost([
    { label: "frame-span", scope: "span", durationMs: 20 },
    { label: "surface", scope: "stage", durationMs: 17 },
    { label: "Surface/emit_surface_requests", scope: "pass", durationMs: 3 },
    { label: "Surface/unique GeometryRecord", scope: "pass", durationMs: 5 },
    { label: "Surface/reconstruct", scope: "pass", durationMs: 2 },
    { label: "unknown", scope: "pass", durationMs: 1 },
  ]);
  assert.equal(result.passSumMs, 11);
  assert.equal(result.outsidePassMs, 9);
  assert.equal(result.surfaceManagementMs, 3);
  assert.equal(result.surfaceEvaluationMs, 5);
  assert.equal(result.surfaceAuxiliaryMs, 2);
  assert.equal(result.queueCompletionMs, null);
  assert.equal(
    summarizeGpuTimingCost([{ label: "frame-span", scope: "span", durationMs: 20 }]).passSumMs,
    null,
  );
});
test("diagnostic unit is independently 128 bytes / 4; queue descriptions never prove completion", () => {
  const id = { runId: "test", deviceEpoch: 1, frameId: 9 },
    words = new Uint32Array(SURFACE_DIAGNOSTICS_BYTE_SIZE / 4);
  writeSurfaceDiagnosticsHeader(words, id, "detailed");
  for (const [name, value] of [
    ["geometryDescriptions", 7],
    ["geometryRecordStrideWords", 32],
    ["materialEvaluatorCompleted", 7],
  ]) {
    const index = C[name];
    words[8 + (index >>> 5)] |= 1 << (index & 31);
    words[SURFACE_DIAGNOSTICS_HEADER_WORDS + index] = value;
  }
  const snapshot = decodeSurfaceDiagnostics(words.buffer, id, "detailed");
  assert.equal(snapshot.values.geometryDescriptions, 7);
  assert.equal(snapshot.values.geometryRecordStrideWords, 32);
  assert.equal(snapshot.values.materialEvaluatorCompleted, undefined);
  assert.equal(snapshot.coverage.status, "unknown");
  assert.equal(SURFACE_DIAGNOSTIC_DESCRIPTORS.materialEvaluatorCompleted.availability, "unavailable");
  assert.equal(
    decodeSurfaceDiagnostics(words.buffer, { ...id, frameId: 10 }, "detailed").availability,
    "invalid",
  );
  words[SURFACE_DIAGNOSTICS_HEADER_WORDS + C.geometryRecordStrideWords] = 8;
  assert.equal(decodeSurfaceDiagnostics(words.buffer, id, "detailed").coverage.status, "fail");
});
test("physical ledger deduplicates imports and reports retired peaks independently", () => {
  const ledger = new ResourceAccounting(),
    physical = {},
    input = { kind: "buffer", owner: "scratch", bytes: 128 };
  const handle = ledger.created(input, physical);
  assert.equal(ledger.created(input, physical), handle);
  assert.equal(ledger.snapshot().totalBytes, 128);
  ledger.setRetired(handle, true);
  assert.equal(ledger.snapshot().retiredBytes, 128);
  assert.equal(ledger.snapshot().liveBytes, 0);
  ledger.destroyed(handle);
  assert.equal(ledger.snapshot().totalBytes, 0);
  assert.equal(ledger.snapshot().retiredPeakBytes, 128);
});
test("standalone timer reports unavailable rather than zero and history has no u32 overflow", () => {
  const f = fixture();
  f.device.features.clear();
  const timer = new GPUPerformanceTimer(f.device);
  assert.equal(timer.getComputeWrites(), undefined);
  assert.equal(timer.data.duration, null);
  timer.destroy();
  const stats = new GPUStatisticsHistory();
  stats.record(5e9);
  assert.equal(stats.last, 5e9);
  assert.equal(stats.average, 5e9);
  stats.history_length = 2;
  stats.record(4);
  stats.record(8);
  stats.record(12);
  assert.equal(stats.average, 10);
});

test("a failed query page waits for every other pending mapping before releasing its slot", async () => {
  const f = fixture();
  let readbacks = 0,
    settleOther;
  const create = f.device.createBuffer;
  f.device.createBuffer = (d) => {
    const buffer = create(d);
    if (d.usage & GPUBufferUsage.MAP_READ) {
      const index = readbacks++;
      buffer.mapAsync = () =>
        index === 0
          ? Promise.reject(new Error("first page failed"))
          : new Promise((resolve) => (settleOther = resolve));
    }
    return buffer;
  };
  const ring = new GPUFrameTimingRing(f.device, 1, 2048),
    s = ring.acquire("full");
  s.begin(f.encoder);
  for (let i = 0; i < 1025; i++) s.writes("pass" + i, "compute");
  s.resolve(f.encoder);
  const result = s.download().then(
    () => null,
    (error) => error,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ring.evidence().pending, 1);
  assert.equal(ring.acquire("full"), null);
  settleOther();
  assert.match((await result).message, /first page failed/);
  assert.equal(ring.evidence().pending, 0);
  ring.destroy();
});
test("partial query coverage never attributes missing evaluation to copy/clear or zero cost", () => {
  const cost = summarizeGpuTimingCost(
    [
      { label: "frame-span", scope: "span", durationMs: 7 },
      { label: "Surface/emit_surface_requests", scope: "pass", durationMs: 2 },
    ],
    false,
  );
  assert.equal(cost.passSumMs, 2, "partial subtotal is retained");
  assert.equal(cost.outsidePassMs, null);
  assert.equal(cost.surfaceEvaluationMs, null);
  assert.equal(cost.surfaceManagementMs, null);
});
test("same-frame contexts accumulate query tax and preserve incomplete timing coverage", async () => {
  const f = fixture();
  f.device.createCommandEncoder = () => ({ ...f.encoder, finish: () => ({}) });
  f.device.queue = { submit() {}, onSubmittedWorkDone: () => Promise.resolve() };
  const profiler = new FrameProfiler({
    enabled: true,
    gpuSampleInterval: 1,
    gpuTimestampAvailable: true,
    gpuTimingMode: "coarse",
  });
  const graphics = {
    device: f.device,
    profiler,
    buffer_allocator_main: { release() {} },
    buffer_allocator_staging: { release() {} },
  };
  profiler.beginFrame(1);
  for (let i = 0; i < 2; i++) {
    const c = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    c.finish();
  }
  const frame = profiler.endFrame();
  for (const resolve of f.pending) resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(frame.counters["gpu.timing.queries"], 4);
  assert.equal(frame.counters["gpu.timing.markerPasses"], 4);
  assert.equal(profiler.latest.gpu.cost.commandSpanCount, 2);
  profiler.destroy();
});

test("cleared frame identity cannot be patched by a delayed old batch", async () => {
  const f = fixture();
  f.device.createCommandEncoder = () => ({ ...f.encoder, finish: () => ({}) });
  f.device.queue = { submit() {}, onSubmittedWorkDone: () => Promise.resolve() };
  const profiler = new FrameProfiler({
    enabled: true,
    gpuSampleInterval: 1,
    gpuTimestampAvailable: true,
    gpuTimingMode: "coarse",
  });
  const graphics = {
    device: f.device,
    profiler,
    buffer_allocator_main: { release() {} },
    buffer_allocator_staging: { release() {} },
  };
  profiler.beginFrame(1);
  ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame").finish();
  profiler.endFrame();
  profiler.clear();
  profiler.beginFrame(1);
  ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame").finish();
  profiler.endFrame();
  f.pending[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(profiler.latest.gpu.pending, true, "old completion must not fill a reused frame index");
  f.pending[1]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(profiler.latest.gpu.pending, false);
  assert.equal(profiler.latest.gpu.segments[0].startTick, "102");
  profiler.destroy();
});

test("full diagnostic timestamps expire after 120 sampled frames", () => {
  const profiler = new FrameProfiler({
    enabled: true,
    gpuSampleInterval: 1,
    gpuTimestampAvailable: true,
    gpuTimingMode: "full",
  });
  for (let frame = 0; frame < 120; frame++) {
    profiler.beginFrame(frame);
    assert.equal(profiler.endFrame().gpu.mode, "full");
  }
  profiler.beginFrame(120);
  assert.equal(profiler.endFrame().gpu.mode, "coarse");
  profiler.destroy();
});

test("library benchmark retains truncated facts but cannot publish complete phase percentiles", () => {
  const profiler = new FrameProfiler({ enabled: true });
  profiler.beginFrame(1);
  const frame = profiler.endFrame();
  frame.gpu = {
    available: true,
    sampled: true,
    pending: false,
    segments: [
      {
        label: "Surface/emit_surface_requests",
        type: "compute",
        phase: "unclassified",
        scope: "pass",
        durationMs: 2,
      },
    ],
  };
  frame.counters["gpu.timing.truncated"] = 1;
  const harness = new BenchmarkHarness(
    { schemaVersion: 4, run: { warmupFrames: 0, sampleFrames: 1, featureSet: [] } },
    {},
  );
  harness.recordFrame(frame);
  const report = harness.complete();
  assert.equal(report.frames[0].gpu.segments.length, 1);
  assert.deepEqual(report.summary.surfacePhaseMs, {});
  profiler.destroy();
});

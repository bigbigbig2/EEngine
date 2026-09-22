import assert from "node:assert/strict";
import test from "node:test";

const {
  aggregateFormalPerfRuns,
  assertFormalPerfFreeze,
  assertFormalPerfRun,
  formalPerfFreezeIdentity,
  validateFormalPerfFreeze
} = await import("../../.test-dist/debug/FormalPerfFreeze.js");

const freeze = Object.freeze({
  schemaVersion: 1,
  commit: "a".repeat(40),
  tree: "b".repeat(40),
  dirty: false,
  browser: {
    channel: "chrome-stable",
    version: "140.0.1",
    executableSha256: "c".repeat(64),
    userAgent: "Mozilla/5.0 Chrome/140.0.1"
  },
  adapter: { vendor: "0x10de", architecture: "turing", device: "0x1e04", description: "NVIDIA" },
  capability: {
    featureSet: ["core-features-and-limits", "timestamp-query"],
    limits: { maxStorageBuffersPerShaderStage: 16, maxStorageBufferBindingSize: 134217728 },
    timestampQuery: true
  },
  resolution: { width: 1920, height: 1080, devicePixelRatio: 1, renderScale: 1 },
  cameraPath: { id: "web-100m-formal-camera-v1", sha256: "d".repeat(64) },
  featureSet: ["core-features-and-limits", "timestamp-query"],
  workload: {
    id: "web-100m-formal-perf-v1",
    sha256: "e".repeat(64),
    sourceSha256: "f".repeat(64),
    sourceTriangles: 100000000
  }
});

function sample(frameIndex, cpu, gpu, cut = false) {
  return {
    frameIndex,
    cpuMs: { frame: cpu, build: cpu * 0.4, submit: cpu * 0.1 },
    gpuMs: gpu,
    ownerPeaks: { sourceBytes: 100, wasmBytes: 200, jsBytes: 300, gpuGeometryBytes: 400 },
    pages: { demand: frameIndex, churn: frameIndex - 1, overflow: 0 },
    cameraCut: cut ? { triggered: true, recoveryMs: 12, recoveryFrames: 3 } : { triggered: false, recoveryMs: null, recoveryFrames: null }
  };
}

function run(samples, overrides = {}) {
  return {
    freeze: { ...freeze, ...overrides.freeze },
    ttfmfMs: overrides.ttfmfMs ?? 18,
    gpuTimestampAvailable: overrides.gpuTimestampAvailable ?? true,
    samples
  };
}

test("formal freeze requires the exact fixed identity and capability feature set", () => {
  assert.deepEqual(validateFormalPerfFreeze(freeze, { requireClean: true, requireGpuTimestamps: true }), []);
  assert.equal(formalPerfFreezeIdentity(freeze).includes(freeze.workload.sha256), true);
  assert.doesNotThrow(() => assertFormalPerfFreeze(freeze, { requireClean: true, requireGpuTimestamps: true }));
  assert.throws(() => assertFormalPerfFreeze({ ...freeze, dirty: true }, { requireClean: true }), /clean revision/u);
  assert.throws(() => assertFormalPerfFreeze({ ...freeze, featureSet: ["timestamp-query", "core-features-and-limits"] }), /sorted/u);
});

test("formal run rejects missing GPU timestamps, duplicate frames, and incomplete cut recovery", () => {
  assert.doesNotThrow(() => assertFormalPerfRun(run([sample(1, 10, 2), sample(2, 12, 3, true)]), { minimumSamples: 2 }));
  assert.throws(() => assertFormalPerfRun(run([sample(1, 10, null)], { gpuTimestampAvailable: false }), { minimumSamples: 1 }), /does not match frozen capability|timestamp-unavailable/u);
  assert.throws(() => assertFormalPerfRun(run([sample(1, 10, 2), sample(1, 11, 2)])), /unique/u);
  assert.throws(() => assertFormalPerfRun(run([{ ...sample(1, 10, 2), cameraCut: { triggered: true, recoveryMs: null, recoveryFrames: null } }])), /recovery metrics/u);
});

test("formal aggregation reports CPU/GPU percentiles, owner peaks, pages, and cut recovery", () => {
  const summary = aggregateFormalPerfRuns([
    run([sample(1, 10, 2), sample(2, 20, 4, true)]),
    run([sample(1, 30, 6), sample(2, 40, 8)])
  ], { minimumSamples: 2 });
  assert.equal(summary.independentRuns, 2);
  assert.deepEqual(summary.cpuMs.frame.p50, 25);
  assert.deepEqual(summary.cpuMs.frame.p95, 38.5);
  assert.deepEqual(summary.gpuMs?.p50, 5);
  assert.equal(summary.ownerPeaks.gpuGeometryBytes, 400);
  assert.equal(summary.pages.overflow.max, 0);
  assert.equal(summary.cameraCutRecoveryMs?.p95, 12);
  assert.equal(summary.cameraCutRecoveryFrames?.p50, 3);
  assert.throws(() => aggregateFormalPerfRuns([
    run([sample(1, 10, 2)]),
    run([sample(1, 10, 2)], { freeze: { commit: "9".repeat(40) } })
  ]), /frozen identity/u);
});

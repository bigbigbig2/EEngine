import test from "node:test";
import assert from "node:assert/strict";

import { validateBenchmarkEvidence } from "../.test-dist/debug/BenchmarkEvidenceGate.js";
import { createBenchmarkCapabilityEvidence } from "../.test-dist/debug/BenchmarkCapabilityEvidence.js";

test("complete clean A/B/C evidence is gate eligible", () => {
  const report = validateBenchmarkEvidence(validResult());
  assert.equal(report.gateEligible, true);
  assert.equal(report.capabilityComplete, true);
  assert.deepEqual(report.blockedCapabilities, []);
  assert.equal(report.baselineRole, "minimum-a");
  assert.deepEqual(report.errors, []);
});

test("supported zero is evidence, while missing and unsupported values are rejected", () => {
  const zero = validResult();
  zero.frames[0].gpuCounters.values.candidateInstances = 0;
  assert.equal(errorCodes(zero).has("gpu-counter-required-field-missing"), false);

  const missing = validResult();
  delete missing.frames[0].gpuCounters.values.candidateInstances;
  assert.ok(errorCodes(missing).has("gpu-counter-required-field-missing"));

  const fakeUnsupported = validResult();
  fakeUnsupported.frames[0].gpuCounters.values.rejectedCone = 0;
  assert.ok(errorCodes(fakeUnsupported).has("gpu-counter-unsupported-field-present"));
});

test("capability matrix rejects missing declarations, fake support and invalid blockers", () => {
  const missingCounter = validResult();
  delete missingCounter.capabilityEvidence.gpuCounters.visitedBvhNodes;
  assert.ok(errorCodes(missingCounter).has("capability-counter-declaration-missing"));

  const unknownCounter = validResult();
  unknownCounter.capabilityEvidence.gpuCounters.futureCounter = {
    status: "unsupported",
    blockerTaskId: "OBS-05",
    reason: "not implemented"
  };
  assert.ok(errorCodes(unknownCounter).has("capability-counter-declaration-unknown"));

  const fakeSupport = validResult();
  fakeSupport.capabilityEvidence.gpuCounters.rejectedCone = {
    status: "supported",
    producer: "fake",
    requiredInSampledFrames: true
  };
  assert.ok(errorCodes(fakeSupport).has("capability-counter-declaration-mismatch"));

  const invalidBlocker = validResult();
  invalidBlocker.capabilityEvidence.gpuCounters.rejectedCone.blockerTaskId = "later";
  assert.ok(errorCodes(invalidBlocker).has("capability-blocker-task-invalid"));

  const reordered = validResult();
  reordered.capabilityEvidence.gpuCounters.candidateInstances = {
    requiredInSampledFrames: true,
    producer: "VisibilityPass/scene-frustum-list reducer",
    status: "supported"
  };
  assert.equal(errorCodes(reordered).has("capability-counter-declaration-mismatch"), false);
});

test("unsupported feature set stays structurally valid but reports a product blocker", () => {
  const result = validResult(["software-visibility"]);
  result.frames[0].gpuCounters.values = {};
  const report = validateBenchmarkEvidence(result);
  assert.equal(report.gateEligible, true);
  assert.equal(report.capabilityComplete, false);
  assert.deepEqual(
    report.blockedCapabilities.map((blocker) => [blocker.kind, blocker.id, blocker.blockerTaskId]),
    [["feature-set", "software-visibility", "VIS-05"]]
  );
});

test("R3 hierarchy SSE is supported by visited, selected and RasterWork counters", () => {
  const result = validResult(["hardware-visibility", "hierarchy-sse-lod"]);
  const report = validateBenchmarkEvidence(result);
  assert.equal(report.capabilityComplete, true);
  assert.deepEqual(report.blockedCapabilities, []);
});

test("R2 Packed Instances is supported by real production counters", () => {
  const result = validResult(["hardware-visibility", "packed-instances"]);
  const report = validateBenchmarkEvidence(result);
  assert.equal(report.capabilityComplete, true);
  assert.deepEqual(report.blockedCapabilities, []);
});

test("old dirty smoke artifacts remain exploratory instead of passing a gate", () => {
  const result = validResult();
  result.schemaVersion = 1;
  result.environment.schemaVersion = 1;
  result.environment.engine.dirty = true;
  delete result.environment.engine.dirtyReasons;
  delete result.environment.run.baselineRole;
  result.case.sceneAssetHashes = ["none:empty"];
  result.case.cameraPathHash = "none:static";
  delete result.diagnostics;
  delete result.summary.gpuPhaseMs;
  result.frames[0].gpu.pending = true;
  result.frames[0].gpu.segments[0].phase = "unclassified";
  result.frames[0].gpuCounters.pending = true;

  const report = validateBenchmarkEvidence(result);
  assert.equal(report.gateEligible, false);
  const codes = new Set(report.errors.map((issue) => issue.code));
  for (const code of [
    "schema-version",
    "environment-schema-version",
    "non-gate-baseline-role",
    "engine-dirty",
    "dirty-reasons-missing",
    "asset-hash-placeholder",
    "camera-hash-placeholder",
    "required-object-missing",
    "gpu-timestamp-pending",
    "gpu-counter-pending",
    "gpu-phase-unclassified",
    "gpu-phase-summary-missing"
  ]) {
    assert.ok(codes.has(code), code);
  }
});

test("gate rejects phase, summary, counter and diagnostics corruption", () => {
  const invalidPhase = validResult();
  invalidPhase.frames[0].gpu.segments[0].phase = "invented-phase";
  assert.ok(errorCodes(invalidPhase).has("gpu-phase-invalid"));

  const invalidSummary = validResult();
  invalidSummary.summary.gpuPhaseMs["hardware-raster"].mean = 2;
  assert.ok(errorCodes(invalidSummary).has("gpu-phase-summary-value-mismatch"));

  const pendingCounter = validResult();
  pendingCounter.frames[0].gpuCounters.pending = true;
  const pendingCodes = errorCodes(pendingCounter);
  assert.ok(pendingCodes.has("gpu-counter-pending"));
  assert.ok(pendingCodes.has("gpu-counter-samples-missing"));

  const invalidCounter = validResult();
  invalidCounter.frames[0].gpuCounters.values.futureCounter = -1;
  const counterCodes = errorCodes(invalidCounter);
  assert.ok(counterCodes.has("gpu-counter-field-unknown"));
  assert.ok(counterCodes.has("gpu-counter-value-invalid"));

  const mismatchedDiagnostics = validResult();
  mismatchedDiagnostics.diagnostics.uncapturedErrorCount = 1;
  assert.ok(
    errorCodes(mismatchedDiagnostics).has(
      "diagnostics-uncapturedErrors-count-mismatch"
    )
  );

  const failedTimestamp = validResult();
  failedTimestamp.diagnostics.failedGpuTimestampBatches = 1;
  assert.ok(
    errorCodes(failedTimestamp).has(
      "diagnostics-failedGpuTimestampBatches"
    )
  );

  const malformedHash = validResult();
  malformedHash.case.sceneAssetHashes = ["sha256:abcd"];
  assert.ok(errorCodes(malformedHash).has("asset-hash-placeholder"));

  const incompleteEnvironment = validResult();
  incompleteEnvironment.environment.engine.commit = "unknown";
  incompleteEnvironment.environment.webgpu.features = [];
  incompleteEnvironment.environment.webgpu.limits = {};
  incompleteEnvironment.environment.webgpu.powerPreference = "unknown";
  incompleteEnvironment.case.seed = 0.5;
  const environmentCodes = errorCodes(incompleteEnvironment);
  for (const code of [
    "engine-commit-missing",
    "timestamp-capability-inconsistent",
    "webgpu-limits-missing",
    "power-preference-missing",
    "case-seed-invalid"
  ]) {
    assert.ok(environmentCodes.has(code), code);
  }
});

function errorCodes(result) {
  return new Set(
    validateBenchmarkEvidence(result).errors.map((issue) => issue.code)
  );
}

function validResult(featureSet = ["hardware-visibility", "hzb-culling"]) {
  const gpuCounterValues = featureSet.includes("hardware-visibility")
    ? {
        candidateInstances: 0,
        visibleInstances: 0,
        candidateClusters: 1,
        selectedClusters: 1,
        rejectedFrustum: 0,
        rejectedHzb: 0,
        hwClusters: 1,
        alphaClusters: 0,
        hwTriangles: 128,
        shadedPixels: 0,
        emptyVisibilityPixels: 2073600,
        queueOverflowMask: 0
      }
    : {};
  return {
    schemaVersion: 3,
    environment: {
      schemaVersion: 3,
      capturedAt: "2026-08-26T00:00:00.000Z",
      engine: {
        commit: "0123456789abcdef",
        dirty: false,
        dirtyReasons: []
      },
      platform: { os: "Windows 11", browser: "Chromium", userAgent: "test" },
      adapter: { vendor: "nvidia", architecture: "turing", device: "gpu", description: "GPU", driver: null },
      webgpu: {
        features: ["timestamp-query"],
        limits: { maxTextureDimension2D: 8192 },
        powerPreference: "high-performance",
        timestampQueryAvailable: true
      },
      frame: {
        canvasWidth: 1920,
        canvasHeight: 1080,
        internalWidth: 1920,
        internalHeight: 1080,
        dpr: 1
      },
      run: {
        baselineRole: "minimum-a",
        featureSet,
        warmupFrames: 120,
        sampleFrames: 1,
        gpuSampleInterval: 1,
        gpuCounterSampleInterval: 1,
        readbackRingSlots: 3
      }
    },
    case: {
      id: "A",
      name: "A",
      sceneAssetHashes: [`sha256:${"01".repeat(32)}`],
      seed: 42,
      cameraPathHash: `sha256:${"fe".repeat(32)}`
    },
    capabilityEvidence: createBenchmarkCapabilityEvidence(featureSet),
    frames: [{
      frameIndex: 1,
      cpuMs: { frame: 1 },
      submits: { count: 1, labels: { main: 1 } },
      readbacks: { count: 1, bytes: 256, labels: { counters: 1 } },
      uploads: { writes: 0, bytes: 0, labels: {} },
      graph: { builds: 1, compiles: 1, executes: 1 },
      counters: {},
      gpu: {
        available: true,
        sampled: true,
        pending: false,
        segments: [{ label: "Visibility", type: "render", phase: "hardware-raster", durationMs: 1 }]
      },
      gpuCounters: {
        available: true,
        sampled: true,
        pending: false,
        dropped: false,
        schemaVersion: 1,
        values: gpuCounterValues
      }
    }],
    summary: {
      cpuMs: {},
      gpuMs: { Visibility: { count: 1, mean: 1, min: 1, max: 1, p50: 1, p95: 1, p99: 1 } },
      gpuPhaseMs: { "hardware-raster": { count: 1, mean: 1, min: 1, max: 1, p50: 1, p95: 1, p99: 1 } },
      counters: {},
      gpuCounters: Object.fromEntries(
        Object.entries(gpuCounterValues).map(([name, value]) => [name, series(value)])
      ),
      submits: {},
      readbacks: {},
      uploadBytes: {}
    },
    diagnostics: {
      validationErrorCount: 0,
      uncapturedErrorCount: 0,
      deviceLostCount: 0,
      uncapturedErrors: [],
      deviceLostReasons: [],
      failedGpuTimestampBatches: 0,
      droppedGpuCounterSamples: 0,
      failedGpuCounterSamples: 0
    }
  };
}

function series(value) {
  return { count: 1, mean: value, min: value, max: value, p50: value, p95: value, p99: value };
}

import type { FrameProfileSnapshot, PackedSceneSource } from "../../../OEngine/src/index.ts";
import {
  VALIDATION_FIXTURE_KEY,
  VALIDATION_PROTOCOL_SCHEMA_VERSION,
  validationAssertion,
  validationError,
  type ValidationAssertion,
  type ValidationFixture,
  type ValidationScenarioRequest,
  type ValidationScenarioResult
} from "../fixture-protocol.ts";
import {
  CanonicalPackedRuntime,
  type CanonicalRuntimeCameraPose
} from "../shared/canonical-runtime.ts";
import { FixtureState } from "../shared/fixture-state.ts";
import { createPackedBoxScene, solidMaterial } from "../shared/packed-scene.ts";
import {
  hasGpuFailure,
  validationAdapter,
  validationDiagnostics
} from "../shared/runtime-evidence.ts";

const DEFAULT_POSE: CanonicalRuntimeCameraPose = {
  position: [0, 3, 14],
  target: [0, 1, -1],
  far: 250
};
const NEAR_POSE: CanonicalRuntimeCameraPose = {
  position: [0, 3, 14],
  target: [0, 1, -1],
  far: 250
};
const FAR_POSE: CanonicalRuntimeCameraPose = {
  position: [0, 11, 74],
  target: [0, 1, -1],
  far: 250
};

const canvas = required<HTMLCanvasElement>("gpu-canvas");
const statusElement = required<HTMLElement>("status");
let disposed = false;
const runtime = new CanonicalPackedRuntime({
  canvas,
  camera: DEFAULT_POSE,
  source: createVisibilitySource,
  onDeviceLost: (message) => {
    state.deviceLost({ name: "GPUDeviceLost", message });
    showStatus();
  }
});
const state = new FixtureState({
  fixtureId: "visibility",
  canvas,
  frame: () => runtime.frame,
  adapter: () => validationAdapter(runtime.renderer?.adapter_info ?? null, runtime.renderer?.device ?? null),
  diagnostics: () => validationDiagnostics(runtime.renderer?.profiler.diagnostics)
});
const fixture: ValidationFixture = { getSnapshot: () => state.snapshot(), runScenario, dispose };
window[VALIDATION_FIXTURE_KEY] = fixture;

void runtime.initialize().then(async () => {
  await runtime.waitForFrames(3);
  state.ready();
  showStatus();
}).catch(failFixture);

async function runScenario(request: ValidationScenarioRequest): Promise<ValidationScenarioResult> {
  const supported = ["basic", "frustum", "occlusion", "lod-near", "lod-far", "camera-cut"];
  if (!supported.includes(request.scenarioId)) {
    return failedScenario(request, new Error(`Unknown visibility scenario '${request.scenarioId}'`));
  }
  const startedFrame = runtime.frame;
  state.start(request.runId, request.scenarioId);
  showStatus();
  try {
    const assertions: ValidationAssertion[] = [];
    const evidence: Record<string, unknown> = {};
    let completed: FrameProfileSnapshot;

    if (request.scenarioId === "lod-near" || request.scenarioId === "lod-far") {
      const near = await samplePose(NEAR_POSE, 3);
      const far = await samplePose(FAR_POSE, 3);
      const nearClusters = near.gpuCounters.values.selectedClusters ?? 0;
      const farClusters = far.gpuCounters.values.selectedClusters ?? 0;
      evidence.nearSelectedClusters = nearClusters;
      evidence.farSelectedClusters = farClusters;
      evidence.nearRasterTriangles = near.gpuCounters.values.hwTriangles ?? 0;
      evidence.farRasterTriangles = far.gpuCounters.values.hwTriangles ?? 0;
      assertions.push(validationAssertion("lod-work-produced", nearClusters > 0 && farClusters > 0, "Both near and far views produced hierarchy work", { nearClusters, farClusters }, "> 0"));
      assertions.push(validationAssertion("lod-distance-reduces-work", nearClusters >= farClusters, "Far view does not select more cluster work than near view", { nearClusters, farClusters }, "near >= far"));
      assertions.push(validationAssertion("lod-distance-reduces-raster", (near.gpuCounters.values.hwTriangles ?? 0) >= (far.gpuCounters.values.hwTriangles ?? 0), "Far view does not emit more raster triangles than near view", {
        near: near.gpuCounters.values.hwTriangles ?? 0,
        far: far.gpuCounters.values.hwTriangles ?? 0
      }, "near >= far"));
      completed = request.scenarioId === "lod-near"
        ? await samplePose(NEAR_POSE, 2)
        : far;
    } else if (request.scenarioId === "camera-cut") {
      const before = await samplePose(DEFAULT_POSE, 2);
      const invalidationsBefore = before.counters["hzb.historyInvalidations"] ?? 0;
      runtime.setCamera({ position: [12, 7, 10], target: [0, 1, -1], far: 250 });
      runtime.renderer?.indicate_view_change();
      completed = await runtime.waitForCounters(runtime.frame);
      const invalidationsAfter = completed.counters["hzb.historyInvalidations"] ?? 0;
      evidence.historyInvalidationsBefore = invalidationsBefore;
      evidence.historyInvalidationsAfter = invalidationsAfter;
      evidence.historyValid = completed.counters["hzb.historyValid"] ?? 0;
      assertions.push(validationAssertion("camera-cut-invalidates-hzb", invalidationsAfter > invalidationsBefore, "The explicit camera cut invalidated HZB history", { invalidationsBefore, invalidationsAfter }, "after > before"));
    } else {
      runtime.setCamera(DEFAULT_POSE);
      if (request.scenarioId === "occlusion") await runtime.waitForFrames(8);
      completed = await runtime.waitForCounters(runtime.frame);
    }

    const counters = completed.gpuCounters.values;
    Object.assign(evidence, {
      candidateInstances: counters.candidateInstances ?? 0,
      visibleInstances: counters.visibleInstances ?? 0,
      rejectedFrustum: counters.rejectedFrustum ?? 0,
      rejectedHzb: counters.rejectedHzb ?? 0,
      selectedClusters: counters.selectedClusters ?? 0,
      rasterTriangles: counters.hwTriangles ?? 0,
      queueOverflowMask: counters.queueOverflowMask ?? 0,
      gpuCounterSchemaVersion: completed.gpuCounters.schemaVersion
    });
    assertions.push(validationAssertion("candidate-work-produced", (counters.candidateInstances ?? 0) >= 6, "All fixed visibility candidates reached GPU work generation", counters.candidateInstances, ">= 6"));
    assertions.push(validationAssertion("visible-work-produced", (counters.visibleInstances ?? 0) > 0, "At least one instance remained visible", counters.visibleInstances, "> 0"));
    assertions.push(validationAssertion("raster-work-produced", (counters.hwTriangles ?? 0) > 0, "Hardware Visibility consumed triangle work", counters.hwTriangles, "> 0"));
    assertions.push(validationAssertion("gpu-queue-no-overflow", (counters.queueOverflowMask ?? 0) === 0, "GPU work queues did not overflow", counters.queueOverflowMask, 0));
    if (request.scenarioId === "frustum") {
      assertions.push(validationAssertion("frustum-rejection-observed", (counters.rejectedFrustum ?? 0) > 0, "The off-axis object was rejected by the GPU frustum stage", counters.rejectedFrustum, "> 0"));
    }
    if (request.scenarioId === "occlusion") {
      assertions.push(validationAssertion("hzb-rejection-observed", (counters.rejectedHzb ?? 0) > 0, "The object behind the occluder was rejected by HZB", counters.rejectedHzb, "> 0"));
    }
    const diagnostics = validationDiagnostics(runtime.renderer?.profiler.diagnostics);
    assertions.push(validationAssertion("gpu-diagnostics-clean", !hasGpuFailure(diagnostics), "WebGPU diagnostics are clean", diagnostics));

    const result: ValidationScenarioResult = {
      schemaVersion: VALIDATION_PROTOCOL_SCHEMA_VERSION,
      fixtureId: "visibility",
      runId: request.runId,
      scenarioId: request.scenarioId,
      status: assertions.every((assertion) => assertion.passed) ? "passed" : "failed",
      startedFrame,
      completedFrame: completed.frameIndex,
      evidence,
      assertions,
      diagnostics
    };
    state.finish();
    showStatus();
    return result;
  } catch (error) {
    state.finish();
    showStatus();
    return failedScenario(request, error, startedFrame);
  }
}

async function samplePose(
  pose: CanonicalRuntimeCameraPose,
  settleFrames: number
): Promise<FrameProfileSnapshot> {
  runtime.setCamera(pose);
  await runtime.waitForFrames(settleFrames);
  return runtime.waitForCounters(runtime.frame);
}

async function dispose(): Promise<void> {
  if (disposed) return;
  disposed = true;
  await runtime.destroy();
  state.dispose();
  showStatus();
  delete window[VALIDATION_FIXTURE_KEY];
}

async function createVisibilitySource(): Promise<PackedSceneSource> {
  const visible = solidMaterial([0.2, 0.75, 0.95, 1], 0.35);
  const occluder = solidMaterial([0.14, 0.18, 0.24, 1], 0.85);
  const hidden = solidMaterial([0.95, 0.2, 0.18, 1], 0.5);
  const detail = solidMaterial([0.35, 0.9, 0.38, 1], 0.45);
  return createPackedBoxScene([
    { size: [2, 2, 2], position: [-4, 1, 0], materialIndex: 0, debugId: 1 },
    { size: [5, 5, 1], position: [0, 2.5, 0], materialIndex: 1, debugId: 2, segments: [4, 4, 2] },
    { size: [0.75, 0.75, 0.75], position: [0, 1, -20], materialIndex: 2, debugId: 3, segments: [8, 8, 8] },
    { size: [2, 2, 2], position: [30, 1, 0], materialIndex: 0, debugId: 4 },
    { size: [3, 3, 3], position: [5, 1.5, -1], materialIndex: 3, debugId: 5, segments: [16, 16, 16] },
    { size: [1.5, 1.5, 1.5], position: [-7, 0.75, -3], materialIndex: 0, debugId: 6 }
  ], [visible, occluder, hidden, detail]);
}

function failedScenario(request: ValidationScenarioRequest, error: unknown, startedFrame = runtime.frame): ValidationScenarioResult {
  const normalized = validationError(error);
  return {
    schemaVersion: VALIDATION_PROTOCOL_SCHEMA_VERSION,
    fixtureId: "visibility",
    runId: request.runId,
    scenarioId: request.scenarioId,
    status: "failed",
    startedFrame,
    completedFrame: Math.max(startedFrame + 1, runtime.frame),
    evidence: {},
    assertions: [validationAssertion("scenario-execution", false, normalized.message)],
    diagnostics: validationDiagnostics(runtime.renderer?.profiler.diagnostics),
    error: normalized
  };
}

function failFixture(error: unknown): void {
  state.fail(validationError(error));
  showStatus();
  console.error(error);
}

function showStatus(): void {
  statusElement.dataset.fixtureStatus = state.status;
  statusElement.textContent = state.status;
}

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id}`);
  return element as T;
}

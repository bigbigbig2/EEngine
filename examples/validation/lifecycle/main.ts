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
import { CanonicalPackedRuntime } from "../shared/canonical-runtime.ts";
import { FixtureState } from "../shared/fixture-state.ts";
import { createPackedBoxScene, solidMaterial } from "../shared/packed-scene.ts";
import {
  hasGpuFailure,
  validationAdapter,
  validationDiagnostics
} from "../shared/runtime-evidence.ts";

const canvas = required<HTMLCanvasElement>("gpu-canvas");
const statusElement = required<HTMLElement>("status");
let disposed = false;
let runtime = createRuntime();

const state = new FixtureState({
  fixtureId: "lifecycle",
  canvas,
  frame: () => runtime.frame,
  adapter: () => validationAdapter(runtime.renderer?.adapter_info ?? null, runtime.renderer?.device ?? null),
  diagnostics: () => validationDiagnostics(runtime.renderer?.profiler.diagnostics)
});

const fixture: ValidationFixture = { getSnapshot: () => state.snapshot(), runScenario, dispose };
window[VALIDATION_FIXTURE_KEY] = fixture;

void runtime.initialize().then(() => {
  state.ready();
  showStatus();
}).catch(failFixture);

function createRuntime(): CanonicalPackedRuntime {
  return new CanonicalPackedRuntime({
    canvas,
    camera: { position: [7, 5.5, 8], target: [0, 0.5, 0] },
    source: createLifecycleSource,
    onDeviceLost: (message) => {
      state.deviceLost({ name: "GPUDeviceLost", message });
      showStatus();
    }
  });
}

async function runScenario(request: ValidationScenarioRequest): Promise<ValidationScenarioResult> {
  if (!["init-destroy", "resize", "recreate-renderer", "replace-scene"].includes(request.scenarioId)) {
    return failedScenario(request, new Error(`Unknown lifecycle scenario '${request.scenarioId}'`));
  }
  const startedFrame = runtime.frame;
  let evidenceStartedFrame = startedFrame;
  state.start(request.runId, request.scenarioId);
  showStatus();
  try {
    let profile: FrameProfileSnapshot | null = null;
    let diagnosticsBeforeDestroy: ReturnType<typeof validationDiagnostics> | null = null;
    const evidence: Record<string, unknown> = {};
    const assertions: ValidationAssertion[] = [];

    if (request.scenarioId === "resize") {
      runtime.resize(640, 360);
      profile = await runtime.waitForCounters(startedFrame);
      evidence.width = canvas.width;
      evidence.height = canvas.height;
      evidence.aspect = runtime.renderer?.aspect_ratio ?? 0;
      assertions.push(validationAssertion("resize-dimensions", canvas.width === 640 && canvas.height === 360, "Renderer applied the requested canvas size", [canvas.width, canvas.height], [640, 360]));
      assertions.push(validationAssertion("resize-aspect", Math.abs((runtime.renderer?.aspect_ratio ?? 0) - 640 / 360) < 0.001, "Camera/render aspect follows the resized surface", runtime.renderer?.aspect_ratio, 640 / 360));
    } else if (request.scenarioId === "replace-scene") {
      const oldScene = runtime.scene;
      await runtime.replaceScene(await createReplacementSource());
      profile = await runtime.waitForCounters(startedFrame);
      const sceneEvidence = runtime.renderer?.gpuSceneEvidence();
      evidence.activeInstanceCount = sceneEvidence?.activeInstanceCount ?? 0;
      assertions.push(validationAssertion("scene-identity-replaced", runtime.scene !== oldScene, "The active Scene owner was replaced"));
      assertions.push(validationAssertion("replacement-visible", (profile.gpuCounters.values.shadedPixels ?? 0) > 0, "The replacement scene rendered visible pixels", profile.gpuCounters.values.shadedPixels, "> 0"));
    } else if (request.scenarioId === "recreate-renderer") {
      const oldRenderer = runtime.renderer;
      await runtime.recreate();
      evidenceStartedFrame = 0;
      profile = await runtime.waitForCounters(runtime.frame);
      evidence.previousRendererFrame = startedFrame;
      evidence.rendererRecreated = runtime.renderer !== oldRenderer;
      assertions.push(validationAssertion("renderer-identity-recreated", runtime.renderer !== oldRenderer && runtime.renderer !== null, "A new Renderer owns the recreated runtime"));
      assertions.push(validationAssertion("recreated-renderer-renders", (profile.gpuCounters.values.shadedPixels ?? 0) > 0, "The recreated Renderer produced visible pixels", profile.gpuCounters.values.shadedPixels, "> 0"));
    } else {
      profile = await runtime.waitForCounters(startedFrame);
      diagnosticsBeforeDestroy = validationDiagnostics(runtime.renderer?.profiler.diagnostics);
      await runtime.destroy();
      evidence.runtimeDestroyed = runtime.renderer === null;
      evidence.diagnosticsBeforeDestroy = diagnosticsBeforeDestroy;
      assertions.push(validationAssertion("renderer-destroyed", runtime.renderer === null && runtime.scene === null && runtime.camera === null, "Renderer, Scene and Camera owners were released"));
      assertions.push(validationAssertion("frame-loop-stopped", runtime.frame === 0, "RAF no longer has a live Renderer to advance"));
    }

    const diagnostics = diagnosticsBeforeDestroy ?? validationDiagnostics(runtime.renderer?.profiler.diagnostics);
    assertions.push(validationAssertion("gpu-diagnostics-clean", !hasGpuFailure(diagnostics), "WebGPU diagnostics are clean", diagnostics));
    assertions.push(validationAssertion("frame-evidence-produced", profile !== null && profile.frameIndex > evidenceStartedFrame, "Scenario produced fresh frame evidence", profile?.frameIndex, `> ${evidenceStartedFrame}`));
    if (profile !== null) {
      evidence.completedFrame = profile.frameIndex;
      evidence.shadedPixels = profile.gpuCounters.values.shadedPixels ?? 0;
      evidence.queueOverflowMask = profile.gpuCounters.values.queueOverflowMask ?? 0;
      assertions.push(validationAssertion("gpu-queue-no-overflow", (profile.gpuCounters.values.queueOverflowMask ?? 0) === 0, "GPU work queues did not overflow", profile.gpuCounters.values.queueOverflowMask, 0));
    }

    const completedFrame = Math.max(evidenceStartedFrame + 1, profile?.frameIndex ?? evidenceStartedFrame + 1);
    const result: ValidationScenarioResult = {
      schemaVersion: VALIDATION_PROTOCOL_SCHEMA_VERSION,
      fixtureId: "lifecycle",
      runId: request.runId,
      scenarioId: request.scenarioId,
      status: assertions.every((assertion) => assertion.passed) ? "passed" : "failed",
      startedFrame: evidenceStartedFrame,
      completedFrame,
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

async function dispose(): Promise<void> {
  if (disposed) return;
  disposed = true;
  await runtime.destroy();
  state.dispose();
  showStatus();
  delete window[VALIDATION_FIXTURE_KEY];
}

async function createLifecycleSource(): Promise<PackedSceneSource> {
  return createPackedBoxScene([
    { size: [2, 2, 2], position: [0, 1, 0], materialIndex: 0, debugId: 1 },
    { size: [12, 0.1, 12], position: [0, -0.05, 0], materialIndex: 1, debugId: 2 }
  ], [solidMaterial([0.18, 0.55, 0.95, 1], 0.35), solidMaterial([0.2, 0.22, 0.26, 1], 0.9)]);
}

async function createReplacementSource(): Promise<PackedSceneSource> {
  return createPackedBoxScene([
    { size: [1.5, 3, 1.5], position: [-1.5, 1.5, 0], materialIndex: 0, debugId: 11 },
    { size: [1.5, 1.5, 1.5], position: [1.5, 0.75, 0], materialIndex: 1, debugId: 12 }
  ], [solidMaterial([0.95, 0.25, 0.18, 1], 0.5), solidMaterial([0.2, 0.85, 0.4, 1], 0.25)]);
}

function failedScenario(request: ValidationScenarioRequest, error: unknown, startedFrame = runtime.frame): ValidationScenarioResult {
  const normalized = validationError(error);
  return {
    schemaVersion: VALIDATION_PROTOCOL_SCHEMA_VERSION,
    fixtureId: "lifecycle",
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

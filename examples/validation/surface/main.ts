import {
  ShadeImage,
  ShadeDataType,
  ShadeTexture,
  type FrameProfileSnapshot,
  type PackedSceneSource
} from "../../../OEngine/src/index.ts";
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
const runtime = new CanonicalPackedRuntime({
  canvas,
  camera: { position: [0, 3.5, 15], target: [0, 1, 0], far: 100 },
  source: createSurfaceSource,
  onDeviceLost: (message) => {
    state.deviceLost({ name: "GPUDeviceLost", message });
    showStatus();
  }
});
const state = new FixtureState({
  fixtureId: "surface",
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
  const supported = ["basic", "textured", "material-switch", "texture-fallback"];
  if (!supported.includes(request.scenarioId)) {
    return failedScenario(request, new Error(`Unknown surface scenario '${request.scenarioId}'`));
  }
  const startedFrame = runtime.frame;
  state.start(request.runId, request.scenarioId);
  showStatus();
  try {
    const assertions: ValidationAssertion[] = [];
    const evidence: Record<string, unknown> = {};
    let profile: FrameProfileSnapshot;

    if (request.scenarioId === "material-switch") {
      const before = await runtime.waitForCounters(startedFrame);
      const renderer = runtime.renderer;
      const scene = runtime.scene;
      if (renderer === null || scene === null) throw new Error("Surface runtime is not initialized");
      const patchedMaterialsBefore = renderer.gpuSceneEvidence().patchedMaterialCount;
      renderer.queuePackedScenePatch(scene, {
        frameId: renderer.frame_count + 1,
        materials: {
          indices: new Uint32Array([0]),
          materialIndices: new Uint32Array([2])
        }
      });
      profile = before;
      let patchedMaterialsAfter = patchedMaterialsBefore;
      for (let attempt = 0; attempt < 6 && patchedMaterialsAfter === patchedMaterialsBefore; attempt++) {
        profile = await runtime.waitForCounters(profile.frameIndex);
        patchedMaterialsAfter = renderer.gpuSceneEvidence().patchedMaterialCount;
      }
      evidence.patchedMaterialsBefore = patchedMaterialsBefore;
      evidence.patchedMaterialsAfter = patchedMaterialsAfter;
      assertions.push(validationAssertion("material-patch-applied", patchedMaterialsAfter === patchedMaterialsBefore + 1, "The explicit material patch was consumed by the GPU Scene", { patchedMaterialsBefore, patchedMaterialsAfter }, "after = before + 1"));
    } else {
      profile = await runtime.waitForCounters(startedFrame);
    }

    const gpu = profile.gpuCounters.values;
    const counted = profile.counters;
    const activeMaterials = gpu.activeMaterials ?? 0;
    const residentTextures = counted["packed.material.residentTextures"] ?? 0;
    const residentTextureBytes = counted["packed.material.residentTextureBytes"] ?? 0;
    const textureFallbacks = counted["packed.material.textureFallbacks"] ?? 0;
    Object.assign(evidence, {
      activeMaterials,
      shadedPixels: gpu.shadedPixels ?? 0,
      residentTextures,
      residentTextureBytes,
      textureFallbacks,
      queueOverflowMask: gpu.queueOverflowMask ?? 0,
      gpuCounterSchemaVersion: profile.gpuCounters.schemaVersion
    });
    assertions.push(validationAssertion("materials-resolved", activeMaterials >= 4, "All four fixed materials are addressable by Material Resolve", activeMaterials, ">= 4"));
    assertions.push(validationAssertion("surface-pixels-resolved", (gpu.shadedPixels ?? 0) > 0, "Material Resolve produced visible Surface pixels", gpu.shadedPixels, "> 0"));
    assertions.push(validationAssertion("gpu-queue-no-overflow", (gpu.queueOverflowMask ?? 0) === 0, "GPU work queues did not overflow", gpu.queueOverflowMask, 0));
    if (request.scenarioId === "textured") {
      assertions.push(validationAssertion("texture-resident", residentTextures >= 1 && residentTextureBytes > 0, "The generated texture owns a resident GPU layer", { residentTextures, residentTextureBytes }, "residentTextures >= 1 and bytes > 0"));
      assertions.push(validationAssertion("texture-fallback-bounded", textureFallbacks === 1, "Only the intentionally unusable texture fell back", textureFallbacks, 1));
    }
    if (request.scenarioId === "texture-fallback") {
      assertions.push(validationAssertion("texture-fallback-recorded", textureFallbacks >= 1, "An unusable texture was recorded as an explicit material fallback", textureFallbacks, ">= 1"));
    }
    const diagnostics = validationDiagnostics(runtime.renderer?.profiler.diagnostics);
    assertions.push(validationAssertion("gpu-diagnostics-clean", !hasGpuFailure(diagnostics), "WebGPU diagnostics are clean", diagnostics));

    const result: ValidationScenarioResult = {
      schemaVersion: VALIDATION_PROTOCOL_SCHEMA_VERSION,
      fixtureId: "surface",
      runId: request.runId,
      scenarioId: request.scenarioId,
      status: assertions.every((assertion) => assertion.passed) ? "passed" : "failed",
      startedFrame,
      completedFrame: profile.frameIndex,
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

async function createSurfaceSource(): Promise<PackedSceneSource> {
  const red = solidMaterial([0.9, 0.08, 0.06, 1], 0.7, 0);
  const metal = solidMaterial([0.72, 0.76, 0.82, 1], 0.18, 1);
  const textured = solidMaterial([1, 1, 1, 1], 0.5, 0);
  textured.texture_albedo = createCheckerTexture();
  const fallback = solidMaterial([0.85, 0.2, 0.85, 1], 0.8, 0);
  fallback.texture_albedo = new ShadeTexture();
  return createPackedBoxScene([
    { size: [2.4, 2.4, 2.4], position: [-4.5, 1.2, 0], materialIndex: 0, debugId: 1 },
    { size: [2.4, 2.4, 2.4], position: [-1.5, 1.2, 0], materialIndex: 1, debugId: 2 },
    { size: [2.4, 2.4, 2.4], position: [1.5, 1.2, 0], materialIndex: 2, debugId: 3 },
    { size: [2.4, 2.4, 2.4], position: [4.5, 1.2, 0], materialIndex: 3, debugId: 4 }
  ], [red, metal, textured, fallback]);
}

function createCheckerTexture(): ShadeTexture {
  const pixels = new Uint8Array([
    255, 255, 255, 255, 25, 80, 230, 255,
    25, 80, 230, 255, 255, 255, 255, 255
  ]);
  const image = ShadeImage.fromArrayBuffer(
    pixels.buffer,
    4,
    ShadeDataType.Uint8,
    2,
    2
  );
  const texture = ShadeTexture.from(image);
  texture.label = "validation-surface-checker";
  return texture;
}

function failedScenario(request: ValidationScenarioRequest, error: unknown, startedFrame = runtime.frame): ValidationScenarioResult {
  const normalized = validationError(error);
  return {
    schemaVersion: VALIDATION_PROTOCOL_SCHEMA_VERSION,
    fixtureId: "surface",
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

import {
  PerspectiveCamera,
  Renderer,
  RenderDebugView,
  Scene,
  ShadeDataType,
  ShadeGPUCommandContext,
  ShadeImage,
  ShadeTexture,
  cookGeometryAssetPackage,
  createGeometryCookRecipe,
  load_gltf_packed
} from "../../OEngine/src/index.ts";
import { GPUViewKey } from "../../OEngine/src/render/ViewManager.ts";
import {
  getGpuVisibilityRasterWorkCapacity
} from "../../OEngine/src/gpu/GpuVisibilityKeyAbi.ts";
import {
  validatePackedVisibilityPreparation
} from "../../OEngine/src/render/passes/PackedVisibilityPass.ts";

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DIRTY__: boolean;
declare const __BUILD_DIRTY_REASONS__: readonly string[];

const INITIAL_WIDTH = 768;
const INITIAL_HEIGHT = 432;
const RESIZED_WIDTH = 640;
const RESIZED_HEIGHT = 360;
const status = requiredElement<HTMLElement>("status");
const result = requiredElement<HTMLElement>("result");
const download = requiredElement<HTMLButtonElement>("download");
const canvas = requiredElement<HTMLCanvasElement>("gpu-canvas");
let finalResult: unknown = null;

download.addEventListener("click", () => {
  if (finalResult === null) return;
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob(
    [JSON.stringify(finalResult, null, 2)],
    { type: "application/json" }
  ));
  anchor.download = `oengine-r4-a-05-${__BUILD_COMMIT__.slice(0, 8)}.json`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
});

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  status.textContent = "R4-A-05 lifecycle validation failed";
  status.className = "error";
  result.textContent = message;
  publishResult({ passed: false, fatalError: message });
  console.error(error);
});

async function run(): Promise<void> {
  const context = canvas.getContext("webgpu");
  if (context === null) throw new Error("WebGPU canvas context is unavailable");

  const imported = await load_gltf_packed(
    new URL("../r4-debug-resolve/alpha-mask.gltf", import.meta.url).href
  );
  const recipe = createGeometryCookRecipe();
  const geometries = [];
  for (const geometry of imported.geometries) {
    geometries.push((await cookGeometryAssetPackage(geometry, recipe)).asset);
  }
  const packedSource = {
    geometries,
    materials: imported.materials,
    count: imported.geometryIndices.length,
    geometryIndices: imported.geometryIndices,
    materialIndices: imported.materialIndices,
    currentTransforms: imported.transforms,
    boundsSpheres: imported.boundsSpheres,
    boundsMin: imported.boundsMin,
    boundsMax: imported.boundsMax,
    flags: imported.flags,
    debugIds: Uint32Array.from(
      { length: imported.geometryIndices.length },
      (_, index) => index + 501
    )
  };

  const renderer = new Renderer();
  await renderer.initialize({ context, pixelRatio: 1 });
  configureRenderer(renderer);
  renderer.resize(INITIAL_WIDTH, INITIAL_HEIGHT);
  const scene = createScene();
  await renderer.uploadPackedScene(scene, packedSource);
  const camera = createCamera(INITIAL_WIDTH / INITIAL_HEIGHT);

  renderOrThrow(renderer, camera, scene, "warm-up");
  renderer.profiler.configure({
    enabled: true,
    gpuSampleInterval: 1_000_000,
    gpuCounterSampleInterval: 1_000_000
  });
  renderOrThrow(renderer, camera, scene, "feature-off");
  const featureOffFrame = renderer.profiler.latest;
  if (featureOffFrame === undefined) throw new Error("Missing feature-off frame evidence");

  renderer.profiler.configure({ gpuCounterSampleInterval: 1 });
  const counterFrameIndex = renderer.frame_count;
  renderOrThrow(renderer, camera, scene, "sampled counters");
  await renderer.device.queue.onSubmittedWorkDone();
  const counterFrame = await waitForCounterFrame(renderer, counterFrameIndex);

  const beforeResize = {
    width: renderer.output_resolution.x,
    height: renderer.output_resolution.y
  };
  renderer.profiler.configure({ gpuCounterSampleInterval: 1_000_000 });
  renderer.resize(RESIZED_WIDTH, RESIZED_HEIGHT);
  camera.aspect = RESIZED_WIDTH / RESIZED_HEIGHT;
  camera.update();
  renderOrThrow(renderer, camera, scene, "resize");
  const afterResize = {
    width: renderer.output_resolution.x,
    height: renderer.output_resolution.y
  };

  const viewKey = GPUViewKey.from(camera, scene);
  const beforeCutView = obtainExistingView(renderer, viewKey);
  const invalidationsBeforeCut =
    beforeCutView.hierarchical_z_buffer.historyInvalidationCount;
  camera.transform.position.set(0.35, 0.15, 3.8);
  camera.transform.lookAt({ x: 0, y: 0, z: 0 });
  camera.update();
  renderer.indicate_view_change();
  renderOrThrow(renderer, camera, scene, "camera cut");
  const afterCutView = obtainExistingView(renderer, viewKey);
  const invalidationsAfterCut =
    afterCutView.hierarchical_z_buffer.historyInvalidationCount;

  const oldViewId = afterCutView.id;
  const releaseViewCommand = ShadeGPUCommandContext.create(
    renderer.graphics,
    "Renderer/View/release"
  );
  const removed = renderer.views.remove(viewKey, releaseViewCommand);
  releaseViewCommand.finish();
  await releaseViewCommand.gpuDone;
  renderOrThrow(renderer, camera, scene, "view recreate");
  const recreatedView = obtainExistingView(renderer, viewKey);
  const viewExistsAfterRecreate = renderer.views.exists(viewKey);

  renderOrThrow(renderer, camera, scene, "in-flight predecessor");
  await renderer.releasePackedScene(scene);
  await renderer.uploadPackedScene(scene, packedSource);
  const replacementRendered = renderer.render(camera, scene, 1 / 60);
  await renderer.device.queue.onSubmittedWorkDone();

  const limits = {
    maxBufferSize: Number(renderer.device.limits.maxBufferSize),
    maxStorageBufferBindingSize: Number(
      renderer.device.limits.maxStorageBufferBindingSize
    )
  };
  const capacity = getGpuVisibilityRasterWorkCapacity(limits);
  const exactBoundary = validatePackedVisibilityPreparation(
    capacity.effectiveCapacity,
    limits
  );
  let overflowError: string | null = null;
  try {
    validatePackedVisibilityPreparation(capacity.effectiveCapacity + 1, limits);
  } catch (error) {
    overflowError = error instanceof Error ? error.message : String(error);
  }

  const diagnosticsBeforeLoss = renderer.profiler.diagnostics;
  const oldDevice = renderer.device;
  const lost = oldDevice.lost;
  oldDevice.destroy();
  const lostInfo = await lost;
  await Promise.resolve();
  const oldRendererStopped = renderer.render(camera, scene, 1 / 60) === false;
  const diagnosticsAfterLoss = renderer.profiler.diagnostics;
  renderer.destroy();

  const freshRenderer = new Renderer();
  await freshRenderer.initialize({ context, pixelRatio: 1 });
  configureRenderer(freshRenderer);
  freshRenderer.resize(RESIZED_WIDTH, RESIZED_HEIGHT);
  const freshScene = createScene();
  await freshRenderer.uploadPackedScene(freshScene, packedSource);
  const freshCamera = createCamera(RESIZED_WIDTH / RESIZED_HEIGHT);
  for (let frame = 0; frame < 3; frame++) {
    renderOrThrow(freshRenderer, freshCamera, freshScene, "fresh Renderer recovery");
  }
  await freshRenderer.device.queue.onSubmittedWorkDone();
  const freshDiagnostics = freshRenderer.profiler.diagnostics;

  const featureOffPassed =
    featureOffFrame.gpuCounters.sampled === false &&
    featureOffFrame.readbacks.count === 0 &&
    featureOffFrame.readbacks.bytes === 0 &&
    renderer.render_debug_view === RenderDebugView.None;
  const counterPassed =
    counterFrame.gpuCounters.sampled &&
    counterFrame.gpuCounters.pending === false &&
    counterFrame.gpuCounters.dropped === false &&
    counterFrame.gpuCounters.values.queueOverflowMask === 0 &&
    counterFrame.gpuCounters.values.invalidVisibilityKeys === 0;
  const resizePassed =
    beforeResize.width === INITIAL_WIDTH &&
    beforeResize.height === INITIAL_HEIGHT &&
    afterResize.width === RESIZED_WIDTH &&
    afterResize.height === RESIZED_HEIGHT;
  const cameraCutPassed = invalidationsAfterCut > invalidationsBeforeCut;
  const viewRecreatePassed =
    removed && recreatedView.id !== oldViewId && viewExistsAfterRecreate;
  const capacityPassed =
    exactBoundary.requiredCapacity === capacity.effectiveCapacity &&
    overflowError !== null;
  const deviceLossPassed =
    lostInfo.reason === "destroyed" &&
    oldRendererStopped &&
    diagnosticsAfterLoss.deviceLostCount === diagnosticsBeforeLoss.deviceLostCount + 1;
  const freshPassed =
    freshDiagnostics.validationErrorCount === 0 &&
    freshDiagnostics.uncapturedErrorCount === 0 &&
    freshDiagnostics.deviceLostCount === 0;
  const passed =
    featureOffPassed && counterPassed && resizePassed && cameraCutPassed &&
    viewRecreatePassed && replacementRendered && capacityPassed &&
    diagnosticsBeforeLoss.validationErrorCount === 0 &&
    diagnosticsBeforeLoss.uncapturedErrorCount === 0 &&
    deviceLossPassed && freshPassed;

  finalResult = {
    passed,
    task: "R4-A-05 Overflow, lifecycle and feature-off",
    build: {
      commit: __BUILD_COMMIT__,
      dirty: __BUILD_DIRTY__,
      dirtyReasons: __BUILD_DIRTY_REASONS__
    },
    asset: {
      path: "examples/r4-debug-resolve/alpha-mask.gltf",
      geometries: geometries.length,
      materials: imported.materials.length,
      instances: packedSource.count
    },
    featureOff: {
      passed: featureOffPassed,
      debugView: renderer.render_debug_view,
      gpuCounters: featureOffFrame.gpuCounters,
      readbacks: featureOffFrame.readbacks,
      submits: featureOffFrame.submits,
      graph: featureOffFrame.graph
    },
    sampledCounters: {
      passed: counterPassed,
      frameIndex: counterFrame.frameIndex,
      gpuCounters: counterFrame.gpuCounters,
      readbacks: counterFrame.readbacks
    },
    resize: { passed: resizePassed, before: beforeResize, after: afterResize },
    cameraCut: {
      passed: cameraCutPassed,
      invalidationsBefore: invalidationsBeforeCut,
      invalidationsAfter: invalidationsAfterCut
    },
    viewRecreate: {
      passed: viewRecreatePassed,
      removed,
      oldViewId,
      newViewId: recreatedView.id,
      existsAfterRecreate: viewExistsAfterRecreate
    },
    inFlightReplacement: { passed: replacementRendered },
    capacity: {
      passed: capacityPassed,
      adapter: capacity,
      exactBoundary,
      rejectedCapacity: capacity.effectiveCapacity + 1,
      overflowError
    },
    deviceLoss: {
      passed: deviceLossPassed,
      reason: lostInfo.reason,
      message: lostInfo.message,
      oldRendererStopped,
      diagnosticsBeforeLoss,
      diagnosticsAfterLoss
    },
    freshRenderer: {
      passed: freshPassed,
      adapter: freshRenderer.adapter_info,
      frames: freshRenderer.frame_count,
      diagnostics: freshDiagnostics
    }
  };
  publishResult(finalResult);
  result.textContent = JSON.stringify(finalResult, null, 2);
  status.textContent = passed
    ? "R4-A-05 lifecycle validation passed"
    : "R4-A-05 lifecycle validation failed";
  status.className = passed ? "ok" : "error";
  download.disabled = false;
}

function renderOrThrow(
  renderer: Renderer,
  camera: PerspectiveCamera,
  scene: Scene,
  label: string
): void {
  if (!renderer.render(camera, scene, 1 / 60)) {
    throw new Error(`${label}: Renderer stopped because the GPU device was lost`);
  }
}

function obtainExistingView(renderer: Renderer, key: GPUViewKey) {
  const command = ShadeGPUCommandContext.create(
    renderer.graphics,
    "R4-A-05/inspect-existing-view"
  );
  const view = renderer.views.obtain(key, command);
  command.abort(new Error("inspection command intentionally not submitted"));
  return view;
}

async function waitForCounterFrame(renderer: Renderer, frameIndex: number) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const frame = renderer.profiler.getFrame(frameIndex);
    if (frame !== undefined && !frame.gpuCounters.pending) return frame;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`GPU counter frame ${frameIndex} did not complete`);
}

function createCamera(aspect: number): PerspectiveCamera {
  const camera = new PerspectiveCamera();
  camera.aspect = aspect;
  camera.near = 0.1;
  camera.transform.position.set(0, 0, 4);
  camera.transform.lookAt({ x: 0, y: 0, z: 0 });
  camera.update();
  return camera;
}

function createScene(): Scene {
  const scene = new Scene();
  scene.lights.environment = createEnvironmentTexture();
  return scene;
}

function createEnvironmentTexture(): ShadeTexture {
  const image = ShadeImage.fromArrayBuffer(
    new Uint16Array([0x2a66, 0x2e66, 0x3266, 0x3c00]).buffer,
    4,
    ShadeDataType.Float16,
    1,
    1,
    1
  );
  image.color_space = 2;
  return ShadeTexture.from(image);
}

function configureRenderer(renderer: Renderer): void {
  renderer.feature_shadows_enabled = false;
  renderer.feature_ssr_enabled = false;
  renderer.feature_ssao_enabled = false;
  renderer.feature_taa_enabled = false;
  renderer.feature_bloom_enabled = false;
  renderer.feature_automatic_exposure_enabled = false;
  renderer.feature_motion_blur_enabled = false;
  renderer.feature_sharpening_enabled = false;
  renderer.render_debug_view = RenderDebugView.None;
}

function publishResult(value: unknown): void {
  (window as unknown as { __OENGINE_R4_A_05_RESULT__: unknown })
    .__OENGINE_R4_A_05_RESULT__ = value;
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id}`);
  return element as T;
}

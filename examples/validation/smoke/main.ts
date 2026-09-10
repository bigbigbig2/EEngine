import {
  DirectionalLight,
  BoxGeometry,
  Mesh,
  PerspectiveCamera,
  Renderer,
  Scene,
  StandardShadeMaterial,
  buildBoxSourceGeometry,
  cookGeometryAssetPackage,
  createGeometryCookRecipe,
  type FrameProfileSnapshot,
  type GeometryAssetPackage,
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
import { FixtureState } from "../shared/fixture-state.ts";
import {
  legacySceneUploadLabels,
  packedFrameHasNoLegacyGeometryOwners,
  shadowFeatureIsCold
} from "../shared/packed-owner-evidence.ts";
import {
  hasGpuFailure,
  settleRendererForValidationDestroy,
  validationAdapter,
  validationDiagnostics,
  waitForCompletedGpuCounters
} from "../shared/runtime-evidence.ts";

const canvas = required<HTMLCanvasElement>("gpu-canvas");
const statusElement = required<HTMLElement>("status");
let renderer: Renderer | null = null;
let scene: Scene | null = null;
let camera: PerspectiveCamera | null = null;
let frameRequest = 0;
let disposed = false;

const state = new FixtureState({
  fixtureId: "smoke",
  canvas,
  frame: () => renderer?.frame_count ?? 0,
  adapter: () => validationAdapter(renderer?.adapter_info ?? null, renderer?.device ?? null),
  diagnostics: () => validationDiagnostics(renderer?.profiler.diagnostics)
});

const fixture: ValidationFixture = {
  getSnapshot: () => state.snapshot(),
  runScenario,
  dispose
};
window[VALIDATION_FIXTURE_KEY] = fixture;

void initialize().catch((error: unknown) => {
  state.fail(validationError(error));
  showStatus();
  console.error(error);
});

async function initialize(): Promise<void> {
  if (navigator.gpu === undefined) throw new Error("WebGPU is unavailable in this browser");
  const context = canvas.getContext("webgpu");
  if (context === null) throw new Error("Unable to create a WebGPU canvas context");

  const activeRenderer = new Renderer();
  renderer = activeRenderer;
  await activeRenderer.initialize({ context, pixelRatio: 1 });
  activeRenderer.configure({
    features: {
      shadows: false,
      ambientOcclusion: false,
      screenSpaceReflections: false,
      temporalAntiAliasing: false,
      bloom: false,
      automaticExposure: false,
      motionBlur: false,
      sharpening: false
    }
  });
  activeRenderer.profiler.configure({
    enabled: true,
    gpuCounterSampleInterval: 1,
    readbackRingSlots: 8
  });
  activeRenderer.profiler.setMode("deep-capture");

  const activeScene = new Scene();
  scene = activeScene;
  const light = new DirectionalLight();
  light.intensity = 2.8;
  light.forward = [-0.45, -0.8, -0.35];
  light.casts_shadow = false;
  activeScene.addChild(light);
  await activeRenderer.uploadPackedScene(activeScene, await createSmokeSceneSource());

  const activeCamera = new PerspectiveCamera();
  camera = activeCamera;
  activeCamera.near = 0.01;
  activeCamera.far = 100;
  activeCamera.transform.position.set(7, 5.5, 8);
  activeCamera.transform.lookAt({ x: 0, y: 0.5, z: 0 });
  resize();

  state.ready();
  showStatus();
  startFrameLoop();
}

async function runScenario(
  request: ValidationScenarioRequest
): Promise<ValidationScenarioResult> {
  if (!["basic", "scene-adapter", "scene-resync"].includes(request.scenarioId)) {
    return failedScenario(request, new Error(`Unknown smoke scenario '${request.scenarioId}'`));
  }
  if (renderer === null || scene === null || camera === null) {
    return failedScenario(request, new Error("Smoke runtime is not initialized"));
  }

  const activeRenderer = renderer;
  const startedFrame = activeRenderer.frame_count;
  state.start(request.runId, request.scenarioId);
  showStatus();
  try {
    const ordinarySceneMode = request.scenarioId === "scene-adapter";
    const ordinaryResyncMode = request.scenarioId === "scene-resync";
    const ordinaryMode = ordinarySceneMode || ordinaryResyncMode;
    if (ordinaryMode) {
      cancelAnimationFrame(frameRequest);
      frameRequest = 0;
      await activeRenderer.releasePackedScene(scene);
      const ordinary = await createOrdinarySmokeScene();
      scene = ordinary.scene;
      await activeRenderer.uploadScene(ordinary.scene, ordinary.geometryAssets);
      if (ordinarySceneMode) {
        ordinary.cube.transform_local.position.set(0.75, 1.06, 0);
        ordinary.cube.material = ordinary.groundMaterial;
      } else {
        const added = Mesh.from(ordinary.cubeGeometry, ordinary.groundMaterial);
        added.transform_local.position.set(-2.5, 0.5, 0);
        ordinary.scene.add(added);
        await activeRenderer.resyncScene(ordinary.scene, ordinary.geometryAssets);
        ordinary.scene.remove(added);
        await activeRenderer.resyncScene(ordinary.scene, ordinary.geometryAssets);
      }
      startFrameLoop();
    }
    const counterPromise = waitForCompletedGpuCounters(activeRenderer.profiler, startedFrame);
    const capturePromise = activeRenderer.requestLinearHdrCapture({
      x: Math.max(0, Math.floor(canvas.width / 2) - 2),
      y: Math.max(0, Math.floor(canvas.height / 2) - 2),
      width: Math.min(4, canvas.width),
      height: Math.min(4, canvas.height),
      stage: "lighting"
    });
    const [profile, capture] = await Promise.all([counterPromise, capturePromise]);
    const stableProfile = await waitForCompletedGpuCounters(
      activeRenderer.profiler,
      profile.frameIndex
    );
    const diagnostics = validationDiagnostics(activeRenderer.profiler.diagnostics);
    const residency = activeRenderer.geometryAssetResidencyEvidence();
    const sceneEvidence = activeRenderer.gpuSceneEvidence();
    const renderWorldEvidence = activeRenderer.gpuRenderWorldEvidence();
    const ownerCreation = activeRenderer.gpuOwnerCreationEvidence();
    const forbiddenLegacyUploads = legacySceneUploadLabels(stableProfile.uploads.labels);
    const temporal = activeRenderer.temporalEvidence();
    const ambientOcclusion = activeRenderer.ambientOcclusionEvidence();
    const reflections = activeRenderer.screenSpaceReflectionsEvidence();
    const memory = activeRenderer.memoryEvidence();
    const luminanceMaximum = maximumFiniteRgb(capture.rgba);
    const counters = stableProfile.gpuCounters.values;
    const disabledFeaturesCold =
      !temporal.enabled && temporal.taaPasses === 0 &&
      temporal.classificationPasses === 0 && temporal.historyTextureCount === 0 &&
      temporal.historyBytes === 0 &&
      !ambientOcclusion.enabled && ambientOcclusion.rawPasses === 0 &&
      ambientOcclusion.spatialPasses === 0 && ambientOcclusion.temporalPasses === 0 &&
      ambientOcclusion.compositePasses === 0 && ambientOcclusion.historyTextureCount === 0 &&
      ambientOcclusion.historyBytes === 0 &&
      !reflections.enabled && reflections.tracePasses === 0 &&
      reflections.prefilterPasses === 0 && reflections.resolvePasses === 0 &&
      reflections.spatialPasses === 0 && reflections.temporalPasses === 0 &&
      reflections.compositePasses === 0 && reflections.historyTextureCount === 0 &&
      reflections.historyBytes === 0 && memory.historyBytes === 0;
    const assertions: ValidationAssertion[] = [
      validationAssertion("frame-advanced", stableProfile.frameIndex > startedFrame, "A newer rendered frame supplied the evidence", stableProfile.frameIndex, `> ${startedFrame}`),
      validationAssertion("adapter-created", activeRenderer.adapter_info !== null, "Renderer captured its originating GPU adapter"),
      validationAssertion("single-main-submit", stableProfile.submits.count === 1 && stableProfile.submits.labels["Renderer/main-0"] === 1, "A stable frame used exactly one main submission", stableProfile.submits, { count: 1, label: "Renderer/main-0" }),
      validationAssertion("stable-graph-cache-hit", stableProfile.graph.builds === 0 && stableProfile.graph.compiles === 0 && stableProfile.graph.cacheHits === 1 && stableProfile.graph.cacheMisses === 0, "A stable frame reused the compiled main graph", stableProfile.graph, { builds: 0, compiles: 0, cacheHits: 1, cacheMisses: 0 }),
      validationAssertion("disabled-features-cold", disabledFeaturesCold, "Disabled temporal, AO and SSR features retained no Pass or history resources", { temporal, ambientOcclusion, reflections, historyOwners: memory.historyOwners }),
      validationAssertion("gpu-raster-work", (counters.geometryRasterTriangles ?? 0) > 0, "Meshlet Hardware Visibility consumed triangle work", counters.geometryRasterTriangles, "> 0"),
      validationAssertion("gpu-shaded-pixels", (counters.shadedPixels ?? 0) > 0, "Material resolve shaded visible pixels", counters.shadedPixels, "> 0"),
      validationAssertion("gpu-queue-no-overflow", (counters.queueOverflowMask ?? 0) === 0, "GPU work queues did not overflow", counters.queueOverflowMask, 0),
      validationAssertion("gpu-diagnostics-clean", !hasGpuFailure(diagnostics), "WebGPU diagnostics are clean", diagnostics)
    ];
    if (ordinaryMode) {
      assertions.push(
        validationAssertion("ordinary-scene-adapter-active", renderWorldEvidence.ordinarySceneAdapterCount === 1 && renderWorldEvidence.packedSourceCount === 0, "The ordinary Scene is registered through the authoritative GPU Render World", renderWorldEvidence),
        validationAssertion("ordinary-scene-update-consumed", ordinarySceneMode ? renderWorldEvidence.ordinaryScenePatchCount >= 1 && sceneEvidence.patchedTransformCount >= 1 && sceneEvidence.patchedMaterialCount >= 1 : sceneEvidence.bulkInstantiateCount >= 4 && sceneEvidence.releaseCount >= 3 && sceneEvidence.activeInstanceCount === 2, ordinarySceneMode ? "SceneChangeSet transform/material deltas reached the compact GPU Instance table" : "Explicit full resync committed add/remove replacements and retained the final active set", { renderWorldEvidence, sceneEvidence }),
        validationAssertion("ordinary-scene-unified-consumers", (counters.geometryRasterTriangles ?? 0) > 0 && (counters.shadedPixels ?? 0) > 0, "The ordinary Scene reached the shared VisibilityKey V2 and Surface consumers", { geometryRasterTriangles: counters.geometryRasterTriangles ?? 0, shadedPixels: counters.shadedPixels ?? 0 }),
        validationAssertion("ordinary-scene-single-material-owner", ownerCreation.renderWorld.materialStoreCreated, "The ordinary Scene created the authoritative Render World material store", ownerCreation.renderWorld),
        validationAssertion("ordinary-scene-single-geometry-owner", packedFrameHasNoLegacyGeometryOwners(ownerCreation), "The ordinary Scene retained one shared environment and one Render World", ownerCreation.scene),
        validationAssertion("ordinary-scene-stable-upload-absent", forbiddenLegacyUploads.length === 0 && (stableProfile.counters["runtime.scenePrepareCount"] ?? 0) === 0, "A stable ordinary Scene frame scanned or uploaded no scene data", { forbiddenLegacyUploads, scenePrepareCount: stableProfile.counters["runtime.scenePrepareCount"] ?? 0, uploads: stableProfile.uploads }, { forbiddenLegacyUploads: [], scenePrepareCount: 0 })
      );
    } else {
      assertions.push(
        validationAssertion("packed-assets-resident", residency.residentAssetCount >= 2, "Cube and ground assets are resident", residency.residentAssetCount, ">= 2"),
        validationAssertion("packed-instances-active", sceneEvidence.activeInstanceCount >= 2, "Cube and ground instances are active", sceneEvidence.activeInstanceCount, ">= 2"),
        validationAssertion("render-world-owner-evidence", ownerCreation.renderWorld.assetStoreCreated && ownerCreation.renderWorld.instanceTableCreated && ownerCreation.renderWorld.sceneRegistryCreated && ownerCreation.renderWorld.materialStoreCreated && ownerCreation.renderWorld.textureResidencyCreated && ownerCreation.renderWorld.baseTextureBankCreated, "Render World asset, instance, scene, material and texture owners were observed", ownerCreation.renderWorld),
        validationAssertion("linear-hdr-non-empty", luminanceMaximum > 0.001, "The rendered HDR sample contains visible output", luminanceMaximum, "> 0.001"),
        validationAssertion("single-material-owner", ownerCreation.renderWorld.materialStoreCreated, "Rendering used the authoritative Render World material store", ownerCreation.renderWorld),
        validationAssertion("single-geometry-owner", packedFrameHasNoLegacyGeometryOwners(ownerCreation), "Rendering retained one shared environment and one Render World", ownerCreation.scene),
        validationAssertion("shadow-feature-cold", shadowFeatureIsCold(ownerCreation), "Shadows-off created no atlas, raster Pass, shadow view, or Packed shadow work owner", ownerCreation.shadow),
        validationAssertion("legacy-scene-upload-absent", forbiddenLegacyUploads.length === 0 && (stableProfile.counters["runtime.scenePrepareCount"] ?? 0) === 0, "A stable Packed frame encoded no legacy scene update or upload", { forbiddenLegacyUploads, scenePrepareCount: stableProfile.counters["runtime.scenePrepareCount"] ?? 0 }, { forbiddenLegacyUploads: [], scenePrepareCount: 0 })
      );
    }
    const result: ValidationScenarioResult = {
      schemaVersion: VALIDATION_PROTOCOL_SCHEMA_VERSION,
      fixtureId: "smoke",
      runId: request.runId,
      scenarioId: request.scenarioId,
      status: assertions.every((assertion) => assertion.passed) ? "passed" : "failed",
      startedFrame,
      completedFrame: stableProfile.frameIndex,
      evidence: {
        residentAssetCount: residency.residentAssetCount,
        activeInstanceCount: sceneEvidence.activeInstanceCount,
        renderWorldEvidence,
        geometryRasterTriangles: counters.geometryRasterTriangles ?? 0,
        shadedPixels: counters.shadedPixels ?? 0,
        queueOverflowMask: counters.queueOverflowMask ?? 0,
        luminanceMaximum,
        gpuCounterSchemaVersion: stableProfile.gpuCounters.schemaVersion,
        ownerCreation,
        stableFrame: {
          submits: stableProfile.submits,
          graph: stableProfile.graph,
          uploads: stableProfile.uploads,
          readbacks: stableProfile.readbacks
        },
        disabledFeatures: {
          temporal,
          ambientOcclusion,
          reflections,
          historyOwners: memory.historyOwners
        }
      },
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

function startFrameLoop(): void {
  const frame = (): void => {
    if (disposed || renderer === null || scene === null || camera === null) return;
    camera.aspect = renderer.aspect_ratio;
    camera.update();
    if (!renderer.render(camera, scene, 1 / 60)) {
      state.deviceLost({ name: "GPUDeviceLost", message: "Renderer stopped after GPU device loss" });
      showStatus();
      return;
    }
    frameRequest = requestAnimationFrame(frame);
  };
  frameRequest = requestAnimationFrame(frame);
}

async function dispose(): Promise<void> {
  if (disposed) return;
  disposed = true;
  cancelAnimationFrame(frameRequest);
  frameRequest = 0;
  if (renderer !== null) {
    await settleRendererForValidationDestroy(renderer);
    renderer.destroy();
  }
  renderer = null;
  scene = null;
  camera = null;
  canvas.getContext("webgpu")?.unconfigure();
  state.dispose();
  showStatus();
  delete window[VALIDATION_FIXTURE_KEY];
}

async function createSmokeSceneSource(): Promise<PackedSceneSource> {
  const recipe = createGeometryCookRecipe();
  const geometries: GeometryAssetPackage[] = [];
  for (const source of [buildBoxSourceGeometry(2, 2, 2), buildBoxSourceGeometry(12, 0.12, 12)]) {
    geometries.push((await cookGeometryAssetPackage(source, recipe)).asset);
  }
  const cube = new StandardShadeMaterial();
  cube.diffuse_color.set(0.1, 0.42, 0.95, 1);
  cube.roughness_factor = 0.34;
  const ground = new StandardShadeMaterial();
  ground.diffuse_color.set(0.18, 0.2, 0.24, 1);
  ground.roughness_factor = 0.9;
  const currentTransforms = new Float32Array(32);
  writeTranslation(currentTransforms, 0, 0, 1.06, 0);
  writeTranslation(currentTransforms, 16, 0, -0.06, 0);
  return {
    geometries,
    materials: [cube, ground],
    count: 2,
    geometryIndices: new Uint32Array([0, 1]),
    materialIndices: new Uint32Array([0, 1]),
    currentTransforms,
    previousTransforms: currentTransforms.slice(),
    boundsSpheres: new Float32Array([0, 1.06, 0, 1.7321, 0, -0.06, 0, 8.4853]),
    boundsMin: new Float32Array([-1, 0.06, -1, -6, -0.12, -6]),
    boundsMax: new Float32Array([1, 2.06, 1, 6, 0, 6]),
    flags: new Uint32Array([0, 0]),
    debugIds: new Uint32Array([1, 2])
  };
}

async function createOrdinarySmokeScene() {
  const ordinaryScene = new Scene();
  const light = new DirectionalLight();
  light.intensity = 2.8;
  light.forward = [-0.45, -0.8, -0.35];
  light.casts_shadow = false;
  const cubeGeometry = new BoxGeometry(2, 2, 2);
  const groundGeometry = new BoxGeometry(12, 0.12, 12);
  const cubeMaterial = new StandardShadeMaterial();
  cubeMaterial.diffuse_color.set(0.1, 0.42, 0.95, 1);
  cubeMaterial.roughness_factor = 0.34;
  const groundMaterial = new StandardShadeMaterial();
  groundMaterial.diffuse_color.set(0.18, 0.2, 0.24, 1);
  groundMaterial.roughness_factor = 0.9;
  const cube = Mesh.from(cubeGeometry, cubeMaterial);
  cube.transform_local.position.set(0, 1.06, 0);
  const ground = Mesh.from(groundGeometry, groundMaterial);
  ground.transform_local.position.set(0, -0.06, 0);
  ordinaryScene.add([cube, ground, light]);

  const recipe = createGeometryCookRecipe();
  const cubeAsset = (await cookGeometryAssetPackage(
    buildBoxSourceGeometry(2, 2, 2),
    recipe
  )).asset;
  const groundAsset = (await cookGeometryAssetPackage(
    buildBoxSourceGeometry(12, 0.12, 12),
    recipe
  )).asset;
  return {
    scene: ordinaryScene,
    cube,
    cubeGeometry,
    groundMaterial,
    geometryAssets: [
      { geometry: cubeGeometry, asset: cubeAsset },
      { geometry: groundGeometry, asset: groundAsset }
    ]
  };
}

function failedScenario(
  request: ValidationScenarioRequest,
  error: unknown,
  startedFrame = renderer?.frame_count ?? 0
): ValidationScenarioResult {
  const normalized = validationError(error);
  const completedFrame = Math.max(startedFrame + 1, renderer?.frame_count ?? 0);
  return {
    schemaVersion: VALIDATION_PROTOCOL_SCHEMA_VERSION,
    fixtureId: "smoke",
    runId: request.runId,
    scenarioId: request.scenarioId,
    status: "failed",
    startedFrame,
    completedFrame,
    evidence: {},
    assertions: [validationAssertion("scenario-execution", false, normalized.message)],
    diagnostics: validationDiagnostics(renderer?.profiler.diagnostics),
    error: normalized
  };
}

function maximumFiniteRgb(rgba: Float32Array): number {
  let maximum = 0;
  for (let index = 0; index < rgba.length; index += 4) {
    for (let channel = 0; channel < 3; channel++) {
      const value = rgba[index + channel] ?? 0;
      if (Number.isFinite(value)) maximum = Math.max(maximum, value);
    }
  }
  return maximum;
}

function resize(): void {
  if (renderer === null || camera === null) return;
  renderer.resize(Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight));
  camera.aspect = renderer.aspect_ratio;
  camera.update();
}

function writeTranslation(target: Float32Array, offset: number, x: number, y: number, z: number): void {
  target.fill(0, offset, offset + 16);
  target[offset] = 1;
  target[offset + 5] = 1;
  target[offset + 10] = 1;
  target[offset + 12] = x;
  target[offset + 13] = y;
  target[offset + 14] = z;
  target[offset + 15] = 1;
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

import {
  DirectionalLight,
  OrbitControls,
  PerspectiveCamera,
  Renderer,
  Scene,
  StandardShadeMaterial,
  buildBoxSourceGeometry,
  cookGeometryAssetPackage,
  createGeometryCookRecipe,
  type GeometryAssetPackage,
  type PackedSceneSource
} from "../../../../OEngine/src/index.ts";

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DIRTY__: boolean;
declare const __BUILD_CONTENT_HASH__: string;

type FixtureStatus = "booting" | "ready" | "failed" | "device-lost";
type FixtureResult = {
  readonly schemaVersion: 1;
  readonly caseId: "foundations-pure-geometry";
  readonly status: FixtureStatus;
  readonly build: { readonly commit: string; readonly dirty: boolean; readonly contentHash: string };
  readonly environment: { readonly width: number; readonly height: number; readonly dpr: number };
  readonly lifecycle: { readonly frame: number; readonly elapsedMs: number; readonly initialized: boolean };
  readonly camera: { readonly position: [number, number, number]; readonly near: number; readonly far: number } | null;
  readonly metrics: Record<string, number | string | boolean | null>;
  readonly error?: { readonly name: string; readonly message: string };
};

declare global {
  interface Window {
    __OENGINE_FOUNDATIONS_PURE_GEOMETRY_FIXTURE__?: {
      getSnapshot: () => FixtureResult;
      downloadJson: () => void;
      captureScreenshot: () => Promise<void>;
    };
  }
}

const canvas = required<HTMLCanvasElement>("gpu-canvas");
const status = required<HTMLElement>("scene-status");
const metrics = required<HTMLElement>("scene-metrics");
const startedAt = performance.now();

let renderer: Renderer | null = null;
let rendererInitialized = false;
let scene: Scene | null = null;
let camera: PerspectiveCamera | null = null;
let controls: OrbitControls | null = null;
let resizeObserver: ResizeObserver | null = null;
let frameRequest = 0;
let disposed = false;
let initialized = false;
let fixtureStatus: FixtureStatus = "booting";
let fixtureError: FixtureResult["error"];
let lastRafIntervalMs = 0;

required<HTMLButtonElement>("download-json").addEventListener("click", downloadJson);
required<HTMLButtonElement>("capture-png").addEventListener("click", () => void captureScreenshot());
required<HTMLButtonElement>("reset-camera").addEventListener("click", resetCamera);
window.__OENGINE_FOUNDATIONS_PURE_GEOMETRY_FIXTURE__ = { getSnapshot, downloadJson, captureScreenshot };

void initialize().catch((error: unknown) => {
  releaseRuntime();
  fixtureStatus = "failed";
  fixtureError = { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) };
  status.dataset.fixtureStatus = fixtureStatus;
  status.textContent = fixtureError.message;
  metrics.textContent = "初始化失败";
  console.error(error);
});

async function initialize(): Promise<void> {
  if (!("gpu" in navigator)) throw new Error("WebGPU 在当前浏览器不可用");
  const context = canvas.getContext("webgpu");
  if (context === null) throw new Error("无法创建 WebGPU canvas context");

  const activeRenderer = new Renderer();
  renderer = activeRenderer;
  await activeRenderer.initialize({ context, pixelRatio: 1 });
  rendererInitialized = true;
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

  const activeScene = new Scene();
  scene = activeScene;
  const light = new DirectionalLight();
  light.intensity = 3.2;
  light.forward = [-0.45, -0.8, -0.35];
  light.casts_shadow = false;
  activeScene.addChild(light);

  const source = await createPureGeometrySource();
  await activeRenderer.uploadPackedScene(activeScene, source);

  const activeCamera = new PerspectiveCamera();
  camera = activeCamera;
  activeCamera.near = 0.01;
  activeCamera.far = 100;
  activeCamera.transform.position.set(7, 5.5, 8);
  activeCamera.transform.lookAt({ x: 0, y: 0.5, z: 0 });
  activeCamera.update();
  const activeControls = new OrbitControls(activeCamera, canvas);
  controls = activeControls;
  activeControls.distanceLimits.min = 2;
  activeControls.distanceLimits.max = 30;
  activeControls.movement_speed_scale = 1.2;
  activeControls.from_transform(activeCamera.transform);

  resizeObserver = new ResizeObserver(() => resize(activeRenderer, activeCamera));
  resizeObserver.observe(canvas);
  resize(activeRenderer, activeCamera);

  initialized = true;
  fixtureStatus = "ready";
  status.dataset.fixtureStatus = fixtureStatus;
  status.textContent = "运行中 · Pure Geometry";
  updateMetrics(source);
  startFrameLoop();
}

async function createPureGeometrySource(): Promise<PackedSceneSource> {
  const sources = [buildBoxSourceGeometry(2, 2, 2), buildBoxSourceGeometry(12, 0.12, 12)];
  const recipe = createGeometryCookRecipe();
  const geometries: GeometryAssetPackage[] = [];
  for (const source of sources) geometries.push((await cookGeometryAssetPackage(source, recipe)).asset);
  const cubeMaterial = new StandardShadeMaterial();
  cubeMaterial.diffuse_color.set(0.1, 0.42, 0.95, 1);
  cubeMaterial.roughness_factor = 0.34;
  const planeMaterial = new StandardShadeMaterial();
  planeMaterial.diffuse_color.set(0.18, 0.2, 0.24, 1);
  planeMaterial.roughness_factor = 0.9;
  const transforms = new Float32Array(32);
  writeTranslation(transforms, 0, 0, 1.06, 0);
  writeTranslation(transforms, 16, 0, -0.06, 0);
  return {
    geometries,
    materials: [cubeMaterial, planeMaterial],
    count: 2,
    geometryIndices: new Uint32Array([0, 1]),
    materialIndices: new Uint32Array([0, 1]),
    currentTransforms: transforms,
    previousTransforms: transforms.slice(),
    boundsSpheres: new Float32Array([0, 1.06, 0, 1.7321, 0, -0.06, 0, 8.4853]),
    boundsMin: new Float32Array([-1, 0.06, -1, -6, -0.12, -6]),
    boundsMax: new Float32Array([1, 2.06, 1, 6, 0, 6]),
    flags: new Uint32Array([0, 0]),
    debugIds: new Uint32Array([1, 2])
  };
}

function writeTranslation(target: Float32Array, offset: number, x: number, y: number, z: number): void {
  target.fill(0, offset, offset + 16);
  target[offset] = 1; target[offset + 5] = 1; target[offset + 10] = 1;
  target[offset + 12] = x; target[offset + 13] = y; target[offset + 14] = z; target[offset + 15] = 1;
}

function resize(activeRenderer: Renderer, activeCamera: PerspectiveCamera): void {
  activeRenderer.resize(Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight));
  activeCamera.aspect = activeRenderer.aspect_ratio;
  activeCamera.update();
}

function startFrameLoop(): void {
  let previousTime = performance.now();
  const frame = (now: number): void => {
    if (disposed || renderer === null || scene === null || camera === null) return;
    lastRafIntervalMs = Math.max(0, now - previousTime);
    previousTime = now;
    const deltaSeconds = Math.min(0.1, lastRafIntervalMs / 1000);
    controls?.update(deltaSeconds);
    camera.aspect = renderer.aspect_ratio;
    camera.update();
    if (!renderer.render(camera, scene, deltaSeconds)) {
      fixtureStatus = "device-lost";
      status.dataset.fixtureStatus = fixtureStatus;
      status.textContent = "WebGPU device lost";
      releaseRuntime();
      return;
    }
    updateRuntimeMetrics();
    frameRequest = requestAnimationFrame(frame);
  };
  frameRequest = requestAnimationFrame(frame);
}

function updateMetrics(source: PackedSceneSource): void {
  metrics.textContent = `instances: ${source.count}\nmaterials: ${source.materials.length}\nDPR: 1\nfeatures: baseline`;
}

function updateRuntimeMetrics(): void {
  metrics.textContent = `frame: ${renderer?.frame_count ?? 0}\nRAF interval: ${lastRafIntervalMs.toFixed(2)} ms\nDPR: 1\nfeatures: baseline`;
}

function resetCamera(): void {
  if (camera === null) return;
  camera.transform.position.set(7, 5.5, 8);
  camera.transform.lookAt({ x: 0, y: 0.5, z: 0 });
  camera.update();
  controls?.from_transform(camera.transform);
}

function getSnapshot(): FixtureResult {
  const position = camera?.transform.position;
  const sceneEvidence = rendererInitialized ? renderer?.gpuSceneEvidence() : undefined;
  return {
    schemaVersion: 1,
    caseId: "foundations-pure-geometry",
    status: fixtureStatus,
    build: { commit: __BUILD_COMMIT__, dirty: __BUILD_DIRTY__, contentHash: __BUILD_CONTENT_HASH__ },
    environment: { width: canvas.width, height: canvas.height, dpr: 1 },
    lifecycle: { frame: renderer?.frame_count ?? 0, elapsedMs: Math.round(performance.now() - startedAt), initialized },
    camera: camera === null || position === undefined ? null : { position: [position.x, position.y, position.z], near: camera.near, far: camera.far },
    metrics: {
      activeInstanceCount: sceneEvidence?.activeInstanceCount ?? 0,
      recordStride: sceneEvidence?.recordStride ?? 0,
      rafIntervalMs: lastRafIntervalMs,
      shadows: false,
      temporalAntiAliasing: false,
      inspector: false
    },
    ...(fixtureError === undefined ? {} : { error: fixtureError })
  };
}

function downloadJson(): void {
  downloadBlob(new Blob([JSON.stringify(getSnapshot(), null, 2)], { type: "application/json" }), "pure-geometry.result.json");
}

async function captureScreenshot(): Promise<void> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (blob !== null) downloadBlob(blob, "pure-geometry.png");
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url);
}

function releaseRuntime(destroyRenderer = true): void {
  cancelAnimationFrame(frameRequest);
  frameRequest = 0;
  resizeObserver?.disconnect();
  resizeObserver = null;
  controls?.pointer.stop();
  controls?.keyboard.stop();
  controls = null;
  if (destroyRenderer && rendererInitialized) renderer?.destroy();
  rendererInitialized = false;
  renderer = null;
  scene = null;
  camera = null;
  canvas.getContext("webgpu")?.unconfigure();
}

function dispose(): void {
  if (disposed) return;
  disposed = true;
  releaseRuntime(false);
  delete window.__OENGINE_FOUNDATIONS_PURE_GEOMETRY_FIXTURE__;
}

window.addEventListener("pagehide", dispose, { once: true });

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id}`);
  return element as T;
}

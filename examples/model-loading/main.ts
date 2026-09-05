import {
  DirectionalLight,
  cookGeometryAssetPackage,
  createGeometryCookRecipe,
  type GeometryAssetPackage,
  load_gltf_packed,
  OrbitControls,
  PerspectiveCamera,
  Renderer,
  Scene,
  type PackedGltfSource
} from "../../OEngine/src/index.ts";
import { Inspector } from "../../OEngine/src/addons/inspector/index.ts";

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DIRTY__: boolean;
declare const __BUILD_CONTENT_HASH__: string;

type FixtureStatus = "booting" | "ready" | "failed" | "device-lost";
type FixtureResult = {
  readonly schemaVersion: 1;
  readonly caseId: "model-loading";
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
    __OENGINE_MODEL_LOADING_FIXTURE__?: {
      getSnapshot: () => FixtureResult;
      downloadJson: () => void;
      captureScreenshot: () => Promise<void>;
    };
  }
}

const MODEL_URL = new URL("../rendering-lab/assets/dungeon_warkarma.glb", import.meta.url).href;
const canvas = required<HTMLCanvasElement>("gpu-canvas");
const status = required<HTMLElement>("fixture-status");
const metrics = required<HTMLElement>("fixture-metrics");
const startedAt = performance.now();

let renderer: Renderer | null = null;
let scene: Scene | null = null;
let camera: PerspectiveCamera | null = null;
let controls: OrbitControls | null = null;
let inspector: Inspector | null = null;
let resizeObserver: ResizeObserver | null = null;
let frameRequest = 0;
let disposed = false;
let initialized = false;
let fixtureStatus: FixtureStatus = "booting";
let fixtureError: FixtureResult["error"];
let loadedSource: PackedGltfSource | null = null;
let cookedAssets: readonly GeometryAssetPackage[] = [];

required<HTMLButtonElement>("download-json").addEventListener("click", downloadJson);
required<HTMLButtonElement>("capture-png").addEventListener("click", () => void captureScreenshot());
required<HTMLButtonElement>("reset-camera").addEventListener("click", resetCamera);
window.__OENGINE_MODEL_LOADING_FIXTURE__ = { getSnapshot, downloadJson, captureScreenshot };

void initialize().catch((error: unknown) => {
  fixtureStatus = "failed";
  fixtureError = {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error)
  };
  status.textContent = fixtureError.message;
  status.dataset.fixtureStatus = fixtureStatus;
  status.style.background = "#4a1720e8";
  metrics.textContent = `Feature 02 · Packed glTF\n失败：${fixtureError.message}`;
  console.error(error);
});

async function initialize(): Promise<void> {
  if (!("gpu" in navigator)) throw new Error("WebGPU 在当前浏览器不可用");
  const context = canvas.getContext("webgpu");
  if (context === null) throw new Error("无法创建 WebGPU canvas context");

  const activeRenderer = new Renderer();
  renderer = activeRenderer;
  await activeRenderer.initialize({ context, pixelRatio: Math.min(window.devicePixelRatio, 2) });
  activeRenderer.configure({
    features: {
      shadows: true,
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
  light.intensity = 3.5;
  light.forward = [-0.45, -0.8, -0.35];
  light.casts_shadow = true;
  activeScene.addChild(light);

  status.textContent = "正在解析 Packed glTF…";
  const source = await load_gltf_packed(MODEL_URL);
  loadedSource = source;
  const bounds = computeBounds(source);
  const recipe = createGeometryCookRecipe();
  const cooked: GeometryAssetPackage[] = [];
  for (const geometry of source.geometries) {
    cooked.push((await cookGeometryAssetPackage(geometry, recipe)).asset);
  }
  cookedAssets = cooked;
  status.textContent = "正在上传模型 GPU 驻留…";
  await activeRenderer.uploadPackedScene(activeScene, {
    ...source,
    geometries: cookedAssets,
    count: source.geometryIndices.length,
    currentTransforms: source.transforms,
    previousTransforms: source.transforms.slice()
  });

  const activeCamera = new PerspectiveCamera();
  camera = activeCamera;
  activeCamera.near = Math.max(0.01, bounds.radius / 1000);
  activeCamera.far = Math.max(100, bounds.radius * 8);
  activeCamera.aspect = activeRenderer.aspect_ratio;
  activeCamera.transform.position.set(
    bounds.center[0] + bounds.radius * 1.2,
    bounds.center[1] + bounds.radius * 0.8,
    bounds.center[2] + bounds.radius * 1.2
  );
  activeCamera.transform.lookAt({ x: bounds.center[0], y: bounds.center[1], z: bounds.center[2] });
  activeCamera.update();
  const activeControls = new OrbitControls(activeCamera, canvas);
  controls = activeControls;
  activeControls.distanceLimits.min = Math.max(0.2, bounds.radius * 0.15);
  activeControls.distanceLimits.max = Math.max(10, bounds.radius * 8);
  activeControls.from_transform(activeCamera.transform);

  resizeObserver = new ResizeObserver(() => resize(activeRenderer, activeCamera));
  resizeObserver.observe(canvas);
  resize(activeRenderer, activeCamera);

  inspector = new Inspector(activeRenderer, {
    container: document.body,
    initialMode: "live",
    historyCapacity: 256,
    uiRefreshHz: 5,
    styles: "inline"
  });
  inspector.open();

  initialized = true;
  fixtureStatus = "ready";
  status.dataset.fixtureStatus = fixtureStatus;
  status.textContent = "Feature 02 · 模型已加载";
  updateMetrics(bounds);
  startFrameLoop();
}

function startFrameLoop(): void {
  let previousTime = performance.now();
  const frame = (now: number): void => {
    if (disposed || renderer === null || scene === null || camera === null) return;
    const deltaSeconds = Math.min(0.1, Math.max(0, now - previousTime) / 1000);
    previousTime = now;
    controls?.update(deltaSeconds);
    camera.aspect = renderer.aspect_ratio;
    camera.update();
    if (!renderer.render(camera, scene, deltaSeconds)) {
      fixtureStatus = "device-lost";
      status.dataset.fixtureStatus = fixtureStatus;
      status.textContent = "WebGPU device lost";
      return;
    }
    frameRequest = requestAnimationFrame(frame);
  };
  frameRequest = requestAnimationFrame(frame);
}

function resetCamera(): void {
  if (camera === null || loadedSource === null) return;
  const bounds = computeBounds(loadedSource);
  camera.transform.position.set(
    bounds.center[0] + bounds.radius * 1.2,
    bounds.center[1] + bounds.radius * 0.8,
    bounds.center[2] + bounds.radius * 1.2
  );
  camera.transform.lookAt({ x: bounds.center[0], y: bounds.center[1], z: bounds.center[2] });
  camera.update();
  controls?.from_transform(camera.transform);
}

function resize(activeRenderer: Renderer, activeCamera: PerspectiveCamera): void {
  activeRenderer.resize(Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight));
  activeCamera.aspect = activeRenderer.aspect_ratio;
  activeCamera.update();
}

function updateMetrics(bounds: Bounds): void {
  if (loadedSource === null || renderer === null) return;
  const residency = renderer.geometryAssetResidencyEvidence();
  metrics.textContent = [
    "Feature 02 · Packed glTF",
    `geometries: ${loadedSource.geometries.length}`,
    `materials: ${loadedSource.materials.length}`,
    `instances: ${loadedSource.geometryIndices.length}`,
    `bounds radius: ${bounds.radius.toFixed(3)}`,
    `resident assets: ${residency.residentAssetCount}`,
    `resident bytes: ${residency.residentBytes}`
  ].join("\n");
}

function getSnapshot(): FixtureResult {
  const position = camera?.transform.position;
  const residency = renderer?.geometryAssetResidencyEvidence();
  const sceneEvidence = renderer?.gpuSceneEvidence();
  return {
    schemaVersion: 1,
    caseId: "model-loading",
    status: fixtureStatus,
    build: { commit: __BUILD_COMMIT__, dirty: __BUILD_DIRTY__, contentHash: __BUILD_CONTENT_HASH__ },
    environment: { width: canvas.width, height: canvas.height, dpr: window.devicePixelRatio },
    lifecycle: {
      frame: renderer?.frame_count ?? 0,
      elapsedMs: Math.round(performance.now() - startedAt),
      initialized
    },
    camera: camera === null || position === undefined
      ? null
      : { position: [position.x, position.y, position.z], near: camera.near, far: camera.far },
    metrics: {
      geometryCount: loadedSource?.geometries.length ?? 0,
      cookedGeometryCount: cookedAssets.length,
      materialCount: loadedSource?.materials.length ?? 0,
      instanceCount: loadedSource?.geometryIndices.length ?? 0,
      residentAssetCount: residency?.residentAssetCount ?? 0,
      residentBytes: residency?.residentBytes ?? 0,
      activeInstanceCount: sceneEvidence?.activeInstanceCount ?? 0
    },
    ...(fixtureError === undefined ? {} : { error: fixtureError })
  };
}

function downloadJson(): void {
  downloadBlob(new Blob([JSON.stringify(getSnapshot(), null, 2)], { type: "application/json" }), "model-loading.result.json");
}

async function captureScreenshot(): Promise<void> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (blob !== null) downloadBlob(blob, "model-loading.png");
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

type Bounds = { readonly center: [number, number, number]; readonly radius: number };

function computeBounds(source: PackedGltfSource): Bounds {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let instance = 0; instance < source.geometryIndices.length; instance++) {
    const boundsOffset = instance * 3;
    const matrixOffset = instance * 16;
    const min = source.boundsMin.subarray(boundsOffset, boundsOffset + 3);
    const max = source.boundsMax.subarray(boundsOffset, boundsOffset + 3);
    for (let corner = 0; corner < 8; corner++) {
      const x = corner & 1 ? max[0]! : min[0]!;
      const y = corner & 2 ? max[1]! : min[1]!;
      const z = corner & 4 ? max[2]! : min[2]!;
      const worldX = source.transforms[matrixOffset]! * x + source.transforms[matrixOffset + 4]! * y + source.transforms[matrixOffset + 8]! * z + source.transforms[matrixOffset + 12]!;
      const worldY = source.transforms[matrixOffset + 1]! * x + source.transforms[matrixOffset + 5]! * y + source.transforms[matrixOffset + 9]! * z + source.transforms[matrixOffset + 13]!;
      const worldZ = source.transforms[matrixOffset + 2]! * x + source.transforms[matrixOffset + 6]! * y + source.transforms[matrixOffset + 10]! * z + source.transforms[matrixOffset + 14]!;
      minimum[0] = Math.min(minimum[0]!, worldX);
      minimum[1] = Math.min(minimum[1]!, worldY);
      minimum[2] = Math.min(minimum[2]!, worldZ);
      maximum[0] = Math.max(maximum[0]!, worldX);
      maximum[1] = Math.max(maximum[1]!, worldY);
      maximum[2] = Math.max(maximum[2]!, worldZ);
    }
  }
  if (![...minimum, ...maximum].every(Number.isFinite)) return { center: [0, 0, 0], radius: 10 };
  const center: [number, number, number] = [
    (minimum[0]! + maximum[0]!) * 0.5,
    (minimum[1]! + maximum[1]!) * 0.5,
    (minimum[2]! + maximum[2]!) * 0.5
  ];
  return {
    center,
    radius: Math.max(1, 0.5 * Math.hypot(
      maximum[0]! - minimum[0]!,
      maximum[1]! - minimum[1]!,
      maximum[2]! - minimum[2]!
    ))
  };
}

function dispose(): void {
  if (disposed) return;
  disposed = true;
  cancelAnimationFrame(frameRequest);
  resizeObserver?.disconnect();
  controls?.pointer.stop();
  controls?.keyboard.stop();
  inspector?.dispose();
  renderer?.destroy();
  canvas.getContext("webgpu")?.unconfigure();
  delete window.__OENGINE_MODEL_LOADING_FIXTURE__;
}

window.addEventListener("pagehide", dispose, { once: true });

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id}`);
  return element as T;
}

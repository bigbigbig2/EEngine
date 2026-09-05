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
  openGeometryAssetPackage,
  type GeometryAssetPackage,
  type GeometryCookEvidence
} from "../../OEngine/src/index.ts";
import { Inspector } from "../../OEngine/src/addons/inspector/index.ts";

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DIRTY__: boolean;
declare const __BUILD_CONTENT_HASH__: string;

type FixtureStatus = "booting" | "ready" | "failed" | "device-lost";
type FixtureResult = {
  readonly schemaVersion: 1;
  readonly caseId: "geometry-preprocess";
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
    __OENGINE_GEOMETRY_PREPROCESS_FIXTURE__?: {
      getSnapshot: () => FixtureResult;
      downloadJson: () => void;
      captureScreenshot: () => Promise<void>;
    };
  }
}

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
let cookedAssets: readonly GeometryAssetPackage[] = [];
let cookEvidence: readonly GeometryCookEvidence[] = [];
let deterministic = false;
let reopened = false;

required<HTMLButtonElement>("download-json").addEventListener("click", downloadJson);
required<HTMLButtonElement>("capture-png").addEventListener("click", () => void captureScreenshot());
required<HTMLButtonElement>("reset-camera").addEventListener("click", resetCamera);
window.__OENGINE_GEOMETRY_PREPROCESS_FIXTURE__ = { getSnapshot, downloadJson, captureScreenshot };

void initialize().catch((error: unknown) => {
  fixtureStatus = "failed";
  fixtureError = {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error)
  };
  status.textContent = fixtureError.message;
  status.dataset.fixtureStatus = fixtureStatus;
  status.style.background = "#4a1720e8";
  metrics.textContent = `Feature 03 · Geometry Preprocess\n失败：${fixtureError.message}`;
  console.error(error);
});

async function initialize(): Promise<void> {
  if (!("gpu" in navigator)) throw new Error("WebGPU 在当前浏览器不可用");
  const context = canvas.getContext("webgpu");
  if (context === null) throw new Error("无法创建 WebGPU canvas context");

  const recipe = createGeometryCookRecipe();
  const sources = [
    buildBoxSourceGeometry(2, 2, 2),
    buildBoxSourceGeometry(10, 0.2, 10)
  ];
  status.textContent = "正在 Cook Meshlet / hierarchy / BVH…";
  const first = await cookGeometryAssetPackage(sources[0]!, recipe);
  const second = await cookGeometryAssetPackage(sources[1]!, recipe);
  cookedAssets = [first.asset, second.asset];
  cookEvidence = [first.evidence, second.evidence];
  deterministic = first.evidence.contentHash === (await cookGeometryAssetPackage(sources[0]!, recipe)).evidence.contentHash;
  reopened = (await openGeometryAssetPackage(first.bytes)).validate().valid &&
    (await openGeometryAssetPackage(second.bytes)).validate().valid;

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
  light.intensity = 3.2;
  light.forward = [-0.45, -0.8, -0.35];
  light.casts_shadow = true;
  activeScene.addChild(light);

  const cubeMaterial = new StandardShadeMaterial();
  cubeMaterial.diffuse_color.set(0.08, 0.38, 0.92, 1);
  cubeMaterial.roughness_factor = 0.32;
  const planeMaterial = new StandardShadeMaterial();
  planeMaterial.diffuse_color.set(0.18, 0.2, 0.25, 1);
  planeMaterial.roughness_factor = 0.9;
  await activeRenderer.uploadPackedScene(activeScene, {
    geometries: cookedAssets,
    materials: [cubeMaterial, planeMaterial],
    count: 2,
    geometryIndices: new Uint32Array([0, 1]),
    materialIndices: new Uint32Array([0, 1]),
    currentTransforms: transforms(),
    previousTransforms: transforms(),
    boundsSpheres: new Float32Array([0, 1.06, 0, 1.7321, 0, -0.06, 0, 7.08]),
    boundsMin: new Float32Array([-1, 0.06, -1, -5, -0.16, -5]),
    boundsMax: new Float32Array([1, 2.06, 1, 5, 0.04, 5]),
    flags: new Uint32Array([0, 0]),
    debugIds: new Uint32Array([1, 2])
  });

  const activeCamera = new PerspectiveCamera();
  camera = activeCamera;
  activeCamera.near = 0.01;
  activeCamera.far = 100;
  activeCamera.aspect = activeRenderer.aspect_ratio;
  activeCamera.transform.position.set(7, 5.5, 8);
  activeCamera.transform.lookAt({ x: 0, y: 0.5, z: 0 });
  activeCamera.update();
  const activeControls = new OrbitControls(activeCamera, canvas);
  controls = activeControls;
  activeControls.distanceLimits.min = 2;
  activeControls.distanceLimits.max = 30;
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
  status.textContent = "Feature 03 · 几何预处理完成";
  updateMetrics();
  startFrameLoop();
}

function transforms(): Float32Array {
  const output = new Float32Array(32);
  writeTranslation(output, 0, 0, 1.06, 0);
  writeTranslation(output, 16, 0, -0.06, 0);
  return output;
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
  if (camera === null) return;
  camera.transform.position.set(7, 5.5, 8);
  camera.transform.lookAt({ x: 0, y: 0.5, z: 0 });
  camera.update();
  controls?.from_transform(camera.transform);
}

function resize(activeRenderer: Renderer, activeCamera: PerspectiveCamera): void {
  activeRenderer.resize(Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight));
  activeCamera.aspect = activeRenderer.aspect_ratio;
  activeCamera.update();
}

function updateMetrics(): void {
  metrics.textContent = [
    "Feature 03 · Geometry Preprocess",
    `packages: ${cookedAssets.length}`,
    `meshlets: ${sumEvidence("meshletCount")}`,
    `clusters: ${sumEvidence("clusterCount")}`,
    `BVH8 nodes: ${sumEvidence("bvh8NodeCount")}`,
    `package bytes: ${sumEvidence("packageBytes")}`,
    `deterministic: ${deterministic}`,
    `reopen valid: ${reopened}`
  ].join("\n");
}

function sumEvidence(key: keyof GeometryCookEvidence): number {
  return cookEvidence.reduce((sum, evidence) => sum + Number(evidence[key]), 0);
}

function getSnapshot(): FixtureResult {
  const position = camera?.transform.position;
  const residency = renderer?.geometryAssetResidencyEvidence();
  const sceneEvidence = renderer?.gpuSceneEvidence();
  return {
    schemaVersion: 1,
    caseId: "geometry-preprocess",
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
      packageCount: cookedAssets.length,
      meshletCount: sumEvidence("meshletCount"),
      clusterCount: sumEvidence("clusterCount"),
      bvh8NodeCount: sumEvidence("bvh8NodeCount"),
      packageBytes: sumEvidence("packageBytes"),
      deterministic,
      reopened,
      residentAssetCount: residency?.residentAssetCount ?? 0,
      residentBytes: residency?.residentBytes ?? 0,
      activeInstanceCount: sceneEvidence?.activeInstanceCount ?? 0
    },
    ...(fixtureError === undefined ? {} : { error: fixtureError })
  };
}

function downloadJson(): void {
  downloadBlob(new Blob([JSON.stringify(getSnapshot(), null, 2)], { type: "application/json" }), "geometry-preprocess.result.json");
}

async function captureScreenshot(): Promise<void> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (blob !== null) downloadBlob(blob, "geometry-preprocess.png");
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
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
  delete window.__OENGINE_GEOMETRY_PREPROCESS_FIXTURE__;
}

window.addEventListener("pagehide", dispose, { once: true });

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id}`);
  return element as T;
}

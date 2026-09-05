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
} from "../../OEngine/src/index.ts";

type MinimalSnapshot = {
  readonly schemaVersion: 1;
  readonly caseId: "foundations-renderer-baseline";
  readonly status: "booting" | "ready" | "failed" | "device-lost";
  readonly frame: number;
  readonly elapsedMs: number;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly cameraPosition: [number, number, number] | null;
  readonly renderScale: number;
  readonly error?: string;
};

type LinearHdrCapture = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly format: "rgba16float";
  readonly rgba: Float32Array;
};

type LinearHdrCaptureRegion = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly stage?: "lighting" | "post-color-grading";
};

declare global {
  interface Window {
    __OENGINE_MINIMAL_SCENE__?: {
    getSnapshot: () => MinimalSnapshot;
    setCameraDistance: (distance: number) => void;
    captureLinearHdr: (region: LinearHdrCaptureRegion) => Promise<LinearHdrCapture>;
    getGraphPasses: () => readonly string[];
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
let scene: Scene | null = null;
let camera: PerspectiveCamera | null = null;
let controls: OrbitControls | null = null;
let frameRequest = 0;
let frame = 0;
let fixtureStatus: MinimalSnapshot["status"] = "booting";
let fixtureError: string | undefined;

window.__OENGINE_MINIMAL_SCENE__ = {
  getSnapshot,
  setCameraDistance,
  captureLinearHdr,
  getGraphPasses,
  downloadJson,
  captureScreenshot
};

required<HTMLButtonElement>("download-json").addEventListener("click", downloadJson);
required<HTMLButtonElement>("capture-png").addEventListener("click", () => void captureScreenshot());
required<HTMLButtonElement>("reset-camera").addEventListener("click", () => setCameraDistance(Math.hypot(7, 5.5, 8)));

void initialize().catch((error: unknown) => {
  fixtureStatus = "failed";
  fixtureError = error instanceof Error ? error.message : String(error);
  status.textContent = fixtureError;
  status.dataset.fixtureStatus = fixtureStatus;
  metrics.textContent = `初始化失败\n${fixtureError}`;
  console.error(error);
});

async function initialize(): Promise<void> {
  if (!("gpu" in navigator)) throw new Error("WebGPU is unavailable in this browser.");
  const context = canvas.getContext("webgpu");
  if (context === null) throw new Error("Unable to create a WebGPU canvas context.");

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
    },
    post: {
      exposureCompensation: 0,
      colorGradingSaturation: 1,
      colorGradingGamma: 1,
      colorGradingGain: 1
    }
  });

  const activeScene = new Scene();
  scene = activeScene;
  const light = new DirectionalLight();
  light.intensity = 1;
  light.forward = [-0.45, -0.8, -0.35];
  light.casts_shadow = false;
  activeScene.addChild(light);

  const source = await createMinimalSceneSource();
  await activeRenderer.uploadPackedScene(activeScene, source);

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
  activeControls.movement_speed_scale = 1.2;
  activeControls.from_transform(activeCamera.transform);

  const resizeObserver = new ResizeObserver(() => resize(activeRenderer, activeCamera));
  resizeObserver.observe(canvas);
  resize(activeRenderer, activeCamera);

  fixtureStatus = "ready";
  status.dataset.fixtureStatus = fixtureStatus;
  status.textContent = "运行中 · Minimal WebGPU";
  metrics.textContent = "frame: 0\nDPR: 1\nfeatures: baseline";
  startFrameLoop();
}

async function createMinimalSceneSource(): Promise<PackedSceneSource> {
  const geometrySources = [
    buildBoxSourceGeometry(2, 2, 2),
    buildBoxSourceGeometry(12, 0.12, 12)
  ];
  const recipe = createGeometryCookRecipe();
  const geometries: GeometryAssetPackage[] = [];
  for (const source of geometrySources) {
    geometries.push((await cookGeometryAssetPackage(source, recipe)).asset);
  }

  const cubeMaterial = new StandardShadeMaterial();
  cubeMaterial.diffuse_color.set(0.1, 0.42, 0.95, 1);
  cubeMaterial.roughness_factor = 0.34;
  const planeMaterial = new StandardShadeMaterial();
  planeMaterial.diffuse_color.set(0.18, 0.2, 0.24, 1);
  planeMaterial.roughness_factor = 0.9;

  const currentTransforms = new Float32Array(32);
  writeTranslation(currentTransforms, 0, 0, 1.06, 0);
  writeTranslation(currentTransforms, 16, 0, -0.06, 0);
  return {
    geometries,
    materials: [cubeMaterial, planeMaterial],
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

function startFrameLoop(): void {
  const frameCallback = (): void => {
    if (renderer === null || scene === null || camera === null) return;
    controls?.update(1 / 60);
    camera.aspect = renderer.aspect_ratio;
    camera.update();
    if (!renderer.render(camera, scene, 1 / 60)) {
      fixtureStatus = "device-lost";
      status.dataset.fixtureStatus = fixtureStatus;
      status.textContent = "WebGPU device lost";
      return;
    }
    frame += 1;
    metrics.textContent = `frame: ${frame}\nDPR: 1\nfeatures: baseline\nRAF: 16.67 ms`;
    frameRequest = requestAnimationFrame(frameCallback);
  };
  frameRequest = requestAnimationFrame(frameCallback);
}

function setCameraDistance(distance: number): void {
  if (camera === null || controls === null) return;
  const safeDistance = Math.max(2, Math.min(30, distance));
  const direction = [7, 5.5, 8];
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  camera.transform.position.set(
    direction[0] / length * safeDistance,
    direction[1] / length * safeDistance,
    direction[2] / length * safeDistance
  );
  camera.transform.lookAt({ x: 0, y: 0.5, z: 0 });
  camera.update();
  controls.from_transform(camera.transform);
}

function getSnapshot(): MinimalSnapshot {
  return {
    schemaVersion: 1,
    caseId: "foundations-renderer-baseline",
    status: fixtureStatus,
    frame,
    elapsedMs: performance.now() - startedAt,
    width: canvas.width,
    height: canvas.height,
    dpr: 1,
    cameraPosition: camera === null ? null : [
      camera.transform.position.x,
      camera.transform.position.y,
      camera.transform.position.z
    ],
    renderScale: 1,
    ...(fixtureError === undefined ? {} : { error: fixtureError })
  };
}

function downloadJson(): void {
  downloadBlob(
    new Blob([JSON.stringify(getSnapshot(), null, 2)], { type: "application/json" }),
    "renderer-baseline.result.json"
  );
}

async function captureScreenshot(): Promise<void> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (blob !== null) downloadBlob(blob, "renderer-baseline.png");
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function captureLinearHdr(region: LinearHdrCaptureRegion): Promise<LinearHdrCapture> {
  if (renderer === null) return Promise.reject(new Error("Renderer is not initialized."));
  return renderer.requestLinearHdrCapture(region);
}

function getGraphPasses(): readonly string[] {
  return renderer?.mainFrameGraphEvidence()?.dump.passes.map(pass => pass.name) ?? [];
}

function resize(activeRenderer: Renderer, activeCamera: PerspectiveCamera): void {
  activeRenderer.resize(Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight));
  activeCamera.aspect = activeRenderer.aspect_ratio;
  activeCamera.update();
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

function required<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element #${id}`);
  return element as T;
}

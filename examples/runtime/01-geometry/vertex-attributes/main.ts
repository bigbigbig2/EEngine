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
  type PackedSceneSource,
  type SourceGeometry,
  type SourceVertexStream
} from "../../../../OEngine/src/index.ts";

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DIRTY__: boolean;
declare const __BUILD_CONTENT_HASH__: string;

type Status = "booting" | "ready" | "failed" | "device-lost";
type Snapshot = {
  readonly schemaVersion: 1;
  readonly caseId: "geometry-vertex-attributes";
  readonly status: Status;
  readonly build: { readonly commit: string; readonly dirty: boolean; readonly contentHash: string };
  readonly environment: { readonly width: number; readonly height: number; readonly dpr: number };
  readonly lifecycle: { readonly frame: number; readonly elapsedMs: number; readonly initialized: boolean };
  readonly metrics: Record<string, number | string | boolean | null>;
  readonly error?: { readonly name: string; readonly message: string };
};

declare global {
  interface Window {
    __OENGINE_GEOMETRY_VERTEX_ATTRIBUTES_FIXTURE__?: {
      getSnapshot: () => Snapshot;
      downloadJson: () => void;
      captureScreenshot: () => Promise<void>;
    };
  }
}

const canvas = required<HTMLCanvasElement>("gpu-canvas");
const status = required<HTMLElement>("scene-status");
const metrics = required<HTMLElement>("scene-metrics");
const attributeList = required<HTMLElement>("attribute-list");
const startedAt = performance.now();
let renderer: Renderer | null = null;
let rendererInitialized = false;
let scene: Scene | null = null;
let camera: PerspectiveCamera | null = null;
let controls: OrbitControls | null = null;
let resizeObserver: ResizeObserver | null = null;
let frameRequest = 0;
let frame = 0;
let disposed = false;
let initialized = false;
let fixtureStatus: Status = "booting";
let fixtureError: Snapshot["error"];
let sourceGeometry: SourceGeometry | null = null;

required<HTMLButtonElement>("download-json").addEventListener("click", downloadJson);
required<HTMLButtonElement>("capture-png").addEventListener("click", () => void captureScreenshot());
required<HTMLButtonElement>("reset-camera").addEventListener("click", resetCamera);
window.__OENGINE_GEOMETRY_VERTEX_ATTRIBUTES_FIXTURE__ = { getSnapshot, downloadJson, captureScreenshot };

void initialize().catch((error: unknown) => {
  releaseRuntime();
  fixtureStatus = "failed";
  fixtureError = { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) };
  status.dataset.fixtureStatus = fixtureStatus;
  status.textContent = fixtureError.message;
  metrics.textContent = `初始化失败\n${fixtureError.message}`;
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
      shadows: false, ambientOcclusion: false, screenSpaceReflections: false,
      temporalAntiAliasing: false, bloom: false, automaticExposure: false,
      motionBlur: false, sharpening: false
    },
    post: { exposureCompensation: 0, colorGradingSaturation: 1, colorGradingGamma: 1, colorGradingGain: 1 }
  });

  const activeScene = new Scene();
  scene = activeScene;
  const light = new DirectionalLight();
  light.intensity = 1;
  light.forward = [-0.45, -0.8, -0.35];
  light.casts_shadow = false;
  activeScene.addChild(light);

  sourceGeometry = buildBoxSourceGeometry(2, 2, 2);
  const cooked = (await cookGeometryAssetPackage(sourceGeometry, createGeometryCookRecipe())).asset;
  await activeRenderer.uploadPackedScene(activeScene, createPackedScene(cooked));

  const activeCamera = new PerspectiveCamera();
  camera = activeCamera;
  activeCamera.near = 0.01;
  activeCamera.far = 100;
  resetCameraTo(activeCamera);
  const activeControls = new OrbitControls(activeCamera, canvas);
  controls = activeControls;
  activeControls.distanceLimits.min = 2;
  activeControls.distanceLimits.max = 20;
  activeControls.from_transform(activeCamera.transform);
  resizeObserver = new ResizeObserver(() => resize(activeRenderer, activeCamera));
  resizeObserver.observe(canvas);
  resize(activeRenderer, activeCamera);

  initialized = true;
  fixtureStatus = "ready";
  status.dataset.fixtureStatus = fixtureStatus;
  status.textContent = "运行中 · Vertex Attributes";
  renderAttributeCards();
  updateMetrics();
  startFrameLoop();
}

function createPackedScene(geometry: GeometryAssetPackage): PackedSceneSource {
  const material = new StandardShadeMaterial();
  material.diffuse_color.set(0.72, 0.78, 0.9, 1);
  material.roughness_factor = 0.5;
  const transform = new Float32Array(16);
  transform[0] = 1; transform[5] = 1; transform[10] = 1; transform[15] = 1;
  return {
    geometries: [geometry], materials: [material], count: 1,
    geometryIndices: new Uint32Array([0]), materialIndices: new Uint32Array([0]),
    currentTransforms: transform, previousTransforms: transform.slice(),
    boundsSpheres: new Float32Array([0, 0, 0, 1.7321]),
    boundsMin: new Float32Array([-1, -1, -1]), boundsMax: new Float32Array([1, 1, 1]),
    flags: new Uint32Array([0]), debugIds: new Uint32Array([1])
  };
}

function renderAttributeCards(): void {
  if (sourceGeometry === null) return;
  const entries = [...sourceGeometry.attributes.values()];
  attributeList.replaceChildren(...entries.map((attribute) => createAttributeCard(attribute)));
}

function updateMetrics(): void {
  if (sourceGeometry === null) return;
  const entries = [...sourceGeometry.attributes.values()];
  metrics.textContent = [
    `vertices: ${sourceGeometry.vertexCount}`,
    `triangles: ${sourceGeometry.triangleCount}`,
    `indices: ${sourceGeometry.indices.length}`,
    `streams: ${entries.length}`,
    `frame: ${frame}`
  ].join("\n");
}

function createAttributeCard(attribute: SourceVertexStream): HTMLElement {
  const card = document.createElement("div");
  card.className = "attribute-card";
  const swatch = document.createElement("span");
  swatch.className = `attribute-swatch attribute-${attribute.semantic}`;
  const text = document.createElement("span");
  text.textContent = `${attribute.semantic} · vec${attribute.componentCount} · ${attribute.dataType} · ${attribute.vertexCount} vertices`;
  card.append(swatch, text);
  return card;
}

function resize(activeRenderer: Renderer, activeCamera: PerspectiveCamera): void {
  activeRenderer.resize(Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight));
  activeCamera.aspect = activeRenderer.aspect_ratio;
  activeCamera.update();
}

function startFrameLoop(): void {
  let previous = performance.now();
  const tick = (now: number): void => {
    if (disposed || renderer === null || scene === null || camera === null) return;
    const deltaSeconds = Math.min(0.1, Math.max(0, now - previous) / 1000);
    previous = now;
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
    frame += 1;
    updateMetrics();
    frameRequest = requestAnimationFrame(tick);
  };
  frameRequest = requestAnimationFrame(tick);
}

function resetCameraTo(activeCamera: PerspectiveCamera): void {
  activeCamera.transform.position.set(5, 3.5, 6);
  activeCamera.transform.lookAt({ x: 0, y: 0, z: 0 });
  activeCamera.update();
}

function resetCamera(): void {
  if (camera === null) return;
  resetCameraTo(camera);
  controls?.from_transform(camera.transform);
}

function getSnapshot(): Snapshot {
  const position = camera?.transform.position;
  const attributes = sourceGeometry === null ? [] : [...sourceGeometry.attributes.values()];
  return {
    schemaVersion: 1,
    caseId: "geometry-vertex-attributes",
    status: fixtureStatus,
    build: { commit: __BUILD_COMMIT__, dirty: __BUILD_DIRTY__, contentHash: __BUILD_CONTENT_HASH__ },
    environment: { width: canvas.width, height: canvas.height, dpr: 1 },
    lifecycle: { frame, elapsedMs: Math.round(performance.now() - startedAt), initialized },
    metrics: {
      vertexCount: sourceGeometry?.vertexCount ?? 0,
      triangleCount: sourceGeometry?.triangleCount ?? 0,
      streamCount: attributes.length,
      streams: attributes.map((attribute) => `${attribute.semantic}:${attribute.dataType}[${attribute.componentCount}]`).join(","),
      cameraPosition: position === undefined ? null : `[${position.x},${position.y},${position.z}]`,
      dpr: 1,
      shadows: false,
      temporalAntiAliasing: false,
      inspector: false
    },
    ...(fixtureError === undefined ? {} : { error: fixtureError })
  };
}

function downloadJson(): void {
  downloadBlob(new Blob([JSON.stringify(getSnapshot(), null, 2)], { type: "application/json" }), "vertex-attributes.result.json");
}

async function captureScreenshot(): Promise<void> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (blob !== null) downloadBlob(blob, "vertex-attributes.png");
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
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
  delete window.__OENGINE_GEOMETRY_VERTEX_ATTRIBUTES_FIXTURE__;
}

window.addEventListener("pagehide", dispose, { once: true });

function required<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element #${id}`);
  return element as T;
}

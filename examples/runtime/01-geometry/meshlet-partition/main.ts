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
  createSourceGeometry,
  type GeometryAssetPackage,
  type GeometryCookEvidence,
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
  readonly caseId: "geometry-meshlet-partition";
  readonly status: Status;
  readonly build: { readonly commit: string; readonly dirty: boolean; readonly contentHash: string };
  readonly environment: { readonly width: number; readonly height: number; readonly dpr: number };
  readonly lifecycle: { readonly frame: number; readonly elapsedMs: number; readonly initialized: boolean };
  readonly metrics: Record<string, number | string | boolean | null>;
  readonly error?: { readonly name: string; readonly message: string };
};

declare global {
  interface Window {
    __OENGINE_GEOMETRY_MESHLET_PARTITION_FIXTURE__?: {
      getSnapshot: () => Snapshot;
      downloadJson: () => void;
      captureScreenshot: () => Promise<void>;
    };
  }
}

const canvas = required<HTMLCanvasElement>("gpu-canvas");
const status = required<HTMLElement>("scene-status");
const metrics = required<HTMLElement>("scene-metrics");
const meshletList = required<HTMLElement>("meshlet-list");
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
let partitionEvidence: GeometryCookEvidence | null = null;
let partitionAsset: GeometryAssetPackage | null = null;

required<HTMLButtonElement>("download-json").addEventListener("click", downloadJson);
required<HTMLButtonElement>("capture-png").addEventListener("click", () => void captureScreenshot());
required<HTMLButtonElement>("reset-camera").addEventListener("click", resetCamera);
window.__OENGINE_GEOMETRY_MESHLET_PARTITION_FIXTURE__ = { getSnapshot, downloadJson, captureScreenshot };

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

  sourceGeometry = buildBoxSourceGeometry(8, 8, 8, 8, 8, 8);
  const partitionCook = await cookGeometryAssetPackage(
    sourceGeometry,
    createGeometryCookRecipe({ hierarchyMode: "single-level", meshletMaxVertices: 64, meshletMaxTriangles: 64 })
  );
  partitionAsset = partitionCook.asset;
  partitionEvidence = partitionCook.evidence;
  // The render preview is rebuilt from the actual Meshlet ranges. All partition
  // metrics and cards above still come only from the single-level artifact.
  const previewScene = await createMeshletPreviewScene(sourceGeometry, partitionAsset);
  await activeRenderer.uploadPackedScene(activeScene, previewScene);

  const activeCamera = new PerspectiveCamera();
  camera = activeCamera;
  activeCamera.near = 0.01;
  activeCamera.far = 100;
  activeCamera.transform.position.set(13, 10, 15);
  activeCamera.transform.lookAt({ x: 0, y: 0, z: 0 });
  activeCamera.update();
  const activeControls = new OrbitControls(activeCamera, canvas);
  controls = activeControls;
  activeControls.distanceLimits.min = 4;
  activeControls.distanceLimits.max = 45;
  activeControls.from_transform(activeCamera.transform);
  resizeObserver = new ResizeObserver(() => resize(activeRenderer, activeCamera));
  resizeObserver.observe(canvas);
  resize(activeRenderer, activeCamera);

  initialized = true;
  fixtureStatus = "ready";
  status.dataset.fixtureStatus = fixtureStatus;
  status.textContent = "运行中 · Meshlet Partition";
  renderMeshletCards();
  updateMetrics();
  startFrameLoop();
}

async function createMeshletPreviewScene(source: SourceGeometry, asset: GeometryAssetPackage): Promise<PackedSceneSource> {
  const position = source.attributes.get("position");
  if (position === undefined) throw new Error("SourceGeometry is missing position data");
  const previewGeometries: GeometryAssetPackage[] = [];
  const materials: StandardShadeMaterial[] = [];
  const transforms = new Float32Array(asset.meshlets.length * 16);
  const boundsSpheres = new Float32Array(asset.meshlets.length * 4);
  const boundsMin = new Float32Array(asset.meshlets.length * 3);
  const boundsMax = new Float32Array(asset.meshlets.length * 3);
  const geometryIndices = new Uint32Array(asset.meshlets.length);
  const materialIndices = new Uint32Array(asset.meshlets.length);
  const flags = new Uint32Array(asset.meshlets.length);
  const debugIds = new Uint32Array(asset.meshlets.length);
  for (let index = 0; index < asset.meshlets.length; index++) {
    const meshlet = asset.meshlets[index]!;
    previewGeometries.push((await cookGeometryAssetPackage(
      createMeshletSource(source, asset, index),
      createGeometryCookRecipe()
    )).asset);
    const material = new StandardShadeMaterial();
    const color = hslToRgb(index / Math.max(1, asset.meshlets.length), 0.72, 0.58);
    material.diffuse_color.set(color[0], color[1], color[2], 1);
    material.roughness_factor = 0.62;
    materials.push(material);
    const transformOffset = index * 16;
    transforms[transformOffset] = 1;
    transforms[transformOffset + 5] = 1;
    transforms[transformOffset + 10] = 1;
    transforms[transformOffset + 15] = 1;
    boundsSpheres.set([meshlet.bounds.centerX, meshlet.bounds.centerY, meshlet.bounds.centerZ, meshlet.bounds.radius], index * 4);
    boundsMin.set(meshlet.boundsBox.subarray(0, 3), index * 3);
    boundsMax.set(meshlet.boundsBox.subarray(3, 6), index * 3);
    geometryIndices[index] = index;
    materialIndices[index] = index;
    debugIds[index] = index + 1;
  }
  return {
    geometries: previewGeometries, materials, count: asset.meshlets.length,
    geometryIndices, materialIndices, currentTransforms: transforms,
    previousTransforms: transforms.slice(), boundsSpheres, boundsMin, boundsMax,
    flags, debugIds
  };
}

function createMeshletSource(source: SourceGeometry, asset: GeometryAssetPackage, index: number): SourceGeometry {
  const meshlet = asset.meshlets[index]!;
  const globalVertices = asset.meshletVertexIndices.subarray(meshlet.vertexOffset, meshlet.vertexOffset + meshlet.vertexCount);
  const localTriangles = asset.meshletTriangleIndices.subarray(meshlet.triangleOffset, meshlet.triangleOffset + meshlet.triangleCount * 3);
  const attributes = [...source.attributes.values()].map((stream: SourceVertexStream) => {
    const data = new Float32Array(meshlet.vertexCount * stream.componentCount);
    for (let vertex = 0; vertex < globalVertices.length; vertex++) {
      const sourceOffset = globalVertices[vertex]! * stream.componentCount;
      data.set(stream.data.subarray(sourceOffset, sourceOffset + stream.componentCount), vertex * stream.componentCount);
    }
    return { semantic: stream.semantic, componentCount: stream.componentCount, normalized: stream.normalized, data };
  });
  return createSourceGeometry({
    sourceId: `meshlet-preview:${index}`,
    indices: localTriangles,
    attributes
  });
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = hue * 6;
  const x = chroma * (1 - Math.abs((sector % 2) - 1));
  const match = lightness - chroma / 2;
  const rgb = sector < 1 ? [chroma, x, 0] : sector < 2 ? [x, chroma, 0] : sector < 3 ? [0, chroma, x] : sector < 4 ? [0, x, chroma] : sector < 5 ? [x, 0, chroma] : [chroma, 0, x];
  return [rgb[0] + match, rgb[1] + match, rgb[2] + match];
}

function renderMeshletCards(): void {
  if (partitionAsset === null) return;
  meshletList.replaceChildren(...partitionAsset.meshlets.map((meshlet, index) => {
    const card = document.createElement("div");
    card.className = "meshlet-card";
    const swatch = document.createElement("span");
    swatch.className = "meshlet-swatch";
    swatch.style.background = `hsl(${Math.round(index * 360 / Math.max(1, partitionAsset!.meshlets.length))} 72% 58%)`;
    const text = document.createElement("span");
    text.textContent = `M${index} · v${meshlet.vertexCount} · t${meshlet.triangleCount} · r${meshlet.bounds.radius.toFixed(2)}`;
    card.append(swatch, text);
    return card;
  }));
}

function updateMetrics(): void {
  if (sourceGeometry === null || partitionEvidence === null) return;
  metrics.textContent = [
    `source triangles: ${sourceGeometry.triangleCount}`,
    `meshlets: ${partitionEvidence.meshletCount}`,
    `meshlet vertices: ${partitionEvidence.meshletVertexIndexCount}`,
    `meshlet triangles: ${partitionEvidence.meshletTriangleCount}`,
    `limits: 64 vertices / 64 triangles`,
    `recipe: single-level`,
    `frame: ${frame}`
  ].join("\n");
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

function resetCamera(): void {
  if (camera === null) return;
  camera.transform.position.set(13, 10, 15);
  camera.transform.lookAt({ x: 0, y: 0, z: 0 });
  camera.update();
  controls?.from_transform(camera.transform);
}

function getSnapshot(): Snapshot {
  return {
    schemaVersion: 1,
    caseId: "geometry-meshlet-partition",
    status: fixtureStatus,
    build: { commit: __BUILD_COMMIT__, dirty: __BUILD_DIRTY__, contentHash: __BUILD_CONTENT_HASH__ },
    environment: { width: canvas.width, height: canvas.height, dpr: 1 },
    lifecycle: { frame, elapsedMs: Math.round(performance.now() - startedAt), initialized },
    metrics: {
      sourceVertexCount: partitionEvidence?.sourceVertexCount ?? 0,
      sourceTriangleCount: partitionEvidence?.sourceTriangleCount ?? 0,
      meshletCount: partitionEvidence?.meshletCount ?? 0,
      meshletVertexIndexCount: partitionEvidence?.meshletVertexIndexCount ?? 0,
      meshletTriangleCount: partitionEvidence?.meshletTriangleCount ?? 0,
      maxMeshletVertices: 64,
      maxMeshletTriangles: 64,
      recipeHierarchyMode: "single-level",
      dpr: 1,
      shadows: false,
      temporalAntiAliasing: false,
      inspector: false
    },
    ...(fixtureError === undefined ? {} : { error: fixtureError })
  };
}

function downloadJson(): void {
  downloadBlob(new Blob([JSON.stringify(getSnapshot(), null, 2)], { type: "application/json" }), "meshlet-partition.result.json");
}

async function captureScreenshot(): Promise<void> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (blob !== null) downloadBlob(blob, "meshlet-partition.png");
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
  delete window.__OENGINE_GEOMETRY_MESHLET_PARTITION_FIXTURE__;
}

window.addEventListener("pagehide", dispose, { once: true });

function required<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element #${id}`);
  return element as T;
}

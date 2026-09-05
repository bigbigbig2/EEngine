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
  type SourceGeometry
} from "../../../../OEngine/src/index.ts";

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DIRTY__: boolean;
declare const __BUILD_CONTENT_HASH__: string;

type Status = "booting" | "ready" | "failed" | "device-lost";
type Snapshot = {
  readonly schemaVersion: 1;
  readonly caseId: "geometry-meshlet-bounds";
  readonly status: Status;
  readonly build: { readonly commit: string; readonly dirty: boolean; readonly contentHash: string };
  readonly environment: { readonly width: number; readonly height: number; readonly dpr: number };
  readonly lifecycle: { readonly frame: number; readonly elapsedMs: number; readonly initialized: boolean };
  readonly metrics: Record<string, number | string | boolean | null>;
  readonly error?: { readonly name: string; readonly message: string };
};

declare global {
  interface Window {
    __OENGINE_GEOMETRY_MESHLET_BOUNDS_FIXTURE__?: {
      getSnapshot: () => Snapshot;
      downloadJson: () => void;
      captureScreenshot: () => Promise<void>;
    };
  }
}

const canvas = required<HTMLCanvasElement>("gpu-canvas");
const status = required<HTMLElement>("scene-status");
const metrics = required<HTMLElement>("scene-metrics");
const boundsList = required<HTMLElement>("bounds-list");
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
let boundsAsset: GeometryAssetPackage | null = null;
let boundsEvidence: GeometryCookEvidence | null = null;
let boundsValidation = false;

required<HTMLButtonElement>("download-json").addEventListener("click", downloadJson);
required<HTMLButtonElement>("capture-png").addEventListener("click", () => void captureScreenshot());
required<HTMLButtonElement>("reset-camera").addEventListener("click", resetCamera);
window.__OENGINE_GEOMETRY_MESHLET_BOUNDS_FIXTURE__ = { getSnapshot, downloadJson, captureScreenshot };

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
  const cooked = await cookGeometryAssetPackage(
    sourceGeometry,
    createGeometryCookRecipe({ hierarchyMode: "single-level", meshletMaxVertices: 64, meshletMaxTriangles: 64 })
  );
  boundsAsset = cooked.asset;
  boundsEvidence = cooked.evidence;
  boundsValidation = boundsAsset.validate().valid;
  await activeRenderer.uploadPackedScene(activeScene, await createBoundsPreviewScene(sourceGeometry, boundsAsset));

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
  status.textContent = "运行中 · Meshlet Bounds";
  renderBoundsCards();
  updateMetrics();
  startFrameLoop();
}

async function createBoundsPreviewScene(source: SourceGeometry, asset: GeometryAssetPackage): Promise<PackedSceneSource> {
  const surface = (await cookGeometryAssetPackage(source, createGeometryCookRecipe())).asset;
  const geometries: GeometryAssetPackage[] = [surface];
  const materials: StandardShadeMaterial[] = [createMaterial([0.28, 0.36, 0.5], false)];
  const transforms = new Float32Array((asset.meshlets.length + 1) * 16);
  const boundsSpheres = new Float32Array((asset.meshlets.length + 1) * 4);
  const boundsMin = new Float32Array((asset.meshlets.length + 1) * 3);
  const boundsMax = new Float32Array((asset.meshlets.length + 1) * 3);
  const geometryIndices = new Uint32Array(asset.meshlets.length + 1);
  const materialIndices = new Uint32Array(asset.meshlets.length + 1);
  const flags = new Uint32Array(asset.meshlets.length + 1);
  const debugIds = new Uint32Array(asset.meshlets.length + 1);
  setIdentity(transforms, 0);
  boundsSpheres.set(source.bounds.sphere, 0);
  boundsMin.set(source.bounds.box.subarray(0, 3), 0);
  boundsMax.set(source.bounds.box.subarray(3, 6), 0);
  geometryIndices[0] = 0;
  debugIds[0] = 1;
  for (let index = 0; index < asset.meshlets.length; index++) {
    const meshlet = asset.meshlets[index]!;
    const geometry = (await cookGeometryAssetPackage(createBoundsWireSource(meshlet.boundsBox, meshlet.bounds, index), createGeometryCookRecipe())).asset;
    const instance = index + 1;
    geometries.push(geometry);
    materials.push(createMaterial(hslToRgb(index / Math.max(1, asset.meshlets.length), 0.78, 0.58), true));
    setIdentity(transforms, instance * 16);
    boundsSpheres.set([meshlet.bounds.centerX, meshlet.bounds.centerY, meshlet.bounds.centerZ, meshlet.bounds.radius], instance * 4);
    boundsMin.set(meshlet.boundsBox.subarray(0, 3), instance * 3);
    boundsMax.set(meshlet.boundsBox.subarray(3, 6), instance * 3);
    geometryIndices[instance] = instance;
    materialIndices[instance] = instance;
    debugIds[instance] = index + 2;
  }
  return { geometries, materials, count: geometries.length, geometryIndices, materialIndices, currentTransforms: transforms, previousTransforms: transforms.slice(), boundsSpheres, boundsMin, boundsMax, flags, debugIds };
}

function createMaterial(rgb: [number, number, number], unlit: boolean): StandardShadeMaterial {
  const material = new StandardShadeMaterial();
  material.diffuse_color.set(rgb[0], rgb[1], rgb[2], 1);
  material.roughness_factor = 0.7;
  material.is_unlit = unlit;
  return material;
}

function createBoundsWireSource(bounds: Float32Array, sphere: { readonly centerX: number; readonly centerY: number; readonly centerZ: number; readonly radius: number }, index: number): SourceGeometry {
  const minX = bounds[0]!, minY = bounds[1]!, minZ = bounds[2]!;
  const maxX = bounds[3]!, maxY = bounds[4]!, maxZ = bounds[5]!;
  const thickness = Math.max(0.025, Math.min(maxX - minX, maxY - minY, maxZ - minZ) * 0.035);
  const half = thickness * 0.5;
  const positions: number[] = [];
  const indices: number[] = [];
  const addBox = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void => {
    const offset = positions.length / 3;
    positions.push(x0, y0, z0, x1, y0, z0, x0, y1, z0, x1, y1, z0, x0, y0, z1, x1, y0, z1, x0, y1, z1, x1, y1, z1);
    indices.push(offset, offset + 1, offset + 2, offset + 2, offset + 1, offset + 3, offset + 4, offset + 6, offset + 5, offset + 6, offset + 7, offset + 5, offset, offset + 4, offset + 1, offset + 1, offset + 4, offset + 5, offset + 2, offset + 3, offset + 6, offset + 6, offset + 3, offset + 7, offset, offset + 2, offset + 4, offset + 4, offset + 2, offset + 6, offset + 1, offset + 5, offset + 3, offset + 3, offset + 5, offset + 7);
  };
  for (const y of [minY, maxY]) for (const z of [minZ, maxZ]) addBox(minX, y - half, z - half, maxX, y + half, z + half);
  for (const x of [minX, maxX]) for (const z of [minZ, maxZ]) addBox(x - half, minY, z - half, x + half, maxY, z + half);
  for (const x of [minX, maxX]) for (const y of [minY, maxY]) addBox(x - half, y - half, minZ, x + half, y + half, maxZ);
  const addSegmentBox = (a: [number, number, number], b: [number, number, number]): void => {
    addBox(
      Math.min(a[0], b[0]) - half, Math.min(a[1], b[1]) - half, Math.min(a[2], b[2]) - half,
      Math.max(a[0], b[0]) + half, Math.max(a[1], b[1]) + half, Math.max(a[2], b[2]) + half
    );
  };
  const segments = 24;
  for (let segment = 0; segment < segments; segment++) {
    const a = segment * Math.PI * 2 / segments;
    const b = (segment + 1) * Math.PI * 2 / segments;
    const ca = Math.cos(a) * sphere.radius;
    const sa = Math.sin(a) * sphere.radius;
    const cb = Math.cos(b) * sphere.radius;
    const sb = Math.sin(b) * sphere.radius;
    addSegmentBox([sphere.centerX + ca, sphere.centerY + sa, sphere.centerZ], [sphere.centerX + cb, sphere.centerY + sb, sphere.centerZ]);
    addSegmentBox([sphere.centerX + ca, sphere.centerY, sphere.centerZ + sa], [sphere.centerX + cb, sphere.centerY, sphere.centerZ + sb]);
    addSegmentBox([sphere.centerX, sphere.centerY + ca, sphere.centerZ + sa], [sphere.centerX, sphere.centerY + cb, sphere.centerZ + sb]);
  }
  return createSourceGeometry({ sourceId: `meshlet-bounds:${index}`, indices, attributes: [{ semantic: "position", componentCount: 3, data: new Float32Array(positions) }] });
}

function setIdentity(target: Float32Array, offset: number): void { target[offset] = 1; target[offset + 5] = 1; target[offset + 10] = 1; target[offset + 15] = 1; }

function renderBoundsCards(): void {
  if (boundsAsset === null) return;
  boundsList.replaceChildren(...boundsAsset.meshlets.map((meshlet, index) => {
    const card = document.createElement("div");
    card.className = "bounds-card";
    const swatch = document.createElement("span");
    swatch.className = "bounds-swatch";
    swatch.style.background = `hsl(${Math.round(index * 360 / Math.max(1, boundsAsset!.meshlets.length))} 78% 58%)`;
    const text = document.createElement("span");
    text.textContent = `M${index} · c[${meshlet.bounds.centerX.toFixed(2)}, ${meshlet.bounds.centerY.toFixed(2)}, ${meshlet.bounds.centerZ.toFixed(2)}] · r${meshlet.bounds.radius.toFixed(2)}`;
    card.append(swatch, text);
    return card;
  }));
}

function updateMetrics(): void {
  if (sourceGeometry === null || boundsEvidence === null || boundsAsset === null) return;
  metrics.textContent = [`meshlets: ${boundsEvidence.meshletCount}`, `source triangles: ${sourceGeometry.triangleCount}`, `AABB records: ${boundsAsset.meshlets.length}`, `sphere records: ${boundsAsset.meshlets.length}`, `validation: ${boundsValidation ? "valid" : "invalid"}`, `frame: ${frame}`].join("\n");
}

function resize(activeRenderer: Renderer, activeCamera: PerspectiveCamera): void { activeRenderer.resize(Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight)); activeCamera.aspect = activeRenderer.aspect_ratio; activeCamera.update(); }
function startFrameLoop(): void { let previous = performance.now(); const tick = (now: number): void => { if (disposed || renderer === null || scene === null || camera === null) return; const delta = Math.min(0.1, Math.max(0, now - previous) / 1000); previous = now; controls?.update(delta); camera.aspect = renderer.aspect_ratio; camera.update(); if (!renderer.render(camera, scene, delta)) { fixtureStatus = "device-lost"; status.dataset.fixtureStatus = fixtureStatus; status.textContent = "WebGPU device lost"; releaseRuntime(); return; } frame += 1; updateMetrics(); frameRequest = requestAnimationFrame(tick); }; frameRequest = requestAnimationFrame(tick); }
function resetCamera(): void { if (camera === null) return; camera.transform.position.set(13, 10, 15); camera.transform.lookAt({ x: 0, y: 0, z: 0 }); camera.update(); controls?.from_transform(camera.transform); }
function getSnapshot(): Snapshot { return { schemaVersion: 1, caseId: "geometry-meshlet-bounds", status: fixtureStatus, build: { commit: __BUILD_COMMIT__, dirty: __BUILD_DIRTY__, contentHash: __BUILD_CONTENT_HASH__ }, environment: { width: canvas.width, height: canvas.height, dpr: 1 }, lifecycle: { frame, elapsedMs: Math.round(performance.now() - startedAt), initialized }, metrics: { sourceTriangleCount: boundsEvidence?.sourceTriangleCount ?? 0, meshletCount: boundsEvidence?.meshletCount ?? 0, boundsRecordCount: boundsAsset?.meshlets.length ?? 0, boundsValidation, hierarchyMode: "single-level", dpr: 1, shadows: false, temporalAntiAliasing: false, inspector: false }, ...(fixtureError === undefined ? {} : { error: fixtureError }) }; }
function downloadJson(): void { downloadBlob(new Blob([JSON.stringify(getSnapshot(), null, 2)], { type: "application/json" }), "meshlet-bounds.result.json"); }
async function captureScreenshot(): Promise<void> { const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png")); if (blob !== null) downloadBlob(blob, "meshlet-bounds.png"); }
function downloadBlob(blob: Blob, filename: string): void { const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url); }
function releaseRuntime(destroyRenderer = true): void { cancelAnimationFrame(frameRequest); frameRequest = 0; resizeObserver?.disconnect(); resizeObserver = null; controls?.pointer.stop(); controls?.keyboard.stop(); controls = null; if (destroyRenderer && rendererInitialized) renderer?.destroy(); rendererInitialized = false; renderer = null; scene = null; camera = null; canvas.getContext("webgpu")?.unconfigure(); }
function dispose(): void { if (disposed) return; disposed = true; releaseRuntime(false); delete window.__OENGINE_GEOMETRY_MESHLET_BOUNDS_FIXTURE__; }
window.addEventListener("pagehide", dispose, { once: true });
function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] { const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation; const sector = hue * 6; const x = chroma * (1 - Math.abs((sector % 2) - 1)); const match = lightness - chroma / 2; const rgb = sector < 1 ? [chroma, x, 0] : sector < 2 ? [x, chroma, 0] : sector < 3 ? [0, chroma, x] : sector < 4 ? [0, x, chroma] : sector < 5 ? [x, 0, chroma] : [chroma, 0, x]; return [rgb[0] + match, rgb[1] + match, rgb[2] + match]; }
function required<T extends Element>(id: string): T { const element = document.getElementById(id); if (element === null) throw new Error(`Missing element #${id}`); return element as T; }

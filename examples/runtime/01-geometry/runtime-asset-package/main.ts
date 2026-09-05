import {
  DirectionalLight,
  OrbitControls,
  PerspectiveCamera,
  Renderer,
  Scene,
  StandardShadeMaterial,
  GEOMETRY_SECTION_TYPES,
  buildBoxSourceGeometry,
  cookGeometryAssetPackage,
  createGeometryCookRecipe,
  type GeometryAssetPackage,
  type GeometryCookEvidence,
  type PackedSceneSource,
  type SourceGeometry
} from "../../../../OEngine/src/index.ts";

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DIRTY__: boolean;
declare const __BUILD_CONTENT_HASH__: string;

type Status = "booting" | "ready" | "failed" | "device-lost";
type Snapshot = { readonly schemaVersion: 1; readonly caseId: "geometry-runtime-asset-package"; readonly status: Status; readonly build: { readonly commit: string; readonly dirty: boolean; readonly contentHash: string }; readonly environment: { readonly width: number; readonly height: number; readonly dpr: number }; readonly lifecycle: { readonly frame: number; readonly elapsedMs: number; readonly initialized: boolean }; readonly metrics: Record<string, number | string | boolean | null>; readonly error?: { readonly name: string; readonly message: string } };

declare global { interface Window { __OENGINE_GEOMETRY_RUNTIME_ASSET_PACKAGE_FIXTURE__?: { getSnapshot: () => Snapshot; downloadJson: () => void; captureScreenshot: () => Promise<void> } } }

const canvas = required<HTMLCanvasElement>("gpu-canvas");
const status = required<HTMLElement>("scene-status");
const metrics = required<HTMLElement>("scene-metrics");
const sectionList = required<HTMLElement>("package-sections");
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
let packageAsset: GeometryAssetPackage | null = null;
let packageEvidence: GeometryCookEvidence | null = null;
let packageValidation = false;
let geometryValidation = false;

required<HTMLButtonElement>("download-json").addEventListener("click", downloadJson);
required<HTMLButtonElement>("capture-png").addEventListener("click", () => void captureScreenshot());
required<HTMLButtonElement>("reset-camera").addEventListener("click", resetCamera);
window.__OENGINE_GEOMETRY_RUNTIME_ASSET_PACKAGE_FIXTURE__ = { getSnapshot, downloadJson, captureScreenshot };

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
  activeRenderer.configure({ features: { shadows: false, ambientOcclusion: false, screenSpaceReflections: false, temporalAntiAliasing: false, bloom: false, automaticExposure: false, motionBlur: false, sharpening: false }, post: { exposureCompensation: 0, colorGradingSaturation: 1, colorGradingGamma: 1, colorGradingGain: 1 } });
  const activeScene = new Scene();
  scene = activeScene;
  const light = new DirectionalLight();
  light.intensity = 1;
  light.forward = [-0.45, -0.8, -0.35];
  light.casts_shadow = false;
  activeScene.addChild(light);

  sourceGeometry = buildBoxSourceGeometry(8, 8, 8, 8, 8, 8);
  const cooked = await cookGeometryAssetPackage(sourceGeometry, createGeometryCookRecipe({ hierarchyMode: "renderable", meshletMaxVertices: 64, meshletMaxTriangles: 64, hierarchyTargetFanout: 4 }));
  packageAsset = cooked.asset;
  packageEvidence = cooked.evidence;
  packageValidation = packageAsset.package.validate().valid;
  geometryValidation = packageAsset.validate().valid;
  renderPackageSections();
  await activeRenderer.uploadPackedScene(activeScene, await createPreviewScene(sourceGeometry, packageAsset));

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
  status.textContent = "运行中 · Runtime Asset Package";
  updateMetrics();
  startFrameLoop();
}

async function createPreviewScene(source: SourceGeometry, asset: GeometryAssetPackage): Promise<PackedSceneSource> {
  const geometry = (await cookGeometryAssetPackage(source, createGeometryCookRecipe())).asset;
  const material = new StandardShadeMaterial();
  material.diffuse_color.set(0.28, 0.36, 0.5, 1);
  material.roughness_factor = 0.7;
  return { geometries: [geometry], materials: [material], count: 1, geometryIndices: new Uint32Array([0]), materialIndices: new Uint32Array([0]), currentTransforms: identity(), previousTransforms: identity(), boundsSpheres: new Float32Array(source.bounds.sphere), boundsMin: new Float32Array(source.bounds.box.subarray(0, 3)), boundsMax: new Float32Array(source.bounds.box.subarray(3, 6)), flags: new Uint32Array([0]), debugIds: new Uint32Array([asset.directory.meshletCount > 0 ? 1 : 0]) };
}

function renderPackageSections(): void {
  if (packageAsset === null) return;
  const names = new Map<number, string>(Object.entries(GEOMETRY_SECTION_TYPES).map(([name, value]) => [Number(value), name]));
  sectionList.replaceChildren(...packageAsset.package.sections.map((section) => { const card = document.createElement("div"); card.className = "section-card"; const name = document.createElement("span"); name.textContent = names.get(section.type) ?? `Section 0x${section.type.toString(16)}`; const bytes = document.createElement("strong"); bytes.textContent = `${section.byteLength} B`; const detail = document.createElement("small"); detail.textContent = `type ${section.type} · offset ${section.byteOffset} · stride ${section.elementStride} · count ${section.elementCount} · align ${section.alignment}`; card.append(name, bytes, detail); return card; }));
}

function updateMetrics(): void {
  if (packageAsset === null || packageEvidence === null) return;
  const manifest = packageAsset.package.manifest;
  metrics.textContent = [`format/schema: v${manifest.formatVersion} / 0x${manifest.schemaHash.toString(16)}`, `sections: ${manifest.sectionCount}`, `package bytes: ${manifest.totalByteLength}`, `content hash: ${manifest.contentHash.slice(0, 24)}…`, `reopen validation: ${packageValidation ? "valid" : "invalid"}`, `geometry validation: ${geometryValidation ? "valid" : "invalid"}`, `meshlets/clusters/BVH8: ${packageEvidence.meshletCount}/${packageEvidence.clusterCount}/${packageEvidence.bvh8NodeCount}`, `frame: ${frame}`].join("\n");
}

function identity(): Float32Array { const matrix = new Float32Array(16); matrix[0] = 1; matrix[5] = 1; matrix[10] = 1; matrix[15] = 1; return matrix; }
function resize(activeRenderer: Renderer, activeCamera: PerspectiveCamera): void { activeRenderer.resize(Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight)); activeCamera.aspect = activeRenderer.aspect_ratio; activeCamera.update(); }
function startFrameLoop(): void { let previous = performance.now(); const tick = (now: number): void => { if (disposed || renderer === null || scene === null || camera === null) return; const delta = Math.min(0.1, Math.max(0, now - previous) / 1000); previous = now; controls?.update(delta); camera.aspect = renderer.aspect_ratio; camera.update(); if (!renderer.render(camera, scene, delta)) { fixtureStatus = "device-lost"; status.dataset.fixtureStatus = fixtureStatus; status.textContent = "WebGPU device lost"; releaseRuntime(); return; } frame += 1; updateMetrics(); frameRequest = requestAnimationFrame(tick); }; frameRequest = requestAnimationFrame(tick); }
function resetCamera(): void { if (camera === null) return; camera.transform.position.set(13, 10, 15); camera.transform.lookAt({ x: 0, y: 0, z: 0 }); camera.update(); controls?.from_transform(camera.transform); }
function getSnapshot(): Snapshot { const manifest = packageAsset?.package.manifest; return { schemaVersion: 1, caseId: "geometry-runtime-asset-package", status: fixtureStatus, build: { commit: __BUILD_COMMIT__, dirty: __BUILD_DIRTY__, contentHash: __BUILD_CONTENT_HASH__ }, environment: { width: canvas.width, height: canvas.height, dpr: 1 }, lifecycle: { frame, elapsedMs: Math.round(performance.now() - startedAt), initialized }, metrics: { formatVersion: manifest?.formatVersion ?? 0, schemaHash: manifest?.schemaHash ?? 0, sectionCount: manifest?.sectionCount ?? 0, packageBytes: manifest?.totalByteLength ?? 0, contentHash: manifest?.contentHash ?? null, packageValidation, geometryValidation, meshletCount: packageEvidence?.meshletCount ?? 0, clusterCount: packageEvidence?.clusterCount ?? 0, bvh8NodeCount: packageEvidence?.bvh8NodeCount ?? 0, dpr: 1, shadows: false, temporalAntiAliasing: false, inspector: false }, ...(fixtureError === undefined ? {} : { error: fixtureError }) }; }
function downloadJson(): void { downloadBlob(new Blob([JSON.stringify(getSnapshot(), null, 2)], { type: "application/json" }), "runtime-asset-package.result.json"); }
async function captureScreenshot(): Promise<void> { const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png")); if (blob !== null) downloadBlob(blob, "runtime-asset-package.png"); }
function downloadBlob(blob: Blob, filename: string): void { const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url); }
function releaseRuntime(destroyRenderer = true): void { cancelAnimationFrame(frameRequest); frameRequest = 0; resizeObserver?.disconnect(); resizeObserver = null; controls?.pointer.stop(); controls?.keyboard.stop(); controls = null; if (destroyRenderer && rendererInitialized) renderer?.destroy(); rendererInitialized = false; renderer = null; scene = null; camera = null; }
function dispose(): void { if (disposed) return; disposed = true; releaseRuntime(false); delete window.__OENGINE_GEOMETRY_RUNTIME_ASSET_PACKAGE_FIXTURE__; }
window.addEventListener("pagehide", dispose, { once: true });
function required<T extends Element>(id: string): T { const element = document.getElementById(id); if (element === null) throw new Error(`Missing element #${id}`); return element as T; }

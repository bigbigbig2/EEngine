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
  type GeometryCookEvidence,
  type GeometryAssetValidationReport,
  type PackedSceneSource,
  type RuntimeAssetValidationReport,
  type SourceGeometry
} from "../../../../OEngine/src/index.ts";

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DIRTY__: boolean;
declare const __BUILD_CONTENT_HASH__: string;

type Status = "booting" | "ready" | "failed" | "device-lost";
type Snapshot = { readonly schemaVersion: 1; readonly caseId: "geometry-package-validation"; readonly status: Status; readonly build: { readonly commit: string; readonly dirty: boolean; readonly contentHash: string }; readonly environment: { readonly width: number; readonly height: number; readonly dpr: number }; readonly lifecycle: { readonly frame: number; readonly elapsedMs: number; readonly initialized: boolean }; readonly metrics: Record<string, number | string | boolean | null>; readonly reports?: { readonly package: RuntimeAssetValidationReport; readonly geometry: GeometryAssetValidationReport }; readonly error?: { readonly name: string; readonly message: string } };

declare global { interface Window { __OENGINE_GEOMETRY_PACKAGE_VALIDATION_FIXTURE__?: { getSnapshot: () => Snapshot; downloadJson: () => void; captureScreenshot: () => Promise<void> } } }

const canvas = required<HTMLCanvasElement>("gpu-canvas");
const status = required<HTMLElement>("scene-status");
const metrics = required<HTMLElement>("scene-metrics");
const reportElement = required<HTMLElement>("validation-report");
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
let validationAsset: GeometryAssetPackage | null = null;
let validationEvidence: GeometryCookEvidence | null = null;
let packageReport: RuntimeAssetValidationReport | null = null;
let geometryReport: GeometryAssetValidationReport | null = null;

required<HTMLButtonElement>("download-json").addEventListener("click", downloadJson);
required<HTMLButtonElement>("capture-png").addEventListener("click", () => void captureScreenshot());
required<HTMLButtonElement>("reset-camera").addEventListener("click", resetCamera);
window.__OENGINE_GEOMETRY_PACKAGE_VALIDATION_FIXTURE__ = { getSnapshot, downloadJson, captureScreenshot };

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
  validationAsset = cooked.asset;
  validationEvidence = cooked.evidence;
  packageReport = validationAsset.package.validate();
  geometryReport = validationAsset.validate();
  renderReports();
  await activeRenderer.uploadPackedScene(activeScene, await createPreviewScene(sourceGeometry));

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
  status.textContent = "运行中 · Package Validation";
  updateMetrics();
  startFrameLoop();
}

async function createPreviewScene(source: SourceGeometry): Promise<PackedSceneSource> {
  const geometry = (await cookGeometryAssetPackage(source, createGeometryCookRecipe())).asset;
  const material = new StandardShadeMaterial();
  material.diffuse_color.set(0.28, 0.36, 0.5, 1);
  material.roughness_factor = 0.7;
  return { geometries: [geometry], materials: [material], count: 1, geometryIndices: new Uint32Array([0]), materialIndices: new Uint32Array([0]), currentTransforms: identity(), previousTransforms: identity(), boundsSpheres: new Float32Array(source.bounds.sphere), boundsMin: new Float32Array(source.bounds.box.subarray(0, 3)), boundsMax: new Float32Array(source.bounds.box.subarray(3, 6)), flags: new Uint32Array([0]), debugIds: new Uint32Array([1]) };
}

function renderReports(): void {
  if (packageReport === null || geometryReport === null) return;
  reportElement.replaceChildren(renderReportCard("RuntimeAssetPackage", packageReport), renderReportCard("GeometryAssetPackage", geometryReport));
}

function renderReportCard(title: string, report: RuntimeAssetValidationReport | GeometryAssetValidationReport): HTMLElement {
  const card = document.createElement("div");
  card.className = `report-card ${report.valid ? "valid" : "invalid"}`;
  const heading = document.createElement("div");
  heading.textContent = `${title} · ${report.valid ? "VALID" : "INVALID"} · ${report.issues.length} issue(s)`;
  card.append(heading);
  for (const issue of report.issues) {
    const element = document.createElement("div");
    element.className = `issue ${issue.severity}`;
    element.textContent = `${issue.severity.toUpperCase()} ${issue.code}${issue.sectionType === undefined ? "" : ` [section ${issue.sectionType}]`}: ${issue.message}`;
    card.append(element);
  }
  if (report.issues.length === 0) { const clean = document.createElement("small"); clean.textContent = "No validation issues."; card.append(clean); }
  return card;
}

function updateMetrics(): void {
  if (validationAsset === null || validationEvidence === null || packageReport === null || geometryReport === null) return;
  metrics.textContent = [`package valid: ${packageReport.valid}`, `geometry valid: ${geometryReport.valid}`, `package issues: ${packageReport.issues.length}`, `geometry issues: ${geometryReport.issues.length}`, `sections: ${validationAsset.package.manifest.sectionCount}`, `package bytes: ${validationAsset.package.manifest.totalByteLength}`, `meshlets/clusters/BVH8: ${validationEvidence.meshletCount}/${validationEvidence.clusterCount}/${validationEvidence.bvh8NodeCount}`, `frame: ${frame}`].join("\n");
}

function identity(): Float32Array { const matrix = new Float32Array(16); matrix[0] = 1; matrix[5] = 1; matrix[10] = 1; matrix[15] = 1; return matrix; }
function resize(activeRenderer: Renderer, activeCamera: PerspectiveCamera): void { activeRenderer.resize(Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight)); activeCamera.aspect = activeRenderer.aspect_ratio; activeCamera.update(); }
function startFrameLoop(): void { let previous = performance.now(); const tick = (now: number): void => { if (disposed || renderer === null || scene === null || camera === null) return; const delta = Math.min(0.1, Math.max(0, now - previous) / 1000); previous = now; controls?.update(delta); camera.aspect = renderer.aspect_ratio; camera.update(); if (!renderer.render(camera, scene, delta)) { fixtureStatus = "device-lost"; status.dataset.fixtureStatus = fixtureStatus; status.textContent = "WebGPU device lost"; releaseRuntime(); return; } frame += 1; updateMetrics(); frameRequest = requestAnimationFrame(tick); }; frameRequest = requestAnimationFrame(tick); }
function resetCamera(): void { if (camera === null) return; camera.transform.position.set(13, 10, 15); camera.transform.lookAt({ x: 0, y: 0, z: 0 }); camera.update(); controls?.from_transform(camera.transform); }
function getSnapshot(): Snapshot { return { schemaVersion: 1, caseId: "geometry-package-validation", status: fixtureStatus, build: { commit: __BUILD_COMMIT__, dirty: __BUILD_DIRTY__, contentHash: __BUILD_CONTENT_HASH__ }, environment: { width: canvas.width, height: canvas.height, dpr: 1 }, lifecycle: { frame, elapsedMs: Math.round(performance.now() - startedAt), initialized }, metrics: { packageValid: packageReport?.valid ?? false, geometryValid: geometryReport?.valid ?? false, packageIssueCount: packageReport?.issues.length ?? 0, geometryIssueCount: geometryReport?.issues.length ?? 0, sectionCount: validationAsset?.package.manifest.sectionCount ?? 0, packageBytes: validationAsset?.package.manifest.totalByteLength ?? 0, meshletCount: validationEvidence?.meshletCount ?? 0, clusterCount: validationEvidence?.clusterCount ?? 0, bvh8NodeCount: validationEvidence?.bvh8NodeCount ?? 0, dpr: 1, shadows: false, temporalAntiAliasing: false, inspector: false }, ...(packageReport === null || geometryReport === null ? {} : { reports: { package: packageReport, geometry: geometryReport } }), ...(fixtureError === undefined ? {} : { error: fixtureError }) }; }
function downloadJson(): void { downloadBlob(new Blob([JSON.stringify(getSnapshot(), null, 2)], { type: "application/json" }), "package-validation.result.json"); }
async function captureScreenshot(): Promise<void> { const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png")); if (blob !== null) downloadBlob(blob, "package-validation.png"); }
function downloadBlob(blob: Blob, filename: string): void { const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url); }
function releaseRuntime(destroyRenderer = true): void { cancelAnimationFrame(frameRequest); frameRequest = 0; resizeObserver?.disconnect(); resizeObserver = null; controls?.pointer.stop(); controls?.keyboard.stop(); controls = null; if (destroyRenderer && rendererInitialized) renderer?.destroy(); rendererInitialized = false; renderer = null; scene = null; camera = null; }
function dispose(): void { if (disposed) return; disposed = true; releaseRuntime(false); delete window.__OENGINE_GEOMETRY_PACKAGE_VALIDATION_FIXTURE__; }
window.addEventListener("pagehide", dispose, { once: true });
function required<T extends Element>(id: string): T { const element = document.getElementById(id); if (element === null) throw new Error(`Missing element #${id}`); return element as T; }

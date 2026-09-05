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
type ClusterRecord = GeometryAssetPackage["clusters"][number];
type Snapshot = { readonly schemaVersion: 1; readonly caseId: "geometry-cluster-hierarchy"; readonly status: Status; readonly build: { readonly commit: string; readonly dirty: boolean; readonly contentHash: string }; readonly environment: { readonly width: number; readonly height: number; readonly dpr: number }; readonly lifecycle: { readonly frame: number; readonly elapsedMs: number; readonly initialized: boolean }; readonly metrics: Record<string, number | string | boolean | null>; readonly error?: { readonly name: string; readonly message: string } };

declare global { interface Window { __OENGINE_GEOMETRY_CLUSTER_HIERARCHY_FIXTURE__?: { getSnapshot: () => Snapshot; downloadJson: () => void; captureScreenshot: () => Promise<void> } } }

const canvas = required<HTMLCanvasElement>("gpu-canvas");
const status = required<HTMLElement>("scene-status");
const metrics = required<HTMLElement>("scene-metrics");
const clusterList = required<HTMLElement>("cluster-list");
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
let hierarchyAsset: GeometryAssetPackage | null = null;
let hierarchyEvidence: GeometryCookEvidence | null = null;
let hierarchyValidation = false;

required<HTMLButtonElement>("download-json").addEventListener("click", downloadJson);
required<HTMLButtonElement>("capture-png").addEventListener("click", () => void captureScreenshot());
required<HTMLButtonElement>("reset-camera").addEventListener("click", resetCamera);
window.__OENGINE_GEOMETRY_CLUSTER_HIERARCHY_FIXTURE__ = { getSnapshot, downloadJson, captureScreenshot };

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
  hierarchyAsset = cooked.asset;
  hierarchyEvidence = cooked.evidence;
  hierarchyValidation = hierarchyAsset.validate().valid && validateHierarchy(hierarchyAsset);
  await activeRenderer.uploadPackedScene(activeScene, await createHierarchyPreviewScene(sourceGeometry, hierarchyAsset));

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
  status.textContent = "运行中 · Cluster Hierarchy";
  renderClusterCards();
  updateMetrics();
  startFrameLoop();
}

async function createHierarchyPreviewScene(source: SourceGeometry, asset: GeometryAssetPackage): Promise<PackedSceneSource> {
  const surface = (await cookGeometryAssetPackage(source, createGeometryCookRecipe())).asset;
  const geometries: GeometryAssetPackage[] = [surface];
  const materials: StandardShadeMaterial[] = [createMaterial([0.28, 0.36, 0.5], false)];
  const edgeCount = asset.clusterChildren.length;
  const count = asset.clusters.length + edgeCount + 1;
  const transforms = new Float32Array(count * 16);
  const boundsSpheres = new Float32Array(count * 4);
  const boundsMin = new Float32Array(count * 3);
  const boundsMax = new Float32Array(count * 3);
  const geometryIndices = new Uint32Array(count);
  const materialIndices = new Uint32Array(count);
  const flags = new Uint32Array(count);
  const debugIds = new Uint32Array(count);
  setIdentity(transforms, 0);
  boundsSpheres.set(source.bounds.sphere, 0);
  boundsMin.set(source.bounds.box.subarray(0, 3), 0);
  boundsMax.set(source.bounds.box.subarray(3, 6), 0);
  debugIds[0] = 1;
  for (let index = 0; index < asset.clusters.length; index++) {
    const cluster = asset.clusters[index]!;
    const instance = index + 1;
    geometries.push((await cookGeometryAssetPackage(createAabbWireSource(cluster.boundsBox, index), createGeometryCookRecipe())).asset);
    materials.push(createMaterial(depthColor(cluster.depth), true));
    setIdentity(transforms, instance * 16);
    boundsSpheres.set([cluster.bounds.centerX, cluster.bounds.centerY, cluster.bounds.centerZ, cluster.bounds.radius], instance * 4);
    boundsMin.set(cluster.boundsBox.subarray(0, 3), instance * 3);
    boundsMax.set(cluster.boundsBox.subarray(3, 6), instance * 3);
    geometryIndices[instance] = instance;
    materialIndices[instance] = instance;
    debugIds[instance] = index + 2;
  }
  let edgeIndex = 0;
  for (let parent = 0; parent < asset.clusters.length; parent++) {
    const cluster = asset.clusters[parent]!;
    for (let childOffset = 0; childOffset < cluster.childCount; childOffset++) {
      const child = asset.clusterChildren[cluster.childBegin + childOffset]!;
      const edge = asset.clusters[child]!;
      const instance = asset.clusters.length + edgeIndex + 1;
      geometries.push((await cookGeometryAssetPackage(createSegmentWireSource(cluster, edge, edgeIndex), createGeometryCookRecipe())).asset);
      materials.push(createMaterial([1, 0.7, 0.18], true));
      setIdentity(transforms, instance * 16);
      const center = midpoint(cluster, edge);
      const radius = Math.max(0.08, distance(cluster, edge) * 0.5);
      boundsSpheres.set([center[0], center[1], center[2], radius], instance * 4);
      boundsMin.set([Math.min(cluster.bounds.centerX, edge.bounds.centerX), Math.min(cluster.bounds.centerY, edge.bounds.centerY), Math.min(cluster.bounds.centerZ, edge.bounds.centerZ)], instance * 3);
      boundsMax.set([Math.max(cluster.bounds.centerX, edge.bounds.centerX), Math.max(cluster.bounds.centerY, edge.bounds.centerY), Math.max(cluster.bounds.centerZ, edge.bounds.centerZ)], instance * 3);
      geometryIndices[instance] = instance;
      materialIndices[instance] = instance;
      debugIds[instance] = asset.clusters.length + edgeIndex + 2;
      edgeIndex++;
    }
  }
  return { geometries, materials, count, geometryIndices, materialIndices, currentTransforms: transforms, previousTransforms: transforms.slice(), boundsSpheres, boundsMin, boundsMax, flags, debugIds };
}

function createMaterial(rgb: [number, number, number], unlit: boolean): StandardShadeMaterial { const material = new StandardShadeMaterial(); material.diffuse_color.set(rgb[0], rgb[1], rgb[2], 1); material.roughness_factor = 0.7; material.is_unlit = unlit; return material; }
function depthColor(depth: number): [number, number, number] { return hslToRgb((depth * 0.17) % 1, 0.78, 0.58); }
function midpoint(a: ClusterRecord, b: ClusterRecord): [number, number, number] { return [(a.bounds.centerX + b.bounds.centerX) * 0.5, (a.bounds.centerY + b.bounds.centerY) * 0.5, (a.bounds.centerZ + b.bounds.centerZ) * 0.5]; }
function distance(a: ClusterRecord, b: ClusterRecord): number { return Math.hypot(a.bounds.centerX - b.bounds.centerX, a.bounds.centerY - b.bounds.centerY, a.bounds.centerZ - b.bounds.centerZ); }

function createAabbWireSource(bounds: Float32Array, index: number): SourceGeometry {
  const minX = bounds[0]!, minY = bounds[1]!, minZ = bounds[2]!, maxX = bounds[3]!, maxY = bounds[4]!, maxZ = bounds[5]!;
  const thickness = Math.max(0.025, Math.min(maxX - minX, maxY - minY, maxZ - minZ) * 0.035), half = thickness * 0.5;
  const positions: number[] = [], indices: number[] = [];
  const addBox = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void => { const offset = positions.length / 3; positions.push(x0, y0, z0, x1, y0, z0, x0, y1, z0, x1, y1, z0, x0, y0, z1, x1, y0, z1, x0, y1, z1, x1, y1, z1); indices.push(offset, offset + 1, offset + 2, offset + 2, offset + 1, offset + 3, offset + 4, offset + 6, offset + 5, offset + 6, offset + 7, offset + 5, offset, offset + 4, offset + 1, offset + 1, offset + 4, offset + 5, offset + 2, offset + 3, offset + 6, offset + 6, offset + 3, offset + 7, offset, offset + 2, offset + 4, offset + 4, offset + 2, offset + 6, offset + 1, offset + 5, offset + 3, offset + 3, offset + 5, offset + 7); };
  for (const y of [minY, maxY]) for (const z of [minZ, maxZ]) addBox(minX, y - half, z - half, maxX, y + half, z + half);
  for (const x of [minX, maxX]) for (const z of [minZ, maxZ]) addBox(x - half, minY, z - half, x + half, maxY, z + half);
  for (const x of [minX, maxX]) for (const y of [minY, maxY]) addBox(x - half, y - half, minZ, x + half, y + half, maxZ);
  return createSourceGeometry({ sourceId: `hierarchy-bounds:${index}`, indices, attributes: [{ semantic: "position", componentCount: 3, data: new Float32Array(positions) }] });
}

function createSegmentWireSource(a: ClusterRecord, b: ClusterRecord, index: number): SourceGeometry {
  const ax = a.bounds.centerX, ay = a.bounds.centerY, az = a.bounds.centerZ, bx = b.bounds.centerX, by = b.bounds.centerY, bz = b.bounds.centerZ;
  const half = 0.045;
  const direction: [number, number, number] = [bx - ax, by - ay, bz - az];
  const directionLength = Math.hypot(direction[0], direction[1], direction[2]);
  const axis: [number, number, number] = directionLength > 1e-8 ? [direction[0] / directionLength, direction[1] / directionLength, direction[2] / directionLength] : [0, 1, 0];
  const reference: [number, number, number] = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const side = normalize(cross(axis, reference));
  const up = normalize(cross(axis, side));
  const endpoints: Array<[number, number, number]> = [[ax, ay, az], [bx, by, bz]];
  const positions: number[] = [];
  for (const endpoint of endpoints) {
    for (const sideSign of [-1, 1]) for (const upSign of [-1, 1]) {
      positions.push(endpoint[0] + (side[0] * sideSign + up[0] * upSign) * half, endpoint[1] + (side[1] * sideSign + up[1] * upSign) * half, endpoint[2] + (side[2] * sideSign + up[2] * upSign) * half);
    }
  }
  const indices = [0, 1, 2, 2, 1, 3, 4, 6, 5, 6, 7, 5, 0, 4, 1, 1, 4, 5, 2, 3, 6, 6, 3, 7, 0, 2, 4, 4, 2, 6, 1, 5, 3, 3, 5, 7];
  return createSourceGeometry({ sourceId: `hierarchy-edge:${index}`, indices, attributes: [{ semantic: "position", componentCount: 3, data: new Float32Array(positions) }] });
}

function normalize(vector: [number, number, number]): [number, number, number] { const length = Math.hypot(vector[0], vector[1], vector[2]); return length > 1e-8 ? [vector[0] / length, vector[1] / length, vector[2] / length] : [1, 0, 0]; }
function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }

function validateHierarchy(asset: GeometryAssetPackage): boolean {
  if (asset.clusterCount === 0 || asset.clusterRoot !== 0 || asset.clusterChildren.length === 0) return false;
  if (asset.clusters[0]!.parent !== 0xffffffff) return false;
  for (let index = 0; index < asset.clusters.length; index++) {
    const cluster = asset.clusters[index]!;
    if (cluster.childBegin + cluster.childCount > asset.clusterChildren.length) return false;
    for (const child of asset.clusterChildren.subarray(cluster.childBegin, cluster.childBegin + cluster.childCount)) {
      if (asset.clusters[child]?.parent !== index) return false;
    }
  }
  return true;
}

function renderClusterCards(): void { if (hierarchyAsset === null) return; clusterList.replaceChildren(...hierarchyAsset.clusters.map((cluster, index) => { const card = document.createElement("div"); card.className = "cluster-card"; const swatch = document.createElement("span"); swatch.className = "cluster-swatch"; const color = depthColor(cluster.depth); swatch.style.background = `rgb(${Math.round(color[0] * 255)} ${Math.round(color[1] * 255)} ${Math.round(color[2] * 255)})`; const text = document.createElement("span"); const children = Array.from(hierarchyAsset!.clusterChildren.subarray(cluster.childBegin, cluster.childBegin + cluster.childCount)).join(","); text.textContent = `C${index} · depth ${cluster.depth} · parent ${cluster.parent} · children [${children || "leaf"}] · meshlets ${cluster.meshletBegin}+${cluster.meshletCount}`; card.append(swatch, text); return card; })); }
function updateMetrics(): void { if (sourceGeometry === null || hierarchyEvidence === null || hierarchyAsset === null) return; const levels = new Set(hierarchyAsset.clusters.map((cluster) => cluster.depth)).size; const maxDepth = hierarchyAsset.clusters.reduce((max, cluster) => Math.max(max, cluster.depth), 0); metrics.textContent = [`source triangles: ${sourceGeometry.triangleCount}`, `meshlets: ${hierarchyEvidence.meshletCount}`, `clusters: ${hierarchyAsset.clusters.length}`, `child links: ${hierarchyAsset.clusterChildren.length}`, `levels: ${levels}`, `max depth: ${maxDepth}`, `root: ${hierarchyAsset.clusterRoot}`, `validation: ${hierarchyValidation ? "valid" : "invalid"}`, `recipe: renderable · fanout 4`, `frame: ${frame}`].join("\n"); }
function setIdentity(target: Float32Array, offset: number): void { target[offset] = 1; target[offset + 5] = 1; target[offset + 10] = 1; target[offset + 15] = 1; }
function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] { const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation, sector = hue * 6, x = chroma * (1 - Math.abs((sector % 2) - 1)), match = lightness - chroma / 2; const rgb = sector < 1 ? [chroma, x, 0] : sector < 2 ? [x, chroma, 0] : sector < 3 ? [0, chroma, x] : sector < 4 ? [0, x, chroma] : sector < 5 ? [x, 0, chroma] : [chroma, 0, x]; return [rgb[0] + match, rgb[1] + match, rgb[2] + match]; }
function resize(activeRenderer: Renderer, activeCamera: PerspectiveCamera): void { activeRenderer.resize(Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight)); activeCamera.aspect = activeRenderer.aspect_ratio; activeCamera.update(); }
function startFrameLoop(): void { let previous = performance.now(); const tick = (now: number): void => { if (disposed || renderer === null || scene === null || camera === null) return; const delta = Math.min(0.1, Math.max(0, now - previous) / 1000); previous = now; controls?.update(delta); camera.aspect = renderer.aspect_ratio; camera.update(); if (!renderer.render(camera, scene, delta)) { fixtureStatus = "device-lost"; status.dataset.fixtureStatus = fixtureStatus; status.textContent = "WebGPU device lost"; releaseRuntime(); return; } frame += 1; updateMetrics(); frameRequest = requestAnimationFrame(tick); }; frameRequest = requestAnimationFrame(tick); }
function resetCamera(): void { if (camera === null) return; camera.transform.position.set(13, 10, 15); camera.transform.lookAt({ x: 0, y: 0, z: 0 }); camera.update(); controls?.from_transform(camera.transform); }
function getSnapshot(): Snapshot { return { schemaVersion: 1, caseId: "geometry-cluster-hierarchy", status: fixtureStatus, build: { commit: __BUILD_COMMIT__, dirty: __BUILD_DIRTY__, contentHash: __BUILD_CONTENT_HASH__ }, environment: { width: canvas.width, height: canvas.height, dpr: 1 }, lifecycle: { frame, elapsedMs: Math.round(performance.now() - startedAt), initialized }, metrics: { sourceTriangleCount: hierarchyEvidence?.sourceTriangleCount ?? 0, meshletCount: hierarchyEvidence?.meshletCount ?? 0, clusterCount: hierarchyAsset?.clusters.length ?? 0, childLinkCount: hierarchyAsset?.clusterChildren.length ?? 0, maxDepth: hierarchyAsset?.clusters.reduce((max, cluster) => Math.max(max, cluster.depth), 0) ?? 0, root: hierarchyAsset?.clusterRoot ?? null, hierarchyValidation, hierarchyMode: "renderable", hierarchyTargetFanout: 4, dpr: 1, shadows: false, temporalAntiAliasing: false, inspector: false }, ...(fixtureError === undefined ? {} : { error: fixtureError }) }; }
function downloadJson(): void { downloadBlob(new Blob([JSON.stringify(getSnapshot(), null, 2)], { type: "application/json" }), "cluster-hierarchy.result.json"); }
async function captureScreenshot(): Promise<void> { const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png")); if (blob !== null) downloadBlob(blob, "cluster-hierarchy.png"); }
function downloadBlob(blob: Blob, filename: string): void { const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url); }
function releaseRuntime(destroyRenderer = true): void { cancelAnimationFrame(frameRequest); frameRequest = 0; resizeObserver?.disconnect(); resizeObserver = null; controls?.pointer.stop(); controls?.keyboard.stop(); controls = null; if (destroyRenderer && rendererInitialized) renderer?.destroy(); rendererInitialized = false; renderer = null; scene = null; camera = null; canvas.getContext("webgpu")?.unconfigure(); }
function dispose(): void { if (disposed) return; disposed = true; releaseRuntime(false); delete window.__OENGINE_GEOMETRY_CLUSTER_HIERARCHY_FIXTURE__; }
window.addEventListener("pagehide", dispose, { once: true });
function required<T extends Element>(id: string): T { const element = document.getElementById(id); if (element === null) throw new Error(`Missing element #${id}`); return element as T; }

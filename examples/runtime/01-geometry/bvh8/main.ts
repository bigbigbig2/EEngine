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
type Snapshot = { readonly schemaVersion: 1; readonly caseId: "geometry-bvh8"; readonly status: Status; readonly build: { readonly commit: string; readonly dirty: boolean; readonly contentHash: string }; readonly environment: { readonly width: number; readonly height: number; readonly dpr: number }; readonly lifecycle: { readonly frame: number; readonly elapsedMs: number; readonly initialized: boolean }; readonly metrics: Record<string, number | string | boolean | null>; readonly error?: { readonly name: string; readonly message: string } };

declare global { interface Window { __OENGINE_GEOMETRY_BVH8_FIXTURE__?: { getSnapshot: () => Snapshot; downloadJson: () => void; captureScreenshot: () => Promise<void> } } }

const canvas = required<HTMLCanvasElement>("gpu-canvas");
const status = required<HTMLElement>("scene-status");
const metrics = required<HTMLElement>("scene-metrics");
const nodeList = required<HTMLElement>("node-list");
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
let bvhAsset: GeometryAssetPackage | null = null;
let bvhEvidence: GeometryCookEvidence | null = null;
let bvhValidation = false;

required<HTMLButtonElement>("download-json").addEventListener("click", downloadJson);
required<HTMLButtonElement>("capture-png").addEventListener("click", () => void captureScreenshot());
required<HTMLButtonElement>("reset-camera").addEventListener("click", resetCamera);
window.__OENGINE_GEOMETRY_BVH8_FIXTURE__ = { getSnapshot, downloadJson, captureScreenshot };

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
  bvhAsset = cooked.asset;
  bvhEvidence = cooked.evidence;
  bvhValidation = bvhAsset.validate().valid && validateBvh(bvhAsset);
  await activeRenderer.uploadPackedScene(activeScene, await createBvhPreviewScene(sourceGeometry, bvhAsset));

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
  status.textContent = "运行中 · BVH8";
  renderNodeCards();
  updateMetrics();
  startFrameLoop();
}

async function createBvhPreviewScene(source: SourceGeometry, asset: GeometryAssetPackage): Promise<PackedSceneSource> {
  const surface = (await cookGeometryAssetPackage(source, createGeometryCookRecipe())).asset;
  const geometries: GeometryAssetPackage[] = [surface];
  const materials: StandardShadeMaterial[] = [createMaterial([0.28, 0.36, 0.5], false)];
  const childSlots = asset.bvh8Nodes.reduce((total, node) => total + node.childCount, 0);
  const count = childSlots + 1;
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
  let instance = 1;
  for (const [nodeIndex, node] of asset.bvh8Nodes.entries()) {
    for (let slot = 0; slot < node.childCount; slot++) {
      const bounds = node.childBoundsBox[slot]!;
      geometries.push((await cookGeometryAssetPackage(createAabbWireSource(bounds, nodeIndex * 8 + slot), createGeometryCookRecipe())).asset);
      const leaf = (node.leafMask & (1 << slot)) !== 0;
      materials.push(createMaterial(leaf ? [0.25, 0.82, 0.48] : [1, 0.56, 0.18], true));
      setIdentity(transforms, instance * 16);
      const center = [(bounds[0]! + bounds[3]!) * 0.5, (bounds[1]! + bounds[4]!) * 0.5, (bounds[2]! + bounds[5]!) * 0.5];
      boundsSpheres.set([center[0], center[1], center[2], Math.hypot(bounds[3]! - bounds[0]!, bounds[4]! - bounds[1]!, bounds[5]! - bounds[2]!) * 0.5], instance * 4);
      boundsMin.set(bounds.subarray(0, 3), instance * 3);
      boundsMax.set(bounds.subarray(3, 6), instance * 3);
      geometryIndices[instance] = instance;
      materialIndices[instance] = instance;
      debugIds[instance] = nodeIndex * 8 + slot + 2;
      instance++;
    }
  }
  return { geometries, materials, count, geometryIndices, materialIndices, currentTransforms: transforms, previousTransforms: transforms.slice(), boundsSpheres, boundsMin, boundsMax, flags, debugIds };
}

function createMaterial(rgb: [number, number, number], unlit: boolean): StandardShadeMaterial { const material = new StandardShadeMaterial(); material.diffuse_color.set(rgb[0], rgb[1], rgb[2], 1); material.roughness_factor = 0.7; material.is_unlit = unlit; return material; }
function createAabbWireSource(bounds: Float32Array, index: number): SourceGeometry { const minX = bounds[0]!, minY = bounds[1]!, minZ = bounds[2]!, maxX = bounds[3]!, maxY = bounds[4]!, maxZ = bounds[5]!; const thickness = Math.max(0.025, Math.min(maxX - minX, maxY - minY, maxZ - minZ) * 0.035), half = thickness * 0.5; const positions: number[] = [], indices: number[] = []; const addBox = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void => { const offset = positions.length / 3; positions.push(x0, y0, z0, x1, y0, z0, x0, y1, z0, x1, y1, z0, x0, y0, z1, x1, y0, z1, x0, y1, z1, x1, y1, z1); indices.push(offset, offset + 1, offset + 2, offset + 2, offset + 1, offset + 3, offset + 4, offset + 6, offset + 5, offset + 6, offset + 7, offset + 5, offset, offset + 4, offset + 1, offset + 1, offset + 4, offset + 5, offset + 2, offset + 3, offset + 6, offset + 6, offset + 3, offset + 7, offset, offset + 2, offset + 4, offset + 4, offset + 2, offset + 6, offset + 1, offset + 5, offset + 3, offset + 3, offset + 5, offset + 7); }; for (const y of [minY, maxY]) for (const z of [minZ, maxZ]) addBox(minX, y - half, z - half, maxX, y + half, z + half); for (const x of [minX, maxX]) for (const z of [minZ, maxZ]) addBox(x - half, minY, z - half, x + half, maxY, z + half); for (const x of [minX, maxX]) for (const y of [minY, maxY]) addBox(x - half, y - half, minZ, x + half, y + half, maxZ); return createSourceGeometry({ sourceId: `bvh8-child:${index}`, indices, attributes: [{ semantic: "position", componentCount: 3, data: new Float32Array(positions) }] }); }

function validateBvh(asset: GeometryAssetPackage): boolean { if (asset.bvh8Nodes.length === 0 || asset.directory.bvhRoot !== 0 || asset.directory.bvhCount !== asset.bvh8Nodes.length) return false; return asset.bvh8Nodes.every((node, index) => node.parent === (index === 0 ? 0xffffffff : node.parent) && node.childCount >= 1 && node.childCount <= 8 && (node.validMask & ~((1 << node.childCount) - 1)) === 0); }
function renderNodeCards(): void { if (bvhAsset === null) return; nodeList.replaceChildren(...bvhAsset.bvh8Nodes.map((node, index) => { const card = document.createElement("div"); card.className = "node-card"; const swatch = document.createElement("span"); swatch.className = "node-swatch"; swatch.style.background = `hsl(${Math.round(node.depth * 55 + 200)} 75% 58%)`; const refs = Array.from(node.childRefs.subarray(0, node.childCount)).map((ref, slot) => `${slot}:${(node.leafMask & (1 << slot)) !== 0 ? "C" : "N"}${ref}`).join(" "); const text = document.createElement("span"); text.textContent = `N${index} · d${node.depth} · parent ${node.parent} · children ${node.childCount} · ${refs}`; card.append(swatch, text); return card; })); }
function updateMetrics(): void { if (bvhAsset === null || bvhEvidence === null || sourceGeometry === null) return; const maxDepth = bvhAsset.bvh8Nodes.reduce((max, node) => Math.max(max, node.depth), 0); const leafSlots = bvhAsset.bvh8Nodes.reduce((sum, node) => sum + popcount(node.leafMask & node.validMask), 0); const childSlots = bvhAsset.bvh8Nodes.reduce((sum, node) => sum + node.childCount, 0); metrics.textContent = [`source triangles: ${sourceGeometry.triangleCount}`, `clusters: ${bvhEvidence.clusterCount}`, `BVH8 nodes: ${bvhAsset.bvh8Nodes.length}`, `child slots: ${childSlots}`, `leaf/internal slots: ${leafSlots}/${childSlots - leafSlots}`, `max depth: ${maxDepth}`, `root: ${bvhAsset.directory.bvhRoot}`, `validation: ${bvhValidation ? "valid" : "invalid"}`, `branching: 8`, `frame: ${frame}`].join("\n"); }
function popcount(value: number): number { let count = 0; for (let bit = value >>> 0; bit !== 0; bit &= bit - 1) count++; return count; }
function setIdentity(target: Float32Array, offset: number): void { target[offset] = 1; target[offset + 5] = 1; target[offset + 10] = 1; target[offset + 15] = 1; }
function resize(activeRenderer: Renderer, activeCamera: PerspectiveCamera): void { activeRenderer.resize(Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight)); activeCamera.aspect = activeRenderer.aspect_ratio; activeCamera.update(); }
function startFrameLoop(): void { let previous = performance.now(); const tick = (now: number): void => { if (disposed || renderer === null || scene === null || camera === null) return; const delta = Math.min(0.1, Math.max(0, now - previous) / 1000); previous = now; controls?.update(delta); camera.aspect = renderer.aspect_ratio; camera.update(); if (!renderer.render(camera, scene, delta)) { fixtureStatus = "device-lost"; status.dataset.fixtureStatus = fixtureStatus; status.textContent = "WebGPU device lost"; releaseRuntime(); return; } frame += 1; updateMetrics(); frameRequest = requestAnimationFrame(tick); }; frameRequest = requestAnimationFrame(tick); }
function resetCamera(): void { if (camera === null) return; camera.transform.position.set(13, 10, 15); camera.transform.lookAt({ x: 0, y: 0, z: 0 }); camera.update(); controls?.from_transform(camera.transform); }
function getSnapshot(): Snapshot { return { schemaVersion: 1, caseId: "geometry-bvh8", status: fixtureStatus, build: { commit: __BUILD_COMMIT__, dirty: __BUILD_DIRTY__, contentHash: __BUILD_CONTENT_HASH__ }, environment: { width: canvas.width, height: canvas.height, dpr: 1 }, lifecycle: { frame, elapsedMs: Math.round(performance.now() - startedAt), initialized }, metrics: { sourceTriangleCount: bvhEvidence?.sourceTriangleCount ?? 0, clusterCount: bvhEvidence?.clusterCount ?? 0, bvhNodeCount: bvhAsset?.bvh8Nodes.length ?? 0, bvhChildSlotCount: bvhAsset?.bvh8Nodes.reduce((sum, node) => sum + node.childCount, 0) ?? 0, maxDepth: bvhAsset?.bvh8Nodes.reduce((max, node) => Math.max(max, node.depth), 0) ?? 0, bvhValidation, branchingFactor: 8, dpr: 1, shadows: false, temporalAntiAliasing: false, inspector: false }, ...(fixtureError === undefined ? {} : { error: fixtureError }) }; }
function downloadJson(): void { downloadBlob(new Blob([JSON.stringify(getSnapshot(), null, 2)], { type: "application/json" }), "bvh8.result.json"); }
async function captureScreenshot(): Promise<void> { const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png")); if (blob !== null) downloadBlob(blob, "bvh8.png"); }
function downloadBlob(blob: Blob, filename: string): void { const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url); }
function releaseRuntime(destroyRenderer = true): void { cancelAnimationFrame(frameRequest); frameRequest = 0; resizeObserver?.disconnect(); resizeObserver = null; controls?.pointer.stop(); controls?.keyboard.stop(); controls = null; if (destroyRenderer && rendererInitialized) renderer?.destroy(); rendererInitialized = false; renderer = null; scene = null; camera = null; }
function dispose(): void { if (disposed) return; disposed = true; releaseRuntime(false); delete window.__OENGINE_GEOMETRY_BVH8_FIXTURE__; }
window.addEventListener("pagehide", dispose, { once: true });
function required<T extends Element>(id: string): T { const element = document.getElementById(id); if (element === null) throw new Error(`Missing element #${id}`); return element as T; }

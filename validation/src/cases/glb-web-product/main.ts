import {
  DirectionalLight,
  GeometryPageStreamingRuntimeV1,
  GeometryProductAdmissionController,
  OrbitControls,
  PerspectiveCamera,
  Renderer,
  Scene,
  ShadeDrawSide,
  ShadeTransparencyMode,
  StandardShadeMaterial,
  createDefaultWebCookWorker,
  load_gltf_web_product,
  type WebCookRuntimeAsset,
  type VirtualGeometrySceneSource
} from "../../../../OEngine/src/index.ts";
import type { WebCookSceneCatalogSnapshot } from "../../../../OEngine/src/assets/web-cook/WebCookClient.ts";

const canvas = document.querySelector<HTMLCanvasElement>("#output")!;
const urlInput = document.querySelector<HTMLInputElement>("#url")!;
const fileInput = document.querySelector<HTMLInputElement>("#file")!;
const statusElement = document.querySelector<HTMLElement>("#status")!;
const metricsElement = document.querySelector<HTMLElement>("#metrics")!;
const loadButton = document.querySelector<HTMLButtonElement>("#load")!;
const cancelButton = document.querySelector<HTMLButtonElement>("#cancel")!;
const reloadButton = document.querySelector<HTMLButtonElement>("#reload")!;

let renderer: Renderer | undefined;
let scene: Scene | undefined;
let camera: PerspectiveCamera | undefined;
let controls: OrbitControls | undefined;
let asset: WebCookRuntimeAsset | undefined;
let admission: GeometryProductAdmissionController | undefined;
let streaming: GeometryPageStreamingRuntimeV1 | undefined;
let loadAbort: AbortController | undefined;
let localUrl: string | undefined;
let operation = 0;

function setStatus(value: string): void { statusElement.textContent = value; }
function number(value: number | undefined): string { return value === undefined ? "-" : value.toLocaleString(); }
function updateMetrics(): void {
  const cook = asset?.evidence();
  const product = admission?.active;
  const residency = product?.state === "active" ? product.residency.evidence() : undefined;
  const stream = streaming?.evidence();
  const rows: [string, string][] = [
    ["source", asset?.catalog?.sourceTransferMode ?? "-"],
    ["worker", cook?.state ?? "-"],
    ["catalog primitives", number(asset?.catalog?.primitiveCount)],
    ["Product revision", product ? `${number(product.generation)} / ${number(product.descriptor.revision)}` : "-"],
    ["bootstrap resident", number(residency?.pinnedPages)],
    ["resident pages", number(residency?.residentPages)],
    ["uploaded bytes", number(residency?.uploadedBytes)],
    ["demand readbacks", number(stream?.lastPoll?.consumedReadbacks)],
    ["demand overflow", number(stream?.readback.overflow)],
    ["scheduler retries", number(stream?.scheduler.retries)],
    ["GPU errors", "see browser console"]
  ];
  metricsElement.innerHTML = rows.map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`).join("");
}

async function ensureRenderer(): Promise<void> {
  if (renderer) return;
  if (!globalThis.isSecureContext || !navigator.gpu) throw new Error("WebGPU requires a secure context and navigator.gpu");
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("WebGPU canvas context is unavailable");
  renderer = new Renderer({
    debug: false,
    requiredLimits: { maxStorageBuffersPerShaderStage: 14 },
    renderSettings: { features: { shadows: false, screenSpaceDiffuseMode: "off", screenSpaceReflections: false, temporalAntiAliasing: false, bloom: false, automaticExposure: false, motionBlur: false, sharpening: false } }
  });
  await renderer.initialize({ context, pixelRatio: Math.min(window.devicePixelRatio || 1, 2) });
  resize();
  renderer.device.lost.then(info => setStatus(`device lost: ${info.reason} ${info.message}`)).catch(() => undefined);
}

function resize(): void {
  if (!renderer || !camera) return;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width * Math.min(window.devicePixelRatio || 1, 2)));
  const height = Math.max(1, Math.floor(rect.height * Math.min(window.devicePixelRatio || 1, 2)));
  canvas.width = width; canvas.height = height;
  renderer.resize(width, height);
  camera.aspect = width / height;
  camera.update();
}

async function loadModel(): Promise<void> {
  const ticket = ++operation;
  loadAbort?.abort(new Error("superseded by a new load"));
  loadAbort = new AbortController();
  await releaseModel();
  setStatus("initializing WebGPU and Worker/WASM...");
  try {
    await ensureRenderer();
    const file = fileInput.files?.[0];
    if (localUrl) URL.revokeObjectURL(localUrl);
    localUrl = file ? URL.createObjectURL(file) : undefined;
    const sourceUrl = localUrl ?? urlInput.value.trim();
    if (!sourceUrl) throw new Error("GLB URL is empty");
    const worker = createDefaultWebCookWorker({ maxCanonicalInputBytes: 64 * 1024 * 1024, maxDecodedProductBytes: 256 * 1024 * 1024 });
    asset = load_gltf_web_product(sourceUrl, {
      worker,
      sessionId: `glb-ui-${crypto.randomUUID()}`,
      sessionGeneration: ticket,
      budgets: { maxConcurrentWorkers: 1, maxSourceBytes: 512 * 1024 * 1024, maxWasmBytes: 64 * 1024 * 1024, maxOutputBytes: 128 * 1024 * 1024, maxQueuedEvents: 512 },
      initialOutputPageCredits: 32,
      maxBufferedPages: 32,
      maxBufferedBytes: 32 * 262144
    });
    admission = new GeometryProductAdmissionController(renderer!.device);
    setStatus("reading GLB JSON and cooking Nyx Product...");
    const consume = admission.consume(asset, loadAbort.signal);
    await consume;
    if (ticket !== operation || loadAbort.signal.aborted) return;
    const catalog = asset.catalog;
    const transaction = admission.active;
    if (!catalog || !transaction || transaction.state !== "active") throw new Error(admission.evidence().lastRejection ?? "No active Web Product revision was admitted");
    scene = new Scene();
    const product = transaction.residency;
    const sceneSource = buildSceneSource(catalog, product.descriptor);
    streaming = new GeometryPageStreamingRuntimeV1(renderer!.device, product);
    await renderer!.uploadVirtualGeometryScene(scene, sceneSource, product, streaming);
    camera = new PerspectiveCamera();
    camera.near = 0.01;
    camera.transform.position.set(0, 0, 3);
    camera.transform.lookAt({ x: 0, y: 0, z: 0 });
    camera.update();
    controls = new OrbitControls(camera, canvas);
    controls.distanceLimits.set(0.01, 100000);
    controls.pointer.start(); controls.keyboard.start();
    const light = new DirectionalLight(); light.intensity = 3; scene.add(light);
    frameScene(sceneSource);
    resize();
    setStatus("ready: drag to orbit, wheel to zoom, arrow keys to pan");
  } catch (error) {
    if (ticket === operation) setStatus(`error: ${error instanceof Error ? error.message : String(error)}`);
    await releaseModel();
  }
}

async function releaseModel(): Promise<void> {
  controls?.pointer.stop(); controls?.keyboard.stop(); controls = undefined;
  if (renderer && scene) await renderer.releaseVirtualGeometryScene(scene).catch(() => undefined);
  scene = undefined; camera = undefined;
  streaming?.destroy(); streaming = undefined;
  if (admission?.active) { admission.retireActive(); admission.retireReplaced(); }
  admission = undefined;
  asset?.dispose(); asset = undefined;
  updateMetrics();
}

function frameScene(source: VirtualGeometrySceneSource): void {
  if (!camera) return;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let index = 0; index < source.count; index++) {
    const x = source.boundsSpheres[index * 4]!, y = source.boundsSpheres[index * 4 + 1]!, z = source.boundsSpheres[index * 4 + 2]!, radius = source.boundsSpheres[index * 4 + 3]!;
    minX = Math.min(minX, x - radius); minY = Math.min(minY, y - radius); minZ = Math.min(minZ, z - radius);
    maxX = Math.max(maxX, x + radius); maxY = Math.max(maxY, y + radius); maxZ = Math.max(maxZ, z + radius);
  }
  const center = { x: (minX + maxX) * 0.5, y: (minY + maxY) * 0.5, z: (minZ + maxZ) * 0.5 };
  const radius = Math.max(0.01, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 0.5);
  controls?.target.set(center.x, center.y, center.z);
  camera.transform.position.set(center.x, center.y, center.z + radius * 2.5);
  camera.transform.lookAt(center); camera.update(); controls?.update();
}

function buildSceneSource(catalog: WebCookSceneCatalogSnapshot, descriptor: Readonly<{ assetRecords: Uint8Array }>): VirtualGeometrySceneSource {
  const assetCount = descriptor.assetRecords.byteLength / 128;
  if (assetCount !== 1 || catalog.primitives.length === 0) throw new Error("The browser Product profile currently publishes one admitted mesh asset");
  const instances = catalog.instances.map(item => ({ ...item, worldMatrix: Float32Array.from(item.worldMatrix) }));
  const instanceByNode = new Map(instances.map(item => [item.nodeIndex, item]));
  const materials: StandardShadeMaterial[] = [];
  const materialForIndex = new Map<number, StandardShadeMaterial>();
  const materialFor = (index: number, value: Readonly<Record<string, unknown>>): number => {
    const key = index === 0xffffffff ? 0 : index;
    if (!materialForIndex.has(key)) {
      const material = new StandardShadeMaterial();
      const base = tuple(value.baseColorFactor, 4, [1, 1, 1, 1]);
      material.diffuse_color.set(base[0]!, base[1]!, base[2]!, base[3]!);
      material.metallic_factor = scalar(value.metallicFactor, 0); material.roughness_factor = scalar(value.roughnessFactor, 1);
      const emissive = tuple(value.emissiveFactor, 3, [0, 0, 0]); material.emissive_factor.set(emissive[0]!, emissive[1]!, emissive[2]!);
      material.alpha_cutoff = scalar(value.alphaCutoff, 0.5); material.is_unlit = value.unlit === true;
      material.draw_side = value.doubleSided === true ? ShadeDrawSide.Double : ShadeDrawSide.Front;
      material.transparency_mode = value.alphaMode === "MASK" ? ShadeTransparencyMode.AlphaTested : value.alphaMode === "BLEND" ? ShadeTransparencyMode.Transparent : ShadeTransparencyMode.Opaque;
      materialForIndex.set(key, material); materials[key] = material;
    }
    return key;
  };
  const profileFlags = { hasAuthoredVertexColor: false, hasUv0: false, hasUv1: false, hasUv2: false, hasNormal: true, hasTangent: false };
  const transforms: number[] = [], geometryIndices: number[] = [], materialIndices: number[] = [], bounds: number[] = [];
  const assetView = new DataView(descriptor.assetRecords.buffer, descriptor.assetRecords.byteOffset, descriptor.assetRecords.byteLength);
  const materialIndex = materialFor(catalog.primitives[0]!.materialIndex, catalog.primitives[0]!.material);
  for (const primitive of catalog.primitives) {
    profileFlags.hasAuthoredVertexColor ||= primitive.attributeSemantics.includes("COLOR_0");
    profileFlags.hasUv0 ||= primitive.attributeSemantics.includes("TEXCOORD_0");
    profileFlags.hasUv1 ||= primitive.attributeSemantics.includes("TEXCOORD_1");
    profileFlags.hasTangent ||= primitive.attributeSemantics.includes("TANGENT");
  }
  const center = [assetView.getFloat32(32, true), assetView.getFloat32(36, true), assetView.getFloat32(40, true)];
  const localRadius = assetView.getFloat32(44, true);
  const nodeIndices = [...new Set(catalog.primitives.flatMap(primitive => primitive.instanceNodeIndices))].sort((a, b) => a - b);
  for (const nodeIndex of nodeIndices) {
    const instance = instanceByNode.get(nodeIndex); if (!instance) throw new Error(`Product instance node ${nodeIndex} is missing from GLB catalog`);
    transforms.push(...instance.worldMatrix); geometryIndices.push(0); materialIndices.push(materialIndex);
    const m = instance.worldMatrix; const worldCenter = [m[0]! * center[0]! + m[4]! * center[1]! + m[8]! * center[2]! + m[12]!, m[1]! * center[0]! + m[5]! * center[1]! + m[9]! * center[2]! + m[13]!, m[2]! * center[0]! + m[6]! * center[1]! + m[10]! * center[2]! + m[14]!];
    const scale = Math.max(Math.hypot(m[0]!, m[1]!, m[2]!), Math.hypot(m[4]!, m[5]!, m[6]!), Math.hypot(m[8]!, m[9]!, m[10]!));
    bounds.push(worldCenter[0]!, worldCenter[1]!, worldCenter[2]!, localRadius * scale);
  }
  for (let index = 0; index < materials.length; index++) {
    if (materials[index]) continue;
    materials[index] = new StandardShadeMaterial();
  }
  return { materials, geometryProfiles: [profileFlags], assetCount, hierarchyMaxDepth: 64, hierarchyTraversalCapacity: Math.max(64, descriptor.assetRecords.byteLength / 128 * 64), hierarchyVisibleClusterCapacity: Math.max(64, descriptor.assetRecords.byteLength / 128 * 256), hierarchyRasterWorkCapacity: Math.max(64, descriptor.assetRecords.byteLength / 128 * 256), count: geometryIndices.length, geometryIndices: Uint32Array.from(geometryIndices), materialIndices: Uint32Array.from(materialIndices), currentTransforms: Float32Array.from(transforms), boundsSpheres: Float32Array.from(bounds) };
}

function tuple(value: unknown, length: number, fallback: readonly number[]): readonly number[] { return Array.isArray(value) && value.length === length && value.every(item => typeof item === "number" && Number.isFinite(item)) ? value : fallback; }
function scalar(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }

function animate(): void {
  controls?.update(1 / 60);
  if (renderer && scene && camera) renderer.render(camera, scene, 1 / 60);
  updateMetrics(); requestAnimationFrame(animate);
}

loadButton.addEventListener("click", () => { void loadModel(); });
reloadButton.addEventListener("click", () => { void loadModel(); });
cancelButton.addEventListener("click", () => { loadAbort?.abort(new Error("cancelled by user")); asset?.cancel("user-cancelled"); setStatus("cancelled"); });
window.addEventListener("resize", resize);
void animate();

import {
  DirectionalLight,
  GeometryPageStreamingRuntimeV1,
  GeometryProductAdmissionController,
  OrbitControls,
  PerspectiveCamera,
  Renderer,
  Scene,
  createDefaultWebCookWorker,
  createWebCookSceneSource,
  load_gltf_web_product,
  type WebCookRuntimeAsset,
  type VirtualGeometrySceneSource
} from "../../../../OEngine/src/index.ts";
import dungeonSourceUrl from "../../../../examples/assets/three/rendering-lab/dungeon_warkarma.glb?url";
import { createValidationController } from "../../host/protocol.ts";
import { attachGpuErrorCollection } from "../../host/webgpu.ts";

const FIXTURE_SOURCE_URL = "/assets/oengine/glb-web-product-v1.glb";
const DUNGEON_SOURCE_URL = dungeonSourceUrl;

/** `?source=fixture|dungeon|<url>`; the runner uses the multi-material dungeon by default. */
function resolveValidationSource(): string {
  const requested = new URLSearchParams(window.location.search).get("source");
  if (requested === "fixture") return FIXTURE_SOURCE_URL;
  if (requested === "dungeon" || requested === null) return DUNGEON_SOURCE_URL;
  return requested;
}

const canvas = document.querySelector<HTMLCanvasElement>("#output")!;
const urlInput = document.querySelector<HTMLInputElement>("#url")!;
const fileInput = document.querySelector<HTMLInputElement>("#file")!;
const statusElement = document.querySelector<HTMLElement>("#status")!;
const metricsElement = document.querySelector<HTMLElement>("#metrics")!;
const loadButton = document.querySelector<HTMLButtonElement>("#load")!;
const cancelButton = document.querySelector<HTMLButtonElement>("#cancel")!;
const reloadButton = document.querySelector<HTMLButtonElement>("#reload")!;
// Manual use defaults to the multi-material Dungeon; the runner overrides this
// from ?source=fixture|dungeon|<url> when it selects the case.
urlInput.value = resolveValidationSource();

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
let errorCollection: ReturnType<typeof attachGpuErrorCollection> | undefined;
let intentionalDeviceTeardown = false;
let disposed = false;
const runnerMode = new URLSearchParams(window.location.search).has("runId");
const controller = runnerMode
  ? createValidationController({ caseId: "glb-web-product", workloadId: "glb-web-product-bootstrap-v1" }, disposeCase)
  : undefined;
const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

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
  // The validation case reads the shaded result back, which needs COPY_SRC.
  const configure = context.configure.bind(context);
  Object.defineProperty(context, "configure", { configurable: true, value: (config: GPUCanvasConfiguration) => configure({ ...config, usage: (config.usage ?? GPUTextureUsage.RENDER_ATTACHMENT) | GPUTextureUsage.COPY_SRC }) });
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
    const runtimeProfile = new URLSearchParams(window.location.search).get("profile") === "isolated-pthreads" ? "isolated-pthreads" : "portable-single";
    const worker = createDefaultWebCookWorker({ maxCanonicalInputBytes: 64 * 1024 * 1024, maxDecodedProductBytes: 256 * 1024 * 1024, runtimeProfile });
    asset = load_gltf_web_product(sourceUrl, {
      worker,
      runtimeProfile,
      sessionId: `glb-ui-${crypto.randomUUID()}`,
      sessionGeneration: ticket,
      budgets: { maxConcurrentWorkers: 1, maxSourceBytes: 512 * 1024 * 1024, maxWasmBytes: 64 * 1024 * 1024, maxOutputBytes: 128 * 1024 * 1024, maxQueuedEvents: 512 },
      initialOutputPageCredits: 32,
      maxBufferedPages: 32,
      maxBufferedBytes: 32 * 262144
    });
    admission = new GeometryProductAdmissionController(renderer!.device);
    setStatus("reading GLB JSON and cooking Nyx Product...");
    // The live CookSession stays open for refinement, so admission streams
    // revisions instead of resolving once. React to the first active revision
    // instead of awaiting the whole session.
    const admitted = admission.consume(asset, loadAbort.signal);
    admitted.catch(() => undefined);
    await waitForActiveRevision(admission, loadAbort.signal);
    if (ticket !== operation || loadAbort.signal.aborted) return;
    const catalog = asset.catalog;
    const transaction = admission.active;
    if (!catalog || !transaction || transaction.state !== "active") throw new Error(admission.evidence().lastRejection ?? "No active Web Product revision was admitted");
    scene = new Scene();
    const product = transaction.residency;
    const sceneSource = createWebCookSceneSource(catalog, product.descriptor).source;
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
    if (runnerMode) throw error;
  }
}

async function waitForActiveRevision(controller: GeometryProductAdmissionController, signal: AbortSignal): Promise<void> {
  while (true) {
    if (signal.aborted) throw signal.reason ?? new Error("Web GLB Product load was aborted");
    const active = controller.active;
    if (active?.state === "active") return;
    const evidence = controller.evidence();
    if (evidence.state === "failed" || evidence.state === "cancelled") throw new Error(evidence.failure ?? "Web GLB Product admission did not activate");
    await new Promise((resolve) => setTimeout(resolve, 16));
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

/** Runner-driven validation host; manual use keeps the buttons and orbit controls. */
async function runValidation(): Promise<void> {
  if (controller === undefined) return;
  try {
    controller.transition("negotiating");
    urlInput.value = resolveValidationSource();
    await loadModel();
    if (!renderer || !scene || !camera) throw new Error(statusElement.textContent ?? "Web GLB Product did not load");
    renderer.profiler.configure({ enabled: true, warmupFrames: 0, gpuSampleInterval: 1, gpuCounterSampleInterval: 1, historyCapacity: 16 });
    renderer.profiler.setMode("deep-capture");
    errorCollection = attachGpuErrorCollection(renderer.device, controller, () => intentionalDeviceTeardown);
    controller.addEvidence("catalog", asset?.catalog ?? null);
    controller.addEvidence("admission", admission?.evidence() ?? null);
    const active = admission?.active;
    controller.addEvidence("residency", active?.state === "active" ? active.residency.evidence() : null);
    controller.transition("ready");
    controller.transition("warming");
    let rendered = false;
    for (let attempt = 0; attempt < 240 && !rendered; attempt++) { rendered = renderer.render(camera, scene, 1 / 60); if (!rendered) await nextFrame(); }
    if (!rendered) throw new Error("Web GLB Product did not produce a renderable frame");
    controller.transition("sampling");
    let latest: unknown;
    let sampled: Record<string, number> | undefined;
    for (let frame = 0; frame < 120; frame++) {
      renderer.render(camera, scene, 1 / 60);
      await nextFrame();
      latest = renderer.profiler.latest;
      const gpuCounters = (latest as { gpuCounters?: { sampled?: boolean; values?: Record<string, number> } } | null)?.gpuCounters;
      if (gpuCounters?.sampled && gpuCounters.values) { sampled = gpuCounters.values; break; }
    }
    const frameCounters = (latest as { counters?: Record<string, number> } | null)?.counters ?? {};
    controller.addEvidence("frame", latest ?? null);
    controller.addEvidence("streaming", streaming?.evidence() ?? null);
    if (!active || active.state !== "active" || active.residency.evidence().residentPages < 1) throw new Error("Web GLB Product activation cut is not resident");
    // Real pixel evidence. Counters alone pass on a black frame, which is how a
    // lost page bank went unnoticed before.
    const region = Math.max(8, Math.min(256, canvas.width, canvas.height));
    const capture = renderer.requestLinearHdrCapture({
      x: Math.max(0, Math.floor((canvas.width - region) / 2)),
      y: Math.max(0, Math.floor((canvas.height - region) / 2)),
      width: region,
      height: region,
      stage: "lighting"
    });
    for (let frame = 0; frame < 4; frame++) { renderer.render(camera, scene, 1 / 60); await nextFrame(); }
    const readback = await capture;
    let litPixels = 0;
    for (let index = 0; index + 3 < readback.rgba.length; index += 4) {
      const luminance = readback.rgba[index]! * 0.2126 + readback.rgba[index + 1]! * 0.7152 + readback.rgba[index + 2]! * 0.0722;
      if (luminance > 0.02) litPixels++;
    }
    controller.addEvidence("coverage", {
      region,
      litPixels,
      sampledPixels: region * region,
      gpuCounters: sampled ?? null,
      hzbPixels: frameCounters["hzb.outputPixels"] ?? 0,
      resolveRan: frameCounters["sparseShading.resolveRan"] ?? 0
    });
    if (litPixels < 64) throw new Error(`Web GLB Product shaded too few lit pixels (${litPixels}/${region * region})`);
    controller.transition("draining");
    await renderer.device.queue.onSubmittedWorkDone();
    controller.pass();
  } catch (error) {
    controller.fail(error instanceof Error ? error.stack ?? error.message : String(error));
  }
}

async function disposeCase(): Promise<Record<string, unknown>> {
  intentionalDeviceTeardown = true;
  disposed = true;
  await releaseModel();
  renderer?.destroy();
  renderer = undefined;
  await errorCollection?.lost.catch(() => undefined);
  errorCollection?.remove();
  errorCollection = undefined;
  return { rendererDestroyed: true, deviceIntentionallyDestroyed: intentionalDeviceTeardown };
}

function animate(): void {
  if (disposed) return;
  controls?.update(1 / 60);
  // Runner mode renders from runValidation() only, so the demand readback ring
  // is not submitted twice per display frame.
  if (!runnerMode && renderer && scene && camera) renderer.render(camera, scene, 1 / 60);
  updateMetrics(); requestAnimationFrame(animate);
}

loadButton.addEventListener("click", () => { void loadModel(); });
reloadButton.addEventListener("click", () => { void loadModel(); });
cancelButton.addEventListener("click", () => { loadAbort?.abort(new Error("cancelled by user")); asset?.cancel("user-cancelled"); setStatus("cancelled"); });
window.addEventListener("resize", resize);
void animate();
if (runnerMode) void runValidation();

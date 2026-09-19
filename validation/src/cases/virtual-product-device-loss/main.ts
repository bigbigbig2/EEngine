import {
  DirectionalLight,
  OrbitControls,
  PerspectiveCamera,
  Renderer,
  Scene,
  createDefaultWebCookWorker,
  load_gltf_web_product,
  type WebCookRuntimeAsset
} from "../../../../OEngine/src/index.ts";
import dungeonSourceUrl from "../../../../examples/assets/three/rendering-lab/dungeon_warkarma.glb?url";
import { createValidationController } from "../../host/protocol.ts";
import { attachGpuErrorCollection } from "../../host/webgpu.ts";

const FIXTURE_SOURCE_URL = "/assets/oengine/glb-web-product-v1.glb";

/** `?source=fixture|dungeon|<url>`; the runner uses the multi-material dungeon by default. */
function resolveValidationSource(): string {
  const requested = new URLSearchParams(window.location.search).get("source");
  if (requested === "fixture") return FIXTURE_SOURCE_URL;
  if (requested === "dungeon" || requested === null) return dungeonSourceUrl;
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
urlInput.value = resolveValidationSource();

let renderer: Renderer | undefined;
let scene: Scene | undefined;
let camera: PerspectiveCamera | undefined;
let controls: OrbitControls | undefined;
let asset: WebCookRuntimeAsset | undefined;
let handles: Awaited<ReturnType<Renderer["uploadWebCookedScene"]>> | undefined;
let loadAbort: AbortController | undefined;
let localUrl: string | undefined;
let operation = 0;
let intentionalLoss = false;
let disposed = false;
// Validation-owned observation hook: counts the devices the public Renderer asks
// for, so recovery can be shown to negotiate a new one.
const requestAdapter = navigator.gpu?.requestAdapter.bind(navigator.gpu);
const adaptersRequested: string[] = [];
if (navigator.gpu) Object.defineProperty(navigator.gpu, "requestAdapter", {
  configurable: true,
  value: async (options?: GPURequestAdapterOptions) => { const adapter = await requestAdapter!(options); adaptersRequested.push(adapter?.info.description ?? "null"); return adapter; }
});
const runnerMode = new URLSearchParams(window.location.search).has("runId");
const controller = runnerMode
  ? createValidationController({ caseId: "virtual-product-device-loss", workloadId: "virtual-product-device-loss-v1" }, disposeCase)
  : undefined;
const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

function setStatus(value: string): void { statusElement.textContent = value; }
function number(value: number | undefined): string { return value === undefined ? "-" : value.toLocaleString(); }
function updateMetrics(): void {
  const rows: [string, string][] = [
    ["adapters", number(adaptersRequested.length)],
    ["replacements", number(handles?.admission.evidence().replacements)],
    ["active generation", number(handles?.current().residency.productGeneration)],
    ["active revision", number(handles?.current().residency.descriptor.revision)],
    ["resident pages", number(handles?.current().residency.evidence().residentPages)],
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
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    renderSettings: { features: { shadows: false, screenSpaceDiffuseMode: "off", screenSpaceReflections: false, temporalAntiAliasing: false, bloom: false, automaticExposure: false, motionBlur: false, sharpening: false } }
  });
  await renderer.initialize({ context, pixelRatio: Math.min(window.devicePixelRatio || 1, 2) });
  renderer.profiler.configure({ enabled: true, warmupFrames: 0, gpuSampleInterval: 1, gpuCounterSampleInterval: 1, historyCapacity: 16 });
  renderer.profiler.setMode("deep-capture");
  resize();
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

function sourceBounds(source: { count: number; boundsSpheres: Float32Array }): { center: [number, number, number]; radius: number } {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let index = 0; index < source.count; index++) {
    const x = source.boundsSpheres[index * 4]!, y = source.boundsSpheres[index * 4 + 1]!, z = source.boundsSpheres[index * 4 + 2]!, radius = source.boundsSpheres[index * 4 + 3]!;
    minX = Math.min(minX, x - radius); minY = Math.min(minY, y - radius); minZ = Math.min(minZ, z - radius);
    maxX = Math.max(maxX, x + radius); maxY = Math.max(maxY, y + radius); maxZ = Math.max(maxZ, z + radius);
  }
  return { center: [(minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5], radius: Math.max(0.01, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 0.5) };
}

async function loadModel(): Promise<void> {
  const ticket = ++operation;
  loadAbort?.abort(new Error("superseded by a new load"));
  loadAbort = new AbortController();
  if (renderer && scene) await renderer.releaseVirtualGeometryScene(scene).catch(() => undefined);
  scene = undefined; camera = undefined;
  setStatus("initializing WebGPU and Worker/WASM...");
  await ensureRenderer();
  const file = fileInput.files?.[0];
  if (localUrl) URL.revokeObjectURL(localUrl);
  localUrl = file ? URL.createObjectURL(file) : undefined;
  const sourceUrl = localUrl ?? urlInput.value.trim();
  if (!sourceUrl) throw new Error("GLB URL is empty");
  const runtimeProfile = new URLSearchParams(window.location.search).get("profile") === "isolated-pthreads" ? "isolated-pthreads" : "portable-single";
  const worker = createDefaultWebCookWorker({ maxCanonicalInputBytes: 64 * 1024 * 1024, maxDecodedProductBytes: 256 * 1024 * 1024, runtimeProfile });
  asset?.dispose();
  asset = load_gltf_web_product(sourceUrl, {
    worker,
    runtimeProfile,
    sessionId: `device-loss-ui-${crypto.randomUUID()}`,
    sessionGeneration: ticket,
    budgets: { maxConcurrentWorkers: 1, maxSourceBytes: 512 * 1024 * 1024, maxWasmBytes: 64 * 1024 * 1024, maxOutputBytes: 128 * 1024 * 1024, maxQueuedEvents: 512 },
    initialOutputPageCredits: 32,
    maxBufferedPages: 32,
    maxBufferedBytes: 32 * 262144
  });
  setStatus("reading GLB JSON and cooking bootstrap Product...");
  scene = new Scene();
  handles = await renderer!.uploadWebCookedScene(scene, asset, { signal: loadAbort.signal, fitHeight: 5.4, fitBase: [0, -1, 0] });
  if (ticket !== operation || loadAbort.signal.aborted) return;
  const bounds = sourceBounds(handles.current().source);
  camera = new PerspectiveCamera();
  camera.near = 0.01;
  camera.far = Math.max(100, bounds.radius * 24);
  controls = new OrbitControls(camera, canvas);
  controls.distanceLimits.set(0.01, 100000);
  controls.pointer.start(); controls.keyboard.start();
  const light = new DirectionalLight(); light.intensity = 3; scene.add(light);
  controls.target.set(bounds.center[0], bounds.center[1], bounds.center[2]);
  camera.transform.position.set(bounds.center[0], bounds.center[1], bounds.center[2] + bounds.radius * 2.5);
  camera.transform.lookAt({ x: bounds.center[0], y: bounds.center[1], z: bounds.center[2] });
  camera.update();
  resize();
  updateMetrics();
  setStatus("ready: drag to orbit, wheel to zoom, arrow keys to pan");
}

async function disposeCase(): Promise<Record<string, unknown>> {
  if (disposed) return { rendererDestroyed: renderer === undefined, intentionalDeviceDestroy: intentionalLoss };
  disposed = true;
  intentionalLoss = true;
  controls?.pointer.stop(); controls?.keyboard.stop(); controls = undefined;
  if (renderer && scene) await renderer.releaseVirtualGeometryScene(scene).catch(() => undefined);
  handles?.current().streaming?.destroy();
  renderer?.destroy();
  asset?.dispose();
  await new Promise((resolve) => setTimeout(resolve, 50));
  setStatus("disposed");
  return { rendererDestroyed: true, intentionalDeviceDestroy: intentionalLoss };
}

async function countLitPixels(target: Renderer, targetScene: Scene, targetCamera: PerspectiveCamera, region: number): Promise<{ region: number; litPixels: number }> {
  const capture = target.requestLinearHdrCapture({
    x: Math.max(0, Math.floor((canvas.width - region) / 2)),
    y: Math.max(0, Math.floor((canvas.height - region) / 2)),
    width: region,
    height: region,
    stage: "lighting"
  });
  for (let frame = 0; frame < 8; frame++) { target.render(targetCamera, targetScene, 1 / 60); await nextFrame(); }
  const readback = await capture;
  let litPixels = 0;
  for (let index = 0; index + 3 < readback.rgba.length; index += 4) {
    const luminance = readback.rgba[index]! * 0.2126 + readback.rgba[index + 1]! * 0.7152 + readback.rgba[index + 2]! * 0.0722;
    if (luminance > 0.02) litPixels++;
  }
  return { region, litPixels };
}

/** Runner-driven S5 validation: intentional device loss and full Web Product recovery. */
async function runValidation(): Promise<void> {
  if (!controller) return;
  let collector: ReturnType<typeof attachGpuErrorCollection> | undefined;
  try {
    controller.transition("negotiating");
    await ensureRenderer();
    const old = renderer!;
    const oldDevice = old.device;
    collector = attachGpuErrorCollection(oldDevice, controller, () => intentionalLoss);
    await loadModel();
    if (!renderer || !scene || !camera || !handles) throw new Error("Web GLB Product did not load");

    controller.transition("ready");
    controller.transition("warming");
    let rendered = false;
    for (let attempt = 0; attempt < 240 && !rendered; attempt++) { rendered = old.render(camera, scene, 1 / 60); if (!rendered) await nextFrame(); }
    if (!rendered) throw new Error("bootstrap Product did not render");
    controller.transition("sampling");

    // Reach steady state: the richer CookSession revision replaced the bootstrap.
    for (let frame = 0; frame < 1800 && handles.admission.evidence().replacements < 1; frame++) { old.render(camera, scene, 1 / 60); await nextFrame(); }
    await handles.settled();
    for (let frame = 0; frame < 30; frame++) { old.render(camera, scene, 1 / 60); await nextFrame(); }
    const steady = handles.current();
    const beforeCoverage = await countLitPixels(old, scene, camera, 256);
    controller.addEvidence("beforeLoss", {
      adapters: adaptersRequested.length,
      replacements: handles.admission.evidence().replacements,
      generation: steady.residency.productGeneration,
      revision: steady.residency.descriptor.revision,
      residency: steady.residency.evidence(),
      coverage: beforeCoverage
    });
    if (beforeCoverage.litPixels < 64) throw new Error(`Product did not render before device loss (${beforeCoverage.litPixels} lit pixels)`);

    // Drain asynchronous readbacks so the intentional loss has no pending work.
    await oldDevice.queue.onSubmittedWorkDone();
    for (let attempt = 0; attempt < 120 && old.profiler.history.some((value) => value.gpu.pending || value.gpuCounters.pending); attempt++) await nextFrame();

    intentionalLoss = true;
    oldDevice.destroy();
    await collector.lost;
    const recovery = old.recoverAfterDeviceLoss();
    if (recovery !== old.recoverAfterDeviceLoss()) throw new Error("Concurrent recovery was not single-flight");
    // Bounded recovery: a stuck Product provider must fail the case instead of
    // burning the whole runner timeout.
    const refreshed = await Promise.race([
      recovery,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Device recovery did not settle within 90s")), 90000))
    ]);
    renderer = refreshed;
    refreshed.profiler.configure({ enabled: true, warmupFrames: 0, gpuSampleInterval: 1, gpuCounterSampleInterval: 1, historyCapacity: 16 });
    refreshed.profiler.setMode("deep-capture");
    intentionalLoss = false;
    if (refreshed.device === oldDevice) throw new Error("Recovery retained the lost GPUDevice");
    if (old.render(camera, scene, 1 / 60)) throw new Error("Lost Renderer submitted after recovery");
    resize();

    // The recovered pipeline rebuilds the complete CPU scene from the retained
    // Product source and closes it back into the GPU consumer.
    const afterCoverage = await countLitPixels(refreshed, scene, camera, 256);
    let recoveryCounters: Record<string, number> = {};
    let recoverySample: Record<string, number> | undefined;
    for (let frame = 0; frame < 120; frame++) {
      refreshed.render(camera, scene, 1 / 60);
      await nextFrame();
      const latest = refreshed.profiler.latest as { counters?: Record<string, number>; gpuCounters?: { sampled?: boolean; values?: Record<string, number> } } | null;
      recoveryCounters = latest?.counters ?? recoveryCounters;
      if (latest?.gpuCounters?.sampled && latest.gpuCounters.values) { recoverySample = latest.gpuCounters.values; break; }
    }
    controller.addEvidence("recoveryFrame", {
      selectedClusters: recoveryCounters["packed.visibility.selectedClusters"] ?? recoverySample?.selectedClusters ?? null,
      visibleInstances: recoverySample?.visibleInstances ?? null,
      hzbOutputPixels: recoveryCounters["hzb.outputPixels"] ?? 0,
      resolveRan: recoveryCounters["sparseShading.resolveRan"] ?? 0,
      canvas: [canvas.width, canvas.height]
    });
    if (afterCoverage.litPixels < 64) throw new Error(`recovery did not rebuild the Product (${afterCoverage.litPixels} lit pixels)`);
    controller.addEvidence("afterRecovery", {
      adapters: adaptersRequested.length,
      sameDevice: refreshed.device === oldDevice,
      coverage: afterCoverage
    });
    if (adaptersRequested.length !== 2) throw new Error(`recovery requested ${adaptersRequested.length} adapters, expected 2`);

    controller.transition("draining");
    await refreshed.device.queue.onSubmittedWorkDone();
    controller.pass();
  } catch (error) {
    controller.addEvidence("failureDiagnostics", { asset: asset?.evidence(), adapters: adaptersRequested.length });
    controller.fail(error instanceof Error ? error.stack ?? error.message : String(error));
  } finally {
    collector?.remove();
  }
}

if (runnerMode) {
  void runValidation();
} else {
  loadButton.addEventListener("click", () => { void loadModel(); });
  cancelButton.addEventListener("click", () => { loadAbort?.abort(new Error("cancelled")); });
  reloadButton.addEventListener("click", () => { void loadModel(); });
  fileInput.addEventListener("change", () => { void loadModel(); });
  void loadModel();
}

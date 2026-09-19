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

/** The public Renderer surface owns the Product handles; the pipeline type stays internal. */
type WebCookedSceneHandles = Awaited<ReturnType<Renderer["uploadWebCookedScene"]>>;

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
let handles: WebCookedSceneHandles | undefined;
let loadAbort: AbortController | undefined;
let localUrl: string | undefined;
let operation = 0;
let errorCollection: ReturnType<typeof attachGpuErrorCollection> | undefined;
let intentionalDeviceTeardown = false;
let disposed = false;
const runnerMode = new URLSearchParams(window.location.search).has("runId");
const controller = runnerMode
  ? createValidationController({ caseId: "virtual-product-replacement", workloadId: "virtual-product-replacement-v1" }, disposeCase)
  : undefined;
const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

function setStatus(value: string): void { statusElement.textContent = value; }
function number(value: number | undefined): string { return value === undefined ? "-" : value.toLocaleString(); }
function updateMetrics(): void {
  const current = handles?.current();
  const evidence = handles?.admission.evidence();
  const residency = current?.residency.evidence();
  const stream = current?.streaming?.evidence();
  const rows: [string, string][] = [
    ["worker", asset?.evidence().state ?? "-"],
    ["replacements", number(evidence?.replacements)],
    ["active generation", number(current?.residency.productGeneration)],
    ["active revision", number(current?.residency.descriptor.revision)],
    ["pinned pages", number(residency?.pinnedPages)],
    ["resident pages", number(residency?.residentPages)],
    ["evicted pages", number(residency?.evictedPages)],
    ["demand readbacks", number(stream?.lastPoll?.consumedReadbacks)],
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

/** Bounds of the active Product; drives camera framing and the demand sweep. */
function sourceBounds(source: WebCookedSceneHandles["source"]): { center: [number, number, number]; radius: number } {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let index = 0; index < source.count; index++) {
    const x = source.boundsSpheres[index * 4]!, y = source.boundsSpheres[index * 4 + 1]!, z = source.boundsSpheres[index * 4 + 2]!, radius = source.boundsSpheres[index * 4 + 3]!;
    minX = Math.min(minX, x - radius); minY = Math.min(minY, y - radius); minZ = Math.min(minZ, z - radius);
    maxX = Math.max(maxX, x + radius); maxY = Math.max(maxY, y + radius); maxZ = Math.max(maxZ, z + radius);
  }
  return { center: [(minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5], radius: Math.max(0.01, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 0.5) };
}

function frameScene(center: readonly [number, number, number], radius: number): void {
  if (!camera) return;
  controls?.target.set(center[0], center[1], center[2]);
  camera.far = Math.max(100, radius * 24);
  camera.transform.position.set(center[0], center[1], center[2] + radius * 2.5);
  camera.transform.lookAt({ x: center[0], y: center[1], z: center[2] });
  camera.update(); controls?.update();
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
      sessionId: `replacement-ui-${crypto.randomUUID()}`,
      sessionGeneration: ticket,
      budgets: { maxConcurrentWorkers: 1, maxSourceBytes: 512 * 1024 * 1024, maxWasmBytes: 64 * 1024 * 1024, maxOutputBytes: 128 * 1024 * 1024, maxQueuedEvents: 512 },
      initialOutputPageCredits: 32,
      maxBufferedPages: 32,
      maxBufferedBytes: 32 * 262144
    });
    setStatus("reading GLB JSON and cooking bootstrap Product...");
    scene = new Scene();
    // uploadWebCookedScene owns admission: the first active revision publishes,
    // every later (richer) revision is swapped in atomically.
    handles = await renderer!.uploadWebCookedScene(scene, asset, { signal: loadAbort.signal, fitHeight: 5.4, fitBase: [0, -1, 0] });
    if (ticket !== operation || loadAbort.signal.aborted) return;
    const bounds = sourceBounds(handles.current().source);
    camera = new PerspectiveCamera();
    camera.near = 0.01;
    controls = new OrbitControls(camera, canvas);
    controls.distanceLimits.set(0.01, 100000);
    controls.pointer.start(); controls.keyboard.start();
    const light = new DirectionalLight(); light.intensity = 3; scene.add(light);
    frameScene(bounds.center, bounds.radius);
    resize();
    setStatus("ready: drag to orbit, wheel to zoom, arrow keys to pan");
  } catch (error) {
    if (ticket === operation) setStatus(`error: ${error instanceof Error ? error.message : String(error)}`);
    await releaseModel();
    if (runnerMode) throw error;
  }
}

async function releaseModel(): Promise<void> {
  controls?.pointer.stop(); controls?.keyboard.stop(); controls = undefined;
  if (renderer && scene) await renderer.releaseVirtualGeometryScene(scene).catch(() => undefined);
  scene = undefined; camera = undefined;
  handles?.current().streaming?.destroy();
  if (handles?.admission.active) { handles.admission.retireActive(); handles.admission.retireReplaced(); }
  handles = undefined;
  asset?.dispose(); asset = undefined;
  updateMetrics();
}

async function disposeCase(): Promise<Record<string, unknown>> {
  if (disposed) return { rendererDestroyed: renderer === undefined, intentionalDeviceDestroy: intentionalDeviceTeardown };
  disposed = true;
  intentionalDeviceTeardown = true;
  await releaseModel();
  renderer?.destroy();
  await errorCollection?.lost.catch(() => undefined);
  errorCollection?.remove();
  await new Promise((resolve) => setTimeout(resolve, 50));
  setStatus("disposed");
  return { rendererDestroyed: true, intentionalDeviceDestroy: intentionalDeviceTeardown };
}

async function countLitPixels(target: Renderer, targetScene: Scene, targetCamera: PerspectiveCamera, region: number): Promise<{ region: number; litPixels: number }> {
  const capture = target.requestLinearHdrCapture({
    x: Math.max(0, Math.floor((canvas.width - region) / 2)),
    y: Math.max(0, Math.floor((canvas.height - region) / 2)),
    width: region,
    height: region,
    stage: "lighting"
  });
  for (let frame = 0; frame < 4; frame++) { target.render(targetCamera, targetScene, 1 / 60); await nextFrame(); }
  const readback = await capture;
  let litPixels = 0;
  for (let index = 0; index + 3 < readback.rgba.length; index += 4) {
    const luminance = readback.rgba[index]! * 0.2126 + readback.rgba[index + 1]! * 0.7152 + readback.rgba[index + 2]! * 0.0722;
    if (luminance > 0.02) litPixels++;
  }
  return { region, litPixels };
}
setInterval(updateMetrics, 500);

async function verifyFailedReplacement(
  target: Renderer,
  targetCamera: PerspectiveCamera,
  baseline: WebCookedSceneHandles["current"] extends () => infer T ? T : never,
  failure: "mapping" | "staging"
): Promise<Record<string, unknown>> {
  setStatus(`injecting failed ${failure} replacement: create`);
  const testScene = new Scene();
  const light = new DirectionalLight(); light.intensity = 3; testScene.add(light);
  const retained = baseline.residency.sourceForStreaming();
  const firstDescriptor = { ...retained.descriptor, replaces: undefined };
  const first = { descriptor: firstDescriptor, readPage: (pageId: number, signal?: AbortSignal) => retained.readPage(pageId, signal), release: () => undefined };
  const nextDescriptor = {
    ...retained.descriptor,
    revision: retained.descriptor.revision + 1,
    replaces: { productId: retained.descriptor.productId.slice(), revision: retained.descriptor.revision }
  };
  let candidateReleases = 0;
  const candidate = {
    descriptor: nextDescriptor,
    async readPage(pageId: number, signal?: AbortSignal) {
      const page = await retained.readPage(pageId, signal);
      return { ...page, revision: nextDescriptor.revision };
    },
    release() { candidateReleases++; }
  };
  async function* revisions() { yield first; yield candidate; }
  const uploaded = await target.uploadProductScene(testScene, { revisions }, ({ descriptor }) => {
    if (descriptor.revision === nextDescriptor.revision) {
      if (failure === "mapping") throw new Error("injected Product mapping failure");
      return { source: { ...baseline.source, geometryProfiles: [] }, materials: baseline.materials };
    }
    return { source: baseline.source, materials: baseline.materials };
  }, { stream: false });
  setStatus(`injecting failed ${failure} replacement: published bootstrap`);
  try {
    const before = await countLitPixels(target, testScene, targetCamera, 256);
    let failureMessage = "";
    try { await uploaded.settled(); }
    catch (error) { failureMessage = error instanceof Error ? error.message : String(error); }
    setStatus(`injecting failed ${failure} replacement: settled ${failureMessage}`);
    if (!failureMessage.includes(failure === "mapping" ? "mapping failure" : "profile count")) {
      throw new Error(`${failure} failure was swallowed: ${failureMessage}`);
    }
    const after = await countLitPixels(target, testScene, targetCamera, 256);
    const active = uploaded.current();
    if (active.residency.productGeneration !== uploaded.admission.active?.generation ||
        active.residency.descriptor.revision !== retained.descriptor.revision ||
        before.litPixels < 64 || after.litPixels < 64 || candidateReleases !== 1) {
      throw new Error(`${failure} failure did not preserve the previous Product pixels/generation and release the candidate`);
    }
    return {
      failureMessage,
      before,
      after,
      activeGeneration: active.residency.productGeneration,
      activeRevision: active.residency.descriptor.revision,
      candidateReleases,
      budget: active.residency.evidence()
    };
  } finally {
    await target.releaseVirtualGeometryScene(testScene);
    uploaded.admission.retireActive(); uploaded.admission.retireReplaced();
  }
}

/** Runner-driven S5 validation: atomic richer-revision replacement, then a safe eviction. */
async function runValidation(): Promise<void> {
  if (!controller) return;
  try {
    controller.transition("negotiating");
    await ensureRenderer();
    errorCollection = attachGpuErrorCollection(renderer!.device, controller, () => intentionalDeviceTeardown);
    await loadModel();
    if (!renderer || !scene || !camera || !handles) throw new Error("Web GLB Product did not load");
    const target = renderer;

    const bootstrap = handles.current();
    if (bootstrap.residency.evidence().residentPages < 1) throw new Error("bootstrap activation cut is not resident");
    controller.addEvidence("bootstrap", {
      generation: bootstrap.residency.productGeneration,
      revision: bootstrap.residency.descriptor.revision,
      residency: bootstrap.residency.evidence()
    });

    controller.transition("ready");
    controller.transition("warming");
    let rendered = false;
    for (let attempt = 0; attempt < 240 && !rendered; attempt++) { rendered = target.render(camera, scene, 1 / 60); if (!rendered) await nextFrame(); }
    if (!rendered) throw new Error("bootstrap Product did not render");
    controller.transition("sampling");

    // Replacement: the background richer revision must swap the bootstrap out.
    // Keep rendering while the CookSession finishes the richer revision.
    for (let frame = 0; frame < 1800 && handles.admission.evidence().replacements < 1; frame++) {
      const admission = handles.admission.evidence();
      if (admission.state === "failed" || admission.state === "cancelled") {
        throw new Error(admission.failure ?? admission.lastRejection ?? "richer Product publication failed");
      }
      target.render(camera, scene, 1 / 60);
      await nextFrame();
    }
    await handles.settled();
    for (let frame = 0; frame < 60; frame++) { target.render(camera, scene, 1 / 60); await nextFrame(); }
    const replacement = handles.current();
    const admissionEvidence = handles.admission.evidence();
    const replacedCoverage = await countLitPixels(target, scene, camera, 256);
    controller.addEvidence("replacement", {
      replacements: admissionEvidence.replacements,
      bootstrapGeneration: bootstrap.residency.productGeneration,
      activeGeneration: replacement.residency.productGeneration,
      bootstrapRevision: bootstrap.residency.descriptor.revision,
      activeRevision: replacement.residency.descriptor.revision,
      activePinnedPages: replacement.residency.evidence().pinnedPages,
      coverage: replacedCoverage
    });
    if (admissionEvidence.replacements < 1) throw new Error("richer revision never replaced the bootstrap");
    if (replacement.residency.productGeneration === bootstrap.residency.productGeneration) throw new Error("replacement did not change the product generation");
    if (replacedCoverage.litPixels < 64) throw new Error(`replacement lost the scene (${replacedCoverage.litPixels} lit pixels)`);

    // Residency refinement on the active revision, then a submission-safe eviction.
    const bounds = sourceBounds(replacement.source);
    const active = replacement.residency;
    const residentBefore = active.evidence().residentPages;
    camera.transform.position.set(bounds.center[0], bounds.center[1], bounds.center[2] + bounds.radius * 0.6);
    camera.update(); controls?.update();
    let refined = false;
    for (let frame = 0; frame < 360 && !refined; frame++) {
      target.render(camera, scene, 1 / 60);
      await nextFrame();
      if (active.evidence().residentPages > residentBefore) refined = true;
    }
    const residentAfterRefine = active.evidence().residentPages;
    const candidates = replacement.streaming === null ? [] : replacement.streaming.selectEvictionCandidates(240, 262144 * 4, 0);
    if (replacement.streaming !== null && candidates.length > 0) {
      await replacement.streaming.retirePages(candidates, target.device.queue.onSubmittedWorkDone());
    }
    const residencyAfterEvict = active.evidence().residentPages;
    const evictCoverage = await countLitPixels(target, scene, camera, 256);
    controller.addEvidence("eviction", {
      residentBefore,
      residentAfterRefine,
      candidates: candidates.length,
      residentAfterEvict: residencyAfterEvict,
      evictedPages: active.evidence().evictedPages,
      coverage: evictCoverage
    });
    if (!refined) throw new Error("residency never refined on the active revision");
    if (candidates.length > 0 && residencyAfterEvict >= residentAfterRefine) throw new Error("retired pages were not released from residency");
    if (evictCoverage.litPixels < 64) throw new Error(`eviction lost the scene (${evictCoverage.litPixels} lit pixels)`);

    controller.addEvidence("failedReplacementMapping", await verifyFailedReplacement(target, camera, replacement, "mapping"));
    controller.addEvidence("failedReplacementStaging", await verifyFailedReplacement(target, camera, replacement, "staging"));

    controller.transition("draining");
    await target.device.queue.onSubmittedWorkDone();
    controller.pass();
  } catch (error) {
    controller.fail(error instanceof Error ? error.stack ?? error.message : String(error));
  }
}

if (runnerMode) {
  void runValidation();
} else {
  loadButton.addEventListener("click", () => { void loadModel(); });
  cancelButton.addEventListener("click", () => { loadAbort?.abort(new Error("cancelled")); void releaseModel(); });
  reloadButton.addEventListener("click", () => { void loadModel(); });
  fileInput.addEventListener("change", () => { void loadModel(); });
  void loadModel();
}

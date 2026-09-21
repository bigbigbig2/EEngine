import {
  DirectionalLight,
  OrbitControls,
  PerspectiveCamera,
  Renderer,
  Scene,
  createDefaultWebCookWorker,
  load_gltf_web_product,
  load_oegpack_product,
  WebCookBudgetLedger,
  parseOegPackSceneManifestV3,
  resolveOegPackScenePackUrlV3,
  resolveWebCookRuntimeProfile,
  type OegPackProductAsset,
  type ProductSceneHandles,
  type WebCookRuntimeAsset
} from "../../../../OEngine/src/index.ts";
import { createValidationController, type ValidationController } from "../../host/protocol.ts";
import { attachGpuErrorCollection, probeWebGpu2026Surface, snapshotAdapterInfo, snapshotGpuFeatures, snapshotGpuLimits } from "../../host/webgpu.ts";
import dungeonSourceUrl from "../../../../examples/assets/three/rendering-lab/dungeon_warkarma.glb?url";

const DEFAULT_WEB = dungeonSourceUrl;
const DEFAULT_OFFLINE = "/assets/oengine/offline-product-a/scene.oescene";
type SourceKind = "web" | "offline";
type SourceHandle = WebCookRuntimeAsset | OegPackProductAsset;
type ReadbackEvidence = { readonly width: number; readonly height: number; readonly litPixels: number; readonly sample: readonly number[] };

const canvas = document.querySelector<HTMLCanvasElement>("#output")!;
const sourceKind = document.querySelector<HTMLSelectElement>("#sourceKind")!;
const profile = document.querySelector<HTMLSelectElement>("#profile")!;
const sourceUrl = document.querySelector<HTMLInputElement>("#sourceUrl")!;
const sourceFile = document.querySelector<HTMLInputElement>("#sourceFile")!;
const statusElement = document.querySelector<HTMLElement>("#status")!;
const metricsElement = document.querySelector<HTMLElement>("#metrics")!;
const detailElement = document.querySelector<HTMLElement>("#detail")!;
const loadButton = document.querySelector<HTMLButtonElement>("#load")!;
const cancelButton = document.querySelector<HTMLButtonElement>("#cancel")!;
const replaceButton = document.querySelector<HTMLButtonElement>("#replace")!;
const breakButton = document.querySelector<HTMLButtonElement>("#breakSource")!;
const closeButton = document.querySelector<HTMLButtonElement>("#cameraClose")!;
const cutButton = document.querySelector<HTMLButtonElement>("#cameraCut")!;
const lossButton = document.querySelector<HTMLButtonElement>("#deviceLoss")!;
const recoverButton = document.querySelector<HTMLButtonElement>("#recover")!;

let renderer: Renderer | undefined;
let scene: Scene | undefined;
let camera: PerspectiveCamera | undefined;
let controls: OrbitControls | undefined;
let asset: SourceHandle | undefined;
let handles: ProductSceneHandles | undefined;
let abortController: AbortController | undefined;
let localUrl: string | undefined;
let operation = 0;
let intentionallyLost = false;
let disposed = false;
let gpuCollector: ReturnType<typeof attachGpuErrorCollection> | undefined;
const cookBudget = new WebCookBudgetLedger({ maxActiveSessions: 2, maxSourceBytes: 512 * 1024 * 1024, maxWasmBytes: 64 * 1024 * 1024, maxOutputBytes: 128 * 1024 * 1024 });
const query = new URLSearchParams(window.location.search);
const runnerMode = query.has("runId");
const controller: ValidationController | undefined = runnerMode
  ? createValidationController({ caseId: "virtual-product-observer", workloadId: "virtual-product-observer-v1" }, disposeCase)
  : undefined;
const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

function setStatus(value: string): void { statusElement.textContent = value; }
function number(value: number | undefined): string { return value === undefined ? "-" : value.toLocaleString(); }
function sourceEvidence(): Record<string, unknown> {
  const current = handles?.current();
  const admission = handles?.admission.evidence();
  const residency = current?.residency.evidence();
  const streaming = current?.streaming?.evidence();
  const evidence = typeof asset?.evidence === "function" ? asset.evidence() : undefined;
  return { sourceKind: sourceKind.value, asset: evidence, catalog: (asset as WebCookRuntimeAsset | undefined)?.catalog ?? null, admission, residency, streaming, materials: current?.materials.length ?? 0 };
}
function updateView(): void {
  const current = handles?.current();
  const evidence = sourceEvidence();
  const residency = current?.residency.evidence();
  const stream = current?.streaming?.evidence();
  const catalog = (asset as WebCookRuntimeAsset | undefined)?.catalog;
  const cook = (asset as WebCookRuntimeAsset | undefined)?.evidence?.();
  const budget = cook && "budget" in cook ? (cook as { budget?: unknown }).budget : undefined;
  const rows: [string, string][] = [
    ["source", sourceKind.value],
    ["catalog primitives", number(catalog?.primitiveCount)],
    ["catalog bytes", number(catalog?.sourceBytes)],
    ["Product revision / generation", current ? `${current.residency.descriptor.revision} / ${current.residency.productGeneration}` : "-"],
    ["resident / pinned / retiring", residency ? `${residency.residentPages} / ${residency.pinnedPages} / ${residency.retiringPages}` : "-"],
    ["resident / uploaded bytes", residency ? `${number(residency.residentBytes)} / ${number(residency.uploadedBytes)}` : "-"],
    ["demand / fallback / overflow", stream ? `${stream.scheduler.requested} / ${stream.scheduler.stale} / ${stream.scheduler.demandOverflow}` : "-"],
    ["materials / texture state", current ? `${current.materials.length} / published` : "-"],
    ["source/WASM/output budget", budget ? JSON.stringify(budget) : "offline or unavailable"],
    ["GPU errors", controller?.snapshot.errors.length ? `${controller.snapshot.errors.length} (see detail)` : "none observed"]
  ];
  metricsElement.innerHTML = rows.map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`).join("");
  detailElement.textContent = JSON.stringify(evidence, null, 2);
}

async function ensureRenderer(): Promise<void> {
  if (renderer) return;
  if (!globalThis.isSecureContext || !navigator.gpu) throw new Error("WebGPU requires a secure context and navigator.gpu");
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("WebGPU canvas context is unavailable");
  const configure = context.configure.bind(context);
  Object.defineProperty(context, "configure", { configurable: true, value: (config: GPUCanvasConfiguration) => configure({ ...config, usage: (config.usage ?? GPUTextureUsage.RENDER_ATTACHMENT) | GPUTextureUsage.COPY_SRC }) });
  renderer = new Renderer({ debug: false, requiredLimits: { maxStorageBuffersPerShaderStage: 16 }, renderSettings: { features: { shadows: false, screenSpaceDiffuseMode: "off", screenSpaceReflections: false, temporalAntiAliasing: false, bloom: false, automaticExposure: false, motionBlur: false, sharpening: false } } });
  await renderer.initialize({ context, pixelRatio: Math.min(window.devicePixelRatio || 1, 2) });
  renderer.profiler.configure({ enabled: true, warmupFrames: 0, gpuSampleInterval: 1, gpuCounterSampleInterval: 1, historyCapacity: 16 });
  renderer.profiler.setMode("deep-capture");
  gpuCollector?.remove();
  if (controller) gpuCollector = attachGpuErrorCollection(renderer.device, controller, () => intentionallyLost || disposed);
  if (controller) {
    const adapter = await navigator.gpu.requestAdapter({ featureLevel: "core" });
    controller.addEvidence("capability", { adapter: adapter ? { info: snapshotAdapterInfo(adapter.info), features: snapshotGpuFeatures(adapter.features), limits: snapshotGpuLimits(adapter.limits) } : null, renderer: renderer.capabilities, surface: await probeWebGpu2026Surface(navigator.gpu, renderer.device) });
  }
  resize();
}
function resize(): void {
  if (!renderer || !camera) return;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width * Math.min(window.devicePixelRatio || 1, 2)));
  const height = Math.max(1, Math.floor(rect.height * Math.min(window.devicePixelRatio || 1, 2)));
  canvas.width = width; canvas.height = height; renderer.resize(width, height); camera.aspect = width / height; camera.update();
}
function bounds(source: { readonly count: number; readonly boundsSpheres: Float32Array }): { center: [number, number, number]; radius: number } {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < source.count; i++) { const x = source.boundsSpheres[i * 4]!, y = source.boundsSpheres[i * 4 + 1]!, z = source.boundsSpheres[i * 4 + 2]!, r = source.boundsSpheres[i * 4 + 3]!; minX = Math.min(minX, x - r); minY = Math.min(minY, y - r); minZ = Math.min(minZ, z - r); maxX = Math.max(maxX, x + r); maxY = Math.max(maxY, y + r); maxZ = Math.max(maxZ, z + r); }
  return { center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2], radius: Math.max(0.01, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2) };
}
async function openOffline(url: string, signal: AbortSignal): Promise<OegPackProductAsset> {
  const response = await fetch(url, { signal, headers: { "Accept-Encoding": "identity" } });
  if (!response.ok) throw new Error(`scene manifest request failed (${response.status})`);
  const manifest = parseOegPackSceneManifestV3(await response.text());
  const manifestUrl = new URL(url, window.location.href).href;
  const packUrl = resolveOegPackScenePackUrlV3(manifestUrl, manifest.packs[0]!);
  if (sourceFile.files?.length) throw new Error("Offline File/Blob 需要显式 scene.oescene manifest URL，不能猜测 pack identity");
  if (query.get("offlineSource") === "memory") {
    const bytes = await (await fetch(packUrl, { signal, headers: { "Accept-Encoding": "identity" } })).arrayBuffer();
    return load_oegpack_product({ kind: "memory", bytes, manifest: await (await fetch(manifestUrl, { signal })).text() }, { signal });
  }
  return load_oegpack_product({ kind: "http-range", url: packUrl, manifestUrl }, { signal });
}
async function releaseScene(): Promise<void> {
  controls?.pointer.stop(); controls?.keyboard.stop(); controls = undefined;
  if (renderer && scene) await renderer.releaseVirtualGeometryScene(scene).catch(() => undefined);
  handles?.current().streaming?.destroy(); handles?.admission.retireActive(); handles?.admission.retireReplaced(); handles = undefined; scene = undefined; camera = undefined;
  if (asset && "dispose" in asset) asset.dispose(); else if (asset && "release" in asset) asset.release();
  asset = undefined; updateView();
}
async function loadModel(): Promise<void> {
  const ticket = ++operation; abortController?.abort(new Error("superseded by a new load")); abortController = new AbortController();
  await releaseScene(); await ensureRenderer(); setStatus("opening source and publishing Product...");
  try {
    const selected = sourceKind.value as SourceKind;
    const file = sourceFile.files?.[0];
    if (selected === "offline" && file) throw new Error("Offline File/Blob 需要显式 scene.oescene manifest URL");
    if (localUrl) URL.revokeObjectURL(localUrl); localUrl = file ? URL.createObjectURL(file) : undefined;
    const selectedProfile = resolveWebCookRuntimeProfile(profile.value as "portable-single" | "portable-pool" | "isolated-pthreads");
    if (selected === "web") {
      const worker = createDefaultWebCookWorker({ maxCanonicalInputBytes: 64 * 1024 * 1024, maxDecodedProductBytes: 256 * 1024 * 1024, runtimeProfile: selectedProfile.selected });
      asset = load_gltf_web_product(file ? (localUrl ?? file) : sourceUrl.value.trim(), { worker, runtimeProfile: selectedProfile.selected, sessionId: `observer-${crypto.randomUUID()}`, sessionGeneration: ticket, budgets: { maxConcurrentWorkers: 1, maxSourceBytes: 512 * 1024 * 1024, maxWasmBytes: 64 * 1024 * 1024, maxOutputBytes: 128 * 1024 * 1024, maxQueuedEvents: 512 }, initialOutputPageCredits: 32, maxBufferedPages: 32, maxBufferedBytes: 32 * 262144, ledger: cookBudget, priority: 100 });
      controller?.addEvidence("runtimeProfile", selectedProfile);
      scene = new Scene(); handles = await renderer!.uploadWebCookedScene(scene, asset as WebCookRuntimeAsset, { signal: abortController.signal, fitHeight: 5.4, fitBase: [0, -1, 0] });
    } else {
      asset = await openOffline(sourceUrl.value.trim() || DEFAULT_OFFLINE, abortController.signal); scene = new Scene(); handles = await renderer!.uploadOegPackScene(scene, asset as OegPackProductAsset, { signal: abortController.signal, fitHeight: 5.4, fitBase: [0, -1, 0] });
    }
    if (ticket !== operation || abortController.signal.aborted || !handles) return;
    const fit = bounds(handles.current().source); camera = new PerspectiveCamera(); camera.near = 0.01; camera.far = Math.max(100, fit.radius * 24); controls = new OrbitControls(camera, canvas); controls.distanceLimits.set(0.01, 100000); controls.pointer.start(); controls.keyboard.start(); controls.target.set(...fit.center); camera.transform.position.set(fit.center[0], fit.center[1], fit.center[2] + fit.radius * 2.5); camera.transform.lookAt({ x: fit.center[0], y: fit.center[1], z: fit.center[2] }); camera.update(); const light = new DirectionalLight(); light.intensity = 3; scene.add(light); resize();
    setStatus("ready: orbit / zoom / pan; Product is active"); updateView();
  } catch (error) { if (ticket === operation) setStatus(`error: ${error instanceof Error ? error.message : String(error)}`); await releaseScene(); if (runnerMode) throw error; }
}
function moveCamera(close: boolean): void { const current = handles?.current(); if (!camera || !current) return; const fit = bounds(current.source); camera.transform.position.set(fit.center[0], fit.center[1], fit.center[2] + fit.radius * (close ? 0.6 : 2.5)); camera.transform.lookAt({ x: fit.center[0], y: fit.center[1], z: fit.center[2] }); camera.update(); controls?.update(); setStatus(close ? "camera close: demand/refinement requested" : "camera cut: deterministic reset"); }
async function captureReadback(): Promise<ReadbackEvidence> { if (!renderer || !scene || !camera) return { width: 0, height: 0, litPixels: 0, sample: [] }; const size = Math.max(8, Math.min(128, canvas.width, canvas.height)); const capture = renderer.requestLinearHdrCapture({ x: Math.max(0, Math.floor((canvas.width - size) / 2)), y: Math.max(0, Math.floor((canvas.height - size) / 2)), width: size, height: size, stage: "lighting" }); for (let i = 0; i < 6; i++) { renderer.render(camera, scene, 1 / 60); await nextFrame(); } const value = await capture; let litPixels = 0; for (let i = 0; i + 3 < value.rgba.length; i += 4) if (value.rgba[i]! * 0.2126 + value.rgba[i + 1]! * 0.7152 + value.rgba[i + 2]! * 0.0722 > 0.02) litPixels++; return { width: size, height: size, litPixels, sample: Array.from(value.rgba.slice(0, 16)).map((v) => Number(v.toFixed(4))) }; }
async function recoverDevice(): Promise<void> { if (!renderer) return; intentionallyLost = true; setStatus("destroying GPU device for explicit recovery..."); const old = renderer; old.device.destroy(); await old.device.lost; renderer = await old.recoverAfterDeviceLoss(); intentionallyLost = false; gpuCollector?.remove(); gpuCollector = controller ? attachGpuErrorCollection(renderer.device, controller, () => intentionallyLost || disposed) : undefined; renderer.profiler.configure({ enabled: true, warmupFrames: 0, gpuSampleInterval: 1, gpuCounterSampleInterval: 1, historyCapacity: 16 }); renderer.profiler.setMode("deep-capture"); resize(); setStatus("device recovered; retained Product was rebuilt"); updateView(); }
async function disposeCase(): Promise<Record<string, unknown>> { if (disposed) return { rendererDestroyed: true }; disposed = true; abortController?.abort(); await releaseScene(); gpuCollector?.remove(); renderer?.destroy(); return { rendererDestroyed: true, sourceReleased: asset === undefined }; }
async function runValidation(): Promise<void> { if (!controller) return; try { controller.transition("negotiating"); await ensureRenderer(); controller.transition("ready"); controller.transition("warming"); sourceKind.value = "web"; sourceUrl.value = DEFAULT_WEB; await loadModel(); if (!renderer || !scene || !camera || !handles) throw new Error("observer Product did not load"); let rendered = false; for (let i = 0; i < 240 && !rendered; i++) { rendered = renderer.render(camera, scene, 1 / 60); if (!rendered) await nextFrame(); } if (!rendered) throw new Error("observer did not produce a renderable bootstrap"); const bootstrap = await captureReadback(); controller.addEvidence("catalog", (asset as WebCookRuntimeAsset).catalog ?? null); controller.addEvidence("bootstrap", { revision: handles.current().residency.descriptor.revision, generation: handles.current().residency.productGeneration, evidence: sourceEvidence(), readback: bootstrap }); controller.transition("sampling"); moveCamera(true); for (let i = 0; i < 90; i++) { renderer.render(camera, scene, 1 / 60); await nextFrame(); } moveCamera(false); const frame = await captureReadback(); controller.addEvidence("cameraCut", { evidence: sourceEvidence(), readback: frame }); controller.addEvidence("readback", { bootstrap, cameraCut: frame }); if (bootstrap.litPixels < 1 || frame.litPixels < 1) throw new Error("observer readback did not contain a meaningful frame"); controller.addEvidence("firstMeaningfulFrame", { at: new Date().toISOString(), bootstrapLitPixels: bootstrap.litPixels, cameraCutLitPixels: frame.litPixels }); controller.transition("draining"); await renderer.device.queue.onSubmittedWorkDone(); controller.pass(); } catch (error) { controller.addEvidence("failureDiagnostics", sourceEvidence()); controller.fail(error instanceof Error ? error.stack ?? error.message : String(error)); } }

sourceKind.addEventListener("change", () => { sourceUrl.value = sourceKind.value === "offline" ? DEFAULT_OFFLINE : DEFAULT_WEB; sourceFile.value = ""; updateView(); });
loadButton.addEventListener("click", () => void loadModel()); replaceButton.addEventListener("click", () => void loadModel()); cancelButton.addEventListener("click", () => abortController?.abort(new DOMException("cancelled", "AbortError"))); sourceFile.addEventListener("change", () => { if (sourceKind.value === "web") void loadModel(); });
breakButton.addEventListener("click", () => { sourceUrl.value = `${sourceUrl.value}.missing`; setStatus("source broken: next Load must surface the provider failure"); }); closeButton.addEventListener("click", () => moveCamera(true)); cutButton.addEventListener("click", () => moveCamera(false)); lossButton.addEventListener("click", () => void recoverDevice()); recoverButton.addEventListener("click", () => void recoverDevice()); window.addEventListener("resize", resize);
if (runnerMode) void runValidation(); else void loadModel();

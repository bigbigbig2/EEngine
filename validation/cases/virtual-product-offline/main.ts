import {
  DirectionalLight,
  OrbitControls,
  PerspectiveCamera,
  Renderer,
  Scene,
  load_oegpack_product,
  resolveOegPackScenePackUrlV3,
  parseOegPackSceneManifestV3,
  type OegPackSceneManifestV3,
  type ProductSceneHandles
} from "../../../../OEngine/src/index.ts";
import { createValidationController } from "../../host/protocol.ts";
import { attachGpuErrorCollection } from "../../host/webgpu.ts";

/** One cooked Product per directory; the case swaps A -> B to exercise replacement. */
const PRODUCT_A_MANIFEST = "/assets/oengine/offline-product-a/scene.oescene";
const PRODUCT_B_MANIFEST = "/assets/oengine/offline-product-b/scene.oescene";

type Selection = "range" | "memory";

function resolveSelection(): Selection {
  return new URLSearchParams(window.location.search).get("source") === "memory" ? "memory" : "range";
}

const canvas = document.querySelector<HTMLCanvasElement>("#output")!;
const urlInput = document.querySelector<HTMLInputElement>("#url")!;
const statusElement = document.querySelector<HTMLElement>("#status")!;
const metricsElement = document.querySelector<HTMLElement>("#metrics")!;
const loadButton = document.querySelector<HTMLButtonElement>("#load")!;
const cancelButton = document.querySelector<HTMLButtonElement>("#cancel")!;
const reloadButton = document.querySelector<HTMLButtonElement>("#reload")!;
urlInput.value = PRODUCT_A_MANIFEST;

let renderer: Renderer | undefined;
let scene: Scene | undefined;
let camera: PerspectiveCamera | undefined;
let controls: OrbitControls | undefined;
let handles: ProductSceneHandles | undefined;
let manifest: OegPackSceneManifestV3 | undefined;
let releaseAsset: (() => void) | undefined;
let loadAbort: AbortController | undefined;
let operation = 0;
let intentionalLoss = false;
let disposed = false;
const runnerMode = new URLSearchParams(window.location.search).has("runId");
const controller = runnerMode
  ? createValidationController({ caseId: "virtual-product-offline", workloadId: "virtual-product-offline-v1" }, disposeCase)
  : undefined;
const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

function setStatus(value: string): void { statusElement.textContent = value; }
function number(value: number | undefined): string { return value === undefined ? "-" : value.toLocaleString(); }
function updateMetrics(): void {
  const current = handles?.current();
  const rows: [string, string][] = [
    ["selection", resolveSelection()],
    ["active generation", number(current?.residency.productGeneration)],
    ["resident pages", number(current?.residency.evidence().residentPages)],
    ["pinned pages", number(current?.residency.evidence().pinnedPages)],
    ["demand requests", number(current?.streaming?.evidence().scheduler.requested)],
    ["GPU errors", "see browser console"]
  ];
  metricsElement.innerHTML = rows.map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`).join("");
}

async function ensureRenderer(): Promise<void> {
  if (renderer) return;
  if (!globalThis.isSecureContext || !navigator.gpu) throw new Error("WebGPU requires a secure context and navigator.gpu");
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("WebGPU canvas context is unavailable");
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

async function fetchManifest(url: string): Promise<OegPackSceneManifestV3> {
  const response = await fetch(url, { headers: { "Accept-Encoding": "identity" } });
  if (!response.ok) throw new Error(`scene manifest request failed (${response.status})`);
  return parseOegPackSceneManifestV3(await response.text());
}

/**
 * Opens one Offline Product through the public second-route selection. `range`
 * streams the pack over HTTP byte ranges; `memory` reads the same bytes first
 * and hands them to the memory source, so the only difference is the source.
 */
async function openProduct(manifestUrl: string, selection: Selection, signal: AbortSignal): Promise<{ handles: ProductSceneHandles; manifest: OegPackSceneManifestV3 }> {
  const loaded = await fetchManifest(manifestUrl);
  const manifestUrlAbsolute = new URL(manifestUrl, window.location.href).href;
  const packUrl = resolveOegPackScenePackUrlV3(manifestUrlAbsolute, loaded.packs[0]!);
  const asset = selection === "range"
    ? await load_oegpack_product({ kind: "http-range", url: packUrl, manifestUrl: manifestUrlAbsolute }, { signal })
    : await load_oegpack_product({ kind: "memory", bytes: await (await fetch(packUrl, { headers: { "Accept-Encoding": "identity" } })).arrayBuffer(), manifest: await (await fetch(manifestUrlAbsolute)).text() }, { signal });
  releaseAsset = () => asset.release();
  const uploaded = await renderer!.uploadOegPackScene(scene!, asset, { signal, fitHeight: 5.4, fitBase: [0, -1, 0] });
  return { handles: uploaded, manifest: loaded };
}

function sourceBounds(source: { readonly count: number; readonly boundsSpheres: Float32Array }): { center: [number, number, number]; radius: number } {
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
  handles?.current().streaming?.destroy();
  handles = undefined;
  releaseAsset?.(); releaseAsset = undefined;
  scene = undefined; camera = undefined;
  setStatus("initializing WebGPU...");
  await ensureRenderer();
  scene = new Scene();
  setStatus(`opening ${resolveSelection()} OEGPACK Product...`);
  const opened = await openProduct(urlInput.value.trim(), resolveSelection(), loadAbort.signal);
  if (ticket !== operation || loadAbort.signal.aborted) return;
  handles = opened.handles;
  manifest = opened.manifest;
  const bounds = sourceBounds(handles.current().source);
  camera = new PerspectiveCamera();
  camera.near = 0.01;
  camera.far = Math.max(100, bounds.radius * 24);
  controls = new OrbitControls(camera, canvas);
  controls.distanceLimits.set(0.01, 100000);
  controls.pointer.start(); controls.keyboard.start();
  const light = new DirectionalLight(); light.intensity = 3;
  // The Offline fixture is a single-sided heightfield, so aim the key light at
  // the camera-facing side instead of relying on the default orientation.
  light.forward = [0.35, -0.6, -0.7];
  scene.add(light);
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
  handles?.admission.retireActive();
  handles?.admission.retireReplaced();
  releaseAsset?.();
  renderer?.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  setStatus("disposed");
  return { rendererDestroyed: true, intentionalDeviceDestroy: intentionalLoss };
}

async function countLitPixels(region: number): Promise<{ region: number; litPixels: number; sample: readonly number[]; peak: number }> {
  const capture = renderer!.requestLinearHdrCapture({
    x: Math.max(0, Math.floor((canvas.width - region) / 2)),
    y: Math.max(0, Math.floor((canvas.height - region) / 2)),
    width: region,
    height: region,
    stage: "lighting"
  });
  for (let frame = 0; frame < 6; frame++) { renderer!.render(camera!, scene!, 1 / 60); await nextFrame(); }
  const readback = await capture;
  let litPixels = 0, peak = 0;
  for (let index = 0; index + 3 < readback.rgba.length; index += 4) {
    const luminance = readback.rgba[index]! * 0.2126 + readback.rgba[index + 1]! * 0.7152 + readback.rgba[index + 2]! * 0.0722;
    if (luminance > 0.02) litPixels++;
    peak = Math.max(peak, luminance);
  }
  return { region, litPixels, sample: Array.from(readback.rgba.slice(0, 16)).map(value => Number(value.toFixed(4))), peak: Number(peak.toFixed(4)) };
}

/** Stable counters that describe the GPU topology the producer must not change. */
function topology(target: Renderer): Record<string, number> {
  const latest = target.profiler.latest as { counters?: Record<string, number> } | null;
  const counters = latest?.counters ?? {};
  return Object.freeze(Object.fromEntries([
    "packed.instance.recordStride",
    "packed.instance.staticRecordStride",
    "packed.instance.dynamicRecordStride",
    "packed.visibility.verticesPerTriangle",
    "packed.visibility.meshletWorkCapacity",
    "sparseShading.surfaceBytesPerPixel",
    "lighting.hdrBytesPerPixel"
  ].map(key => [key, counters[key] ?? -1])));
}

/** Runner-driven S6 validation: Offline OEGPACK parity on the shared Product path. */
async function runValidation(): Promise<void> {
  if (!controller) return;
  let collector: ReturnType<typeof attachGpuErrorCollection> | undefined;
  try {
    controller.transition("negotiating");
    await ensureRenderer();
    collector = attachGpuErrorCollection(renderer!.device, controller, () => intentionalLoss);
    controller.transition("ready");
    controller.transition("warming");

    const rangeRun: Record<string, unknown> = {};
    const memoryRun: Record<string, unknown> = {};
    for (const selection of ["range", "memory"] as const) {
      urlInput.value = PRODUCT_A_MANIFEST;
      await loadModel();
      if (!renderer || !scene || !camera || !handles) throw new Error(`Offline ${selection} Product did not load`);
      const target = renderer;
      const active = handles.current();
      const evidence = active.residency.evidence();
      let rendered = false;
      for (let attempt = 0; attempt < 240 && !rendered; attempt++) { rendered = target.render(camera, scene, 1 / 60); if (!rendered) await nextFrame(); }
      if (!rendered) throw new Error(`Offline ${selection} Product did not render`);
      if (evidence.residentPages < 1 || evidence.pinnedPages < 1) throw new Error(`Offline ${selection} activation cut is not resident`);
      let gpuSample: Record<string, number> | undefined;
      for (let frame = 0; frame < 120; frame++) {
        target.render(camera, scene, 1 / 60);
        await nextFrame();
        const latest = target.profiler.latest as { gpuCounters?: { sampled?: boolean; values?: Record<string, number> } } | null;
        if (latest?.gpuCounters?.sampled && latest.gpuCounters.values && Object.keys(latest.gpuCounters.values).length > 0) { gpuSample = latest.gpuCounters.values; break; }
      }
      const coverage = await countLitPixels(256);
      if (coverage.litPixels < 64) {
        controller.addEvidence("firstRunDiagnostics", { selection, gpuCounters: gpuSample ?? null, coverage, canvas: [canvas.width, canvas.height] });
        throw new Error(`Offline ${selection} Product shaded too few lit pixels (${coverage.litPixels}, peak ${coverage.peak})`);
      }
      const record = {
        selection,
        productId: hex(active.residency.descriptor.productId),
        revision: active.residency.descriptor.revision,
        assetCount: active.source.assetCount,
        activationPageCount: active.residency.descriptor.activationPageIds.length,
        residency: evidence,
        topology: topology(target),
        gpuCounters: gpuSample ?? null,
        coverage,
        counters: (target.profiler.latest as { counters?: Record<string, number> } | null)?.counters?.["packed.visibility.drawIndirect"] ?? 0
      };
      if (selection === "range") Object.assign(rangeRun, record); else Object.assign(memoryRun, record);
    }
    controller.transition("sampling");
    controller.addEvidence("sourceParity", { range: rangeRun, memory: memoryRun });
    // Source selection must not change the GPU topology or the Product identity.
    if (JSON.stringify(rangeRun.topology) !== JSON.stringify(memoryRun.topology)) throw new Error("Offline source selection changed the GPU topology");
    if (rangeRun.productId !== memoryRun.productId) throw new Error("Offline source selection changed the Product identity");
    if (rangeRun.activationPageCount !== memoryRun.activationPageCount) throw new Error("Offline source selection changed the activation cut");
    for (const key of Object.keys(rangeRun.topology as Record<string, number>)) {
      if ((rangeRun.topology as Record<string, number>)[key]! < 0) throw new Error(`Offline topology counter ${key} is unavailable`);
    }

    // Source failure must surface unchanged instead of silently changing quality.
    // The probe points at a served but invalid pack so the failure is a format
    // rejection, not a browser network error.
    let failure = "none";
    try {
      await load_oegpack_product({ kind: "http-range", url: "/assets/oengine/offline-product-a/scene.oescene" });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    controller.addEvidence("sourceFailure", { failure });
    if (failure === "none") throw new Error("Offline source failure was silently accepted");
    if (!/magic/iu.test(failure)) throw new Error(`Offline source failure did not report the pack format: ${failure}`);

    // Replacement: publish the second pre-cooked Product over the first one.
    urlInput.value = PRODUCT_B_MANIFEST;
    const beforeSwap = await countLitPixels(256);
    const previousProductId = hex(handles!.current().residency.descriptor.productId);
    await loadModel();
    if (!renderer || !scene || !camera || !handles) throw new Error("Offline replacement Product did not load");
    const swapped = handles.current();
    let swapRendered = false;
    for (let attempt = 0; attempt < 240 && !swapRendered; attempt++) { swapRendered = renderer.render(camera, scene, 1 / 60); if (!swapRendered) await nextFrame(); }
    const afterSwap = await countLitPixels(256);
    const activeProductId = hex(swapped.residency.descriptor.productId);
    controller.addEvidence("replacement", {
      previousProductId,
      activeProductId,
      beforeSwap,
      afterSwap,
      residency: swapped.residency.evidence()
    });
    // An OEGPACK pack is a distributed artifact, so its content hash is the
    // Product identity: a replacement is a different Product, not a new revision
    // of the same one. The scene must still switch without losing pixels.
    if (activeProductId === previousProductId) throw new Error("Offline replacement reused the previous Product identity");
    if (afterSwap.litPixels < 64) throw new Error(`Offline replacement lost the scene (${afterSwap.litPixels} lit pixels)`);

    // Demand: move the camera close so the traversal wants finer LODs.
    const bounds = sourceBounds(swapped.source);
    const residentBefore = swapped.residency.evidence().residentPages;
    camera.transform.position.set(bounds.center[0], bounds.center[1], bounds.center[2] + bounds.radius * 0.6);
    camera.update(); controls?.update();
    let demandReached = false;
    for (let frame = 0; frame < 480 && !demandReached; frame++) {
      renderer.render(camera, scene, 1 / 60);
      await nextFrame();
      const evidence = swapped.streaming?.evidence();
      if ((evidence?.scheduler.requested ?? 0) > 0 && swapped.residency.evidence().residentPages > residentBefore) demandReached = true;
    }
    const demand = swapped.streaming?.evidence();
    controller.addEvidence("demand", {
      scheduler: demand?.scheduler ?? null,
      readback: demand?.readback ?? null,
      residentBefore,
      residentAfter: swapped.residency.evidence().residentPages
    });
    if ((demand?.scheduler.requested ?? 0) < 1) throw new Error("Offline GPU page demand never reached the scheduler");
    if (swapped.residency.evidence().residentPages <= residentBefore) throw new Error("Offline GPU page demand did not refine resident pages");
    const demandCoverage = await countLitPixels(256);
    controller.addEvidence("demandCoverage", demandCoverage);
    if (demandCoverage.litPixels < 64) throw new Error(`Offline demand lost the scene (${demandCoverage.litPixels} lit pixels)`);

    controller.transition("draining");
    await renderer.device.queue.onSubmittedWorkDone();
    controller.pass();
  } catch (error) {
    const latest = renderer?.profiler.latest as { counters?: Record<string, number>; gpuCounters?: { sampled?: boolean; values?: Record<string, number> } } | null;
    controller.addEvidence("failureDiagnostics", {
      operation,
      counters: latest?.counters ?? null,
      gpuCounters: latest?.gpuCounters?.values ?? null,
      residency: handles?.current().residency.evidence() ?? null,
      sourceCount: handles?.current().source.count ?? null,
      assetCount: handles?.current().source.assetCount ?? null,
      materialCount: handles?.current().materials.length ?? null
    });
    controller.fail(error instanceof Error ? error.stack ?? error.message : String(error));
  } finally {
    collector?.remove();
  }
}

function hex(bytes: Uint8Array): string { return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(""); }

if (runnerMode) {
  void runValidation();
} else {
  loadButton.addEventListener("click", () => { void loadModel(); });
  cancelButton.addEventListener("click", () => { loadAbort?.abort(new Error("cancelled")); });
  reloadButton.addEventListener("click", () => { void loadModel(); });
  void loadModel();
}

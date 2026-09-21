import {
  DirectionalLight,
  OrbitControls,
  PerspectiveCamera,
  Renderer,
  Scene,
  createDefaultWebCookWorker,
  load_gltf_web_product,
  resolveWebCookRuntimeProfile,
  type GeometryPageStreamingRuntimeV1,
  type GeometryProductAdmissionController,
  type ProductSceneHandles,
  type VirtualGeometryResidency,
  type WebCookRuntimeAsset
} from "../../../../OEngine/src/index.ts";
import dungeonSourceUrl from "../../../../examples/assets/three/rendering-lab/dungeon_warkarma.glb?url";
import { createValidationController } from "../../host/protocol.ts";
import { attachGpuErrorCollection } from "../../host/webgpu.ts";

// ADR-0017 fourth slice. The RenderingLab dungeon is the same multi-material
// model the interactive example uses, and it is large enough that a single
// activation cut cannot cover every page. That is what makes the incremental
// path observable: some pages only ever exist because GPU demand asked for them.
const DUNGEON_SOURCE_URL: string = dungeonSourceUrl;

const canvas = document.querySelector<HTMLCanvasElement>("#output")!;
const statusElement = document.querySelector<HTMLElement>("#status")!;
const cookMetricsElement = document.querySelector<HTMLElement>("#cookMetrics")!;
const residencyMetricsElement = document.querySelector<HTMLElement>("#residencyMetrics")!;
const demandMetricsElement = document.querySelector<HTMLElement>("#demandMetrics")!;
const loadButton = document.querySelector<HTMLButtonElement>("#load")!;
const reloadButton = document.querySelector<HTMLButtonElement>("#reload")!;

let renderer: Renderer | undefined;
let scene: Scene | undefined;
let camera: PerspectiveCamera | undefined;
let controls: OrbitControls | undefined;
let asset: WebCookRuntimeAsset | undefined;
let productHandles: ProductSceneHandles | undefined;
let admission: GeometryProductAdmissionController | undefined;
let streaming: GeometryPageStreamingRuntimeV1 | undefined;
let residency: VirtualGeometryResidency | undefined;
let sceneBounds: { readonly center: readonly [number, number, number]; readonly radius: number } | undefined;
let errorCollection: ReturnType<typeof attachGpuErrorCollection> | undefined;
let intentionalDeviceTeardown = false;
let disposed = false;
let operation = 0;
const runnerMode = new URLSearchParams(window.location.search).has("runId");
const validationQuery = new URLSearchParams(window.location.search);
const controller = runnerMode
  ? createValidationController({
      caseId: validationQuery.get("case") ?? "glb-incremental-publication",
      workloadId: validationQuery.get("workload") ?? "glb-incremental-publication-v1"
    }, disposeCase)
  : undefined;
const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

function setStatus(value: string): void { statusElement.textContent = value; }
function number(value: number | undefined): string { return value === undefined ? "-" : value.toLocaleString(); }
function rows(element: HTMLElement, values: readonly (readonly [string, string])[]): void {
  element.innerHTML = values.map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`).join("");
}

function updateMetrics(): void {
  const cook = asset?.evidence();
  const active = admission?.active;
  const live = active?.state === "active" ? active.residency.evidence() : undefined;
  const stream = streaming?.evidence();
  rows(cookMetricsElement, [
    ["cook state", cook?.state ?? "-"],
    ["progress events", number(cook?.progressEvents)],
    ["recoverable failures", number(cook?.recoverableFailures)],
    ["failure codes", cook?.recoverableFailureCodes.join(", ") || "-"]
  ]);
  rows(residencyMetricsElement, [
    ["product generation", number(active?.generation)],
    ["revision", number(active?.descriptor.revision)],
    ["page count", number(active?.descriptor.pageRecords ? active.descriptor.pageRecords.byteLength / 32 : undefined)],
    ["bootstrap resident", number(live?.pinnedPages)],
    ["resident pages", number(live?.residentPages)],
    ["uploaded bytes", number(live?.uploadedBytes)]
  ]);
  rows(demandMetricsElement, [
    ["scheduler requested", number(stream?.scheduler.requested)],
    ["resident (scheduler)", number(stream?.scheduler.resident)],
    ["readbacks", number(stream?.lastPoll?.consumedReadbacks)],
    ["uploaded bytes/frame", number(stream?.lastPoll?.uploadedBytes)]
  ]);
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
  await releaseModel();
  setStatus("initializing WebGPU and Worker/WASM...");
  try {
    await ensureRenderer();
    const profileQuery = validationQuery.get("profile");
    const requestedProfile = profileQuery === "isolated-pthreads" || profileQuery === "portable-pool" ? profileQuery : "portable-single";
    const runtimeCapability = resolveWebCookRuntimeProfile(requestedProfile);
    const runtimeProfile = runtimeCapability.selected;
    const worker = createDefaultWebCookWorker({ maxCanonicalInputBytes: 64 * 1024 * 1024, maxDecodedProductBytes: 256 * 1024 * 1024, runtimeProfile });
    // The credit pool is the hard ceiling on how much of a revision can be
    // streamed without a consumer. It is deliberately generous here so the case
    // measures the incremental path, not an accidental credit stall.
    asset = load_gltf_web_product(DUNGEON_SOURCE_URL, {
      worker,
      runtimeProfile,
      sessionId: `glb-incremental-${crypto.randomUUID()}`,
      sessionGeneration: ticket,
      budgets: { maxConcurrentWorkers: 1, maxSourceBytes: 512 * 1024 * 1024, maxWasmBytes: 64 * 1024 * 1024, maxOutputBytes: 256 * 1024 * 1024, maxQueuedEvents: 1024 },
      initialOutputPageCredits: 256,
      maxBufferedPages: 256,
      maxBufferedBytes: 256 * 262144
    });
    controller?.addEvidence("runtimeProfile", runtimeCapability);
    setStatus("reading GLB JSON and cooking Nyx Product...");
    scene = new Scene();
    productHandles = await renderer!.uploadWebCookedScene(scene, asset);
    admission = productHandles.admission;
    streaming = productHandles.streaming ?? undefined;
    residency = productHandles.residency;
    const sceneSource = productHandles.source;
    if (ticket !== operation) return;
    camera = new PerspectiveCamera();
    camera.near = 0.01;
    camera.transform.position.set(0, 0, 3);
    camera.transform.lookAt({ x: 0, y: 0, z: 0 });
    camera.update();
    controls = new OrbitControls(camera, canvas);
    controls.distanceLimits.set(0.01, 100000);
    const light = new DirectionalLight(); light.intensity = 3; scene.add(light);
    sceneBounds = frameScene(sceneSource);
    resize();
    setStatus("ready");
  } catch (error) {
    if (ticket === operation) setStatus(`error: ${error instanceof Error ? error.message : String(error)}`);
    await releaseModel();
    if (runnerMode) throw error;
  }
}

async function releaseModel(): Promise<void> {
  if (renderer && scene) await renderer.releaseVirtualGeometryScene(scene).catch(() => undefined);
  scene = undefined; camera = undefined; controls = undefined;
  streaming?.destroy(); streaming = undefined; residency = undefined; sceneBounds = undefined;
  productHandles = undefined;
  if (admission?.active) { admission.retireActive(); admission.retireReplaced(); }
  admission = undefined;
  asset?.dispose(); asset = undefined;
  updateMetrics();
}

function frameScene(source: { readonly count: number; readonly boundsSpheres: Float32Array }): { readonly center: readonly [number, number, number]; readonly radius: number } | undefined {
  if (!camera) return undefined;
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
  return { center: [center.x, center.y, center.z] as const, radius };
}

/** Counts lit pixels in a centre region of the current frame. */
async function captureLitPixels(region: number): Promise<number> {
  const capture = renderer!.requestLinearHdrCapture({
    x: Math.max(0, Math.floor((canvas.width - region) / 2)),
    y: Math.max(0, Math.floor((canvas.height - region) / 2)),
    width: region,
    height: region,
    stage: "lighting"
  });
  for (let frame = 0; frame < 4; frame++) { renderer!.render(camera!, scene!, 1 / 60); await nextFrame(); }
  const readback = await capture;
  let litPixels = 0;
  for (let index = 0; index + 3 < readback.rgba.length; index += 4) {
    const luminance = readback.rgba[index]! * 0.2126 + readback.rgba[index + 1]! * 0.7152 + readback.rgba[index + 2]! * 0.0722;
    if (luminance > 0.02) litPixels++;
  }
  return litPixels;
}

async function runValidation(): Promise<void> {
  if (controller === undefined) return;
  try {
    controller.transition("negotiating");
    await loadModel();
    if (!renderer || !scene || !camera) throw new Error(statusElement.textContent ?? "incremental publication case did not load");
    renderer.profiler.configure({ enabled: true, warmupFrames: 0, gpuSampleInterval: 1, gpuCounterSampleInterval: 1, historyCapacity: 16 });
    renderer.profiler.setMode("deep-capture");
    errorCollection = attachGpuErrorCollection(renderer.device, controller, () => intentionalDeviceTeardown);
    controller.addEvidence("catalog", asset?.catalog ?? null);
    controller.transition("ready");
    controller.transition("warming");
    let rendered = false;
    for (let attempt = 0; attempt < 240 && !rendered; attempt++) { rendered = renderer.render(camera, scene, 1 / 60); if (!rendered) await nextFrame(); }
    if (!rendered) throw new Error("incremental publication case did not produce a renderable frame");
    controller.transition("sampling");

    // Claim 1: the activation cut is resident before anything else is demanded.
    // `residentPages` at this point can only come from the streamed cut.
    const activeAtStart = admission?.active;
    if (!activeAtStart || activeAtStart.state !== "active") throw new Error("incremental publication case has no active Product revision");
    const admittedPageCount = activeAtStart.descriptor.pageRecords.byteLength / 32;
    const cutPageCount = new Set(activeAtStart.descriptor.activationPageIds).size;
    const bootstrapResident = activeAtStart.residency.evidence().pinnedPages;
    if (cutPageCount < 1) throw new Error("activation cut is empty");
    if (cutPageCount >= admittedPageCount) {
      throw new Error(`the model's activation cut covers every page (${cutPageCount}/${admittedPageCount}); incremental production cannot be observed`);
    }
    if (bootstrapResident < cutPageCount) throw new Error(`activation cut is not fully resident before demand (${bootstrapResident}/${cutPageCount})`);
    controller.addEvidence("activationCut", {
      pageCount: admittedPageCount,
      cutPageCount,
      cutPages: Array.from(activeAtStart.descriptor.activationPageIds),
      pinnedPages: bootstrapResident,
      residentPages: activeAtStart.residency.evidence().residentPages
    });

    // Claim 2: the richer revision publishes its descriptor before producing all
    // payloads. The plain bootstrap revision must stay readable while the richer
    // one is still pending, and the replacement must still land.
    const refinementDeadline = performance.now() + 90000;
    while ((admission?.evidence().replacements ?? 0) < 1 && performance.now() < refinementDeadline) await nextFrame();
    const admissionEvidence = admission?.evidence() ?? null;
    controller.addEvidence("admission", admissionEvidence);
    controller.addEvidence("cook", asset?.evidence() ?? null);
    controller.addEvidence("statusText", statusElement.textContent ?? "");
    controller.addEvidence("clientState", asset?.state ?? "unknown");
    if ((admission?.evidence().replacements ?? 0) < 1) {
      throw new Error(`richer revision was never activated within the validation window (cook=${asset?.state ?? "?"}; rejection=${admissionEvidence?.lastRejection ?? "-"}; recoverable=${JSON.stringify(asset?.evidence().recoverableFailureCodes ?? [])})`);
    }

    // ProductSceneHandles exposes live getters; refresh only after the atomic
    // replacement committed so demand targets the replacing revision.
    streaming = productHandles?.streaming ?? undefined;
    residency = productHandles?.residency;
    if (streaming === undefined || residency === undefined || sceneBounds === undefined) throw new Error("incremental publication case requires a streaming runtime");

    // Claim 3: GPU demand drives payload production for pages the cut never
    // streamed. Moving the camera in makes traversal want finer LODs.
    const residentBefore = residency.evidence().residentPages;
    camera.transform.position.set(sceneBounds.center[0], sceneBounds.center[1], sceneBounds.center[2] + sceneBounds.radius * 0.6);
    camera.update(); controls?.update();
    let demandReached = false;
    for (let frame = 0; frame < 600 && !demandReached; frame++) {
      renderer.render(camera, scene, 1 / 60);
      await nextFrame();
      const evidence = streaming.evidence();
      if (evidence.scheduler.requested > 0 && residency.evidence().residentPages > residentBefore) demandReached = true;
    }
    const demandEvidence = streaming.evidence();
    const residentAfter = residency.evidence().residentPages;
    controller.addEvidence("demand", {
      scheduler: demandEvidence.scheduler,
      readback: demandEvidence.readback,
      residentBefore,
      residentAfter
    });
    if (demandEvidence.scheduler.requested < 1) throw new Error("GPU page demand never reached the delayed scheduler");
    if (residentAfter <= residentBefore) throw new Error(`GPU page demand did not refine resident pages (${residentBefore} -> ${residentAfter})`);

    // Claim 4: the scene stays drawable throughout. A lost page bank would show
    // up as a black frame even when every counter looks healthy.
    const region = Math.max(8, Math.min(256, canvas.width, canvas.height));
    const demandLitPixels = await captureLitPixels(region);
    controller.addEvidence("demandCoverage", { region, litPixels: demandLitPixels, sampledPixels: region * region });
    if (demandLitPixels < 64) throw new Error(`scene was not drawable during incremental demand (${demandLitPixels} lit pixels)`);

    controller.addEvidence("cook-final", asset?.evidence() ?? null);
    controller.addEvidence("residency-final", residency.evidence());
    // The producer never reported a payload-stage failure on the healthy path.
    // A failure here would be a real regression, not an allowed outcome.
    if ((asset?.evidence().recoverableFailures ?? 0) > 0) throw new Error(`payload stage reported a recoverable failure: ${asset?.evidence().recoverableFailureCodes.join(", ")}`);

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
  if (!runnerMode && renderer && scene && camera) renderer.render(camera, scene, 1 / 60);
  updateMetrics(); requestAnimationFrame(animate);
}

loadButton.addEventListener("click", () => { void loadModel(); });
reloadButton.addEventListener("click", () => { void loadModel(); });
window.addEventListener("resize", resize);
void animate();
if (runnerMode) void runValidation();

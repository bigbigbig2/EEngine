import {
  createDefaultWebCookWorker, load_gltf, OrbitControls, PerspectiveCamera,
  RenderDebugView, Renderer, resolveWebCookRuntimeProfile, Scene, webCookCatalogSceneFraming,
  type MultiProductSceneHandles, type WebCookRuntimeAsset, type WebCookSceneCatalogSnapshot
} from "../../../../OEngine/src/index.ts";
import { PineForestPanel } from "./panel.ts";
import { PineForestTelemetry } from "./telemetry.ts";

const MiB = 1024 * 1024;
const canvas = document.querySelector<HTMLCanvasElement>("#viewport")!;
const telemetry = new PineForestTelemetry();
const scene = new Scene();
const abort = new AbortController();
let renderer: Renderer | undefined;
let asset: WebCookRuntimeAsset | undefined;
let handles: MultiProductSceneHandles | undefined;
let loading: Promise<MultiProductSceneHandles> | undefined;
let controls: OrbitControls | undefined;
let camera: PerspectiveCamera | undefined;
let catalog: WebCookSceneCatalogSnapshot | undefined;
let catalogFraming: ReturnType<typeof webCookCatalogSceneFraming> | undefined;
let resizeObserver: ResizeObserver | undefined;
let frameId = 0;
let refreshId = 0;
let closing = false;
let settled = false;
let meshletView = true;

const panel = new PineForestPanel(telemetry, {
  center: () => placeCamera(false), overview: () => placeCamera(true),
  reload: () => location.reload(), release: () => { void release(); }
});
document.querySelector("#meshlet-view")!.addEventListener("click", () => setColorMode(true));
document.querySelector("#solid-view")!.addEventListener("click", () => setColorMode(false));
void start().catch(error => {
  if (closing) return;
  const message = error instanceof Error ? error.message : String(error);
  telemetry.error = message;
  telemetry.event("加载失败", message);
  console.error(error);
  panel.paint();
  void release(false);
});

async function start(): Promise<void> {
  if (!navigator.gpu) throw new Error("此浏览器没有可用的 WebGPU");
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("无法创建 WebGPU canvas context");
  const source = await fetch(telemetry.sourceUrl, { method: "HEAD" });
  if (!source.ok) throw new Error(`Pine Forest GLB 资源不可用：HTTP ${source.status}`);
  telemetry.event("资源可用", `${source.headers.get("content-length") ?? "未知"} bytes`);
  renderer = new Renderer({
    debug: false,
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    renderSettings: {
      resolution: { mode: "fixed", internalScale: 1 },
      features: {
        shadows: false, screenSpaceDiffuseMode: "off", screenSpaceReflections: false,
        temporalAntiAliasing: false, bloom: false, automaticExposure: false,
        motionBlur: false, sharpening: false
      }
    }
  });
  await renderer.initialize({ context, pixelRatio: Math.min(devicePixelRatio, 2) });
  if (closing) return;
  renderer.render_debug_view = meshletView ? RenderDebugView.MeshletId : RenderDebugView.None;
  renderer.packed_visibility_cone_enabled = true;
  renderer.packed_visibility_hzb_enabled = true;
  renderer.packed_visibility_sse_threshold = 4;
  renderer.profiler.configure({ enabled: true, gpuSampleInterval: 8, gpuCounterSampleInterval: 16, historyCapacity: 400, cpuPassTimings: true });
  renderer.profiler.subscribe(frame => telemetry.acceptFrame(frame));
  telemetry.adapter = { identity: renderer.adapter_info, gpuTimestamp: renderer.profiler.gpuTimestampAvailable, features: renderer.capabilities.features };
  telemetry.event("WebGPU 就绪", renderer.adapter_info?.device ?? "adapter");

  const cookerConcurrency = Math.max(1, navigator.hardwareConcurrency || 1);
  const profile = resolveWebCookRuntimeProfile("auto");
  const worker = createDefaultWebCookWorker({
    maxSourceWindowBytes: 64 * MiB, maxCanonicalInputBytes: 32 * MiB,
    maxDecodedProductBytes: 128 * MiB, maxSessionSpillBytes: 1024 * MiB,
    maxTrianglesPerProduct: 128 * 1024, maxVerticesPerProduct: 512 * 1024,
    maxDomainsPerProduct: 64, runtimeProfile: profile.selected, maxWorkers: cookerConcurrency,
    catalogPriorityWindowMs: 10_000
  });
  telemetry.event("Web Cook 并行配置", `${profile.selected} / ${cookerConcurrency} logical cores${profile.fallbackReason ? ` / fallback: ${profile.fallbackReason}` : ""}`);
  asset = load_gltf(telemetry.sourceUrl, {
    worker, runtimeProfile: profile.selected,
    sessionId: `pine-forest-${crypto.randomUUID()}`, sessionGeneration: 1,
    budgets: { maxConcurrentWorkers: cookerConcurrency, maxSourceBytes: 128 * MiB, maxWasmBytes: 512 * MiB, maxOutputBytes: 256 * MiB, maxQueuedEvents: 2048 },
    bootstrap: { unitCount: 1 },
    initialOutputPageCredits: 512, maxBufferedPages: 512, maxBufferedBytes: 128 * MiB,
    onSceneCatalogReady: value => {
      catalog = value;
      telemetry.catalog = value;
      telemetry.catalogAt = performance.now() - telemetry.startedAt;
      for (const primitive of value.primitives) {
        const uses = primitive.instanceNodeIndices.length;
        const score = primitive.meshIndex === 0 ? 1_000_000 - primitive.primitiveIndex : 10_000 - uses;
        asset?.setSourcePriority(primitive.assetKey, score, 0);
      }
      telemetry.event("目录就绪", `${value.primitiveCount} primitive`);
      panel.paint();
    },
    onProgress: progress => {
      telemetry.progress = progress;
      if (progress.stage === "cook-complete") telemetry.event("Cook 完成", `${progress.units} primitive`);
    },
    onProductTaskTrace: trace => telemetry.acceptTrace(trace)
  });
  refreshId = window.setInterval(refresh, 500);
  loading = renderer.uploadWebCookedMultiProductScene(scene, asset, {
    signal: abort.signal, geometryOnly: true,
    fitHeight: 10, fitBase: [0, -5, 0],
    multiProductMetadataBytes: 128 * MiB, multiProductSlotCapacity: 2048,
    onProductPublicationTiming: timing => {
      telemetry.publications.push(timing);
      telemetry.firstPublishedAt ??= performance.now() - telemetry.startedAt;
      if (timing.shardIndex === 1) telemetry.event("首个 Product 发布");
    }
  });
  handles = await loading;
  if (closing) return;
  if (!catalog) throw new Error("Product 已发布，但目录没有到达");
  catalogFraming = webCookCatalogSceneFraming(catalog, { fitHeight: 10, fitBase: [0, -5, 0] });
  if (catalogFraming.unknownBoundPrimitives > 0) telemetry.event("目录边界不完整", String(catalogFraming.unknownBoundPrimitives));
  camera = new PerspectiveCamera();
  camera.near = Math.max(0.001, catalogFraming.radius / 10000);
  camera.far = Math.max(100, catalogFraming.radius * 30);
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.minDistance = Math.max(0.02, catalogFraming.radius / 1000);
  controls.maxDistance = catalogFraming.radius * 15;
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  resize();
  placeCamera(false);
  let previous = performance.now();
  const frame = (now: number) => {
    if (closing || !renderer || !camera) return;
    const interval = Math.max(0, now - previous);
    previous = now;
    const delta = Math.min(0.1, interval / 1000);
    controls?.update(delta);
    camera.update();
    renderer.profiler.recordExternalMetric("frame.rafIntervalMs", interval);
    const submitted = renderer.render(camera, scene, delta);
    if (submitted && telemetry.firstSubmittedAt === undefined) {
      telemetry.firstSubmittedAt = performance.now() - telemetry.startedAt;
      telemetry.event("首次提交画面");
    }
    if (renderer.profiler.diagnostics.deviceLostCount > 0) {
      telemetry.error = "WebGPU 设备丢失";
      panel.paint();
      return;
    }
    frameId = requestAnimationFrame(frame);
  };
  frameId = requestAnimationFrame(frame);
  await handles.settled();
  if (closing) return;
  settled = true;
  telemetry.settledAt = performance.now() - telemetry.startedAt;
  telemetry.event("所有 Product settled", `${handles.current().shardCount} shards`);
  refresh();
}

function setColorMode(meshlet: boolean): void {
  meshletView = meshlet;
  if (renderer) renderer.render_debug_view = meshlet ? RenderDebugView.MeshletId : RenderDebugView.None;
  document.querySelector("#meshlet-view")!.setAttribute("aria-pressed", String(meshlet));
  document.querySelector("#solid-view")!.setAttribute("aria-pressed", String(!meshlet));
  document.querySelector("#color-caption")!.textContent = meshlet ? "MESHLET ID" : "UNLIT";
  panel.setColorMode(meshlet ? "meshlet" : "solid");
}

function placeCamera(overview: boolean): void {
  if (!camera || !controls || !catalogFraming || !renderer) return;
  const published = overview ? undefined : handles?.current().source;
  const min = [...catalogFraming.min];
  const max = [...catalogFraming.max];
  if (published?.boundsMin && published.boundsMax) {
    min.fill(Infinity);
    max.fill(-Infinity);
    for (let index = 0; index < published.count; index++) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis]!, published.boundsMin[index * 3 + axis]!);
        max[axis] = Math.max(max[axis]!, published.boundsMax[index * 3 + axis]!);
      }
    }
  }
  const center = min.map((value, axis) => (value + max[axis]!) * 0.5);
  const extent = max.map((value, axis) => value - min[axis]!);
  const mainAxis = extent.indexOf(Math.max(...extent));
  const shortExtent = Math.max(0.1, ...extent.filter((_, axis) => axis !== mainAxis));
  const distance = overview ? catalogFraming.radius * 2.6 : Math.max(2, Math.min(catalogFraming.radius * 0.9, shortExtent * 0.9));
  const eye = [center[0], center[1] + distance * 1.2, center[2]];
  eye[mainAxis === 2 ? 0 : 2]! += distance * 1.2;
  camera.transform.position.set(eye[0]!, eye[1]!, eye[2]!);
  camera.transform.lookAt({ x: center[0], y: center[1], z: center[2] });
  controls.target.set(center[0]!, center[1]!, center[2]!);
  controls.reset();
  renderer.indicate_view_change();
  telemetry.event(overview ? "全览视角" : "中心视角");
}

function resize(): void {
  if (!renderer || !camera) return;
  renderer.resize(Math.max(1, Math.round(canvas.clientWidth)), Math.max(1, Math.round(canvas.clientHeight)));
  camera.aspect = renderer.aspect_ratio;
  camera.update();
}

function refresh(): void {
  if (!renderer || closing) return;
  telemetry.cook = asset?.evidence() ?? null;
  telemetry.runtime = handles?.runtime.evidence() ?? null;
  telemetry.streaming = handles?.streaming?.evidence() ?? null;
  telemetry.acceptMemory(renderer.memoryEvidence());
  telemetry.peakGpuBytes = Math.max(telemetry.peakGpuBytes, renderer.profiler.latest?.counters["gpu.residentBytes"] ?? 0);
  telemetry.adapter = { ...(telemetry.adapter as object), deviceErrors: renderer.profiler.diagnostics.uncapturedErrorCount + renderer.profiler.diagnostics.validationErrorCount };
  panel.paint();
}

async function release(waitForCleanup = true): Promise<void> {
  if (closing) return;
  closing = true;
  telemetry.releasingAt = performance.now() - telemetry.startedAt;
  telemetry.event("开始释放");
  panel.paint();
  abort.abort(new Error("demo released"));
  cancelAnimationFrame(frameId);
  clearInterval(refreshId);
  resizeObserver?.disconnect();
  controls?.dispose();
  if (!settled) asset?.cancel("demo released");
  try {
    if (loading && !handles) {
      try { handles = await loading; } catch { /* The aborted first publication has no handle to release. */ }
    }
    if (handles) await handles.settled().catch(() => undefined);
    telemetry.event("Product 发布已停止");
    await handles?.release();
    telemetry.event("Scene 已释放");
    if (waitForCleanup && settled) await asset?.disposeAsync();
    else asset?.dispose();
  } catch (error) {
    telemetry.error ??= error instanceof Error ? error.message : String(error);
    asset?.dispose();
  } finally {
    renderer?.destroy();
    canvas.getContext("webgpu")?.unconfigure();
    telemetry.disposedAt = performance.now() - telemetry.startedAt;
    telemetry.event("资源已释放");
    panel.paint();
  }
}

window.addEventListener("pagehide", () => { void release(false); }, { once: true });

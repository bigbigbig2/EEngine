import {
  createDefaultWebCookWorker, DirectionalLight, load_environment_map, load_gltf, OrbitControls, PerspectiveCamera,
  RenderDebugView, Renderer, Scene, webCookCatalogSceneFraming,
  type MultiProductSceneHandles, type WebCookRuntimeAsset, type WebCookSceneCatalogSnapshot
} from "../../../../OEngine/src/index.ts";
import { BasicPanel } from "./panel.ts";
import { BasicTelemetry } from "./telemetry.ts";

const sourceUrl = new URL("../../../assets/three/rendering-lab/dungeon_warkarma.glb", import.meta.url).href;
const environmentUrl = new URL("../../../assets/three/rendering-lab/venice_sunset_1k.hdr", import.meta.url).href;
const canvas = document.querySelector<HTMLCanvasElement>("#viewport")!;
const telemetry = new BasicTelemetry(sourceUrl);
const scene = new Scene();
const abort = new AbortController();
let renderer: Renderer | undefined;
let asset: WebCookRuntimeAsset | undefined;
let loading: Promise<MultiProductSceneHandles> | undefined;
let handles: MultiProductSceneHandles | undefined;
let catalog: WebCookSceneCatalogSnapshot | undefined;
let framing: ReturnType<typeof webCookCatalogSceneFraming> | undefined;
let camera: PerspectiveCamera | undefined;
let controls: OrbitControls | undefined;
let resizeObserver: ResizeObserver | undefined;
let frameId = 0;
let refreshId = 0;
let closing = false;
let settled = false;

const panel = new BasicPanel(telemetry, {
  center: () => placeCamera(false), overview: () => placeCamera(true),
  reload: () => location.reload(), release: () => { void release(); },
  feature: (name, enabled) => configureFeature(name, enabled),
  diffuse: value => configureDiffuse(value),
  gpuCounters: enabled => {
    if (!renderer || closing) return;
    renderer.profiler.setMode(enabled ? "record" : "live");
    telemetry.event("GPU 像素诊断", enabled ? "on" : "off");
  }
});
document.querySelector("#meshlet-view")!.addEventListener("click", () => setColorMode(true));
document.querySelector("#solid-view")!.addEventListener("click", () => setColorMode(false));

void start().catch(error => {
  if (closing) return;
  telemetry.error = error instanceof Error ? error.message : String(error);
  telemetry.event("加载失败", telemetry.error);
  console.error(error);
  panel.paint();
  void release(false);
});

async function start(): Promise<void> {
  if (!navigator.gpu) throw new Error("此浏览器没有可用的 WebGPU");
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("无法创建 WebGPU canvas context");
  renderer = new Renderer({
    debug: false,
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    textureMaxResolution: 1024,
    renderSettings: {
      resolution: { mode: "fixed", internalScale: 1 },
      features: {
        shadows: true, screenSpaceDiffuseMode: "gtao", screenSpaceReflections: true,
        temporalAntiAliasing: true, bloom: true, automaticExposure: true,
        motionBlur: true, sharpening: true
      },
      ao: { resolutionScale: 0.5, temporalEnabled: true },
      ssr: { resolutionScale: 0.5, temporalEnabled: true }
    }
  });
  await renderer.initialize({ context, pixelRatio: Math.min(devicePixelRatio, 2) });
  if (closing) return;
  renderer.render_debug_view = RenderDebugView.None;
  renderer.packed_visibility_cone_enabled = true;
  renderer.packed_visibility_hzb_enabled = true;
  renderer.packed_visibility_sse_threshold = 4;
  renderer.profiler.configure({ enabled: true, gpuSampleInterval: 8, gpuCounterSampleInterval: 16, historyCapacity: 400, cpuPassTimings: true });
  renderer.profiler.subscribe(frame => telemetry.acceptFrame(frame));
  telemetry.adapter = { identity: renderer.adapter_info, gpuTimestamp: renderer.profiler.gpuTimestampAvailable, features: renderer.capabilities.features };
  telemetry.features = { ...renderer.render_settings.features };
  panel.syncFeatures(renderer.render_settings.features);
  telemetry.event("WebGPU 就绪", renderer.adapter_info?.device ?? "adapter");

  const sun = new DirectionalLight();
  sun.name = "Rendering Lab Sun";
  sun.intensity = 2.8;
  sun.casts_shadow = true;
  const azimuth = -36 * Math.PI / 180;
  const elevation = 65 * Math.PI / 180;
  sun.forward = [Math.cos(elevation) * Math.cos(azimuth), -Math.sin(elevation), Math.cos(elevation) * Math.sin(azimuth)];
  scene.addChild(sun);
  scene.lights.environment = await load_environment_map(environmentUrl);
  if (closing) return;
  telemetry.event("环境光就绪", "venice_sunset_1k.hdr");

  // This page owns its Worker and Product; it does not use the shared RenderingLab lifecycle.
  const worker = createDefaultWebCookWorker({
    maxCanonicalInputBytes: 128 * 1024 * 1024,
    maxDecodedProductBytes: 512 * 1024 * 1024,
    runtimeProfile: "portable-single"
  });
  asset = load_gltf(sourceUrl, {
    worker, runtimeProfile: "portable-single",
    sessionId: `rendering-lab-basic-${crypto.randomUUID()}`, sessionGeneration: 1,
    budgets: { maxConcurrentWorkers: 1, maxSourceBytes: 128 * 1024 * 1024, maxWasmBytes: 128 * 1024 * 1024, maxOutputBytes: 256 * 1024 * 1024, maxQueuedEvents: 1024 },
    initialOutputPageCredits: 64, maxBufferedPages: 64, maxBufferedBytes: 64 * 262144,
    onSceneCatalogReady: value => {
      catalog = value;
      telemetry.catalog = value;
      telemetry.acceptMaterialCatalog(value);
      telemetry.catalogAt = performance.now() - telemetry.startedAt;
      framing = webCookCatalogSceneFraming(value, { fitHeight: 5.4, fitBase: [0, -1, 0] });
      telemetry.event("GLB 目录就绪", `${value.primitiveCount} primitives`);
      panel.paint();
    },
    onProgress: progress => {
      telemetry.progress = progress;
      if (progress.stage === "cook-complete") telemetry.event("Worker Cook 完成", `${progress.units} primitives`);
    }
  });
  refreshId = window.setInterval(refresh, 500);
  loading = renderer.uploadWebCookedMultiProductScene(scene, asset, {
    signal: abort.signal, geometryOnly: false,
    fitHeight: 5.4, fitBase: [0, -1, 0],
    onProductPublicationTiming: timing => {
      telemetry.publications.push(timing);
      telemetry.firstPublishedAt ??= performance.now() - telemetry.startedAt;
      telemetry.shardCount = timing.shardIndex;
    }
  });
  handles = await loading;
  if (closing) return;
  if (!catalog || !framing) throw new Error("Product 已发布，但 GLB 目录没有到达");
  telemetry.firstPublishedAt = performance.now() - telemetry.startedAt;
  telemetry.sourceCount = handles.current().source.count;
  telemetry.assetCount = handles.current().source.assetCount;
  telemetry.event("虚拟几何 Product 发布", `${telemetry.sourceCount} instances`);
  camera = new PerspectiveCamera();
  camera.near = Math.max(0.01, framing.radius / 5000);
  camera.far = Math.max(100, framing.radius * 24);
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.minDistance = Math.max(0.02, framing.radius / 1000);
  controls.maxDistance = framing.radius * 12;
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  resize();
  placeCamera(false);
  refresh();

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
  telemetry.sourceCount = handles.current().source.count;
  telemetry.assetCount = handles.current().source.assetCount;
  telemetry.shardCount = handles.current().shardCount;
  telemetry.event("Product settled", `${telemetry.sourceCount} instances`);
  refresh();
}

function setColorMode(meshlet: boolean): void {
  if (renderer) renderer.render_debug_view = meshlet ? RenderDebugView.MeshletId : RenderDebugView.None;
  document.querySelector("#meshlet-view")!.setAttribute("aria-pressed", String(meshlet));
  document.querySelector("#solid-view")!.setAttribute("aria-pressed", String(!meshlet));
  document.querySelector("#color-caption")!.textContent = meshlet ? "MESHLET ID" : "PBR";
  panel.setColorMode(meshlet ? "meshlet" : "pbr");
}

type BooleanFeature = "shadows" | "screenSpaceReflections" | "temporalAntiAliasing" | "bloom" | "automaticExposure" | "motionBlur" | "sharpening";

function configureFeature(name: BooleanFeature, enabled: boolean): void {
  if (!renderer || closing) return;
  try {
    renderer.configure({ features: { [name]: enabled } });
    telemetry.features = { ...renderer.render_settings.features };
    telemetry.event("渲染效果", `${name}: ${enabled ? "on" : "off"}`);
  } catch (error) {
    telemetry.event("效果切换失败", error instanceof Error ? error.message : String(error));
  }
  panel.syncFeatures(renderer.render_settings.features);
}

function configureDiffuse(value: "off" | "gtao" | "ssgi"): void {
  if (!renderer || closing) return;
  try {
    renderer.configure({ features: { screenSpaceDiffuseMode: value } });
    telemetry.features = { ...renderer.render_settings.features };
    telemetry.event("漫反射效果", value);
  } catch (error) {
    telemetry.event("效果切换失败", error instanceof Error ? error.message : String(error));
  }
  panel.syncFeatures(renderer.render_settings.features);
}

function placeCamera(overview: boolean): void {
  if (!camera || !controls || !framing || !renderer) return;
  const center = framing.center;
  const radius = framing.radius;
  const distance = overview ? radius * 2.6 : radius * 1.5;
  camera.transform.position.set(center[0] + distance, center[1] + distance * 0.55, center[2] + distance * 1.2);
  camera.transform.lookAt({ x: center[0], y: center[1], z: center[2] });
  controls.target.set(...center);
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
  telemetry.texture = renderer.textureResidencyEvidence();
  if (handles) {
    telemetry.sourceCount = handles.current().source.count;
    telemetry.assetCount = handles.current().source.assetCount;
    telemetry.shardCount = handles.current().shardCount;
    telemetry.materialCount = handles.current().source.materials.length;
  }
  telemetry.acceptMemory(renderer.memoryEvidence());
  telemetry.peakGpuBytes = Math.max(telemetry.peakGpuBytes, renderer.profiler.latest?.counters["gpu.residentBytes"] ?? 0);
  telemetry.adapter = { ...(telemetry.adapter as object), deviceErrors: renderer.profiler.diagnostics.uncapturedErrorCount + renderer.profiler.diagnostics.validationErrorCount };
  panel.paint();
}

async function release(waitForCleanup = true): Promise<void> {
  if (closing) return;
  closing = true;
  telemetry.releasingAt = performance.now() - telemetry.startedAt;
  panel.paint();
  abort.abort(new Error("demo released"));
  cancelAnimationFrame(frameId);
  clearInterval(refreshId);
  resizeObserver?.disconnect();
  controls?.dispose();
  if (!settled) asset?.cancel("demo released");
  try {
    if (loading && !handles) {
      try { handles = await loading; } catch { /* No Scene was published. */ }
    }
    if (handles) {
      await handles.settled().catch(() => undefined);
      await handles.release();
    }
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

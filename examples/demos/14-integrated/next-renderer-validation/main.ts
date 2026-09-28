import {
  createDefaultWebCookWorker, load_gltf, OrbitControls, PerspectiveCamera, Renderer, Scene,
  webCookCatalogSceneFraming,
  type MultiProductSceneHandles, type WebCookCatalogSceneFramingV1,
  type WebCookProductPublicationTiming, type WebCookRuntimeAsset
} from "../../../../OEngine/src/index.ts";

function element<T extends Element>(selector: string): T {
  const result = document.querySelector<T>(selector);
  if (result === null) throw new Error(`Missing validation control ${selector}`);
  return result;
}

const canvas = element<HTMLCanvasElement>("#viewport");
const state = element<HTMLDivElement>("#view-state");
const startButton = element<HTMLButtonElement>("#start-scene");
const azimuthInput = element<HTMLInputElement>("#sun-azimuth");
const elevationInput = element<HTMLInputElement>("#sun-elevation");
const scene = new Scene();
const modelUrl = new URL("../../../assets/three/rendering-lab/dungeon_warkarma.glb", import.meta.url).href;
const loadOnly = new URLSearchParams(location.search).has("loadOnly");
const boundedFrame = new URLSearchParams(location.search).has("boundedFrame");
const geometryOnly = new URLSearchParams(location.search).has("geometryOnly");
const skipAuthoredTextures = new URLSearchParams(location.search).has("skipTextures");
const disableGtao = new URLSearchParams(location.search).has("disableGtao");
const singleLitMaterial = new URLSearchParams(location.search).has("singleLit");

let renderer: Renderer | undefined;
let asset: WebCookRuntimeAsset | undefined;
let handles: MultiProductSceneHandles | undefined;
let loading: Promise<MultiProductSceneHandles> | undefined;
let framing: WebCookCatalogSceneFramingV1 | undefined;
let camera: PerspectiveCamera | undefined;
let controls: OrbitControls | undefined;
let resizeObserver: ResizeObserver | undefined;
let frameId = 0;
let refreshId = 0;
let closed = false;
let fps = 0;
let failed = false;
let gpuUnavailable = false;
let firstCutReady = false;
let refinementComplete = false;
let cookProgress: { stage: string; units: number; total: number; elapsedMs: number;
  timings: Readonly<Record<string, number>> } = {
  stage: "catalog", units: 0, total: 0, elapsedMs: 0, timings: {}
};
let publicationCount = 0;
let publicationTotals = { waitMs: 0, runtimeMs: 0, mapMs: 0, mergeMs: 0, publishMs: 0 };
let lastPublication: WebCookProductPublicationTiming | undefined;
const loadStartedAt = performance.now();
const abort = new AbortController();

element<HTMLButtonElement>("#overview-view").addEventListener("click", () => setView("overview"));
element<HTMLButtonElement>("#detail-view").addEventListener("click", () => setView("detail"));
element<HTMLButtonElement>("#export-diagnostics").addEventListener("click", exportDiagnostics);
for (const input of [azimuthInput, elevationInput]) {
  input.addEventListener("input", updateSunLabels);
  input.addEventListener("change", publishSun);
}
publishSun();
startButton.addEventListener("click", () => {
  startButton.disabled = true;
  startButton.hidden = true;
  void start().catch(error => {
    if (closed) return;
    fail(error);
    void release();
  });
}, { once: true });

async function start(): Promise<void> {
  if (!navigator.gpu) throw new Error("当前浏览器不支持 WebGPU");
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("无法创建 WebGPU canvas context");
  renderer = new Renderer({
    enableVsm: false,
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    textureMaxResolution: 1024
  });
  renderer.shadowVisibilityEnabled = false;
  renderer.xe_gtao_enabled = !disableGtao;
  if (boundedFrame) renderer.packed_geometry_work_budget = {
    maxTestedHierarchyNodes: 16384,
    targetMeshletWork: 2048,
    maxMeshletWork: 4096,
    targetRasterVertices: 262144,
    maxRasterVertices: 524288,
    maxRiskyTriangles: 65536,
    maxSetupBytes: 2 * 1024 * 1024
  };
  setState("初始化 WebGPU", "loading");
  await renderer.initialize({ context });
  if (closed) return;
  renderer.packed_visibility_hzb_enabled = true;
  renderer.packed_visibility_cone_enabled = true;
  setState("加载 Dungeon 场景", "loading");

  const worker = createDefaultWebCookWorker({
    maxCanonicalInputBytes: 128 * 1024 * 1024,
    maxDecodedProductBytes: 512 * 1024 * 1024,
    runtimeProfile: "portable-single"
  });
  asset = load_gltf(modelUrl, {
    worker, runtimeProfile: "portable-single",
    sessionId: `next-renderer-validation-${crypto.randomUUID()}`, sessionGeneration: 1,
    budgets: {
      maxConcurrentWorkers: 1, maxSourceBytes: 128 * 1024 * 1024,
      maxWasmBytes: 128 * 1024 * 1024, maxOutputBytes: 256 * 1024 * 1024,
      maxQueuedEvents: 1024
    },
    initialOutputPageCredits: 64, maxBufferedPages: 64,
    maxBufferedBytes: 64 * 262144,
    onSceneCatalogReady: catalog => {
      framing = webCookCatalogSceneFraming(catalog, { fitHeight: 5.4, fitBase: [0, -1, 0] });
      element<HTMLElement>("#instance-count").textContent = String(catalog.instances.length);
    },
    onProgress: progress => {
      cookProgress = { stage: progress.stage, units: progress.units,
        total: progress.catalogPrimitives, elapsedMs: progress.elapsedMs ?? 0,
        timings: progress.timings };
      if (closed || refinementComplete) return;
      const count = progress.catalogPrimitives > 0
        ? ` ${progress.units}/${progress.catalogPrimitives}` : "";
      setState(`${firstCutReady ? "精化场景" : "加载场景"} · ${progress.stage}${count}`, "loading");
    }
  });
  loading = renderer.uploadWebCookedMultiProductScene(scene, asset, {
    signal: abort.signal, fitHeight: 5.4, fitBase: [0, -1, 0],
    geometryOnly, singleLitMaterial, skipAuthoredTextures,
    onProductPublicationTiming: timing => {
      publicationCount++;
      lastPublication = timing;
      publicationTotals.waitMs += timing.sourceWaitMs;
      publicationTotals.runtimeMs += timing.runtimeLoadMs;
      publicationTotals.mapMs += timing.sceneMapMs;
      publicationTotals.mergeMs += timing.sourceMergeMs;
      publicationTotals.publishMs += timing.scenePublishMs;
      if (loadOnly) setState(`加载 Product ${publicationCount} · ${Math.round(performance.now() - loadStartedAt)} ms`, "loading");
    }
  });
  handles = await loading;
  if (closed) return;
  if (!framing) throw new Error("模型目录没有提供有效边界");
  firstCutReady = true;

  camera = new PerspectiveCamera();
  camera.near = Math.max(0.01, framing.radius / 5000);
  camera.far = Math.max(100, framing.radius * 24);
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.minDistance = Math.max(0.2, framing.radius * 0.08);
  controls.maxDistance = framing.radius * 12;
  setView("overview");
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  resize();

  let previous = 0;
  const draw = (now: number): void => {
    if (closed || !renderer || !camera) return;
    const targetFrameMs = refinementComplete ? 1000 / 20 : 1000 / 8;
    if (previous > 0 && now - previous < targetFrameMs) {
      frameId = requestAnimationFrame(draw);
      return;
    }
    const interval = previous > 0 ? Math.max(1, now - previous) : 0;
    previous = now;
    if (interval > 0) fps = fps === 0 ? 1000 / interval :
      fps * 0.9 + (1000 / interval) * 0.1;
    try {
      controls?.update(Math.min(0.1, (interval || 16.7) / 1000));
      camera.update();
      if (!renderer.render(camera, scene, Math.min(0.1, (interval || 16.7) / 1000))) {
        gpuUnavailable = true;
        throw new Error("WebGPU 设备已失效，渲染已停止");
      }
      const diagnostics = renderer.profiler.diagnostics;
      if (diagnostics.validationErrorCount > 0 || diagnostics.uncapturedErrorCount > 0 || diagnostics.deviceLostCount > 0) {
        gpuUnavailable = diagnostics.deviceLostCount > 0;
        throw new Error(`GPU 验证失败，已停止提交（validation=${diagnostics.validationErrorCount}, uncaptured=${diagnostics.uncapturedErrorCount}）`);
      }
      frameId = requestAnimationFrame(draw);
    } catch (error) {
      fail(error);
      void release();
    }
  };
  if (!loadOnly) frameId = requestAnimationFrame(draw);
  refreshId = window.setInterval(refresh, 500);

  await handles.settled();
  if (closed || failed) return;
  refinementComplete = true;
  if (loadOnly) {
    console.info("A-D scene loading diagnostics", JSON.stringify({
      elapsedMs: Math.round(performance.now() - loadStartedAt),
      publicationCount, totals: publicationTotals, lastPublication,
      cookProgress
    }));
  }
  setState(loadOnly ? "场景已加载（未渲染）" : "场景已就绪", "ready");
  refresh();
}

function setView(preset: "overview" | "detail"): void {
  if (!camera || !controls || !framing) return;
  const [x, y, z] = framing.center;
  const distance = framing.radius * (preset === "overview" ? 1.75 : 0.95);
  camera.transform.position.set(x + distance, y + distance * 0.55, z + distance * 1.15);
  camera.transform.lookAt({ x, y, z });
  controls.target.set(x, y, z);
  controls.reset();
  camera.update();
}

function resize(): void {
  if (!renderer || !camera) return;
  const width = Math.max(1, Math.round(canvas.clientWidth));
  const height = Math.max(1, Math.round(canvas.clientHeight));
  const scale = Math.min(1, 800 / width, 450 / height);
  renderer.resize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
  camera.aspect = renderer.aspect_ratio;
  camera.update();
}

function updateSunLabels(): void {
  element<HTMLOutputElement>("#azimuth-value").value = `${azimuthInput.value}°`;
  element<HTMLOutputElement>("#elevation-value").value = `${elevationInput.value}°`;
}

function publishSun(): void {
  updateSunLabels();
  const azimuth = Number(azimuthInput.value) * Math.PI / 180;
  const elevation = Number(elevationInput.value) * Math.PI / 180;
  scene.physical_environment.setSun([
    Math.cos(elevation) * Math.cos(azimuth), Math.sin(elevation),
    Math.cos(elevation) * Math.sin(azimuth)
  ], [1.474, 1.8504, 1.91198]);
}

function refresh(): void {
  if (!renderer) return;
  const graph = renderer.mainFrameGraphEvidence();
  const stages = graph?.program.stages ?? [];
  const expected = ["visibility", "surface", "temporal-facts", "fsr3", "radiometry", "bloom", "present"];
  const connected = expected.every(stage => stages.includes(stage as typeof stages[number])) &&
    !stages.includes("vsm");
  element<HTMLElement>("#path-state").textContent = graph ? (connected ? "已接通" : "检查节点") : "等待首帧";
  element<HTMLElement>("#frame-rate").textContent = fps ? `${fps.toFixed(0)} fps` : "--";
  const diagnostics = renderer.profiler.diagnostics;
  element<HTMLElement>("#gpu-errors").textContent = String(
    diagnostics.uncapturedErrorCount + diagnostics.validationErrorCount + diagnostics.deviceLostCount
  );
  fillList("#program-stages", stages);
  fillList("#graph-passes", graph?.dump.passes.filter(pass => !pass.culled).map(pass => pass.name) ?? []);
}

function fillList(selector: string, values: readonly string[], className = (_value: string): string => ""): void {
  const list = element<HTMLOListElement>(selector);
  const entries = (values.length ? values : ["等待首帧"]).map(value => {
    const item = document.createElement("li");
    item.textContent = value;
    item.className = className(value);
    return item;
  });
  list.replaceChildren(...entries);
}

function exportDiagnostics(): void {
  const graph = renderer?.mainFrameGraphEvidence();
  const data = {
    schema: "eengine-next-validation-v1", capturedAt: new Date().toISOString(),
    mode: "baseline", modelUrl, adapter: renderer?.adapter_info,
    geometryOnly, singleLitMaterial, skipAuthoredTextures, disableGtao,
    boundedFrame, loadOnly,
    sun: scene.physical_environment.snapshot(),
    camera: camera ? { position: camera.transform.position, near: camera.near, far: camera.far } : null,
    instances: handles?.current().source.count ?? 0,
    frameCount: renderer?.frame_count ?? 0,
    cookProgress,
    loading: { elapsedMs: Math.round(performance.now() - loadStartedAt),
      publicationCount, totals: publicationTotals, lastPublication },
    cook: asset?.evidence(),
    diagnostics: renderer?.profiler.diagnostics,
    program: graph?.program ?? null,
    graphPasses: graph?.dump.passes.filter(pass => !pass.culled).map(pass => pass.name) ?? []
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `eengine-next-baseline-${Date.now()}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setState(message: string, status: "loading" | "ready" | "error"): void {
  if (failed && status !== "error") return;
  state.textContent = message;
  state.dataset.state = status;
}

function fail(error: unknown): void {
  failed = true;
  console.error(error);
  setState(error instanceof Error ? error.message : String(error), "error");
}

async function release(): Promise<void> {
  if (closed) return;
  closed = true;
  abort.abort(new Error("validation page closed"));
  cancelAnimationFrame(frameId);
  clearInterval(refreshId);
  resizeObserver?.disconnect();
  controls?.dispose();
  if (!handles) asset?.cancel("validation page closed");
  try {
    if (loading && !handles) handles = await loading.catch(() => undefined);
    if (handles && !gpuUnavailable) {
      await handles.settled().catch(() => undefined);
      await handles.release();
    }
  } finally {
    asset?.dispose();
    renderer?.destroy();
    canvas.getContext("webgpu")?.unconfigure();
  }
}

window.addEventListener("pagehide", () => { void release(); }, { once: true });

import {
  createDefaultWebCookWorker,
  load_gltf,
  OrbitControls,
  PerspectiveCamera,
  Renderer,
  Scene,
  webCookCatalogSceneFraming,
  RenderDebugView,
  type MultiProductSceneHandles,
  type WebCookCatalogSceneFramingV1,
  type WebCookRuntimeAsset,
  type RenderDebugViewName,
} from "../../../../OEngine/src/index.ts";
import { BenchmarkCapture, type CaptureRequest } from "./BenchmarkCapture.ts";

type GeometryDebugView = "none" | "triangle" | "shading" | "meshlet" | "depth";
const geometryDebugRenderViews: Readonly<Record<GeometryDebugView, RenderDebugViewName>> = {
  none: RenderDebugView.None,
  triangle: RenderDebugView.VisibilityKey,
  shading: RenderDebugView.MaterialId,
  meshlet: RenderDebugView.MeshletId,
  depth: RenderDebugView.Depth,
};
const geometryDebugDescriptions: Readonly<Record<GeometryDebugView, string>> = {
  none: "生产画面。选择视图可直接检查 Visibility、材质归属和 Meshlet 分区。",
  triangle:
    "Triangle：按当前 VisibilityKey 的 Meshlet 与局部三角形分色。三角形边界出现彩色碎片是此视图的预期结果。",
  shading: "Shading：按当前可见像素的 resident MaterialRecord 分色，用来查材质归属。",
  meshlet: "Meshlet：按当前可见 Meshlet 分色。色块边界是 Meshlet 分块，不代表几何缺失。",
  depth: "Depth：显示硬件反向 Z 深度，用来检查几何覆盖、裁剪和深度竞争。",
};

function element<T extends Element>(id: string): T {
  const node = document.getElementById(id) as T | null;
  if (node === null) throw new Error(`Missing showcase control #${id}`);
  return node;
}

const canvas = element<HTMLCanvasElement>("viewport");
const startButton = element<HTMLButtonElement>("start-scene");
const state = element<HTMLElement>("scene-state");
const pathBadge = element<HTMLElement>("path-badge");
const fpsReadout = element<HTMLElement>("fps-readout");
const panel = element<HTMLElement>("control-panel");
const panelToggle = element<HTMLButtonElement>("panel-toggle");
const loadingOverlay = element<HTMLElement>("loading-overlay");
const loadingTitle = element<HTMLElement>("loading-title");
const loadingDetail = element<HTMLElement>("loading-detail");
const loadingProgress = element<HTMLElement>("loading-progress");
const loadingPercent = element<HTMLElement>("loading-percent");
const loadingElapsed = element<HTMLElement>("loading-elapsed");
const cpuReadout = element<HTMLElement>("cpu-readout");
const gpuReadout = element<HTMLElement>("gpu-readout");
const instanceReadout = element<HTMLElement>("instance-readout");
const resolutionReadout = element<HTMLElement>("resolution-readout");
const streamingReadout = element<HTMLElement>("streaming-readout");
const diagnosticState = element<HTMLElement>("diagnostic-state");
const geometryDebugHelp = element<HTMLElement>("geometry-debug-help");
const modelUrl = new URL("../../../assets/three/rendering-lab/dungeon_warkarma.glb", import.meta.url).href;
const scene = new Scene();
const baseIrradiance = [1.474, 1.8504, 1.91198] as const;
const settings = {
  autoExposure: false,
  fixedExposure: 4,
  gtao: true,
  fsr3: true,
  bloom: true,
  hzb: true,
  cone: true,
  autoRotate: false,
  profiler: false,
  renderScale: 1,
  sse: 4,
  sunAzimuth: 30,
  sunElevation: 63,
  sunIntensity: 1.5,
  debugView: "none" as GeometryDebugView,
};

let renderer: Renderer | undefined;
let asset: WebCookRuntimeAsset | undefined;
let handles: MultiProductSceneHandles | undefined;
let loading: Promise<MultiProductSceneHandles> | undefined;
let framing: WebCookCatalogSceneFramingV1 | undefined;
let camera: PerspectiveCamera | undefined;
let controls: OrbitControls | undefined;
let resizeObserver: ResizeObserver | undefined;
let frameId = 0;
let captureTimer: number | null = null;
let closed = false;
let failed = false;
let refinementComplete = false;
let firstFrameComplete = false;
let firstFrameCompletion: Promise<void> | null = null;
let fps = 0;
let previousTime = 0;
let previousRenderedTime = 0;
let loadStart = performance.now();
let starting: Promise<void> | undefined;
let captureExtent: readonly [number, number] | null = null;
let capturePaused = false;
let captureTarget: { end: number; resolve(): void; reject(error: unknown): void; timer: number } | null =
  null;
let savedCamera: { matrix: number[]; target: number[] } | null = null;
let hudUpdatedAt = 0;
let captureConditions: Record<string, unknown> = {};
interface ShowcaseDiagnosticHost {
  vsm?: boolean;
  mode?: string;
  pipelineInitialization?: string;
  prepare?: (renderer: Renderer) => Promise<void>;
  onTrajectoryFrame?: (snapshot: ReturnType<typeof frameSnapshot>) => Promise<void>;
}
const diagnosticHost = (
  globalThis as typeof globalThis & {
    __surfaceDiagnostic?: ShowcaseDiagnosticHost;
  }
).__surfaceDiagnostic;
const diagnosticVsm = diagnosticHost?.vsm ?? false;
let capturePath: {
  begin: number;
  frames: number;
  position: readonly number[];
  target: readonly number[];
} | null = null;

function publishedSceneFacts() {
  const graphics = renderer?.graphics;
  const runtime = graphics?.render_world.runtime(scene);
  if (!runtime) {
    return null;
  }
  const publication = runtime.nativeMaterials?.publication;
  return {
    sourceKind: runtime.sourceKind,
    instances: runtime.instanceCount,
    materialInstances: runtime.materialDictionaryCount,
    programs: publication ? new Set(publication.entries.map((entry) => entry.programIndex)).size : 0,
    executionBins: publication?.bins.length ?? 0,
    bindingSets: publication ? new Set(publication.bins.map((bin) => bin.bindingSet)).size : 0,
  };
}

const capture = new BenchmarkCapture({
  beginMeasurement: (begin, request) => {
    if (request.trajectory !== "orbit-return") return;
    capturePath = {
      begin,
      frames: request.frames,
      position: [camera!.transform.position.x, camera!.transform.position.y, camera!.transform.position.z],
      target: [controls!.target.x, controls!.target.y, controls!.target.z],
    };
  },
  endMeasurement: () => {
    capturePath = null;
  },
  renderer: () => {
    if (!renderer || !refinementComplete || failed)
      throw new Error(`Scene is not ready: ${state.textContent}`);
    return renderer;
  },
  prepare: (request) => {
    savedCamera = {
      matrix: Array.from(camera!.transform.matrix),
      target: [controls!.target.x, controls!.target.y, controls!.target.z],
    };
    captureExtent = [request.width, request.height];
    capturePaused = true;
    setView(request.view);
    setViewDistance(request.distanceScale);
    camera!.aspect = request.width / request.height;
    camera!.update();
    renderer!.setResolutionScale(1);
    renderer!.resize(request.width, request.height);
    renderer!.xe_gtao_enabled = request.profile !== "no-ao";
    renderer!.fsr3_enabled = request.profile !== "no-fsr3";
    renderer!.bloom_enabled = request.profile !== "no-bloom";
    renderer!.shadowVisibilityEnabled = request.vsm;
    renderer!.render_debug_view = RenderDebugView.None;
    renderer!.packed_visibility_hzb_enabled = true;
    renderer!.packed_visibility_cone_enabled = true;
    renderer!.packed_visibility_sse_threshold = 4;
    renderer!.invalidateTemporalHistory();
    canvas.style.pointerEvents = "none";
    const diagnostic = globalThis as typeof globalThis & {
      __surfaceDiagnostic?: { mode: string; pipelineInitialization: string };
    };
    captureConditions = {
      modelUrl,
      shaderMode: diagnostic.__surfaceDiagnostic?.mode ?? "production",
      coverage: request.coverage,
      output: [request.width, request.height],
      internalScale: 1,
      camera: {
        transform: Array.from(camera!.transform.matrix),
        viewProjection: Array.from(camera!.view_projection_matrix),
        near: camera!.near,
        far: camera!.far,
        fov: camera!.fov,
      },
      features: {
        gtao: renderer!.xe_gtao_enabled,
        fsr3: renderer!.fsr3_enabled,
        bloom: renderer!.bloom_enabled,
        vsm: diagnosticVsm && renderer!.shadowVisibilityEnabled,
        jitter: false,
        hzb: true,
        cone: true,
        currentHzbLateRecheck: false,
        sse: 4,
      },
      sun: scene.physical_environment.snapshot(),
      exposure: settings.fixedExposure,
      instanceCount: publishedSceneFacts()?.instances ?? scene.instance_count,
      nativeScene: publishedSceneFacts(),
      counters: request.counters,
      trajectory: request.trajectory,
      trajectoryRadians: 0.05,
      trajectoryStages: "equal thirds: static, sin(pi*t) orbit returning to base, settled",
      frameDeltaSeconds: 1 / 60,
      hudIntervalMs: 250,
      scheduling: "timer-driven; Renderer two-frame completion backpressure",
      pipelineInitialization: diagnostic.__surfaceDiagnostic?.pipelineInitialization ?? "native-production",
    };
    return captureConditions;
  },
  conditions: () => ({
    ...captureConditions,
    camera: {
      transform: Array.from(camera!.transform.matrix),
      viewProjection: Array.from(camera!.view_projection_matrix),
      near: camera!.near,
      far: camera!.far,
      fov: camera!.fov,
    },
  }),
  setDistance: (scale) => {
    setViewDistance(scale);
    renderer!.invalidateTemporalHistory();
  },
  stability: () => {
    const state = renderer!.geometryStreamingEvidence(scene);
    return {
      signature: JSON.stringify(
        state
          ? [
              state.residency.productGeneration,
              state.residency.activeRevisions,
              state.residency.residentPages,
              state.residency.uploadedBytes,
              state.residency.evictedPages,
            ]
          : null,
      ),
      busy: Boolean(state && state.scheduler.inFlightBytes > 0),
      failed: Boolean(
        state &&
          (state.scheduler.failed || state.residency.failedPages || state.scheduler.malformedReadbacks),
      ),
    };
  },
  renderFrames: async (count) => {
    if (capturePath && diagnosticHost?.onTrajectoryFrame) {
      // Diagnostic screenshots happen between completed frame submissions.
      // Static timing keeps the normal uninterrupted batch path.
      for (let index = 0; index < count; index++) {
        await renderFrameBatch(1);
        await renderer!.device.queue.onSubmittedWorkDone();
        await diagnosticHost.onTrajectoryFrame(frameSnapshot());
      }
      return;
    }
    await renderFrameBatch(count);
  },
  restore: (retainView = false) => {
    if (captureTarget) {
      clearTimeout(captureTarget.timer);
      captureTarget.reject(new Error("Capture stopped"));
      captureTarget = null;
    }
    capturePaused = false;
    captureExtent = null;
    canvas.style.pointerEvents = "";
    if (savedCamera && !retainView) {
      // Restore the actual pose; restoring only position would lose camera orientation.
      camera!.transform.fromMatrix(savedCamera.matrix);
      controls!.target.set(...(savedCamera.target as [number, number, number]));
      controls!.reset();
      camera!.update();
      savedCamera = null;
    }
    savedCamera = null;
    renderer!.perf_gpu_counters_enabled = settings.profiler;
    renderer!.profiler.configure({
      enabled: settings.profiler,
      gpuSampleInterval: 1,
      gpuCounterSampleInterval: 8,
      historyCapacity: 180,
    });
    renderer!.xe_gtao_enabled = settings.gtao;
    renderer!.fsr3_enabled = settings.fsr3;
    renderer!.bloom_enabled = settings.bloom;
    renderer!.shadowVisibilityEnabled = false;
    renderer!.render_debug_view = geometryDebugRenderViews[settings.debugView];
    renderer!.packed_visibility_hzb_enabled = settings.hzb;
    renderer!.packed_visibility_cone_enabled = settings.cone;
    renderer!.packed_visibility_sse_threshold = settings.sse;
    renderer!.setResolutionScale(settings.renderScale);
    renderer!.invalidateTemporalHistory();
    resize();
  },
  status: (message) => {
    element<HTMLElement>("benchmark-state").textContent = message;
    if ("__surfaceDiagnostic" in globalThis) console.info(`SURFACE_CAPTURE ${message}`);
  },
});

function renderFrameBatch(count: number): Promise<void> {
  if (!count) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      capturePaused = true;
      captureTarget = null;
      reject(new Error("Frame batch timeout"));
    }, 120000);
    captureTarget = { end: renderer!.frame_count + count, resolve, reject, timer };
    capturePaused = false;
  });
}

function frameSnapshot() {
  return {
    submittedFrame: renderer!.frame_count - 1,
    output: [canvas.width, canvas.height],
    camera: {
      transform: Array.from(camera!.transform.matrix),
      viewProjection: Array.from(camera!.view_projection_matrix),
    },
    trajectoryFrame: capturePath ? renderer!.frame_count - 1 - capturePath.begin : null,
    benchmark: element<HTMLElement>("benchmark-state").textContent,
  };
}

/** Explicit diagnostic seam for local automation; no private Renderer mutation. */
export const showcaseDiagnostics = {
  start: () => (starting ??= start()),
  get ready() {
    return refinementComplete && firstFrameComplete && !failed;
  },
  get failed() {
    return failed;
  },
  get busy() {
    return capture.busy;
  },
  get snapshot() {
    return renderer && camera ? frameSnapshot() : null;
  },
  pause: async () => {
    if (capture.busy) throw new Error("Cannot pause an active capture");
    capturePaused = true;
    await renderer!.device.queue.onSubmittedWorkDone();
    return frameSnapshot();
  },
  stepFrames: async (count = 1) => {
    if (capture.busy) throw new Error("Cannot step an active capture");
    if (!Number.isSafeInteger(count) || count < 1 || count > 16)
      throw new Error("Invalid diagnostic frame count");
    await renderFrameBatch(count);
    await renderer!.device.queue.onSubmittedWorkDone();
    return frameSnapshot();
  },
  get lastCapture() {
    return capture.last;
  },
  // Completed snapshots are needed by diagnostics: latest is normally still pending.
  get profiles() {
    return renderer?.profiler.history ?? [];
  },
  get adapter() {
    return renderer?.adapter_info;
  },
  get runtime() {
    return {
      frameCount: renderer?.frame_count,
      diagnostics: renderer?.profiler.diagnostics,
      preparation: capture.preparation,
      visibility: document.visibilityState,
      streaming: renderer?.geometryStreamingEvidence(scene),
      nativeScene: publishedSceneFacts(),
      memory: renderer?.graphics ? renderer.memoryEvidence() : undefined,
    };
  },
  capture: async (request: CaptureRequest = {}) => {
    await showcaseDiagnostics.start();
    return capture.run(request);
  },
  dispose: release,
};
Object.assign(globalThis, { __eengineShowcase: showcaseDiagnostics });

for (const id of [
  "toggle-gtao",
  "toggle-fsr3",
  "toggle-bloom",
  "toggle-hzb",
  "toggle-cone",
  "toggle-rotate",
  "toggle-profiler",
]) {
  element<HTMLInputElement>(id).addEventListener("change", () => applySettings());
}
for (const id of ["render-scale", "sse-threshold", "sun-azimuth", "sun-elevation", "sun-intensity"]) {
  element<HTMLInputElement>(id).addEventListener("input", () => applySettings());
}
const debugViewSelect = element<HTMLSelectElement>("geometry-debug-view");
debugViewSelect.addEventListener("change", () => {
  const view = debugViewSelect.value as GeometryDebugView;
  if (!(view in geometryDebugRenderViews)) return;
  settings.debugView = view;
  geometryDebugHelp.textContent = geometryDebugDescriptions[view];
  applySettings();
});
element<HTMLButtonElement>("export-diagnostics").addEventListener("click", exportDiagnostics);
element<HTMLButtonElement>("run-benchmark").addEventListener("click", () => {
  void showcaseDiagnostics
    .capture({
      profile: element<HTMLSelectElement>("benchmark-profile").value as CaptureRequest["profile"],
      coverage: element<HTMLSelectElement>("benchmark-view").value as CaptureRequest["coverage"],
    })
    .catch((error) => {
      element<HTMLElement>("benchmark-state").textContent = String(error);
    });
});
element<HTMLButtonElement>("cancel-benchmark").addEventListener("click", () => {
  capture.cancel();
  capturePaused = true;
  if (captureTarget) {
    clearTimeout(captureTarget.timer);
    captureTarget.reject(new Error("Capture cancelled"));
    captureTarget = null;
  }
});
element<HTMLButtonElement>("export-benchmark").addEventListener("click", () => {
  if (capture.last) downloadJson(capture.last, "eengine-showcase-capture");
});
panelToggle.addEventListener("click", () => {
  const collapsed = panel.dataset.collapsed === "true";
  const nextCollapsed = !collapsed;
  panel.dataset.collapsed = String(nextCollapsed);
  panelToggle.dataset.open = String(!nextCollapsed);
  panelToggle.setAttribute("aria-expanded", String(!nextCollapsed));
  panelToggle.setAttribute("aria-label", nextCollapsed ? "打开调试面板" : "收起调试面板");
});
startButton.addEventListener(
  "click",
  () => {
    startButton.disabled = true;
    startButton.hidden = true;
    setLoading("初始化 WebGPU", "创建设备与渲染上下文", 0.03);
    void showcaseDiagnostics.start().catch((error) => fail(error));
  },
  { once: true },
);

function setState(message: string, status: "loading" | "ready" | "error" = "ready"): void {
  state.textContent = message;
  state.dataset.state = status;
  pathBadge.textContent = status === "error" ? "渲染错误" : message;
  pathBadge.dataset.state = status;
  if (status === "error") setLoading("加载失败", message, 0);
}

function setLoading(title: string, detail: string, progress: number): void {
  loadingTitle.textContent = title;
  loadingDetail.textContent = detail;
  const clamped = Math.max(0, Math.min(1, progress));
  loadingProgress.style.width = `${clamped * 100}%`;
  loadingPercent.textContent = `${Math.round(clamped * 100)}%`;
  loadingElapsed.textContent =
    loadStart > 0 ? `${((performance.now() - loadStart) / 1000).toFixed(1)} s` : "--";
}

function cookStageLabel(stage: string): string {
  switch (stage) {
    case "bootstrap-cook":
      return "生成首个可渲染产品";
    case "refinement":
      return "精化完整场景";
    case "cook-complete":
      return "产品烹饪完成";
    default:
      return `处理 ${stage}`;
  }
}

function cookTimingSummary(timings: Readonly<Record<string, number>>): string {
  const phases: string[] = [];
  for (const [key, label] of [
    ["catalogMs", "目录"],
    ["bootstrapCookMs", "首批产品"],
    ["activationStreamMs", "激活"],
    ["refinementMs", "精化"],
  ] as const) {
    const value = timings[key];
    if (typeof value === "number" && value > 0) phases.push(`${label} ${(value / 1000).toFixed(1)}s`);
  }
  return phases.length > 0 ? ` · ${phases.join(" · ")}` : "";
}

function applySun(): void {
  const azimuth = (settings.sunAzimuth * Math.PI) / 180;
  const elevation = (settings.sunElevation * Math.PI) / 180;
  scene.physical_environment.setSun(
    [Math.cos(elevation) * Math.cos(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.sin(azimuth)],
    baseIrradiance.map((value) => value * settings.sunIntensity) as [number, number, number],
  );
  element<HTMLOutputElement>("sun-azimuth-value").value = `${settings.sunAzimuth}°`;
  element<HTMLOutputElement>("sun-elevation-value").value = `${settings.sunElevation}°`;
  element<HTMLOutputElement>("sun-intensity-value").value = `${settings.sunIntensity.toFixed(2)}×`;
}

function applySettings(): void {
  if (capture.busy) return;
  settings.gtao = element<HTMLInputElement>("toggle-gtao").checked;
  settings.fsr3 = element<HTMLInputElement>("toggle-fsr3").checked;
  settings.bloom = element<HTMLInputElement>("toggle-bloom").checked;
  settings.hzb = element<HTMLInputElement>("toggle-hzb").checked;
  settings.cone = element<HTMLInputElement>("toggle-cone").checked;
  settings.autoRotate = element<HTMLInputElement>("toggle-rotate").checked;
  settings.profiler = element<HTMLInputElement>("toggle-profiler").checked;
  settings.renderScale = Number(element<HTMLInputElement>("render-scale").value);
  settings.sse = Number(element<HTMLInputElement>("sse-threshold").value);
  settings.sunAzimuth = Number(element<HTMLInputElement>("sun-azimuth").value);
  settings.sunElevation = Number(element<HTMLInputElement>("sun-elevation").value);
  settings.sunIntensity = Number(element<HTMLInputElement>("sun-intensity").value);
  element<HTMLOutputElement>("render-scale-value").value = `${settings.renderScale.toFixed(2)}×`;
  element<HTMLOutputElement>("sse-value").value = settings.sse.toFixed(1);
  applySun();
  if (!renderer) return;
  renderer.xe_gtao_enabled = settings.gtao;
  renderer.fsr3_enabled = settings.fsr3;
  renderer.bloom_enabled = settings.bloom;
  renderer.packed_visibility_hzb_enabled = settings.hzb;
  renderer.packed_visibility_cone_enabled = settings.cone;
  renderer.packed_visibility_sse_threshold = settings.sse;
  renderer.render_debug_view = geometryDebugRenderViews[settings.debugView];
  renderer.invalidateTemporalHistory();
  renderer.setResolutionScale(settings.renderScale);
  if (controls) controls.autoRotate = settings.autoRotate;
  if (settings.profiler) {
    renderer.profiler.configure({
      enabled: true,
      gpuSampleInterval: 1,
      gpuCounterSampleInterval: 8,
      historyCapacity: 180,
    });
    renderer.profiler.setMode("record");
    renderer.perf_gpu_counters_enabled = true;
    diagnosticState.textContent = "GPU timestamp 与 counters 采样中";
  } else {
    renderer.perf_gpu_counters_enabled = false;
    renderer.profiler.configure({ enabled: false });
    diagnosticState.textContent = "采样关闭";
  }
  resize();
}

async function start(): Promise<void> {
  if (!navigator.gpu) throw new Error("当前浏览器不支持 WebGPU");
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("无法创建 WebGPU canvas context");
  loadStart = performance.now();
  renderer = new Renderer({
    enableVsm: diagnosticVsm,
    enablePhysicalEnvironment: true,
    autoExposure: settings.autoExposure,
    fixedExposure: settings.fixedExposure,
    renderScale: 1,
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
  });
  renderer.shadowVisibilityEnabled = false;
  renderer.temporal_jitter_enabled = false;
  renderer.xe_gtao_enabled = settings.gtao;
  renderer.fsr3_enabled = settings.fsr3;
  renderer.bloom_enabled = settings.bloom;
  renderer.packed_visibility_hzb_enabled = settings.hzb;
  renderer.packed_visibility_cone_enabled = settings.cone;
  setState("初始化 WebGPU", "loading");
  setLoading("初始化 WebGPU", "创建设备与渲染上下文", 0.03);
  await renderer.initialize({ context });
  if (closed) return;
  setState("加载 Dungeon 场景", "loading");
  setLoading("加载 Dungeon 场景", "读取 GLB 目录并启动 WebCook", 0.08);
  const worker = createDefaultWebCookWorker({
    maxCanonicalInputBytes: 128 * 1024 * 1024,
    maxDecodedProductBytes: 512 * 1024 * 1024,
    runtimeProfile: "portable-single",
  });
  asset = load_gltf(modelUrl, {
    worker,
    runtimeProfile: "portable-single",
    sessionId: `next-renderer-showcase-${crypto.randomUUID()}`,
    sessionGeneration: 1,
    budgets: {
      maxConcurrentWorkers: 1,
      maxSourceBytes: 128 * 1024 * 1024,
      maxWasmBytes: 128 * 1024 * 1024,
      maxOutputBytes: 256 * 1024 * 1024,
      maxQueuedEvents: 1024,
    },
    initialOutputPageCredits: 64,
    maxBufferedPages: 64,
    maxBufferedBytes: 64 * 262144,
    onSceneCatalogReady: (catalog) => {
      framing = webCookCatalogSceneFraming(catalog, { fitHeight: 5.4, fitBase: [0, -1, 0] });
      instanceReadout.textContent = String(catalog.instances.length);
    },
    onProgress: (progress) => {
      if (closed || refinementComplete) return;
      const total = progress.catalogPrimitives;
      const count = total > 0 ? `${progress.units}/${total} 个几何单元` : "等待目录";
      const fraction = progress.fraction ?? (total > 0 ? progress.units / total : 0);
      const stageProgress =
        progress.stage === "bootstrap-cook"
          ? 0.1 + Math.min(0.35, fraction * 0.35)
          : progress.stage === "refinement"
            ? 0.45 + Math.min(0.42, fraction * 0.42)
            : progress.stage === "cook-complete"
              ? 0.9
              : 0.12;
      const elapsed = progress.elapsedMs ?? performance.now() - loadStart;
      const timing = cookTimingSummary(progress.timings);
      setState(`${cookStageLabel(progress.stage)} · ${count}`, "loading");
      setLoading(
        cookStageLabel(progress.stage),
        `${count} · ${(elapsed / 1000).toFixed(1)}s${timing}`,
        stageProgress,
      );
    },
  });
  loading = renderer.uploadWebCookedMultiProductScene(scene, asset, {
    signal: new AbortController().signal,
    fitHeight: 5.4,
    fitBase: [0, -1, 0],
  });
  handles = await loading;
  if (closed) return;
  if (!framing) throw new Error("模型目录没有提供有效边界");
  setState("首批产品已发布 · 等待场景稳定", "loading");
  setLoading("等待场景稳定", "首批产品已可用，正在等待 WebCook 精化与 GPU 资源发布", 0.55);
  camera = new PerspectiveCamera();
  camera.near = Math.max(0.01, framing.radius / 5000);
  camera.far = Math.max(100, framing.radius * 24);
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.minDistance = Math.max(0.2, framing.radius * 0.08);
  controls.maxDistance = framing.radius * 12;
  controls.autoRotate = settings.autoRotate;
  setView("overview");
  resizeObserver = new ResizeObserver(resize);
  // Renderer.resize sets inline canvas dimensions; observe the layout owner.
  resizeObserver.observe(canvas.parentElement!);
  resize();
  applySettings();
  await handles.settled();
  await diagnosticHost?.prepare?.(renderer);
  if (closed) return;
  refinementComplete = true;
  setState("场景已加载 · 等待首帧 GPU 完成", "loading");
  setLoading("准备首帧", "场景已加载，正在等待 GPU 管线编译与首帧渲染完成", 0.95);
  frameId = requestAnimationFrame(draw);
  void renderer.graphics.device.lost.then((info) => {
    if (!closed) fail(new Error(`GPU 设备丢失：${info.reason} ${info.message}`));
  });
}

function setView(preset: "overview" | "detail"): void {
  setViewDistance(preset === "overview" ? 1.75 : 0.95);
}

function setViewDistance(scale: number): void {
  if (!camera || !controls || !framing) return;
  const [x, y, z] = framing.center;
  const distance = framing.radius * scale;
  camera.transform.position.set(x + distance, y + distance * 0.55, z + distance * 1.15);
  camera.transform.lookAt({ x, y, z });
  controls.target.set(x, y, z);
  controls.reset();
  camera.update();
}

function resize(): void {
  if (!renderer || !camera) return;
  if (captureExtent) return;
  const width = Math.max(1, Math.round(canvas.parentElement!.clientWidth));
  const height = Math.max(1, Math.round(canvas.parentElement!.clientHeight));
  renderer.resize(width, height);
  camera.aspect = width / height;
  camera.update();
  resolutionReadout.textContent = `${Math.round(width * settings.renderScale)}×${Math.round(height * settings.renderScale)}`;
}

function draw(now: number): void {
  if (closed || !renderer || !camera || failed) return;
  if (capturePaused) {
    frameId = requestAnimationFrame(draw);
    return;
  }
  const delta = previousTime > 0 ? Math.min(0.1, Math.max(1 / 240, (now - previousTime) / 1000)) : 1 / 60;
  previousTime = now;
  if (!capture.busy) controls?.update(delta);
  if (capturePath) {
    const index = renderer.frame_count - capturePath.begin,
      third = Math.floor(capturePath.frames / 3);
    const angle =
      index >= third && index < 2 * third ? 0.05 * Math.sin((Math.PI * (index - third + 1)) / third) : 0;
    const [x, y, z] = capturePath.position,
      [cx, cy, cz] = capturePath.target;
    const dx = x! - cx!,
      dz = z! - cz!,
      cosine = Math.cos(angle),
      sine = Math.sin(angle);
    camera.transform.position.set(cx! + dx * cosine - dz * sine, y!, cz! + dx * sine + dz * cosine);
    camera.transform.lookAt({ x: cx!, y: cy!, z: cz! });
  }
  camera.update();
  try {
    const previousFrame = renderer.frame_count;
    const encodeStart = Date.now();
    if (!renderer.render(camera, scene, capture.busy ? 1 / 60 : delta))
      throw new Error("WebGPU 设备已失效，渲染已停止");
    if (renderer.frame_count !== previousFrame) {
      if (firstFrameCompletion === null) {
        firstFrameCompletion = renderer.device.queue
          .onSubmittedWorkDone()
          .then(() => {
            if (closed || failed) return;
            firstFrameComplete = true;
            setState(`场景已就绪 · ${Math.round(performance.now() - loadStart)} ms`, "ready");
            setLoading("场景已就绪", "首帧 GPU 渲染已完成", 1);
            loadingOverlay.dataset.visible = "false";
          })
          .catch(fail);
      }
      capture.encoded(previousFrame, encodeStart, Date.now());
      if (captureTarget && renderer.frame_count >= captureTarget.end) {
        capturePaused = true;
        clearTimeout(captureTarget.timer);
        captureTarget.resolve();
        captureTarget = null;
      }
      if (previousRenderedTime > 0) {
        const instantaneous = 1000 / Math.max(1, now - previousRenderedTime);
        fps = fps === 0 ? instantaneous : fps * 0.9 + instantaneous * 0.1;
      }
      previousRenderedTime = now;
    }
    if (now - hudUpdatedAt >= 250) {
      updateHud();
      hudUpdatedAt = now;
    }
  } catch (error) {
    fail(error);
    return;
  }
  if (capture.busy && !capturePaused) {
    // Benchmark submissions must not inherit browser presentation/occlusion pacing.
    // Renderer.render still enforces its existing completion-based frame limit.
    captureTimer = window.setTimeout(() => {
      captureTimer = null;
      draw(performance.now());
    }, 0);
  } else frameId = requestAnimationFrame(draw);
}

function updateHud(): void {
  if (!renderer) return;
  fpsReadout.textContent = `${fps.toFixed(0)} FPS`;
  instanceReadout.textContent =
    instanceReadout.textContent === "--" ? String(scene.instance_count) : instanceReadout.textContent;
  const graph = renderer.mainFrameGraphEvidence();
  const connected = graph?.program.stages.includes("surface") && graph.program.stages.includes("present");
  pathBadge.textContent = connected ? "Next · 已接通" : "等待首帧";
  pathBadge.dataset.state = connected ? "ready" : "loading";
  const streaming = renderer.geometryStreamingEvidence(scene);
  if (streaming === null) {
    streamingReadout.textContent = "--";
  } else {
    streamingReadout.textContent = `${streaming.residency.residentPages} 页 · ${streaming.scheduler.requested} 请求`;
  }
  if (!settings.profiler) return;
  const frame = renderer.profiler.latest;
  if (!frame) return;
  const completedProfiles = renderer.profiler.history.reverse();
  const gpuFrame = completedProfiles.find(
    (snapshot) => snapshot.gpu.sampled && !snapshot.gpu.pending && snapshot.gpu.segments.length > 0,
  );
  const gpu = gpuFrame?.gpu.segments.reduce((sum, segment) => sum + segment.durationMs, 0);
  cpuReadout.textContent = Number.isFinite(frame.cpuMs.frame) ? `${frame.cpuMs.frame.toFixed(2)} ms` : "--";
  gpuReadout.textContent = gpu === undefined ? "等待" : `${gpu.toFixed(2)} ms`;
  const counters = completedProfiles.find(
    (snapshot) => snapshot.gpuCounters.values.geometryVisiblePixels !== undefined,
  )?.gpuCounters.values;
  if (counters) {
    element<HTMLElement>("surface-visible-readout").textContent = `${counters.geometryVisiblePixels}`;
  }
  resolutionReadout.textContent = `${renderer.internal_resolution_scale.toFixed(2)}×`;
}

function exportDiagnostics(): void {
  const data = {
    schema: "eengine-next-showcase-v1",
    capturedAt: new Date().toISOString(),
    modelUrl,
    settings,
    adapter: renderer?.adapter_info,
    camera: camera ? { position: camera.transform.position, near: camera.near, far: camera.far } : null,
    frameCount: renderer?.frame_count ?? 0,
    diagnostics: renderer?.profiler.diagnostics ?? null,
    streaming: renderer?.geometryStreamingEvidence(scene) ?? null,
    latestProfile: renderer?.profiler.latest ?? null,
    completedGpuProfile:
      renderer?.profiler.history
        .reverse()
        .find(
          (snapshot) => snapshot.gpu.sampled && !snapshot.gpu.pending && snapshot.gpu.segments.length > 0,
        ) ?? null,
    graph: renderer?.mainFrameGraphEvidence() ?? null,
    surfaceProfile:
      renderer?.profiler.history
        .reverse()
        .find((snapshot) => snapshot.gpu.segments.some((segment) => segment.label.includes("SurfaceV4/"))) ??
      null,
  };
  downloadJson(data, "eengine-next-showcase");
}

function downloadJson(data: unknown, prefix: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${prefix}-${Date.now()}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fail(error: unknown): void {
  capture.cancel();
  if (captureTarget) {
    clearTimeout(captureTarget.timer);
    captureTarget.reject(error);
    captureTarget = null;
  }
  failed = true;
  console.error(error);
  setState(error instanceof Error ? error.message : String(error), "error");
  loadingOverlay.dataset.visible = "true";
  startButton.disabled = true;
  startButton.hidden = false;
}

async function release(): Promise<void> {
  if (closed) return;
  closed = true;
  cancelAnimationFrame(frameId);
  if (captureTimer !== null) {
    clearTimeout(captureTimer);
    captureTimer = null;
  }
  resizeObserver?.disconnect();
  controls?.dispose();
  try {
    if (loading && !handles) handles = await loading.catch(() => undefined);
    if (handles) {
      await handles.settled().catch(() => undefined);
      await handles.release();
    }
  } finally {
    asset?.dispose();
    renderer?.destroy();
    canvas.getContext("webgpu")?.unconfigure();
  }
}

applySun();
window.addEventListener(
  "pagehide",
  () => {
    void release();
  },
  { once: true },
);

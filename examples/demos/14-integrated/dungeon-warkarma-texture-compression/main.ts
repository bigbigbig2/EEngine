import {
  createDefaultWebCookWorker,
  load_gltf,
  OrbitControls,
  PerspectiveCamera,
  Renderer,
  RenderDebugView,
  type RenderDebugViewName,
  type ExposureDiagnostics,
  type PhysicalLightingDiagnostic,
  resolveWebCookRuntimeProfile,
  Scene,
  webCookCatalogSceneFraming,
  type MultiProductSceneHandles,
  type WebCookRuntimeAsset,
  type WebCookSceneCatalogSnapshot,
  type WebCookProductPublicationTiming,
} from "../../../../OEngine/src/index.ts";
import { materialTextureLeaves } from "../../../../OEngine/src/assets/PcMaterialTextures.ts";
import { ShadeTransparencyMode } from "../../../../OEngine/src/material/enums.ts";
import { summarizeGpuTimingCost } from "../../../../OEngine/src/debug/GpuTimingCost.ts";
import { geometryProductGpuBudgetEvidence } from "../../../../OEngine/src/gpu/GeometryProductGpuBudget.ts";
import {
  createElement,
  createIcons,
  ChevronRight,
  Download,
  PanelRightClose,
  PanelRightOpen,
  RotateCw,
  Scan,
  Square,
  StepForward,
} from "lucide";
import "./style.css";
import { loadCookedScene } from "./cooked-scene.ts";
import { setupVsmControls } from "./vsm-controls.ts";
import { calendarSunDirection, formatSunDay, formatSunTime, SUN_CALENDAR_YEAR } from "./sun-calendar.ts";

const MiB = 1024 ** 2;
const query = new URLSearchParams(location.search);
const fixture = false;
const cookedMode = query.get("mode") !== "raw";
const requestedGeometryMiB = Number(query.get("geometryMiB") ?? (fixture ? 128 : 1536));
const geometryCapacityBytes =
  Number.isSafeInteger(requestedGeometryMiB) && requestedGeometryMiB >= 128 && requestedGeometryMiB <= 2048
    ? requestedGeometryMiB * MiB
    : (fixture ? 128 : 1536) * MiB;
const autoExposure = query.get("exposure") === "auto";
const requestedExposure = Number(query.get("fixedExposure") ?? 5);
const fixedExposure =
  Number.isFinite(requestedExposure) && requestedExposure > 0 && requestedExposure <= 64
    ? requestedExposure
    : 5;
const exposureSettings = {
  lowPercentile: Number(query.get("exposureLow") ?? 0.6),
  highPercentile: Number(query.get("exposureHigh") ?? 0.95),
  highlightHeadroom: Number(query.get("exposureHeadroom") ?? 2),
};
let exposureDiagnostic: ExposureDiagnostics | null = null;
const sunDirection = [0.39036003, 0.8922514, 0.22306285] as const;
const sunIrradiance = [1.474, 1.8504, 1.91198] as const;
const cookedBase = new URL("./assets/playground-cooked/", location.href).href;
const sourceUrl = new URL("./assets/dungeon_warkarma.glb", location.href).href;
const scope = [
  ["Virtual Texture", "NOT IMPLEMENTED"],
  ["Texture Page Table", "NOT IMPLEMENTED"],
  ["GPU Texture Feedback", "NOT IMPLEMENTED"],
  ["Physical Texture Page Cache", "NOT IMPLEMENTED"],
  ["Mip/Page Eviction", "NOT IMPLEMENTED"],
  ["BC5 Normal", "NOT IMPLEMENTED"],
  ["BC6H Environment", "NOT IMPLEMENTED"],
  ["Spark GPU Production Encoder", "DEFERRED"],
  ["ASTC production fallback", "NOT TARGET"],
  ["ETC2 production fallback", "NOT TARGET"],
  ["RGBA material fallback", "REMOVED BY DESIGN"],
  ["Full BLEND transparency path", "NOT COMPLETE"],
];
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = element<HTMLCanvasElement>("viewport");
const scene = new Scene();
const camera = new PerspectiveCamera();
const abort = new AbortController();
const started = performance.now();
const phases: Array<{ phase: string; atMs: number }> = [];
const publications: WebCookProductPublicationTiming[] = [];
const cpu = { normal: [] as number[], profiled: [] as number[] };
const intervals: number[] = [];
const callbacks: Array<{ atMs: number; submitted: boolean; source: "raf" | "ready"; frameIndex: number; cpuMs: number }> = [];
let resumeFrame: (() => void) | undefined;
let lastSubmittedAt: number | null = null;
let renderer: Renderer | undefined;
let asset: WebCookRuntimeAsset | undefined;
let handles: Pick<MultiProductSceneHandles, "settled"> | undefined;
let loading: Promise<Pick<MultiProductSceneHandles, "settled">> | undefined;
let cooked: Awaited<ReturnType<typeof loadCookedScene>> | undefined;
let controls: OrbitControls | undefined;
let framing: Pick<ReturnType<typeof webCookCatalogSceneFraming>, "center" | "radius"> | undefined;
let catalog: WebCookSceneCatalogSnapshot | undefined;
let resizeObserver: ResizeObserver | undefined;
let phase = "Initializing WebGPU";
let failure: { phase: string; atMs: number; message: string; stack?: string } | null = null;
let closing = false;
let settled = false;
let profiled = false;
let sourceBytes = 0;
let firstUsefulMs: number | null = null;
let fullQualityMs: number | null = null;
let fullFrame = Infinity;
let stableFrames = 0;
let completionPending = false;
let frameId = 0;
let refreshId = 0;
let teardown: unknown = null;
let progressTimings: Readonly<Record<string, number>> | null = null;
let lastSnapshot: ReturnType<typeof snapshot> | undefined;
let paused = false;
let stepFrames = 0;
let sampleResetFrame = 0;
let geometryActivity = "PENDING";
let geometryDelta = { uploadedBytes: 0, evicted: 0, reloads: 0 };
let lastGeometrySample: { uploaded: number; evicted: number; reloads: number } | undefined;

function resetFrameSamples(): void {
  cpu.normal.length = 0;
  cpu.profiled.length = 0;
  intervals.length = 0;
  callbacks.length = 0;
  lastSubmittedAt = null;
  stableFrames = 0;
  sampleResetFrame = renderer?.frame_count ?? 0;
}

function setPhase(value: string): void {
  if (closing || phase === value) return;
  phase = value;
  phases.push({ phase: value, atMs: performance.now() - started });
  element("phase").textContent = value;
}

function percentile(values: readonly number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1]!,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
  };
}

function append(values: number[], value: number): void {
  values.push(value);
  if (values.length > 600) values.shift();
}

function snapshot() {
  const runtime = renderer?.graphics?.render_world.runtime(scene);
  const texture = renderer?.graphics?.texture_residency_if_created?.evidence() ?? null;
  const leaves = [...new Set(runtime?.materials.flatMap((m) => [...materialTextureLeaves(m)]) ?? [])];
  const products = new Map(leaves.map((t) => [t.texture_product?.identity, t.texture_product]));
  const masks =
    runtime?.materials.filter((m) => m.transparency_mode === ShadeTransparencyMode.AlphaTested) ?? [];
  const quality = {
    productCount: [...products.values()].filter(Boolean).length,
    textureLeafCount: leaves.length,
    allLeavesHaveSchema3: leaves.every((t) => t.texture_product?.metadata.schemaVersion === 3),
    allFullMips: leaves.every((t) => {
      const m = t.texture_product?.metadata;
      return (
        !!m &&
        m.planes.every(
          (p) => p.mips.length === Math.floor(Math.log2(Math.max(m.storageWidth, m.storageHeight))) + 1,
        )
      );
    }),
    transferFunctions: leaves.every((t) => {
      const m = t.texture_product?.metadata;
      if (!m) return false;
      const srgb = m.semantic === "base-color-srgb" || m.semantic === "emissive-srgb";
      const expected = srgb
        ? "bc7-rgba-unorm-srgb"
        : m.semantic === "occlusion-linear"
          ? "bc4-r-unorm"
          : m.semantic === "alpha-mask"
            ? "r8unorm"
            : "bc7-rgba-unorm";
      return m.planes[0]?.format === expected;
    }),
    maskMaterials: masks.length,
    exactMaskCoverage: masks.every(
      (m) =>
        m.texture_albedo?.texture_product?.metadata.exactAlpha &&
        m.texture_albedo.texture_product.metadata.planes.some(
          (p) => p.role === "coverage" && p.format === "r8unorm",
        ),
    ),
    nativeMaterialPublication: !!runtime?.nativeMaterials,
    sourceMaterialLimitation: "Known source-material conversion limitation",
    webCookSpecularSupport: cookedMode
      ? "Not used: cooked materials use parseGltfMaterial"
      : "NOT MAPPED: specular factors/color/maps are omitted by current WebCook mapper",
    gltfMaterialParserSpecularSupport:
      "Factors saturated to [0,1]; scalar alpha + sRGB RGB textures + UV transforms supported",
    visualChecks: "NOT YET VERIFIED: base color, normal detail, MASK vegetation, VSM, mips",
  };
  const gpu: number[] = [],
    surface: number[] = [];
  for (const p of renderer?.profiler.history ?? []) {
    if (
      p.frameIndex < Math.max(fullFrame, sampleResetFrame) + 60 ||
      !p.gpu.sampled ||
      p.gpu.pending ||
      p.gpu.mode !== "full" ||
      p.counters["gpu.timing.truncated"]
    )
      continue;
    const cost = summarizeGpuTimingCost(p.gpu.segments);
    if (cost.commandSpanMs !== null) gpu.push(cost.commandSpanMs);
    if (cost.surfacePassSumMs !== null) surface.push(cost.surfacePassSumMs);
  }
  const distribution = texture?.formatDistribution ?? [];
  const count = (format: string) =>
    distribution
      .filter((v) => v.format.startsWith(format))
      .reduce((sum, v) => sum + v.residentTextureCount, 0);
  const neutralBytes =
    texture?.packageSegments.reduce((sum, s) => sum + s.allocatedBytes / s.allocatedCapacity, 0) ?? 0;
  const freeBytes =
    texture?.packageSegments.reduce(
      (sum, s) => sum + (s.freeLayerCount * s.allocatedBytes) / s.allocatedCapacity,
      0,
    ) ?? 0;
  const streaming = renderer?.geometryStreamingEvidence(scene) ?? null;
  const sampleElapsedMs = callbacks.length > 1 ? callbacks.at(-1)!.atMs - callbacks[0]!.atMs : 0;
  const sampledCallbacks = callbacks.slice(1);
  const rafCallbacks = callbacks.filter((sample) => sample.source === "raf");
  const submittedCallbacks = sampledCallbacks.reduce((sum, sample) => sum + Number(sample.submitted), 0);
  const submission = renderer?.frameSubmissionEvidence() ?? null;
  const completion = { normal: [] as number[], profiled: [] as number[] };
  for (const sample of submission?.completionSamples ?? []) {
    if (sample.frameIndex >= Math.max(fullFrame, sampleResetFrame) + 60) {
      completion[sample.profiled ? "profiled" : "normal"].push(sample.elapsedMs);
    }
  }
  const geometryPages =
    streaming?.products.reduce(
      (sum, product) => ({
        resident: sum.resident + product.residentPages,
        pinned: sum.pinned + product.pinnedPages,
        retiring: sum.retiring + product.retiringPages,
        residentBytes: sum.residentBytes + product.residentBytes,
        uploadedBytes: sum.uploadedBytes + product.uploadedBytes,
        evicted: sum.evicted + product.evictedPages,
        reloads: sum.reloads + product.reloads,
        thrashBytes: sum.thrashBytes + product.thrashBytes,
        failed: sum.failed + product.failedPages,
      }),
      {
        resident: 0,
        pinned: 0,
        retiring: 0,
        residentBytes: 0,
        uploadedBytes: 0,
        evicted: 0,
        reloads: 0,
        thrashBytes: 0,
        failed: 0,
      },
    ) ?? null;
  return {
    schema: "dungeon-warkarma-texture-compression-demo-v1",
    fixture,
    mode: cookedMode ? "Cooked" : "Raw",
    offlineCook: cooked?.manifest.evidence ?? null,
    playground: cooked?.manifest.playground ?? null,
    sourceUrl: cookedMode ? cookedBase : sourceUrl,
    baseline: "RTX 2060 8GB / Windows / Chrome WebGPU (user supplied)",
    adapter: renderer?.adapter_info ?? null,
    browser: navigator.userAgent,
    driverActualVram: "UNKNOWN",
    phase,
    failure,
    elapsedMs: performance.now() - started,
    phases,
    asset: cooked?.manifest.source ?? {
      bytes: sourceBytes,
      triangles:
        catalog?.primitives.reduce((sum, p) => sum + p.triangleCount * p.instanceNodeIndices.length, 0) ??
        null,
      primitives: catalog?.primitiveCount ?? null,
      meshes: catalog ? new Set(catalog.instances.map((n) => n.meshIndex)).size : null,
      materials: catalog ? new Set(catalog.primitives.map((p) => p.materialIndex)).size : null,
      textures: catalog?.textures.length ?? null,
      images: catalog?.images.length ?? null,
      transferMode: catalog?.sourceTransferMode ?? null,
    },
    texture,
    formats: { bc7: count("bc7"), bc4: count("bc4"), r8Coverage: count("r8unorm") },
    overhead: {
      neutralBytes,
      freeBytes,
      allocationMinusLiveBytes: texture ? texture.allocatedBytes - texture.residentTextureBytes : null,
    },
    preparation: renderer?.texturePreparationEvidence() ?? null,
    upload: texture
      ? {
          tailBytes: texture.uploadBytes - texture.progressiveMipUploadBytes,
          promotionBytes: texture.progressiveMipUploadBytes,
          totalBytes: texture.uploadBytes,
          promotionCount: texture.mipPromotionCount,
        }
      : null,
    load: {
      firstUsefulMs,
      fullQualityMs,
      fullGeometrySettled: settled,
      glbReadMs: null,
      gltfParseMs: null,
      note: cookedMode
        ? "Offline material catalog + OEGPACK ranges + validated TextureProducts; original GLB is not fetched"
        : "Range catalog read+parse are combined in producer catalogMs; no whole 1GB ArrayBuffer read",
      timings: progressTimings,
      publications,
    },
    stable: {
      normal: { cpuFrameMs: percentile(cpu.normal), gpuFrameMs: null, surfaceMs: null },
      profiled: {
        cpuFrameMs: percentile(cpu.profiled),
        gpuCommandSpanMs: percentile(gpu),
        surfacePassSumMs: percentile(surface),
      },
      rafIntervalMs: percentile(
        rafCallbacks.slice(1).map((sample, index) => sample.atMs - rafCallbacks[index]!.atMs),
      ),
      submittedIntervalMs: percentile(intervals),
      submissions: {
        sampleElapsedMs,
        callbacks: sampledCallbacks.length,
        rafCallbacks: sampledCallbacks.filter((sample) => sample.source === "raf").length,
        readyCallbacks: sampledCallbacks.filter((sample) => sample.source === "ready").length,
        submitted: submittedCallbacks,
        deferred: sampledCallbacks.length - submittedCallbacks,
        framesPerSecond: sampleElapsedMs > 0 ? (submittedCallbacks * 1000) / sampleElapsedMs : null,
        callbacksPerSecond: sampleElapsedMs > 0 ? (sampledCallbacks.length * 1000) / sampleElapsedMs : null,
        presentedFramesPerSecond: null,
      },
      completionLatencyMs: {
        normal: percentile(completion.normal),
        profiled: percentile(completion.profiled),
      },
      submission,
      warmupFrames: 60,
      visibility: document.visibilityState,
    },
    quality,
    memory: renderer?.graphics ? renderer.memoryEvidence() : null,
    resourceAccounting: renderer?.graphics?.resource_accounting.snapshot() ?? null,
    geometry: renderer?.device ? geometryProductGpuBudgetEvidence(renderer.device) : null,
    geometryRequestedCapacityBytes: geometryCapacityBytes,
    streaming,
    geometryPages,
    renderState: {
      frame: renderer?.frame_count ?? 0,
      paused,
      view: renderer?.render_debug_view ?? "none",
      vsm: renderer?.shadowVisibilityEnabled ?? false,
      vsmSettings: renderer?.vsmSettings ?? null,
      gtao: renderer?.xe_gtao_enabled ?? false,
      fsr3: renderer?.fsr3_enabled ?? false,
      bloom: renderer?.bloom_enabled ?? false,
      jitter: renderer?.temporalJitterActive ?? false,
      hzb: renderer?.packed_visibility_hzb_enabled ?? false,
      cone: renderer?.packed_visibility_cone_enabled ?? false,
      sse: renderer?.packed_visibility_sse_threshold ?? null,
      renderScale: renderer?.internal_resolution_scale ?? null,
      controls: controls
        ? {
            damping: controls.enableDamping,
            dampingFactor: controls.dampingFactor,
            rotateSpeed: controls.rotateSpeed,
          }
        : null,
      temporal: renderer?.temporalHistoryEvidence() ?? null,
      resolution: renderer?.resolutionEvidence() ?? null,
      exposure: {
        autoExposure,
        fixedExposure,
        settings: exposureSettings,
        lastRequestedGpuSample: exposureDiagnostic,
      },
      environment: scene.physical_environment.snapshot(),
      sunCalendar: {
        enabled: element<HTMLInputElement>("sun-calendar").checked,
        year: SUN_CALENDAR_YEAR,
        ...readSunCalendar(),
      },
      authoredLights: 0,
      authoredHdr: false,
      ssr: "NOT WIRED IN CURRENT FRAME PROGRAM",
      screenSpaceGi: "NOT WIRED IN CURRENT FRAME PROGRAM",
      stages: renderer?.mainFrameGraphEvidence()?.program.stages ?? [],
      camera: {
        position: [camera.transform.position.x, camera.transform.position.y, camera.transform.position.z],
        near: camera.near,
        far: camera.far,
        fov: camera.fov_degrees,
        target: controls ? [controls.target.x, controls.target.y, controls.target.z] : null,
      },
      geometryActivity,
      geometryDelta,
      streamingError:
        renderer?.geometryStreamingError() ?? streaming?.lastError ?? streaming?.scheduler.lastError ?? null,
      visualStability: "NOT VERIFIED: full texture mips do not establish geometry or lighting stability",
    },
    diagnostics: renderer?.profiler.diagnostics ?? null,
    scope,
    teardown,
    acceptance: fixture
      ? "SMOKE FIXTURE ONLY"
      : "NOT PASS: geometry/exposure stability and visual texture/MASK/VSM acceptance unresolved",
  };
}

const rows: Array<[string, string]> = [
  ["Hardware", ""],
  ["Adapter", "adapter"],
  ["Baseline", "baseline"],
  ["Driver actual VRAM", "driver"],
  ["Scene", ""],
  ["Triangles", "triangles"],
  ["Primitives / materials", "scene"],
  ["Source images", "images"],
  ["Texture", ""],
  ["Cooked tasks", "tasks"],
  ["TextureProducts", "products"],
  ["BC7 / BC4 / R8", "formats"],
  ["Live bytes", "live"],
  ["Allocated bytes", "allocated"],
  ["Peak bytes", "peak"],
  ["Retiring bytes", "retiring"],
  ["Pending / in-flight", "pending"],
  ["Segments", "segments"],
  ["Neutral / free bytes", "overhead"],
  ["Current min mip (max)", "mip"],
  ["Upload", ""],
  ["Tail bytes", "tail"],
  ["Promotion bytes", "promotion"],
  ["Load / frame", ""],
  ["Raw preparation", "preparation"],
  ["First useful", "first"],
  ["Full texture mips", "full"],
  ["Submitted FPS / interval P50", "fps"],
  ["RAF / ready / deferred", "callbacks"],
  ["Normal CPU P50/P95", "cpu"],
  ["Profiled CPU P50/P95", "profiledCpu"],
  ["Normal submit/completion P50/P95", "completion"],
  ["Profiled submit/completion P50/P95", "profiledCompletion"],
  ["In-flight / limit", "inFlight"],
  ["Completion / publication deferrals", "deferrals"],
  ["Profiled GPU P50/P95", "gpu"],
  ["Profiled Surface P50/P95", "surface"],
  ["Total software bytes", "total"],
];
const cells = new Map<string, HTMLElement>();
for (const [label, key] of rows) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  element("metrics").append(dt);
  if (!key) {
    dt.className = "group";
    continue;
  }
  const dd = document.createElement("dd");
  dd.textContent = "UNKNOWN";
  cells.set(key, dd);
  element("metrics").append(dd);
}
const renderCells = new Map<string, HTMLElement>();
for (const [key, label] of [
  ["effects", "Active effects"],
  ["exposure", "Exposure"],
  ["geometryActivity", "Geometry activity"],
  ["geometryDelta", "Last 0.5 s upload / evict / reload"],
  ["pages", "Resident / pinned pages"],
  ["geometryBytes", "Resident geometry bytes"],
  ["geometryCapacity", "Shared heap / metadata"],
  ["geometryRequested", "Requested geometry capacity"],
  ["io", "Pending / in-flight"],
  ["evictions", "Evictions / reloads"],
  ["thrash", "Short-term thrash bytes"],
  ["blocked", "Blocked uploads"],
  ["overflow", "Demand / readback overflow"],
  ["geometryErrors", "Failed / stream error"],
  ["frame", "Submitted frame"],
  ["temporal", "FSR3 generation / color resets"],
  ["resolution", "Internal / output"],
  ["jitter", "Raster / FSR jitter (pixels)"],
  ["clip", "Camera near / far"],
  ["stages", "Frame stages"],
]) {
  const dt = document.createElement("dt"),
    dd = document.createElement("dd");
  dt.textContent = label!;
  dd.textContent = "PENDING";
  renderCells.set(key!, dd);
  element("render-state").append(dt, dd);
}
for (const [label, value] of scope) {
  const dt = document.createElement("dt"),
    dd = document.createElement("dd");
  dt.textContent = label!;
  dd.textContent = value!;
  element("scope").append(dt, dd);
}
const bytes = (n?: number | null) =>
  n === undefined || n === null ? "UNKNOWN" : `${(n / MiB).toFixed(2)} MiB`;
const time = (n?: number | null) =>
  n === undefined || n === null ? "PENDING" : `${(n / 1000).toFixed(1)} s`;
const pair = (p: ReturnType<typeof percentile>) =>
  p ? `${p.p50.toFixed(2)} / ${p.p95.toFixed(2)} ms` : "UNKNOWN";

function refresh(): void {
  if (closing || !renderer) return;
  const s = snapshot();
  lastSnapshot = s;
  const t = s.texture,
    p = s.preparation;
  const g = s.geometryPages,
    scheduler = s.streaming?.scheduler;
  if (g) {
    geometryDelta = lastGeometrySample
      ? {
          uploadedBytes: g.uploadedBytes - lastGeometrySample.uploaded,
          evicted: g.evicted - lastGeometrySample.evicted,
          reloads: g.reloads - lastGeometrySample.reloads,
        }
      : { uploadedBytes: 0, evicted: 0, reloads: 0 };
    const changed =
      lastGeometrySample &&
      (g.uploadedBytes !== lastGeometrySample.uploaded ||
        g.evicted !== lastGeometrySample.evicted ||
        g.reloads !== lastGeometrySample.reloads);
    geometryActivity =
      s.renderState.streamingError || g.failed || scheduler?.failed
        ? "ERROR"
        : paused
          ? "RENDER PAUSED"
          : changed
            ? geometryDelta.evicted || geometryDelta.reloads
              ? "EVICTING / RELOADING"
              : "PAGES CHANGING"
            : scheduler?.pending || scheduler?.inFlightBytes
              ? "IO / DEMAND PENDING"
              : "NO PAGE CHANGE IN LAST 0.5 s";
    lastGeometrySample = { uploaded: g.uploadedBytes, evicted: g.evicted, reloads: g.reloads };
  }
  const state = s.renderState;
  element("quick-fps").textContent = s.stable.submissions.framesPerSecond?.toFixed(1) ?? "--";
  const activeCpu = profiled ? s.stable.profiled.cpuFrameMs : s.stable.normal.cpuFrameMs;
  element("quick-cpu").textContent = activeCpu ? `${activeCpu.p50.toFixed(1)} ms` : "--";
  element("quick-gpu").textContent =
    profiled && s.stable.profiled.gpuCommandSpanMs
      ? `${s.stable.profiled.gpuCommandSpanMs.p50.toFixed(1)} ms`
      : "--";
  element("fsr3-generation").textContent = String(state.temporal?.fsr3Generation ?? 0);
  const vsm = renderer.vsmCapabilities;
  for (const [key, value] of Object.entries({
    profile: vsm?.profile ?? "Unavailable",
    atlas: vsm ? `${vsm.atlasDimension} x ${vsm.atlasDimension}` : "--",
    clips: String(vsm?.clipLevels ?? 0),
    page: vsm ? `${vsm.pageSize} px + ${vsm.border} px border` : "--",
    slots: String(vsm?.residentSlots ?? 0),
    taps: String(vsm?.pcfTapCount ?? 0),
  }))
    vsmCells.get(key)!.textContent = value;
  const renderValues: Record<string, string> = {
    effects: [
      state.vsm && "VSM",
      state.gtao && "GTAO",
      state.fsr3 && "FSR3",
      state.bloom && "Bloom",
      state.jitter && "Jitter",
      "Sun / Sky / IBL / Atmosphere",
    ]
      .filter(Boolean)
      .join("\n"),
    exposure: autoExposure ? "AUTO (GPU metering)" : `FIXED ${fixedExposure}`,
    geometryActivity,
    geometryDelta: `${bytes(geometryDelta.uploadedBytes)} / ${geometryDelta.evicted} / ${geometryDelta.reloads}`,
    pages: g ? `${g.resident} / ${g.pinned}` : "PENDING",
    geometryBytes: bytes(g?.residentBytes),
    geometryCapacity: `${bytes(s.geometry?.allocatedBytes)} / ${bytes(s.geometry?.metadataBytes)}`,
    geometryRequested: bytes(s.geometryRequestedCapacityBytes),
    io: `${scheduler?.pending ?? 0} / ${bytes(scheduler?.inFlightBytes)}`,
    evictions: `${g?.evicted ?? 0} / ${g?.reloads ?? 0}`,
    thrash: bytes(g?.thrashBytes),
    blocked: String(scheduler?.blockedUploads ?? 0),
    overflow: `${scheduler?.demandOverflow ?? 0} / ${s.streaming?.readback.overflow ?? 0}`,
    geometryErrors: `${(g?.failed ?? 0) + (scheduler?.failed ?? 0)} / ${state.streamingError ?? "none"}`,
    frame: String(state.frame),
    temporal: `${state.temporal?.fsr3Generation ?? 0} / ${state.temporal?.color.invalidationCount ?? 0} (${state.temporal?.color.lastInvalidationReason ?? "none"})`,
    resolution: `${state.resolution?.internal.join(" × ")} → ${state.resolution?.output.join(" × ")}\nCSS ${state.resolution?.css.join(" × ")} / DPR ${state.resolution?.pixelRatio}`,
    jitter: `${state.temporal?.jitter?.committed.map((value) => value.toFixed(3)).join(", ")}\nphase ${state.temporal?.phaseIndex} / ${state.temporal?.jitter?.phaseCount}`,
    clip: `${camera.near.toFixed(3)} / ${camera.far.toFixed(1)}`,
    stages: state.stages.join("\n"),
  };
  for (const [key, value] of Object.entries(renderValues)) renderCells.get(key)!.textContent = value;
  if (p?.activeBatches) setPhase(`Preparing BC Texture Products (${p.cookedTasks} cooked)`);
  else if (!settled && publications.length) setPhase("Mapping / publishing GPU Render World");
  else if (settled && fullQualityMs === null) setPhase("Full mip promotion");
  const raf = s.stable.submittedIntervalMs;
  const values: Record<string, string> = {
    adapter:
      [s.adapter?.description, s.adapter?.device, s.adapter?.vendor, s.adapter?.architecture]
        .filter(Boolean)
        .join(" ") || "UNKNOWN",
    baseline: "RTX 2060 8GB",
    driver: "UNKNOWN",
    triangles: s.asset.triangles?.toLocaleString() ?? "UNKNOWN",
    scene: `${s.asset.primitives ?? "?"} / ${s.asset.materials ?? "?"}`,
    images: String(s.asset.images ?? "UNKNOWN"),
    tasks: String(p?.cookedTasks ?? 0),
    products: String(s.quality.productCount),
    formats: `${s.formats.bc7} / ${s.formats.bc4} / ${s.formats.r8Coverage}`,
    live: bytes(t?.residentTextureBytes),
    allocated: bytes(t?.allocatedBytes),
    peak: bytes(t?.allocatedPeakBytes),
    retiring: bytes(t?.retiringTextureBytes),
    pending: `${t?.pendingTextureCount ?? 0} / ${t?.pendingPromotionTextureCount ?? 0} textures`,
    segments: String(t?.segmentCount ?? 0),
    overhead: `${bytes(s.overhead.neutralBytes)} / ${bytes(s.overhead.freeBytes)}`,
    mip: String(t?.maximumResidentMinimumMip ?? "UNKNOWN"),
    tail: bytes(s.upload?.tailBytes),
    promotion: bytes(s.upload?.promotionBytes),
    preparation: time((p?.wallMs ?? 0) + (p?.activeElapsedMs ?? 0)),
    first: time(firstUsefulMs),
    full: time(fullQualityMs),
    fps:
      raf && s.stable.submissions.framesPerSecond !== null
        ? `${s.stable.submissions.framesPerSecond.toFixed(1)} / ${raf.p50.toFixed(2)} ms`
        : "PENDING",
    callbacks: `${s.stable.submissions.rafCallbacks} / ${s.stable.submissions.readyCallbacks} / ${s.stable.submissions.deferred}`,
    cpu: pair(s.stable.normal.cpuFrameMs),
    profiledCpu: pair(s.stable.profiled.cpuFrameMs),
    completion: pair(s.stable.completionLatencyMs.normal),
    profiledCompletion: pair(s.stable.completionLatencyMs.profiled),
    inFlight: `${s.stable.submission?.inFlight ?? 0} / ${s.stable.submission?.inFlightLimit ?? 0}`,
    deferrals: `${s.stable.submission?.completionDeferredTicks ?? 0} / ${s.stable.submission?.publicationDeferredTicks ?? 0}`,
    gpu: pair(s.stable.profiled.gpuCommandSpanMs),
    surface: pair(s.stable.profiled.surfacePassSumMs),
    total: bytes(s.memory?.allocatedBytes),
  };
  for (const [key, value] of Object.entries(values)) cells.get(key)!.textContent = value;
  element("elapsed").textContent = time(performance.now() - started);
}

async function start(): Promise<void> {
  if (fixture) document.querySelector("h1")!.textContent = "Texture Compression Smoke Fixture";
  if (!navigator.gpu) throw new Error("WebGPU is unavailable");
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("WebGPU canvas context is unavailable");
  element("mode-name").textContent = cookedMode ? "Cooked" : "Raw";
  const alternateMode = new URL(location.href);
  alternateMode.searchParams.set("mode", cookedMode ? "raw" : "cooked");
  element<HTMLAnchorElement>("mode-switch").href = alternateMode.href;
  element("mode-switch").textContent = cookedMode ? "Raw" : "Cooked";
  element("importer-note").textContent = cookedMode
    ? "glTF material importer: KHR_materials_specular factors/maps supported."
    : "Raw mode loads the original Dungeon model without the playground.";
  if (!cookedMode) {
    const head = await fetch(sourceUrl, { method: "HEAD", signal: abort.signal });
    if (!head.ok) throw new Error(`Local GLB unavailable: HTTP ${head.status}`);
    sourceBytes = Number(head.headers.get("content-length"));
  }
  renderer = new Renderer({
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    enableVsm: true,
    enablePhysicalEnvironment: true,
    autoExposure,
    fixedExposure,
    exposure: exposureSettings,
    renderScale: 1,
  });
  await renderer.initialize({ context });
  if (closing) return;
  vsmControls.sync();
  // Apply the initial effect switches; VSM starts enabled in this demo.
  for (const [id, set] of effectSwitches) set(renderer, element<HTMLInputElement>(id).checked);
  renderer.profiler.configure({ enabled: false });
  applySunControls();
  scene.physical_environment.setSkyLuminanceScale(Number(element<HTMLInputElement>("sky").value));
  setPhase("Reading / parsing GLB range catalog");
  refreshId = window.setInterval(refresh, 500);
  if (cookedMode) {
    loading = loadCookedScene(
      renderer,
      scene,
      cookedBase,
      abort.signal,
      setPhase,
      geometryCapacityBytes,
    ).then((value) => {
      cooked = value;
      sourceBytes = value.manifest.source.bytes;
      framing = value.framing;
      return value;
    });
  } else {
    const profile = resolveWebCookRuntimeProfile("auto");
    const workers = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1));
    asset = load_gltf(sourceUrl, {
      worker: createDefaultWebCookWorker({
        runtimeProfile: profile.selected,
        maxWorkers: workers,
        maxSourceWindowBytes: 64 * MiB,
        maxCanonicalInputBytes: 32 * MiB,
        maxDecodedProductBytes: 128 * MiB,
        maxSessionSpillBytes: 2048 * MiB,
        maxTrianglesPerProduct: 128 * 1024,
        maxVerticesPerProduct: 512 * 1024,
        maxDomainsPerProduct: 64,
      }),
      runtimeProfile: profile.selected,
      budgets: {
        maxConcurrentWorkers: workers,
        maxSourceBytes: 128 * MiB,
        maxWasmBytes: 512 * MiB,
        maxOutputBytes: 256 * MiB,
        maxQueuedEvents: 2048,
      },
      initialOutputPageCredits: 512,
      maxBufferedPages: 512,
      maxBufferedBytes: 128 * MiB,
      onSceneCatalogReady: (value) => {
        catalog = value;
        framing = webCookCatalogSceneFraming(value);
        if (webCookCatalogSceneFraming(value).unknownBoundPrimitives)
          throw new Error("Cannot frame the complete source catalog");
        setPhase("Mapping scene/materials / preparing Geometry Products");
      },
      onProgress: (value) => {
        progressTimings = value.timings;
      },
    });
    loading = renderer.uploadWebCookedMultiProductScene(scene, asset, {
      signal: abort.signal,
      multiProductMetadataBytes: 128 * MiB,
      residency: {
        requestedProfile: "HighEnd",
        configuredCapacityBytes: geometryCapacityBytes,
        configuredBankBytes: geometryCapacityBytes / 4,
      },
      onMaterials: () => setPhase("Preparing BC Texture Products"),
      onProductPublicationTiming: (value) => {
        publications.push(value);
        setPhase("Tail texture residency ready");
      },
    });
  }
  handles = await loading;
  if (closing) return;
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  diagnosticControlsDisabled(false);
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas.parentElement!);
  resize();
  frameScene();
  if (query.get("performanceCapture") === "1" && query.has("performanceCamera")) {
    const values = query.get("performanceCamera")!.split(",").map(Number);
    if (values.length !== 6 || !values.every(Number.isFinite)) throw new RangeError("Invalid diagnostic camera");
    camera.transform.position.set(values[0]!, values[1]!, values[2]!);
    controls.target.set(values[3]!, values[4]!, values[5]!);
    controls.reset();
    camera.transform.lookAt({ x: values[3]!, y: values[4]!, z: values[5]! });
    camera.update();
    renderer.invalidateTemporalHistory();
  }
  let previous = performance.now();
  const draw = (now: number, source: "raf" | "ready") => {
    if (closing || !renderer) return;
    try {
      const interval = now - previous;
      previous = now;
      if (paused && stepFrames === 0) {
        return;
      }
      const begin = performance.now();
      controls?.update(Math.min(0.1, interval / 1000));
      camera.update();
      const beforeFrame = renderer.frame_count;
      renderer.render(camera, scene, Math.min(0.1, interval / 1000));
      const submitted = renderer.frame_count > beforeFrame;
      if (paused && submitted) stepFrames--;
      const duration = performance.now() - begin;
      if (submitted && fullQualityMs !== null) stableFrames++;
      if (!paused && fullQualityMs !== null && stableFrames > 60 && document.visibilityState === "visible") {
        callbacks.push({ atMs: now, submitted, source, frameIndex: renderer.frame_count - 1, cpuMs: duration });
        if (callbacks.length > (query.get("performanceCapture") === "1" ? 8000 : 600)) callbacks.shift();
        if (submitted) {
          append(cpu[profiled ? "profiled" : "normal"], duration);
          if (lastSubmittedAt !== null) append(intervals, now - lastSubmittedAt);
          lastSubmittedAt = now;
        }
      } else {
        lastSubmittedAt = null;
      }
      if (
        submitted &&
        !completionPending &&
        (firstUsefulMs === null || (settled && fullQualityMs === null))
      ) {
        completionPending = true;
        void renderer.device.queue
          .onSubmittedWorkDone()
          .then(() => {
            if (closing) return;
            if (firstUsefulMs === null) {
              firstUsefulMs = performance.now() - started;
              setPhase("First useful frame");
            }
            const evidence = renderer!.graphics.texture_residency_if_created?.evidence();
            if (
              settled &&
              evidence &&
              evidence.maximumResidentMinimumMip === 0 &&
              !evidence.pendingPromotionTextureCount
            ) {
              fullQualityMs = performance.now() - started;
              fullFrame = renderer!.frame_count;
              setPhase("Full texture mips ready / geometry streaming active");
            }
            completionPending = false;
          })
          .catch(fail);
      }
      if (renderer.profiler.diagnostics.deviceLostCount) throw new Error("WebGPU device lost");
    } catch (error) {
      fail(error);
    }
  };
  const frame = () => {
    draw(performance.now(), "raf");
    if (!closing) frameId = requestAnimationFrame(frame);
  };
  resumeFrame = () => {
    if (!closing && document.visibilityState === "visible") draw(performance.now(), "ready");
  };
  renderer.onFrameAvailable.add(resumeFrame);
  frameId = requestAnimationFrame(frame);
  await handles.settled();
  settled = true;
  if (!closing) {
    setPhase("Full mip promotion");
    refresh();
  }
}

function resize(): void {
  if (!renderer) return;
  const bounds = canvas.parentElement!.getBoundingClientRect();
  renderer.resize(Math.max(1, Math.round(bounds.width)), Math.max(1, Math.round(bounds.height)));
  camera.aspect = renderer.aspect_ratio;
  camera.update();
}

function frameScene(): void {
  if (!framing || !controls || !renderer) return;
  const c = framing.center,
    r = framing.radius;
  camera.fov_degrees = 60;
  element<HTMLInputElement>("fov").value = "60";
  element("fov-value").textContent = "60 deg";
  camera.near = Math.max(0.01, r / 5000);
  camera.far = r * 20;
  const halfFov = Math.atan(Math.tan(Math.PI / 6) * Math.min(1, camera.aspect));
  const distance = (r / Math.sin(halfFov)) * 1.12;
  camera.transform.position.set(
    c[0] + distance * 0.6,
    c[1] + distance * 0.5,
    c[2] + distance * Math.sqrt(0.39),
  );
  camera.transform.lookAt({ x: c[0], y: c[1], z: c[2] });
  controls.target.set(c[0], c[1], c[2]);
  controls.minDistance = r / 1000;
  controls.maxDistance = r * 15;
  controls.reset();
  camera.update();
  renderer.invalidateTemporalHistory();
}

function fail(error: unknown): void {
  if (closing) return;
  failure = {
    phase,
    atMs: performance.now() - started,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
  element("error").textContent = `${failure.phase}: ${failure.message}`;
  console.error(error);
  refresh();
  void release().catch((cleanupError) => {
    element("error").textContent += `\nRelease: ${String(cleanupError)}`;
  });
}

async function release(): Promise<void> {
  if (closing) return;
  lastSnapshot = renderer ? snapshot() : undefined;
  closing = true;
  exposureDiagnostic = null;
  element("exposure-diagnostic").textContent = "Renderer released; previous exposure sample is stale";
  if (resumeFrame) renderer?.onFrameAvailable.remove(resumeFrame);
  resumeFrame = undefined;
  diagnosticControlsDisabled(true);
  cancelAnimationFrame(frameId);
  clearInterval(refreshId);
  resizeObserver?.disconnect();
  controls?.dispose();
  abort.abort(new Error("Demo released"));
  element<HTMLButtonElement>("release").disabled = true;
  element("phase").textContent = "Releasing";
  const owner = renderer?.graphics?.texture_residency_if_created;
  try {
    if (settled && renderer) {
      await renderer.releaseScene(scene);
      await renderer.device.queue.onSubmittedWorkDone();
      await Promise.resolve();
      await Promise.resolve();
    } else {
      // Destroy cancels the Renderer-owned cold codec, including pre-publication work.
      asset?.cancel("Demo released");
      renderer?.destroy();
      if (loading) {
        try {
          await loading;
        } catch (error) {
          teardown = { abortedPublication: error instanceof Error ? error.message : String(error) };
        }
      }
    }
    const texture = owner?.evidence() ?? null;
    const zero =
      !texture ||
      (texture.allocatedBytes === 0 &&
        texture.residentTextureCount === 0 &&
        texture.retiringTextureCount === 0 &&
        texture.pendingTextureCount === 0 &&
        texture.quarantinedTextureCount === 0);
    teardown = {
      texture,
      textureOwnerZero: zero,
      geometry: renderer?.device ? geometryProductGpuBudgetEvidence(renderer.device) : null,
      prior: teardown,
    };
    if (!zero) throw new Error("TextureResidency did not reach zero after release fence");
    element("phase").textContent = "Released";
  } finally {
    cooked?.dispose();
    cooked = undefined;
    handles = undefined;
    loading = undefined;
    asset?.dispose();
    renderer?.destroy();
  }
}

element("frame-scene").addEventListener("click", frameScene);
createIcons({ icons: { Download, PanelRightClose, RotateCw, Scan, Square, StepForward } });
for (const summary of document.querySelectorAll("summary")) {
  summary.append(createElement(ChevronRight, { "aria-hidden": "true" }));
}
const panel = element("debug-panel");
const panelBody = element("panel-body");
const panelToggle = element<HTMLButtonElement>("panel-toggle");
panelToggle.addEventListener("click", () => {
  const collapsed = panel.classList.toggle("collapsed");
  panelBody.hidden = collapsed;
  panelToggle.setAttribute("aria-expanded", String(!collapsed));
  panelToggle.title = collapsed ? "Expand panel" : "Collapse panel";
  panelToggle.setAttribute("aria-label", panelToggle.title);
  panelToggle.replaceChildren(
    createElement(collapsed ? PanelRightOpen : PanelRightClose, { "aria-hidden": "true" }),
  );
});
const vsmCells = new Map<string, HTMLElement>();
for (const [key, label] of [
  ["profile", "Profile"],
  ["atlas", "Atlas"],
  ["clips", "Clip levels"],
  ["page", "Page size"],
  ["slots", "Resident slot capacity"],
  ["taps", "PCF ceiling / axis"],
]) {
  const dt = document.createElement("dt"),
    dd = document.createElement("dd");
  dt.textContent = label!;
  dd.textContent = "--";
  vsmCells.set(key!, dd);
  element("vsm-state").append(dt, dd);
}
const vsmControls = setupVsmControls(() => renderer, resetFrameSamples);
function diagnosticControlsDisabled(disabled: boolean): void {
  for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
    ".diagnostic-controls input, .diagnostic-controls select, .diagnostic-controls button",
  )) {
    control.disabled = disabled || (control.id === "step" && !paused);
  }
}
diagnosticControlsDisabled(true);
// OrbitControls listens above the canvas; focused sidebar inputs own their keys.
document.querySelector("aside")!.addEventListener("keydown", (event) => event.stopPropagation());
element<HTMLSelectElement>("exposure-mode").value = autoExposure ? "auto" : "fixed";
element<HTMLInputElement>("fixed-exposure").value = String(fixedExposure);
element<HTMLInputElement>("exposure-low").value = String(exposureSettings.lowPercentile * 100);
element<HTMLInputElement>("exposure-high").value = String(exposureSettings.highPercentile * 100);
element<HTMLInputElement>("exposure-headroom").value = String(exposureSettings.highlightHeadroom);
function applyLightingDiagnostic(): void {
  scene.physical_environment.setLightingDiagnostic(
    element<HTMLSelectElement>("lighting-contribution").value as PhysicalLightingDiagnostic,
    element<HTMLInputElement>("aerial-perspective").checked,
  );
  renderer?.invalidateTemporalHistory();
  resetFrameSamples();
}
element("lighting-contribution").addEventListener("change", applyLightingDiagnostic);
element("aerial-perspective").addEventListener("change", applyLightingDiagnostic);
element("read-exposure").addEventListener("click", async () => {
  const active = renderer;
  if (!active) return;
  const button = element<HTMLButtonElement>("read-exposure");
  button.disabled = true;
  try {
    const sample = await active.readExposureDiagnostics();
    if (renderer !== active) return;
    exposureDiagnostic = sample;
    element("exposure-diagnostic").textContent = sample.autoExposure
      ? `Exposure ${sample.exposure.toPrecision(5)} · Metered L ${sample.meteredLuminance.toPrecision(5)} · Adapted L ${sample.adaptedLuminance.toPrecision(5)} · Log L ${sample.adaptedLogLuminance.toFixed(3)} stops · Highlight L ${sample.highlightLuminance.toPrecision(5)} (one-shot)`
      : `Fixed exposure ${sample.exposure.toPrecision(5)} · Meter disabled (one-shot)`;
  } catch (error) {
    element("exposure-diagnostic").textContent = `Diagnostic unavailable: ${String(error)}`;
  } finally {
    button.disabled = renderer === null || closing;
  }
});
element("reset-exposure").addEventListener("click", () => {
  renderer?.resetExposure();
  exposureDiagnostic = null;
  element("exposure-diagnostic").textContent = "Exposure reset; read again after the next frame";
});
function syncExposureControls(): void {
  element("fixed-exposure-control").hidden = element<HTMLSelectElement>("exposure-mode").value !== "fixed";
}
element("exposure-mode").addEventListener("change", syncExposureControls);
syncExposureControls();
element("debug-view").addEventListener("change", (event) => {
  if (!renderer) return;
  renderer.render_debug_view = (event.target as HTMLSelectElement).value as RenderDebugViewName;
  resetFrameSamples();
});
const effectSwitches = [
  [
    "vsm",
    (r: Renderer, v: boolean) => {
      r.shadowVisibilityEnabled = v;
    },
  ],
  [
    "gtao",
    (r: Renderer, v: boolean) => {
      r.xe_gtao_enabled = v;
    },
  ],
  [
    "fsr3",
    (r: Renderer, v: boolean) => {
      r.fsr3_enabled = v;
    },
  ],
  [
    "bloom",
    (r: Renderer, v: boolean) => {
      r.bloom_enabled = v;
    },
  ],
  [
    "jitter",
    (r: Renderer, v: boolean) => {
      r.temporal_jitter_enabled = v;
    },
  ],
  [
    "hzb",
    (r: Renderer, v: boolean) => {
      r.packed_visibility_hzb_enabled = v;
    },
  ],
  [
    "cone",
    (r: Renderer, v: boolean) => {
      r.packed_visibility_cone_enabled = v;
    },
  ],
] as const;
function syncEffectParameters(id: string): void {
  const input = element<HTMLInputElement>(id);
  const parameters = input.getAttribute("aria-controls");
  if (parameters) element(parameters).hidden = !input.checked;
}
for (const [id, set] of effectSwitches) {
  syncEffectParameters(id);
  element<HTMLInputElement>(id).addEventListener("change", (event) => {
    syncEffectParameters(id);
    if (!renderer) return;
    const enabled = (event.target as HTMLInputElement).checked;
    if (id === "fsr3" && !enabled) {
      // The production bypass requires equal internal/output extents.
      renderer.internal_resolution_scale = 1;
      element<HTMLInputElement>("render-scale").value = "1";
      element("render-scale-value").textContent = "100%";
      element<HTMLInputElement>("jitter").checked = false;
      renderer.temporal_jitter_enabled = false;
    }
    set(renderer, enabled);
    renderer.invalidateTemporalHistory();
    resetFrameSamples();
  });
}
element<HTMLInputElement>("damping").addEventListener("change", (event) => {
  syncEffectParameters("damping");
  if (controls) controls.enableDamping = (event.target as HTMLInputElement).checked;
});
for (const [id, format, apply] of [
  [
    "render-scale",
    (v: number) => `${Math.round(v * 100)}%`,
    (v: number) => {
      if (renderer?.fsr3_enabled) {
        renderer.internal_resolution_scale = v;
        camera.aspect = renderer.aspect_ratio;
        camera.update();
      }
    },
  ],
  [
    "damping-factor",
    (v: number) => v.toFixed(2),
    (v: number) => {
      if (controls) controls.dampingFactor = v;
    },
  ],
  [
    "orbit-speed",
    (v: number) => v.toFixed(2),
    (v: number) => {
      if (controls) controls.rotateSpeed = v;
    },
  ],
  [
    "fov",
    (v: number) => `${v} deg`,
    (v: number) => {
      camera.fov_degrees = v;
      camera.update();
    },
  ],
] as const) {
  const input = element<HTMLInputElement>(id);
  input.addEventListener("input", () => {
    element(`${id}-value`).textContent = format(Number(input.value));
  });
  input.addEventListener("change", () => {
    if (!input.checkValidity()) return;
    apply(Number(input.value));
    renderer?.invalidateTemporalHistory();
    resetFrameSamples();
  });
}
element<HTMLInputElement>("sse").addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
  if (!renderer || !input.checkValidity()) return;
  renderer.packed_visibility_sse_threshold = Number(input.value);
  renderer.invalidateTemporalHistory();
  resetFrameSamples();
});
function readSunCalendar() {
  return {
    dayOfYear: Number(element<HTMLInputElement>("sun-day").value),
    timeOfDay: Number(element<HTMLInputElement>("sun-time").value),
    latitude: Number(element<HTMLInputElement>("sun-latitude").value),
    longitude: Number(element<HTMLInputElement>("sun-longitude").value),
  };
}
function applySunControls(): void {
  const enabled = element<HTMLInputElement>("sun-calendar").checked;
  element("sun-calendar-parameters").hidden = !enabled;
  if (enabled) {
    const invalid = ["sun-day", "sun-time", "sun-latitude", "sun-longitude"]
      .map((id) => element<HTMLInputElement>(id))
      .find((input) => !input.checkValidity());
    if (invalid) {
      invalid.reportValidity();
      return;
    }
  }
  const parameters = readSunCalendar();
  element("sun-day-value").textContent = formatSunDay(parameters.dayOfYear);
  element("sun-time-value").textContent = formatSunTime(parameters.timeOfDay);
  const position = enabled ? calendarSunDirection(parameters) : null;
  element("sun-altitude-value").textContent = position ? `${position.altitudeDegrees.toFixed(1)}°` : "--";
  const intensity = Number(element<HTMLInputElement>("sun").value);
  scene.physical_environment.setSun(
    position?.direction ?? sunDirection,
    sunIrradiance.map((value) => value * intensity) as [number, number, number],
  );
}
element("sun-calendar").addEventListener("change", () => {
  applySunControls();
  renderer?.invalidateTemporalHistory();
  resetFrameSamples();
});
for (const id of ["sun-day", "sun-time", "sun-latitude", "sun-longitude"] as const) {
  element<HTMLInputElement>(id).addEventListener("input", () => {
    const input = element<HTMLInputElement>(id);
    if (!input.checkValidity()) {
      return;
    }
    if (id === "sun-day") {
      element("sun-day-value").textContent = formatSunDay(Number(input.value));
    }
    if (id === "sun-time") {
      element("sun-time-value").textContent = formatSunTime(Number(input.value));
    }
  });
  // Commit on release, like the intensity controls. Dragging does not repeatedly
  // regenerate the physical sky IBL or restart temporal history each frame.
  element<HTMLInputElement>(id).addEventListener("change", () => {
    const valid = ["sun-day", "sun-time", "sun-latitude", "sun-longitude"].every((parameter) =>
      element<HTMLInputElement>(parameter).checkValidity(),
    );
    if (!valid) {
      return;
    }
    applySunControls();
    renderer?.invalidateTemporalHistory();
    resetFrameSamples();
  });
}
for (const id of ["sun", "sky"] as const) {
  element<HTMLInputElement>(id).addEventListener("input", () => {
    element(`${id}-value`).textContent = Number(element<HTMLInputElement>(id).value).toFixed(2);
  });
  element<HTMLInputElement>(id).addEventListener("change", () => {
    const value = Number(element<HTMLInputElement>(id).value);
    if (id === "sun") applySunControls();
    else scene.physical_environment.setSkyLuminanceScale(value);
    element(`${id}-value`).textContent = value.toFixed(2);
    renderer?.invalidateTemporalHistory();
    resetFrameSamples();
  });
}
element<HTMLInputElement>("pause").addEventListener("change", (event) => {
  paused = (event.target as HTMLInputElement).checked;
  element<HTMLButtonElement>("step").disabled = !paused;
  stepFrames = 0;
  resetFrameSamples();
  renderer?.invalidateTemporalHistory();
});
document.addEventListener("visibilitychange", resetFrameSamples);
element("step").addEventListener("click", () => {
  if (paused) stepFrames++;
});
element("apply-exposure").addEventListener("click", () => {
  const input = element<HTMLInputElement>("fixed-exposure");
  if (!input.checkValidity()) {
    input.reportValidity();
    return;
  }
  const url = new URL(location.href);
  url.searchParams.set("exposure", element<HTMLSelectElement>("exposure-mode").value);
  const low = element<HTMLInputElement>("exposure-low");
  const high = element<HTMLInputElement>("exposure-high");
  const headroom = element<HTMLInputElement>("exposure-headroom");
  low.setCustomValidity("");
  for (const control of [low, high, headroom]) {
    if (!control.checkValidity()) {
      control.reportValidity();
      return;
    }
  }
  low.setCustomValidity(
    Number(low.value) < Number(high.value) ? "" : "Low percentile must be below high percentile",
  );
  if (!low.reportValidity()) return;
  url.searchParams.set("fixedExposure", input.value);
  url.searchParams.set("exposureLow", String(Number(low.value) / 100));
  url.searchParams.set("exposureHigh", String(Number(high.value) / 100));
  url.searchParams.set("exposureHeadroom", headroom.value);
  void release()
    .then(() => location.assign(url.href))
    .catch(failCleanup);
});
element("release").addEventListener("click", () => {
  void release().catch(failCleanup);
});
element("reload").addEventListener("click", () => {
  void release()
    .then(() => location.reload())
    .catch(failCleanup);
});
function failCleanup(error: unknown): void {
  element("error").textContent += `\nRelease: ${String(error)}`;
  console.error(error);
}
element<HTMLInputElement>("profile").addEventListener("change", (event) => {
  profiled = (event.target as HTMLInputElement).checked;
  resetFrameSamples();
  renderer?.profiler.configure({
    enabled: profiled,
    gpuTimingMode: profiled ? "full" : "production",
    gpuSampleInterval: 1,
    historyCapacity: 512,
    warmupFrames: 0,
  });
});
function report() {
  return closing ? { ...lastSnapshot, teardown, failure } : snapshot();
}
element("export").addEventListener("click", () => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(report(), null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "dungeon-warkarma-texture-compression.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
// Read-only browser inspection and the same lifecycle action as the Release button.
Object.assign(window, { dungeonDemo: { report, release } });
// Explicit diagnostic host only. Raw samples and existing profiler controls do
// not change the ordinary example or add a frame submission/readback owner.
if (query.get("performanceCapture") === "1") {
  Object.assign(window, {
    dungeonPerformance: {
      configure(mode: "production" | "coarse" | "stage" | "full", cpuPassTimings = false, counters = false) {
        if (!renderer) throw new Error("Renderer is not initialized");
        profiled = mode !== "production";
        element<HTMLInputElement>("profile").checked = profiled;
        resetFrameSamples();
        renderer.perf_gpu_counters_enabled = counters;
        renderer.profiler.clear();
        renderer.profiler.setMode(counters ? "record" : "live");
        renderer.profiler.configure({
          enabled: profiled,
          gpuTimingMode: mode,
          gpuSampleInterval: 4,
          gpuCounterSampleInterval: 4,
          cpuPassTimings,
          historyCapacity: 512,
          warmupFrames: 0,
        });
        return renderer.frame_count;
      },
      vsmDiagnostics: () => renderer?.vsmDiagnostics() ?? null,
      samples: () => ({
        cpu,
        intervals,
        callbacks,
        frames: renderer?.profiler.history ?? [],
        resetFrame: sampleResetFrame,
        graph: renderer?.mainFrameGraphEvidence() ?? null,
        vsmCapabilities: renderer?.vsmCapabilities ?? null,
        deviceFeatures: renderer ? [...renderer.device.features] : [],
        instanceBegin: renderer?.graphics?.render_world.runtime(scene)?.instanceBegin ?? null,
        instanceCount: renderer?.graphics?.render_world.runtime(scene)?.instanceCount ?? null,
        deviceLimits: renderer ? Object.fromEntries(Object.keys(GPUSupportedLimits.prototype).map(key => [key, renderer!.device.limits[key as keyof GPUSupportedLimits]])) : {},
      }),
      setCamera(position: readonly [number, number, number], target: readonly [number, number, number], cut = true) {
        camera.transform.position.set(...position);
        controls?.target.set(...target);
        controls?.reset();
        camera.transform.lookAt({ x: target[0], y: target[1], z: target[2] });
        camera.update();
        if (cut) renderer?.invalidateTemporalHistory();
      },
    },
  });
}
window.addEventListener("pagehide", () => {
  void release().catch(failCleanup);
});
void start().catch(fail);

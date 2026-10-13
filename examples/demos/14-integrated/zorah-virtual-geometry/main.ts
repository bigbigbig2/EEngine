import {
  DirectionalLight,
  FirstPersonControls,
  OrbitControls,
  PerspectiveCamera,
  Renderer,
  Scene,
  type RenderDebugViewName
} from "../../../../OEngine/src/index.ts";
import type { FrameProfileSnapshot } from "../../../../OEngine/src/debug/FrameProfiler.ts";
import { summarizeGpuTimingCost } from "../../../../OEngine/src/debug/GpuTimingCost.ts";
import { geometryProductGpuBudgetEvidence } from "../../../../OEngine/src/gpu/GeometryProductGpuBudget.ts";
import { loadZorahScene, type LoadOptions, type LoadProgress } from "./cooked-scene.ts";
import "./style.css";

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => element<HTMLInputElement>(id);
const select = (id: string) => element<HTMLSelectElement>(id);
const canvas = element<HTMLCanvasElement>("viewport");
const query = new URLSearchParams(location.search);
const defaults: LoadOptions = {
  packStart: 0,
  packCount: 0,
  geometryMiB: 2048,
  metadataMiB: 192,
  frameMiB: 512,
  frameOwnerMiB: 1024,
  workMi: 4,
  reads: 8,
  inFlightMiB: 32,
  uploadMiB: 16
};
for (const key of Object.keys(defaults) as (keyof LoadOptions)[]) {
  const value = query.get(key);
  if (value !== null) {
    input(key).value = value;
  }
  if (!input(key).checkValidity()) {
    input(key).value = String(defaults[key]);
  }
}
for (const id of ["sse", "fov", "speed", "moveSpeed"] as const) {
  if (query.has(id)) {
    input(id).value = query.get(id)!;
    if (!input(id).checkValidity()) {
      input(id).value = id === "sse" ? "4" : id === "fov" ? "60" : id === "moveSpeed" ? "1.5" : "2";
    }
  } else if (id === "moveSpeed") {
    input("moveSpeed").value = "1.5";
  }
}
for (const id of ["hzb", "cone", "taa", "ao", "bloom", "orbit"] as const) {
  if (query.has(id)) {
    input(id).checked = query.get(id) === "1";
  }
}
for (const id of ["view", "extent", "scale", "profile", "controlsMode"] as const) {
  const value = query.get(id);
  if (value !== null && [...select(id).options].some((option) => option.value === value)) {
    select(id).value = value;
  }
}
const options = Object.fromEntries(
  Object.keys(defaults).map((key) => [key, Number(input(key).value)])
) as unknown as LoadOptions;
const progress: LoadProgress = {
  phase: "初始化 WebGPU",
  opened: 0,
  admitted: 0,
  total: 0,
  totalPacks: 0,
  totalInstances: 0,
  selectedInstances: 0,
  fileBytes: 0,
  pages: 0,
  activationPages: 0
};
const startedAt = performance.now();
const scene = new Scene();
const camera = new PerspectiveCamera();
const abort = new AbortController();
const frames = new Map<number, FrameProfileSnapshot>();
const events: { atMs: number; message: string }[] = [];
let renderer: Renderer | undefined;
let cooked: Awaited<ReturnType<typeof loadZorahScene>> | undefined;
let orbitControls: OrbitControls | undefined;
let fpsControls: FirstPersonControls | undefined;
let loading: Promise<Awaited<ReturnType<typeof loadZorahScene>>> | undefined;
let initialization: Promise<void> | undefined;
let resizeObserver: ResizeObserver | undefined;
let unsubscribe: (() => void) | undefined;
let frameId = 0;
let refreshId = 0;
let paused = false;
let stepPending = false;
let closing = false;
let failure: string | null = null;
let cleanup: Promise<void> | undefined;
let submittedFrames = 0;
let deferredFrames = 0;
let firstFrameMs: number | null = null;
let lastFrame = -1;
let previousTime = performance.now();
let peakOwnerBytes = 0;
let lastWorkStatus: NonNullable<ReturnType<Renderer["geometryStreamingEvidence"]>>["workStatus"];
let record:
  | {
      state: "warmup" | "sampling" | "draining" | "done" | "interrupted";
      startMs: number;
      sampleMs: number;
      endMs: number;
      drainMs: number;
      startFrame: number;
      endFrame: number;
      conditions: object;
      frames: Map<number, FrameProfileSnapshot>;
      reason?: string;
    }
  | undefined;

function event(message: string): void {
  events.push({ atMs: performance.now() - startedAt, message });
  if (events.length > 120) {
    events.shift();
  }
}
function fail(error: unknown): void {
  failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  event(`失败 · ${failure}`);
  progress.phase = "失败 · 查看错误与准入信息";
  console.error(error);
  paint();
  void release();
}
function conditions() {
  return {
    options,
    scope: {
      packStart: options.packStart,
      packCount: progress.total,
      fullScene: options.packStart === 0 && progress.total === progress.totalPacks,
      instances: progress.selectedInstances
    },
    browser: navigator.userAgent,
    adapter: renderer?.adapter_info,
    capabilities: renderer?.capabilities,
    resolution: renderer?.resolutionEvidence(),
    view: select("view").value,
    sse: Number(input("sse").value),
    hzb: input("hzb").checked,
    cone: input("cone").checked,
    effects: { taa: input("taa").checked, ao: input("ao").checked, bloom: input("bloom").checked },
    camera: {
      eye: [camera.transform.position.x, camera.transform.position.y, camera.transform.position.z],
      mode: select("controlsMode")?.value ?? "fps",
      target: orbitControls ? [orbitControls.target.x, orbitControls.target.y, orbitControls.target.z] : null,
      fov: camera.fov_degrees,
      near: camera.near,
      far: camera.far,
      cruise: input("orbit").checked,
      speed: Number(input("speed").value),
      moveSpeed: Number(input("moveSpeed")?.value ?? 1.5)
    },
    instrumentation: select("profile").value
  };
}
function interruptRecord(reason: string): void {
  frames.clear();
  if (record && ["warmup", "sampling", "draining"].includes(record.state)) {
    record.state = "interrupted";
    record.reason = reason;
    event(`采样中断 · ${reason}`);
  }
}
function distribution(values: number[]) {
  values = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) {
    return null;
  }
  return {
    p50: values[Math.floor((values.length - 1) * 0.5)]!,
    p95: values[Math.floor((values.length - 1) * 0.95)]!,
    count: values.length
  };
}
function stats(source: Iterable<FrameProfileSnapshot>) {
  const list = [...source];
  const validGpu = list.filter(
    (frame) =>
      frame.gpu.available &&
      frame.gpu.sampled &&
      !frame.gpu.pending &&
      frame.gpu.segments.length > 0 &&
      !frame.counters["gpu.timing.truncated"]
  );
  return {
    cpu: distribution(list.map((frame) => frame.cpuMs.frame!)),
    gpu: distribution(
      validGpu
        .map((frame) => summarizeGpuTimingCost(frame.gpu.segments).commandSpanMs)
        .filter((value): value is number => value !== null)
    ),
    raf: distribution(list.map((frame) => frame.counters["frame.rafIntervalMs"]!))
  };
}
const bytes = (value: number) => `${(value / 1024 ** 2).toFixed(1)} MiB`;
const escape = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

function snapshot() {
  const stream = renderer?.device && cooked && !closing ? renderer.geometryStreamingEvidence(scene) : null;
  lastWorkStatus = stream?.workStatus ?? lastWorkStatus;
  const memory = renderer?.device && !closing ? renderer.memoryEvidence() : null;
  if (memory) {
    peakOwnerBytes = Math.max(peakOwnerBytes, memory.allocatedBytes);
  }
  return {
    schema: "oengine-zorah-stress-lab-v1",
    capturedAt: new Date().toISOString(),
    source: "/assets/local-zorah/cooked/scene.oescene",
    conditions: conditions(),
    progress,
    firstFrameMs,
    submittedFrames,
    deferredFrames,
    elapsedMs: performance.now() - startedAt,
    paused,
    released: closing,
    failure,
    peakOwnerBytes,
    memory,
    geometryBudget: renderer?.device ? geometryProductGpuBudgetEvidence(renderer.device) : null,
    runtime: cooked && !closing ? cooked.runtime.evidence() : null,
    streaming: stream,
    workStatus: lastWorkStatus,
    diagnostics: renderer?.profiler.diagnostics,
    frameAdmission: renderer?.frameSubmissionEvidence(),
    graph: renderer?.device && !closing ? renderer.mainFrameGraphEvidence() : null,
    io: cooked && !closing ? cooked.ioEvidence() : null,
    stats: stats(frames.values()),
    events
  };
}

function paint(): void {
  const s = snapshot();
  element("phase").textContent = progress.phase;
  element("error").textContent = failure ?? "";
  const bar = element<HTMLProgressElement>("progress");
  bar.max = Math.max(1, progress.total * 2);
  bar.value = progress.opened + progress.admitted;
  element("scope").textContent =
    `包 [${options.packStart}, ${options.packStart + progress.total}) / ${progress.totalPacks || "…"} · ${progress.selectedInstances.toLocaleString()} / ${progress.totalInstances.toLocaleString()} 实例 · ${s.conditions.scope.fullScene ? "全量场景" : "明确选择的部分场景"}`;
  const cards = [
    ["CPU Render P50", s.stats.cpu],
    ["GPU Command Span P50", s.stats.gpu],
    ["RAF P50", s.stats.raf]
  ] as const;
  element("cards").innerHTML = cards
    .map(
      ([label, stat]) =>
        `<div class="card"><small>${label}</small><strong>${stat ? stat.p50.toFixed(2) : "—"}<small>ms · P95 ${stat ? stat.p95.toFixed(2) : "—"} · N ${stat?.count ?? 0}</small></strong></div>`
    )
    .join("");
  const products = s.streaming?.products ?? [];
  const sum = (
    key: "residentBytes" | "residentPages" | "pinnedPages" | "evictedPages" | "reloads" | "thrashBytes"
  ) => products.reduce((total, product) => total + product[key], 0);
  const rows = [
    [
      "加载时间 / 首帧",
      `${(s.elapsedMs / 1000).toFixed(1)} s / ${firstFrameMs === null ? "—" : (firstFrameMs / 1000).toFixed(2) + " s"}`
    ],
    ["CPU 打开 / GPU 准入包", `${progress.opened} / ${progress.admitted} / ${progress.total}`],
    ["原始三角形（全源）", progress.source?.triangles.toLocaleString() ?? "—"],
    ["所选包磁盘体积 / 页数", `${bytes(progress.fileBytes)} / ${progress.pages.toLocaleString()}`],
    [
      "激活页 / 已驻留 / 固定",
      `${progress.activationPages} / ${sum("residentPages")} / ${sum("pinnedPages")}`
    ],
    ["MeshletWork 全细节理论量", progress.work?.hierarchyRasterWorkCapacity.toLocaleString() ?? "—"],
    ["本帧 MeshletWork 队列容量", progress.meshletWorkCapacity?.toLocaleString() ?? "—"],
    ["已完成帧实际 MeshletWork", s.workStatus?.header.writtenCount.toLocaleString() ?? "待反馈"],
    [
      "Work overflow / invalid",
      `${s.workStatus?.header.overflowCount ?? 0} / ${s.workStatus?.header.invalidCount ?? 0}`
    ],
    [
      "Frame arena 预检体积 / 上限",
      `${progress.frameArenaBytes === undefined ? "—" : bytes(progress.frameArenaBytes)} / ${options.frameMiB} MiB`
    ],
    ["Frame arena owner 总上限", `${options.frameOwnerMiB} MiB`],
    [
      "请求容量 / 实际几何分配",
      `${options.geometryMiB} MiB / ${bytes(s.geometryBudget?.allocatedBytes ?? 0)}`
    ],
    ["元数据请求 / 实际分配", `${options.metadataMiB} MiB / ${bytes(s.geometryBudget?.metadataBytes ?? 0)}`],
    ["驻留页物理体积", bytes(sum("residentBytes"))],
    ["Owner 当前 / 峰值", `${bytes(s.memory?.allocatedBytes ?? 0)} / ${bytes(peakOwnerBytes)}`],
    [
      "流送 pending / failed",
      `${s.streaming?.scheduler.pending ?? 0} / ${s.streaming?.scheduler.failed ?? 0}`
    ],
    [
      "流送上传总量 / blocked",
      `${bytes(s.streaming?.scheduler.uploadedBytes ?? 0)} / ${s.streaming?.scheduler.blockedUploads ?? 0}`
    ],
    [
      "读取延迟 P50 / P95",
      `${s.streaming?.scheduler.readLatencyP50Ms.toFixed(2) ?? "—"} / ${s.streaming?.scheduler.readLatencyP95Ms.toFixed(2) ?? "—"} ms`
    ],
    ["驱逐 / 重载 / Thrash", `${sum("evictedPages")} / ${sum("reloads")} / ${bytes(sum("thrashBytes"))}`],
    ["Demand overflow", String(s.streaming?.scheduler.demandOverflow ?? 0)],
    ["反馈 readback ring overflow", String(s.streaming?.readback.overflow ?? 0)],
    [
      "Timestamp 失败 / Counter 丢弃",
      `${s.diagnostics?.failedGpuTimestampBatches ?? 0} / ${s.diagnostics?.droppedGpuCounterSamples ?? 0}`
    ],
    ["提交 / 等待 ticks", `${submittedFrames} / ${deferredFrames}`],
    ["GPU Timestamp", renderer?.profiler.gpuTimestampAvailable ? "可用" : "不可用"],
    ["实际 GPU 计时模式", renderer?.profiler.gpuTimingMode ?? "—"],
    [
      "Validation / uncaptured / lost",
      `${s.diagnostics?.validationErrorCount ?? 0} / ${s.diagnostics?.uncapturedErrorCount ?? 0} / ${s.diagnostics?.deviceLostCount ?? 0}`
    ],
    ["Stream error", s.streaming?.lastError ?? s.streaming?.scheduler.lastError ?? "无"]
  ];
  element("status").innerHTML = rows
    .map(([key, value]) => `<dt>${escape(key!)}</dt><dd>${escape(value!)}</dd>`)
    .join("");
  const passSamples = new Map<string, number[]>();
  for (const frame of frames.values()) {
    if (
      !frame.gpu.available ||
      !frame.gpu.sampled ||
      frame.gpu.pending ||
      frame.counters["gpu.timing.truncated"]
    ) {
      continue;
    }
    for (const part of frame.gpu.segments) {
      const label = `${part.scope ?? "pass"} · ${part.label}`;
      const values = passSamples.get(label) ?? [];
      values.push(part.durationMs);
      passSamples.set(label, values);
    }
  }
  element("passes").innerHTML =
    `<table><thead><tr><th>Pass</th><th>P50</th><th>P95</th><th>N</th></tr></thead><tbody>${[...passSamples]
      .map(([label, values]) => {
        const d = distribution(values)!;
        return `<tr><td>${escape(label)}</td><td>${d.p50.toFixed(3)}</td><td>${d.p95.toFixed(3)}</td><td>${d.count}</td></tr>`;
      })
      .join("")}</tbody></table>`;
  element("counters").textContent = JSON.stringify(renderer?.profiler.latest?.counters ?? {}, null, 2);
  element("evidence").textContent = JSON.stringify(
    {
      work: progress.work,
      runtime: s.runtime,
      streaming: s.streaming,
      budget: s.geometryBudget,
      memory: s.memory,
      graph: s.graph,
      adapter: s.conditions.adapter,
      capabilities: s.conditions.capabilities,
      frameAdmission: s.frameAdmission
    },
    null,
    2
  );
  element("events").textContent = events
    .map((entry) => `${(entry.atMs / 1000).toFixed(2)}s · ${entry.message}`)
    .join("\n");
  element("record-status").textContent = record
    ? `${record.state} · ${record.frames.size} 帧 · ${record.reason ?? "导出包含固定条件与采样结果"}`
    : "最近 360 帧滚动统计";
}

function configureProfiler(): void {
  if (!renderer) {
    return;
  }
  const mode = select("profile").value;
  renderer.perf_gpu_counters_enabled = mode === "counters" || mode === "heavy";
  renderer.profiler.configure({
    enabled: mode !== "off",
    gpuSampleInterval: 8,
    gpuCounterSampleInterval: mode === "heavy" ? 1 : 16,
    gpuTimingMode: mode === "full" ? "full" : mode === "counters" || mode === "heavy" ? "stage" : "coarse",
    historyCapacity: 512,
    readbackRingSlots: 8,
    cpuPassTimings: true
  });
  renderer.profiler.setMode(mode === "counters" || mode === "heavy" || mode === "full" ? "record" : "live");
}
function applyControls(): void {
  if (!renderer) {
    return;
  }
  renderer.render_debug_view = select("view").value as RenderDebugViewName;
  renderer.packed_visibility_sse_threshold = Number(input("sse").value);
  renderer.packed_visibility_hzb_enabled = input("hzb").checked;
  renderer.packed_visibility_cone_enabled = input("cone").checked;
  renderer.fsr3_enabled = input("taa").checked || Number(select("scale").value) < 1;
  renderer.xe_gtao_enabled = input("ao").checked;
  renderer.bloom_enabled = input("bloom").checked;
  renderer.internal_resolution_scale = Number(select("scale").value);
  camera.fov_degrees = Number(input("fov").value);
  const mode = select("controlsMode").value as "fps" | "orbit";
  const cruise = input("orbit").checked;
  const cruiseSpeed = Number(input("speed").value);
  const moveSpeed = Number(input("moveSpeed").value);

  if (orbitControls) {
    orbitControls.enabled = mode === "orbit";
    orbitControls.autoRotate = cruise;
    orbitControls.autoRotateSpeed = cruiseSpeed;
  }
  if (fpsControls) {
    fpsControls.enabled = mode === "fps";
    fpsControls.movementSpeed = moveSpeed;
    fpsControls.autoForward = mode === "fps" && cruise;
  }
  const moveSpeedRow = element("moveSpeedRow");
  if (moveSpeedRow) {
    moveSpeedRow.style.display = mode === "fps" ? "flex" : "none";
  }
  configureProfiler();
  resize();
  renderer.invalidateTemporalHistory();
}
function resize(): void {
  if (!renderer?.device || closing) {
    return;
  }
  const extent = select("extent").value;
  const height = extent === "window" ? canvas.clientHeight : Number(extent);
  const width = extent === "window" ? canvas.clientWidth : Math.round((height * 16) / 9);
  renderer.resize(Math.max(1, width), Math.max(1, height));
  // Renderer.resize sets a CSS pixel size. Keep the fixed benchmark buffer
  // inside the responsive viewport instead of clipping a 1920px canvas.
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  camera.aspect = renderer.aspect_ratio;
  camera.update();
}
function placeCamera(mode: "courtyard" | "interior" | "overview" = "courtyard"): void {
  if (!cooked) {
    return;
  }
  if (mode === "courtyard") {
    // 庭院中央楼梯与正门通道：站在中轴线看向大拱门与大廊柱
    camera.near = 0.1;
    camera.far = 10000;
    camera.transform.position.set(5.0, 4.5, 0.0);
    camera.transform.lookAt({ x: 62.7, y: 8.0, z: 0.0 });
    orbitControls?.target.set(62.7, 8.0, 0.0);
  } else if (mode === "interior") {
    // 王座大厅室内：站立在殿门柱廊内看向王座深处
    camera.near = 0.1;
    camera.far = 10000;
    camera.transform.position.set(-20.0, 3.8, 0.0);
    camera.transform.lookAt({ x: -38.0, y: 3.5, z: 0.0 });
    orbitControls?.target.set(-38.0, 3.5, 0.0);
  } else {
    const { center, radius } = cooked.framing;
    const distance = radius * 2.5;
    camera.near = Math.max(0.001, radius / 10000);
    camera.far = Math.max(100, radius * 30);
    camera.transform.position.set(
      center[0] + distance * 0.6,
      center[1] + distance * 0.45,
      center[2] + distance
    );
    camera.transform.lookAt({ x: center[0], y: center[1], z: center[2] });
    orbitControls?.target.set(...center);
  }
  orbitControls?.reset();
  fpsControls?.setOrientation();
  fpsControls?.saveState();
  renderer?.invalidateTemporalHistory();
  interruptRecord(`相机视角改变 · ${mode}`);
}

async function start(): Promise<void> {
  if (!navigator.gpu) {
    throw new Error("此浏览器没有 WebGPU，请使用支持 WebGPU 的 Chrome / Edge");
  }
  const context = canvas.getContext("webgpu");
  if (!context) {
    throw new Error("无法创建 WebGPU canvas context");
  }
  renderer = new Renderer({
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    enableVsm: false,
    enablePhysicalEnvironment: false,
    autoExposure: false,
    fixedExposure: 1,
    frameGeometry: {
      maxBytes: options.frameMiB * 1024 ** 2,
      ownerMaxBytes: options.frameOwnerMiB * 1024 ** 2
    }
  });
  initialization = renderer.initialize({ context });
  await initialization;
  abort.signal.throwIfAborted();
  renderer.packed_meshlet_work_candidate_capacity = options.workMi * 1024 ** 2;
  renderer.pixel_ratio = 1;
  applyControls();
  unsubscribe = renderer.profiler.subscribe((frame) => {
    lastFrame = Math.max(lastFrame, frame.frameIndex);
    // A late readback may replace its frame, but must not reinsert an expired frame.
    if (frames.has(frame.frameIndex) || frame.frameIndex >= (frames.keys().next().value ?? -1)) {
      frames.set(frame.frameIndex, frame);
      if (frames.size > 360) {
        frames.delete(frames.keys().next().value!);
      }
    }
    if (
      record &&
      (record.state === "sampling" || record.state === "draining") &&
      frame.frameIndex >= record.startFrame &&
      frame.frameIndex <= record.endFrame
    ) {
      if (record.frames.size >= 6000 && !record.frames.has(frame.frameIndex)) {
        interruptRecord("达到 6000 帧上限");
      } else {
        record.frames.set(frame.frameIndex, frame);
      }
    }
  });
  event(`WebGPU 就绪 · ${renderer.adapter_info?.device ?? "adapter"}`);
  refreshId = window.setInterval(paint, 500);
  loading = loadZorahScene(
    renderer,
    scene,
    new URL("/assets/local-zorah/cooked/", location.href).href,
    options,
    abort.signal,
    progress,
    paint
  );
  cooked = await loading;
  abort.signal.throwIfAborted();
  const sun = new DirectionalLight();
  sun.intensity = 2.5;
  sun.color.r = 1.0;
  sun.color.g = 0.98;
  sun.color.b = 0.92;
  sun.forward = [0.35, -0.85, -0.4];
  scene.add(sun);
  orbitControls = new OrbitControls(camera, canvas);
  orbitControls.minDistance = 0.1;
  orbitControls.maxDistance = 50000;
  orbitControls.enableDamping = true;

  fpsControls = new FirstPersonControls(camera, canvas);
  fpsControls.movementSpeed = Number(input("moveSpeed").value);
  fpsControls.lookSpeed = 0.15;
  fpsControls.dampingFactor = 0.35;

  fpsControls.addEventListener("change", () => {
    if (fpsControls && select("controlsMode").value === "fps") {
      const currentSpeed = Math.round(fpsControls.movementSpeed * 10) / 10;
      if (input("moveSpeed").value !== String(currentSpeed)) {
        input("moveSpeed").value = String(currentSpeed);
      }
    }
  });

  applyControls();
  placeCamera("courtyard");
  resizeObserver = new ResizeObserver(() => {
    if (select("extent").value === "window") {
      interruptRecord("窗口分辨率改变");
      resize();
    }
  });
  resizeObserver.observe(canvas);
  event(`已发布 ${cooked.source.count} 实例 / ${progress.total} 包`);
  previousTime = performance.now();
  frameId = requestAnimationFrame(frame);
  paint();
}

function frame(now: number): void {
  if (closing || !renderer || !cooked) {
    return;
  }
  const interval = Math.max(0, now - previousTime);
  previousTime = now;
  const delta = Math.min(0.1, interval / 1000);
  try {
    if ((!paused || stepPending) && !document.hidden) {
      const activeMode = select("controlsMode").value;
      if (activeMode === "fps") {
        fpsControls?.update(delta);
      } else {
        orbitControls?.update(delta);
      }
      camera.update();
      if (record?.state === "warmup" && now >= record.sampleMs) {
        record.state = "sampling";
        record.startFrame = lastFrame + 1;
      }
      if (record?.state === "sampling" && now >= record.endMs) {
        record.state = "draining";
        record.endFrame = lastFrame;
      }
      renderer.profiler.recordExternalMetric("frame.rafIntervalMs", interval);
      const submitted = renderer.render(camera, scene, delta);
      if (submitted) {
        submittedFrames++;
        stepPending = false;
        if (firstFrameMs === null) {
          firstFrameMs = now - startedAt;
          event("首次场景帧提交");
        }
      } else {
        deferredFrames++;
      }
      if (record?.state === "draining" && now >= record.drainMs) {
        record.state = "done";
        event("定时采样完成");
      }
    }
    if (renderer.profiler.diagnostics.deviceLostCount) {
      throw new Error(`WebGPU device lost: ${renderer.profiler.diagnostics.deviceLostReasons.join(", ")}`);
    }
    const streamError = renderer.geometryStreamingError();
    if (streamError) {
      throw new Error(`Geometry streaming: ${streamError}`);
    }
    frameId = requestAnimationFrame(frame);
  } catch (error) {
    fail(error);
  }
}

function release(): Promise<void> {
  cleanup ??= (async () => {
    closing = true;
    abort.abort(new Error("用户中止 / 页面释放"));
    cancelAnimationFrame(frameId);
    clearInterval(refreshId);
    resizeObserver?.disconnect();
    orbitControls?.dispose();
    fpsControls?.dispose();
    unsubscribe?.();
    interruptRecord("场景已释放");
    try {
      if (initialization) {
        try {
          await initialization;
        } catch (error) {
          event(`初始化未完成 · ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // Await the in-flight admission so it cannot publish into a destroyed device.
      if (loading) {
        try {
          cooked = await loading;
        } catch (error) {
          if (!failure) {
            event(`加载已中止 · ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      if (cooked && renderer) {
        await renderer.releaseScene(scene);
        cooked.disposeSources();
      }
    } catch (error) {
      failure ??= `释放失败：${error instanceof Error ? error.message : String(error)}`;
      console.error(error);
    } finally {
      cooked?.disposeSources();
      renderer?.destroy();
      canvas.getContext("webgpu")?.unconfigure();
      if (!failure) {
        progress.phase = "已中止 / 已释放 · 可重新加载";
      }
      event("资源释放完成");
      paint();
    }
  })();
  return cleanup;
}

element<HTMLFormElement>("load-form").addEventListener("submit", (event) => {
  event.preventDefault();
  reloadRange();
});
function reloadRange(): void {
  if (!element<HTMLFormElement>("load-form").reportValidity()) {
    return;
  }
  const url = new URL(location.href);
  for (const key of Object.keys(defaults)) {
    url.searchParams.set(key, input(key).value);
  }
  for (const id of ["sse", "fov", "speed", "view", "extent", "scale", "profile"]) {
    url.searchParams.set(id, element<HTMLInputElement | HTMLSelectElement>(id).value);
  }
  for (const id of ["hzb", "cone", "taa", "ao", "bloom", "orbit"]) {
    url.searchParams.set(id, input(id).checked ? "1" : "0");
  }
  void release().then(() => location.assign(url.href));
}
element("full").addEventListener("click", () => {
  input("packStart").value = "0";
  input("packCount").value = "0";
  reloadRange();
});
element("probe").addEventListener("click", () => {
  input("packStart").value = "2096";
  input("packCount").value = "1";
  reloadRange();
});
element("courtyard").addEventListener("click", () => placeCamera("courtyard"));
element("interior").addEventListener("click", () => placeCamera("interior"));
element("overview").addEventListener("click", () => placeCamera("overview"));
function togglePause(): void {
  paused = !paused;
  element("pause").textContent = paused ? "继续" : "暂停";
  interruptRecord(paused ? "已暂停" : "已继续");
  paint();
}
element("pause").addEventListener("click", togglePause);
element("step").addEventListener("click", () => {
  if (!paused) {
    togglePause();
  }
  stepPending = true;
});
element("release").addEventListener("click", () => {
  void release();
});
element("toggle").addEventListener("click", () => {
  const panel = element("panel");
  panel.hidden = !panel.hidden;
  document.body.classList.toggle("panel-hidden", panel.hidden);
  element("toggle").setAttribute("aria-expanded", String(!panel.hidden));
});
for (const id of [
  "sse",
  "view",
  "hzb",
  "cone",
  "extent",
  "scale",
  "taa",
  "ao",
  "bloom",
  "orbit",
  "speed",
  "fov",
  "profile",
  "controlsMode",
  "moveSpeed"
]) {
  element<HTMLInputElement | HTMLSelectElement>(id).addEventListener("change", () => {
    if (element<HTMLInputElement | HTMLSelectElement>(id).checkValidity() && !closing) {
      if (id === "controlsMode") {
        const mode = select("controlsMode").value as "fps" | "orbit";
        if (mode === "fps") {
          fpsControls?.setOrientation();
        } else if (mode === "orbit" && orbitControls) {
          const f = camera.transform.forward;
          const p = camera.transform.position;
          orbitControls.target.set(p.x + f.x * 10, p.y + f.y * 10, p.z + f.z * 10);
          orbitControls.update(0);
        }
      }
      interruptRecord(`${id} 参数改变`);
      applyControls();
      event(`${id} 已更新`);
      paint();
    }
  });
}
canvas.addEventListener("pointerdown", () => interruptRecord("手动操作相机"));
canvas.addEventListener("wheel", () => interruptRecord("手动操作相机"), { passive: true });
document.addEventListener("visibilitychange", () => interruptRecord("页面可见状态改变"));
element("clear").addEventListener("click", () => {
  interruptRecord("清空统计");
  record = undefined;
  paint();
});
element("record").addEventListener("click", () => {
  if (
    !cooked ||
    paused ||
    closing ||
    select("profile").value === "off" ||
    !input("warmup").checkValidity() ||
    !input("duration").checkValidity()
  ) {
    element("record-status").textContent = "请在运行且采集开启时采样，并输入有效时间";
    return;
  }
  const now = performance.now();
  const sampleMs = now + Number(input("warmup").value) * 1000;
  const endMs = sampleMs + Number(input("duration").value) * 1000;
  record = {
    state: "warmup",
    startMs: now,
    sampleMs,
    endMs,
    drainMs: endMs + 1000,
    startFrame: Infinity,
    endFrame: Infinity,
    conditions: conditions(),
    frames: new Map()
  };
  event("定时采样开始");
  paint();
});
element("export").addEventListener("click", () => {
  const capturedFrames = record ? record.frames : frames;
  const result = {
    ...snapshot(),
    recording: record ? { ...record, frames: undefined } : null,
    recordedStats: stats(capturedFrames.values()),
    frames: [...capturedFrames.values()]
  };
  const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `zorah-stress-${Date.now()}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener("keydown", (event) => {
  if ((event.target as HTMLElement).matches("input, select, textarea")) {
    return;
  }
  // P 键触发暂停；若在 Orbit 模式下，空格也可触发暂停；在 FPS 模式下，空格保留为飞行上升
  if (event.code === "KeyP" || (event.code === "Space" && select("controlsMode").value !== "fps")) {
    event.preventDefault();
    togglePause();
  } else if (event.code === "KeyH") {
    element("toggle").click();
  }
});
window.addEventListener(
  "pagehide",
  () => {
    void release();
  },
  { once: true }
);
paint();
void start().catch((error) => {
  if (!closing) {
    fail(error);
  }
});

import {
  cookSceneGeometryProductV1,
  createDefaultWebGeometryCookerModule,
  OrbitControls,
  PerspectiveCamera,
  Renderer
} from "../../../../OEngine/src/index.ts";
import {
  SURFACE_CACHE_GI_DEFAULTS,
  surfaceCacheGiSettings,
  type SurfaceCacheGiSettings
} from "../../../../OEngine/src/render/gi/SurfaceCacheGiSettings.ts";
import type { FrameProfileSnapshot } from "../../../../OEngine/src/debug/FrameProfiler.ts";
import {
  CAMERAS,
  createLabScene,
  EXPERIMENTS,
  SCENE_DEFAULTS,
  type CameraName,
  type ExperimentName,
  type SceneParameters
} from "./scene.ts";

const element = <T extends HTMLElement>(id: string) => {
  const result = document.getElementById(id);
  if (!result) {
    throw new Error(`Missing demo element #${id}`);
  }
  return result as T;
};
const canvas = element<HTMLCanvasElement>("viewport");
const status = element("status");
const controlsElement = element<HTMLFieldSetElement>("controls");
const lab = createLabScene();
const camera = new PerspectiveCamera();
camera.near = 0.04;
camera.far = 80;
const orbit = new OrbitControls(camera, canvas);
orbit.keyboard.stop(); // Editing a numeric input must not pan the camera.
orbit.enableDamping = false;
orbit.minDistance = 0.15;
orbit.maxDistance = 40;

const LAB_GI: SurfaceCacheGiSettings = surfaceCacheGiSettings({
  enabled: true,
  resolution: 8,
  cascades: 3,
  patches: 4096,
  updates: 128,
  requests: 2048,
  bounceRequests: 256,
  voxelSize: 1,
  hemisphereSamples: 8,
  connectionSamples: 2,
  lightSamples: 32,
  batchRays: 128,
  maximumLights: 32,
  primitiveCapacity: 4096,
  queryMaximumBytes: 64 * 1024 ** 2,
  gather: true,
  gatherTile: 12,
  gatherDirections: 16,
  gatherBatchRays: 65536,
  gatherDistance: 3
});

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
interface Presentation {
  width: number;
  scale: number;
  exposure: number;
  temporal: boolean;
  jitter: boolean;
  ao: boolean;
  ssr: boolean;
  bloom: boolean;
  shadows: boolean;
}
const presentation: Presentation = {
  width: 1920,
  scale: 1,
  exposure: 4,
  temporal: true,
  jitter: false,
  ao: false,
  ssr: false,
  bloom: false,
  shadows: true
};
// URL overrides are explicit user/debug choices, never adaptive downgrades.
const launchParameters = new URLSearchParams(location.search);
const launchWidth = Number(launchParameters.get("width"));
const launchScale = Number(launchParameters.get("scale"));
if ([320, 640, 960, 1280, 1920].includes(launchWidth)) {
  presentation.width = launchWidth;
}
if ([0.5, 0.667, 0.75, 1].includes(launchScale)) {
  presentation.scale = launchScale;
}
const gi: Mutable<SurfaceCacheGiSettings> = { ...LAB_GI };
const sceneParameters: SceneParameters = { ...SCENE_DEFAULTS };
const experiment = {
  preset: "sun" as ExperimentName,
  camera: "main" as CameraName,
  animate: false,
  frames: 16
};
let activeScene = { ...sceneParameters };
let activeAnimate = false;
let appliedExperiment: ExperimentName = "sun";
let effectiveScene: SceneParameters = { ...sceneParameters };
let appliedPresentation = { ...presentation };
let renderer: Renderer;
let geometryProduct: Awaited<ReturnType<typeof cookSceneGeometryProductV1>>;
let disposed = false;
let ready = false;
let running = !new URLSearchParams(location.search).has("paused");
let fatal: string | undefined;
let busy = false;
let simulationTick = 0;
let settledFrame: Promise<void> | null = null;
let operations: Promise<void> = Promise.resolve();
let lastProfile: FrameProfileSnapshot | undefined;
let sampledGpu: {
  frame: number;
  commandSpanMs: number | null;
  passSumMs: number | null;
  complete: boolean;
  segments: FrameProfileSnapshot["gpu"]["segments"];
} | null = null;
let unsubscribeProfile: (() => void) | undefined;
const errors: string[] = [];
const inputRefreshers: (() => void)[] = [];
const objectUrls: string[] = [];
let initialFrame = 0;
let comparisonLabel = "interactive";

function message(text: string, state = "ready"): void {
  status.textContent = text;
  status.dataset.state = state;
}

function fail(error: unknown): void {
  const text = error instanceof Error ? error.message : String(error);
  errors.push(text);
  fatal = text;
  running = false;
  message(text, "error");
  console.error(error);
  refreshAvailability();
}

function dirty(): void {
  element("dirty").textContent = "有待应用的参数";
}

function refreshInputs(): void {
  for (const refresh of inputRefreshers) {
    refresh();
  }
  element("dirty").textContent = "已应用";
}

function refreshAvailability(): void {
  const disabled = busy || !ready || disposed || Boolean(fatal);
  controlsElement.disabled = disabled;
  orbit.enabled = !disabled;
  for (const id of ["run", "step", "warm", "fullscreen", "capture", "apply", "reset", "compare"]) {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (button) {
      button.disabled = disabled;
    }
  }
  element("run").textContent = running ? "暂停渲染" : "继续渲染";
}

function group(title: string, hint: string, open = false): HTMLElement {
  const details = document.createElement("details");
  details.open = open;
  const summary = document.createElement("summary");
  summary.textContent = title;
  const description = document.createElement("p");
  description.className = "hint";
  description.textContent = hint;
  details.append(summary, description);
  controlsElement.append(details);
  return details;
}

let controlSerial = 0;
function field(
  parent: HTMLElement,
  title: string,
  input: HTMLInputElement | HTMLSelectElement,
  wide = false
): void {
  const row = document.createElement("div");
  row.className = wide ? "field wide" : "field";
  const label = document.createElement("label");
  input.id = `parameter-${++controlSerial}`;
  input.dataset.parameter = title;
  label.htmlFor = input.id;
  label.textContent = title;
  row.append(label, input);
  parent.append(row);
}

function number<T extends object>(
  parent: HTMLElement,
  object: T,
  key: keyof T,
  title: string,
  min: number,
  max: number,
  step = 1
): void {
  const input = document.createElement("input");
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.addEventListener("change", () => {
    const value = input.valueAsNumber;
    if (input.checkValidity() && Number.isFinite(value)) {
      object[key] = value as T[keyof T];
      dirty();
    } else {
      input.reportValidity();
    }
  });
  inputRefreshers.push(() => {
    input.value = String(object[key]);
  });
  field(parent, title, input);
}

function toggle<T extends object>(parent: HTMLElement, object: T, key: keyof T, title: string): void {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.addEventListener("change", () => {
    object[key] = input.checked as T[keyof T];
    dirty();
  });
  inputRefreshers.push(() => {
    input.checked = Boolean(object[key]);
  });
  field(parent, title, input);
}

function select<T extends object>(
  parent: HTMLElement,
  object: T,
  key: keyof T,
  title: string,
  options: readonly (readonly [string, string])[],
  wide = false
): void {
  const input = document.createElement("select");
  for (const [value, label] of options) {
    input.add(new Option(label, value));
  }
  input.addEventListener("change", () => {
    object[key] = (typeof object[key] === "number" ? Number(input.value) : input.value) as T[keyof T];
    dirty();
  });
  inputRefreshers.push(() => {
    input.value = String(object[key]);
  });
  field(parent, title, input, wide);
}

const debugModes: readonly (readonly [SurfaceCacheGiSettings["debug"], string])[] = [
  ["off", "最终画面 · world + gather"],
  ["appearance-world-only", "最终画面 · 仅 world GI"],
  ["world-only", "仅 world irradiance"],
  ["irradiance", "组合 irradiance"],
  ["confidence", "world confidence"],
  ["residual", "signed residual · 红正 / 蓝负"],
  ["gather-confidence", "gather confidence"],
  ["gather-source", "diffuse source · 非最终 HDR"]
];

function buildControls(): void {
  const experiments = group(
    "01 · 实验 / 观察点",
    "预设会恢复场景基准并清空 GI；只换相机则保留 world cache、重置画面历史。",
    true
  );
  select(
    experiments,
    experiment,
    "preset",
    "实验预设",
    Object.entries(EXPERIMENTS).map(([key, value]) => [key, value.label]),
    true
  );
  select(
    experiments,
    experiment,
    "camera",
    "固定观察点",
    Object.entries(CAMERAS).map(([key, value]) => [key, value.label]),
    true
  );
  toggle(experiments, experiment, "animate", "播放刚体实验");
  number(experiments, experiment, "frames", "累积 / 比较帧数", 1, 512);
  const compare = document.createElement("button");
  compare.id = "compare";
  compare.type = "button";
  compare.textContent = "生成三组独立暖机对比";
  compare.addEventListener("click", () => {
    void schedule(compareModes);
  });
  experiments.append(compare);
  const scene = group(
    "02 · 门窗 / 光照 / 材质",
    "门窗为刚体平移。发光片不附带补光；默认不开点光源。光色和反射率使用线性 RGB。",
    true
  );
  number(scene, sceneParameters, "door", "门开启比例", 0, 1, 0.05);
  number(scene, sceneParameters, "shutter", "窗开启比例", 0, 1, 0.05);
  number(scene, sceneParameters, "blocker", "走廊遮挡比例", 0, 1, 0.05);
  number(scene, sceneParameters, "emitterX", "发光片 X 偏移 (m)", -0.4, 0.4, 0.05);
  number(scene, sceneParameters, "emission", "发光强度 (HDR)", 0, 100, 0.5);
  number(scene, sceneParameters, "sun", "太阳辐照度倍率", 0, 20, 0.1);
  number(scene, sceneParameters, "sunElevation", "太阳高度 (°)", 5, 85);
  number(scene, sceneParameters, "sunAzimuth", "太阳方位 (°)", -180, 180);
  number(scene, sceneParameters, "sky", "天空亮度倍率", 0, 3, 0.05);
  number(scene, sceneParameters, "point", "诊断点光源强度", 0, 50, 0.5);
  toggle(scene, sceneParameters, "coloredWalls", "红 / 绿反弹墙");
  number(scene, sceneParameters, "roughness", "白墙粗糙度", 0.05, 1, 0.05);

  const cache = group(
    "03 · World Surface Cache",
    "表示 / 容量变化可能重建工作集；这是显式画质选择，不是显存档位承诺。覆盖尺度约为 resolution × voxelSize × 2^cascade。",
    true
  );
  toggle(cache, gi, "enabled", "开启 SCGI");
  number(cache, gi, "voxelSize", "基础 cell (m)", 0.125, 4, 0.125);
  number(cache, gi, "resolution", "每级网格边长", 4, 24, 2);
  number(cache, gi, "cascades", "级联数量", 1, 4);
  number(cache, gi, "patches", "Patch 容量", 512, 32768, 512);
  number(cache, gi, "updates", "每帧 Patch 更新", 16, 512, 16);
  number(cache, gi, "hemisphereSamples", "半球样本 / 更新", 1, 64);
  number(cache, gi, "connectionSamples", "连接样本 / 更新", 1, 16);
  number(cache, gi, "lightSamples", "光源候选样本", 1, 128);
  toggle(cache, gi, "multiBounce", "多跳传播");
  toggle(cache, gi, "spatial", "空间过滤");
  toggle(cache, gi, "post", "后置过滤");
  number(cache, gi, "spatialTaps", "空间 taps", 1, 32);
  number(cache, gi, "lookupTaps", "查询 taps", 1, 32);

  const gather = group(
    "04 · 近场残差 / 调试信号",
    "Gather 读取上一已提交帧的残差。冻结仅冻结 Gather 更新，world GI 仍更新；不是全局 freeze。方向数改变采样量，batch 只改变执行切分。",
    true
  );
  toggle(gather, gi, "gather", "开启近场 Gather");
  toggle(gather, gi, "gatherFreeze", "冻结 Gather 历史");
  number(gather, gi, "gatherTile", "Probe tile (internal px)", 4, 32, 2);
  number(gather, gi, "gatherDirections", "方向 / probe", 1, 256);
  number(gather, gi, "gatherDistance", "近场距离 (m)", 0.25, 8, 0.25);
  number(gather, gi, "gatherBatchRays", "Gather batch 容量", 256, 65536, 256);
  select(gather, gi, "debug", "显示信号", debugModes, true);

  const display = group(
    "05 · 输出 / 重建 / 干扰项",
    "默认和最高输出为 1920×1080，internal scale 默认 1.0。不随窗口或 DPR 偷改分辨率；低尺寸只供手动调试。曝光是 Renderer 不可变配置，修改后将重建并重新上传同一 Product。"
  );
  select(
    display,
    presentation,
    "width",
    "输出宽度",
    [320, 640, 960, 1280, 1920].map((value) => [String(value), String(value)])
  );
  select(display, presentation, "scale", "Internal scale", [
    ["0.5", "0.5"],
    ["0.667", "0.667"],
    ["0.75", "0.75"],
    ["1", "1.0"]
  ]);
  number(display, presentation, "exposure", "固定曝光", 0.0625, 32, 0.0625);
  toggle(display, presentation, "temporal", "Temporal 重建");
  toggle(display, presentation, "jitter", "Temporal jitter");
  toggle(display, presentation, "ao", "XeGTAO");
  toggle(display, presentation, "ssr", "SSSR");
  toggle(display, presentation, "bloom", "Bloom");
  toggle(display, presentation, "shadows", "VSM / 太阳阴影");
  const advanced = group(
    "06 · 工作容量 / 执行",
    "超过设备或工作集上界会明确报错，不截断几何。batchRays 是执行批大小，不是每像素 ray 数。参数上限仅是本 demo 的交互范围。"
  );
  number(advanced, gi, "batchRays", "Estimator batch", 32, 1024, 32);
  number(advanced, gi, "requests", "请求容量", 512, 8192, 512);
  number(advanced, gi, "bounceRequests", "Bounce 请求容量", 64, 2048, 64);
  number(advanced, gi, "primitiveCapacity", "Query primitive 容量", 1024, 32768, 1024);
  number(advanced, gi, "maximumLights", "Local light 容量", 1, 4096);
  select(
    advanced,
    gi,
    "queryMaximumBytes",
    "Query 预算 (MiB)",
    [32, 64, 128, 256].map((value) => [String(value * 1024 ** 2), String(value)])
  );
  refreshInputs();
}

let selectedCamera: CameraName;
function setCamera(name: CameraName): void {
  const view = CAMERAS[name];
  orbit.target.set(view.target[0], view.target[1], view.target[2]);
  camera.transform.position.set(view.eye[0], view.eye[1], view.eye[2]);
  camera.transform.lookAt(orbit.target);
  orbit.reset();
  camera.update();
  selectedCamera = name;
  experiment.camera = name;
  renderer?.invalidateTemporalHistory();
  element("view-label").textContent = view.label;
}

function applyScene(advance: boolean): void {
  if (advance && activeAnimate) {
    simulationTick++;
  }
  effectiveScene = { ...activeScene };
  if (activeAnimate) {
    // Deterministic frame-based motion: one tick is 1/30 simulated second,
    // independent of GPU throughput. Pause retains the exact tick and pose.
    const phase = (simulationTick / 240) * Math.PI * 2;
    if (appliedExperiment === "door") {
      effectiveScene.door = (1 - Math.cos(phase)) * 0.5;
    } else if (appliedExperiment === "blocker") {
      effectiveScene.blocker = (1 - Math.cos(phase)) * 0.5;
    } else if (appliedExperiment === "emitter") {
      effectiveScene.emitterX = Math.sin(phase) * 0.4;
      effectiveScene.emission = simulationTick % 240 < 180 ? activeScene.emission : 0;
    } else if (appliedExperiment === "sun") {
      effectiveScene.shutter = (1 - Math.cos(phase)) * 0.5;
    }
  }
  lab.apply(effectiveScene);
}

async function createRenderer(): Promise<void> {
  if (!navigator.gpu) {
    throw new Error("当前浏览器没有 WebGPU；请使用支持 WebGPU 的浏览器和 GPU。");
  }
  const context = canvas.getContext("webgpu");
  if (!context) {
    throw new Error("无法创建 WebGPU canvas context");
  }
  renderer = new Renderer({
    autoExposure: false,
    fixedExposure: presentation.exposure,
    enableVsm: true,
    enablePhysicalEnvironment: true,
    surfaceCacheGi: gi,
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 }
  });
  renderer.bloom_enabled = presentation.bloom;
  renderer.pixel_ratio = 1;
  await renderer.initialize({ context });
  const owner = renderer;
  owner.device.addEventListener("uncapturederror", (event) => {
    if (owner === renderer && !disposed) {
      fail(new Error(`WebGPU: ${event.error.message}`));
    }
  });
  void owner.device.lost.then((info) => {
    if (owner === renderer && !disposed && info.reason !== "destroyed") {
      fail(new Error(`GPU device lost: ${info.reason} ${info.message}。请刷新示例重新初始化。`));
    }
  });
  renderer.profiler.configure({
    enabled: true,
    gpuSampleInterval: 8,
    gpuCounterSampleInterval: 32,
    historyCapacity: 128,
    readbackRingSlots: 4,
    cpuPassTimings: false
  });
  unsubscribeProfile = renderer.profiler.subscribe((profile) => {
    lastProfile = profile;
    if (profile.gpu.sampled && !profile.gpu.pending && profile.gpu.available) {
      sampledGpu = {
        frame: profile.frameIndex,
        commandSpanMs: profile.gpu.cost?.commandSpanMs ?? null,
        passSumMs: profile.gpu.cost?.passSumMs ?? null,
        complete: profile.gpu.cost?.complete ?? false,
        segments: profile.gpu.segments
      };
    }
  });
  await renderer.uploadCookedSceneProduct(lab.scene, geometryProduct);
  applyPresentation();
  appliedPresentation = { ...presentation };
}

function applyPresentation(): void {
  const height = (presentation.width * 9) / 16;
  renderer.setResolutionScale(presentation.scale);
  renderer.resize(presentation.width, height);
  canvas.parentElement!.style.aspectRatio = `${presentation.width} / ${height}`;
  camera.aspect = presentation.width / height;
  camera.update();
  renderer.fsr3_enabled = presentation.temporal;
  renderer.temporal_jitter_enabled = presentation.jitter;
  renderer.bloom_enabled = presentation.bloom;
  renderer.shadowVisibilityEnabled = presentation.shadows;
  renderer.setAmbientOcclusionSettings({ enabled: presentation.ao });
  renderer.setScreenSpaceReflectionsSettings({ enabled: presentation.ssr });
  renderer.invalidateTemporalHistory();
}

/** One host frame at a time. Waiting for asynchronous preparation never
 * advances animation or camera input a second time. No per-frame GPU readback. */
async function draw(advance = false): Promise<void> {
  if (disposed || fatal) {
    throw new Error(fatal ?? "Demo disposed");
  }
  applyScene(advance);
  orbit.update(1 / 30);
  const frame = renderer.frame_count;
  const deadline = performance.now() + 120000;
  const preparingNotice = window.setTimeout(() => {
    if (!disposed && !fatal && renderer.frame_count === frame) {
      message("本帧仍在准备 / 编码；首次完整 query 需要编译。暂停可停止后续帧，当前工作会正常完成。");
    }
  }, 900);
  try {
    while (renderer.frame_count === frame) {
      if (disposed || fatal) {
        throw new Error(fatal ?? "Demo disposed");
      }
      if (performance.now() > deadline) {
        throw new Error("单帧等待超过 120 秒；查看控制台的 GPU / 工作集错误。");
      }
      renderer.render(camera, lab.scene, 1 / 30);
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 8);
      });
    }
  } finally {
    window.clearTimeout(preparingNotice);
  }
}

function schedule(work: () => Promise<void>): Promise<void> {
  // Busy is set before waiting for the active live frame. UI and scripted
  // operations use the same serialization; no resize/reset races preparation.
  busy = true;
  refreshAvailability();
  const next = operations.then(async () => {
    await settledFrame;
    await work();
    updateMetrics();
  });
  operations = next.then(
    () => {
      busy = false;
      refreshAvailability();
    },
    (error) => {
      busy = false;
      fail(error);
      throw error;
    }
  );
  // Mark the queue rejection handled for DOM callers, while preserving the
  // rejecting return value for browser automation and explicit consumers.
  void operations.catch(() => {});
  return operations;
}

async function frames(count: number, advance: boolean): Promise<void> {
  for (let index = 0; index < count; index++) {
    message(`累积 ${index + 1} / ${count} 帧 · ${comparisonLabel}`);
    await draw(advance);
  }
  // Diagnostic batch completion only; the interactive loop does not wait for
  // queue completion or read back GPU data on every frame.
  await renderer.device.queue.onSubmittedWorkDone();
}

async function resetGi(): Promise<void> {
  const desired = renderer.surfaceCacheGiSettings;
  renderer.setSurfaceCacheGiSettings({ enabled: false });
  await draw();
  await renderer.device.queue.onSubmittedWorkDone();
  renderer.setSurfaceCacheGiSettings(desired);
  renderer.invalidateTemporalHistory();
  renderer.resetExposure();
  initialFrame = renderer.frame_count;
  sampledGpu = null;
}

async function apply(): Promise<void> {
  for (const input of controlsElement.querySelectorAll("input")) {
    if (!input.checkValidity()) {
      message(`参数超出范围：${input.dataset.parameter}`, "error");
      return;
    }
  }
  let validated: SurfaceCacheGiSettings;
  try {
    validated = surfaceCacheGiSettings(gi, SURFACE_CACHE_GI_DEFAULTS);
  } catch (error) {
    message(error instanceof Error ? error.message : String(error), "error");
    return;
  }
  const presetChanged = appliedExperiment !== experiment.preset;
  if (presetChanged) {
    Object.assign(sceneParameters, SCENE_DEFAULTS, EXPERIMENTS[experiment.preset].parameters);
    experiment.camera = EXPERIMENTS[experiment.preset].camera;
    simulationTick = 0;
  } else if (activeAnimate && !experiment.animate) {
    const motionKeys: Partial<Record<ExperimentName, (keyof SceneParameters)[]>> = {
      sun: ["shutter"],
      door: ["door"],
      blocker: ["blocker"],
      emitter: ["emitterX", "emission"]
    };
    // Stop at the current pose unless the user explicitly entered a new pose
    // in the same edit. Lighting history is not silently reset by this pause.
    for (const key of motionKeys[appliedExperiment] ?? []) {
      if (sceneParameters[key] === activeScene[key]) {
        Object.assign(sceneParameters, { [key]: effectiveScene[key] });
      }
    }
  }
  appliedExperiment = experiment.preset;
  activeScene = { ...sceneParameters };
  activeAnimate = experiment.animate;
  applyScene(false);
  const rebuild = presentation.exposure !== appliedPresentation.exposure;
  if (rebuild) {
    message("曝光配置变化：退休 Renderer，复用 CPU GeometryProduct 重新上传…");
    await renderer.device.queue.onSubmittedWorkDone();
    unsubscribeProfile?.();
    renderer.destroy();
    sampledGpu = null;
    lastProfile = undefined;
    await createRenderer();
  } else {
    renderer.setSurfaceCacheGiSettings(validated);
    if (JSON.stringify(presentation) !== JSON.stringify(appliedPresentation)) {
      applyPresentation();
    } else {
      renderer.invalidateTemporalHistory();
    }
  }
  if (experiment.camera !== selectedCamera || presetChanged || rebuild) {
    setCamera(experiment.camera);
  }
  if (presetChanged || rebuild) {
    await resetGi();
  }
  appliedPresentation = { ...presentation };
  element("purpose").textContent = EXPERIMENTS[experiment.preset].purpose;
  refreshInputs();
  // Gather is a previous-submission signal. A paused diagnostic must show a
  // consumer frame after its first producer frame, not only the cleared reset.
  await frames(renderer.surfaceCacheGiSettings.gather ? 2 : 1, false);
  element("signal-label").textContent = debugModes.find(([key]) => key === gi.debug)?.[1] ?? gi.debug;
  message("参数已应用；可继续累积、播放实验或导出当前帧。");
}

function snapshot() {
  return {
    schemaVersion: 1,
    example: "surface-cache-gi-lab",
    capturedAt: new Date().toISOString(),
    scope: "Interactive procedural lab; not SCGI-10 qualification, path-traced truth or a benchmark",
    scene: lab.metadata,
    preset: appliedExperiment,
    comparisonLabel,
    frame: renderer.frame_count,
    submittedFramesSinceReset: renderer.frame_count - initialFrame,
    simulation: { tick: simulationTick, secondsPerTick: 1 / 30, animate: activeAnimate },
    authoredScene: { ...activeScene },
    effectiveScene: { ...effectiveScene },
    camera: {
      selectedView: selectedCamera,
      eye: [camera.transform.position.x, camera.transform.position.y, camera.transform.position.z],
      target: [orbit.target.x, orbit.target.y, orbit.target.z],
      near: camera.near,
      far: camera.far,
      projection: Array.from(camera.projection_matrix),
      viewProjection: Array.from(camera.view_projection_matrix)
    },
    settings: { ...renderer.surfaceCacheGiSettings },
    presentation: { ...appliedPresentation },
    resolution: renderer.resolutionEvidence(),
    scgi: renderer.surfaceCacheGiEvidence(),
    memory: renderer.memoryEvidence(),
    temporal: renderer.temporalHistoryEvidence(),
    submission: renderer.frameSubmissionEvidence(),
    device: {
      features: Array.from(renderer.device.features).sort(),
      maxStorageBuffersPerShaderStage: renderer.device.limits.maxStorageBuffersPerShaderStage,
      maxStorageBufferBindingSize: renderer.device.limits.maxStorageBufferBindingSize,
      maxBufferSize: renderer.device.limits.maxBufferSize
    },
    lastProfile,
    sampledGpu,
    errors: [...errors],
    limitations: [
      "Memory accounting is explicit engine allocation, not total driver VRAM; see owner exclusions.",
      "Ray and dispatch bounds are theoretical encoded upper bounds, not executed counts.",
      "GPU command span, if available, is a sampled timestamp interval; not a P50/P95 benchmark or queue latency.",
      "Local point main-view shadows are incomplete; default point intensity is zero.",
      "No cache-age/AS-unknown GPU readback is invented; these require further instrumentation.",
      "Comparison images are independent equal-frame warmups, not frozen identical cache samples."
    ]
  };
}

function updateMetrics(): void {
  const resolution = renderer.resolutionEvidence();
  const scgi = renderer.surfaceCacheGiEvidence();
  const mib = (value: number) => `${(value / 1024 ** 2).toFixed(1)} MiB`;
  const metrics = [
    ["Output / internal", `${resolution.output.join("×")} / ${resolution.internal.join("×")}`],
    ["已提交帧 / 自重置", `${renderer.frame_count} / ${renderer.frame_count - initialFrame}`],
    ["SCGI 当前 owner*", scgi ? mib(scgi.currentOwnedBytes) : "未分配"],
    [
      "Query 已发布 AS 分片",
      scgi ? `${scgi.queryShards}${scgi.queryShards === 0 ? " · 冷准备 / 无分片" : ""}` : "未分配"
    ],
    [
      "CPU 主图编码",
      lastProfile?.cpuMs["graph-execute"] != null
        ? `${lastProfile.cpuMs["graph-execute"].toFixed(2)} ms`
        : "等待采样"
    ],
    [
      "执行 batch · Est / Gather",
      `${renderer.surfaceCacheGiSettings.batchRays} / ${renderer.surfaceCacheGiSettings.gatherBatchRays}`
    ],
    [
      "Gather rays 上界 / 帧",
      scgi?.gather ? scgi.gather.probeRaysUpperBound.toLocaleString() : "关闭 / 未分配"
    ],
    [
      "Gather dispatch 上界",
      scgi?.gather ? scgi.gather.maximumEncodedDispatches.toLocaleString() : "关闭 / 未分配"
    ],
    [
      "采样 GPU command span*",
      sampledGpu?.commandSpanMs != null && sampledGpu.complete
        ? `${sampledGpu.commandSpanMs.toFixed(2)} ms · f${sampledGpu.frame}`
        : "不可用 / 等待采样"
    ]
  ];
  element("metrics").replaceChildren(
    ...metrics.map(([title, value]) => {
      const row = document.createElement("div");
      row.className = "metric";
      const label = document.createElement("small");
      label.textContent = title;
      const result = document.createElement("strong");
      result.textContent = value;
      row.append(label, result);
      return row;
    })
  );
  if ((element("diagnostics").parentElement as HTMLDetailsElement).open) {
    element("diagnostics").textContent = JSON.stringify(snapshot(), null, 2);
  }
}

async function capture(label: string = renderer.surfaceCacheGiSettings.debug): Promise<void> {
  await renderer.device.queue.onSubmittedWorkDone();
  const metadata = snapshot();
  const image = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Canvas PNG 导出失败"))), "image/png");
  });
  const imageUrl = URL.createObjectURL(image);
  const jsonUrl = URL.createObjectURL(
    new Blob([JSON.stringify(metadata, null, 2)], { type: "application/json" })
  );
  objectUrls.push(imageUrl, jsonUrl);
  const card = document.createElement("article");
  card.className = "capture";
  const preview = document.createElement("img");
  preview.src = imageUrl;
  preview.alt = `${appliedExperiment} / ${label}`;
  const description = document.createElement("p");
  description.textContent = `${appliedExperiment} · ${label} · f${metadata.frame} · 暖机 ${metadata.submittedFramesSinceReset} 帧`;
  const name = `scgi-${appliedExperiment}-${label}-${metadata.frame}`;
  const imageLink = document.createElement("a");
  imageLink.href = imageUrl;
  imageLink.download = `${name}.png`;
  imageLink.textContent = "下载 PNG";
  const jsonLink = document.createElement("a");
  jsonLink.href = jsonUrl;
  jsonLink.download = `${name}.json`;
  jsonLink.textContent = "下载 JSON";
  card.append(preview, description, imageLink, jsonLink);
  element("captures").prepend(card);
  // Bounded host-side capture gallery, independent of GPU cache/history.
  while (element("captures").children.length > 9) {
    const last = element("captures").lastElementChild!;
    for (const anchor of last.querySelectorAll("a")) {
      URL.revokeObjectURL(anchor.href);
      const index = objectUrls.indexOf(anchor.href);
      if (index >= 0) {
        objectUrls.splice(index, 1);
      }
    }
    last.remove();
  }
}

async function compareModes(): Promise<void> {
  running = false;
  const saved = renderer.surfaceCacheGiSettings;
  const savedAnimate = activeAnimate;
  const savedScene = activeScene;
  activeScene = { ...effectiveScene };
  activeAnimate = false;
  try {
    for (const [label, enabled, gather] of [
      ["GI-off", false, false],
      ["world", true, false],
      ["world-gather", true, true]
    ] as const) {
      comparisonLabel = label;
      renderer.setSurfaceCacheGiSettings({ ...saved, enabled, gather, debug: "off", gatherFreeze: false });
      await resetGi();
      await frames(experiment.frames, false);
      await capture(label);
    }
  } finally {
    comparisonLabel = "interactive";
    activeAnimate = savedAnimate;
    activeScene = savedScene;
    renderer.setSurfaceCacheGiSettings(saved);
  }
  await resetGi();
  await frames(experiment.frames, false);
  message("三组对比已生成，渲染已暂停。每组独立清空并累积相同帧数；随机相位 / cache 不保证逐样本一致。");
}

async function live(): Promise<void> {
  if (disposed) {
    return;
  }
  if (!busy && ready && running && !fatal) {
    const started = performance.now();
    settledFrame = draw(true);
    try {
      await settledFrame;
      if (performance.now() - started > 1000) {
        message("正在渲染；当前是完整软件 query 路径，可降低 internal / 方向数或切换单步观察。");
      }
      updateMetrics();
    } catch (error) {
      fail(error);
    } finally {
      settledFrame = null;
    }
  }
  requestAnimationFrame(() => {
    void live();
  });
}

buildControls();
element("run").addEventListener("click", () => {
  running = !running;
  refreshAvailability();
  message(
    running
      ? "连续渲染；勾选并应用“播放刚体实验”可播放确定性动作。"
      : "已暂停渲染；单步仍会推进一个已提交帧。"
  );
});
element("step").addEventListener("click", () => {
  running = false;
  void schedule(async () => {
    await frames(1, true);
    message("单步完成");
  });
});
element("warm").addEventListener("click", () => {
  running = false;
  void schedule(async () => {
    await frames(experiment.frames, false);
    message("累积完成，渲染已暂停。");
  });
});
element("apply").addEventListener("click", () => {
  void schedule(apply);
});
element("reset").addEventListener("click", () => {
  void schedule(async () => {
    await resetGi();
    await frames(1, false);
    message("GI 与画面历史已清空；重新累积从此帧开始。");
  });
});
element("capture").addEventListener("click", () => {
  running = false;
  void schedule(async () => {
    await capture();
    message("当前帧 PNG 与条件 JSON 已生成，下方可预览和下载。渲染已暂停。");
  });
});
element("fullscreen").addEventListener("click", () => {
  void canvas.parentElement!.requestFullscreen().catch((error) => {
    message(`无法进入全屏：${error instanceof Error ? error.message : String(error)}`, "error");
  });
});
element("diagnostics").parentElement!.addEventListener("toggle", () => {
  if (ready) updateMetrics();
});

async function start(): Promise<void> {
  message("程序化几何 cooking；无需下载模型…");
  geometryProduct = await cookSceneGeometryProductV1(lab.scene, {
    module: await createDefaultWebGeometryCookerModule(),
    producerId: "surface-cache-gi-lab",
    producerVersion: "1",
    maxDecodedProductBytes: 64 * 1024 ** 2
  });
  message("初始化 Renderer / 上传 GeometryProduct…");
  await createRenderer();
  setCamera("main");
  element("purpose").textContent = EXPERIMENTS.sun.purpose;
  await frames(1, false);
  ready = true;
  element("app").dataset.ready = "true";
  message("实验屋已就绪。默认 1920×1080 / internal 1.0；可手动选较低尺寸调试，或累积更多帧检查质量。");
  updateMetrics();
  refreshAvailability();
  // Small demo automation seam. It calls the exact same public actions as the
  // UI and never exposes internal GPU products or replaces renderer methods.
  window.scgiLab = {
    snapshot,
    advance: (count: number) =>
      schedule(async () => {
        running = false;
        await frames(count, true);
      }),
    preset: (value: ExperimentName) =>
      schedule(async () => {
        experiment.preset = value;
        await apply();
      }),
    view: (value: CameraName) =>
      schedule(async () => {
        setCamera(value);
        refreshInputs();
        await frames(1, false);
      }),
    debug: (value: SurfaceCacheGiSettings["debug"]) =>
      schedule(async () => {
        gi.debug = value;
        await apply();
      }),
    reset: () =>
      schedule(async () => {
        await resetGi();
        await frames(1, false);
      }),
    capture: () =>
      schedule(async () => {
        running = false;
        await capture();
      }),
    compare: () => schedule(compareModes)
  };
  void live();
}

declare global {
  interface Window {
    scgiLab: {
      snapshot: typeof snapshot;
      advance: (count: number) => Promise<void>;
      preset: (value: ExperimentName) => Promise<void>;
      view: (value: CameraName) => Promise<void>;
      debug: (value: SurfaceCacheGiSettings["debug"]) => Promise<void>;
      reset: () => Promise<void>;
      capture: () => Promise<void>;
      compare: () => Promise<void>;
    };
  }
}

window.addEventListener(
  "pagehide",
  () => {
    disposed = true;
    running = false;
    orbit.dispose();
    unsubscribeProfile?.();
    renderer?.destroy();
    for (const url of objectUrls) {
      URL.revokeObjectURL(url);
    }
  },
  { once: true }
);
void start().catch(fail);

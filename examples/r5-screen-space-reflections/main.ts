import {
  PerspectiveCamera,
  RenderDebugView,
  Renderer,
  Scene,
  ShadeDataType,
  ShadeImage,
  ShadeTexture,
  StandardShadeMaterial,
  buildBoxSourceGeometry,
  captureWebGpuLimits,
  cookGeometryAssetPackage,
  createEnvironmentManifest,
  createGeometryCookRecipe,
  type FrameProfileSnapshot,
  type FrameProfilerDiagnostics,
  type ScreenSpaceReflectionsRuntimeEvidence
} from "../../OEngine/src/index.ts";

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DIRTY__: boolean;
declare const __BUILD_DIRTY_REASONS__: string[];
declare const __BUILD_CONTENT_HASH__: string;

const WIDTH = 1280;
const HEIGHT = 720;
const SMOKE = new URLSearchParams(location.search).get("profile") === "smoke";
const WARMUP = SMOKE ? 2 : 30;
const SAMPLES = SMOKE ? 5 : 120;
const TOTAL = WARMUP + SAMPLES;

type StageKind = "static" | "screen-miss" | "offscreen" | "pan" | "disocclusion" | "feature-off";
type Stage = Readonly<{
  id: string;
  kind: StageKind;
  view: (typeof RenderDebugView)[keyof typeof RenderDebugView];
  captureHdr?: boolean;
}>;
type Keyframe = Readonly<{
  ordinal: number;
  label: string;
  role: "settle" | "stage-end";
  framesSinceEvent?: number;
}>;
type HdrMetrics = Readonly<{
  region: { x: number; y: number; width: number; height: number };
  finite: boolean;
  meanRgb: readonly number[];
  minimumRgb: readonly number[];
  maximumRgb: readonly number[];
  nearBlackFraction: number;
}>;
type StageResult = Readonly<{
  definition: Stage;
  frameBegin: number;
  frameEnd: number;
  firstEvidence: ScreenSpaceReflectionsRuntimeEvidence;
  finalEvidence: ScreenSpaceReflectionsRuntimeEvidence;
  hdr: HdrMetrics | null;
  gpu: Readonly<Record<string, { p50: number | null; p95: number | null; p99: number | null }>>;
  graphBuilds: number;
  graphExecutes: number;
  maxSubmits: number;
  maxReadbacks: number;
  readbackLabels: Readonly<Record<string, number>>;
  timestampLabels: readonly string[];
}>;
type Fx08Result = Readonly<{
  completed: true;
  passed: boolean;
  issues: readonly string[];
  build: { commit: string; dirty: boolean; dirtyReasons: readonly string[]; contentHash: string };
  contract: typeof contract;
  environment: ReturnType<typeof createEnvironmentManifest>;
  diagnostics: FrameProfilerDiagnostics;
  stages: readonly StageResult[];
}>;

declare global {
  interface Window {
    __OENGINE_FX_08_STATE__?: {
      completed: boolean;
      stageReady?: boolean;
      eventIndex?: number;
      stageId?: string;
      keyframe?: Keyframe;
      result?: Fx08Result;
    };
    __OENGINE_FX_08_ADVANCE__?: () => void;
  }
}

const contract = Object.freeze({
  width: WIDTH,
  height: HEIGHT,
  dpr: 1,
  warmupFramesPerStage: WARMUP,
  sampleFramesPerStage: SAMPLES,
  gpuSampleInterval: 2,
  // Two rgba16float histories at half resolution: 2 * 8 * 0.25.
  historyBytesPerPixel: 4,
  roughnessSweep: [0, 0.5, 1] as const,
  sequence: "hit-miss/roughness/history/fallback/offscreen/pan/disocclusion/off-on"
});

const stages: readonly Stage[] = [
  { id: "hit-miss", kind: "static", view: RenderDebugView.ScreenSpaceReflectionHitMiss },
  { id: "roughness-0-05-1", kind: "static", view: RenderDebugView.Roughness },
  { id: "history-confidence", kind: "static", view: RenderDebugView.ScreenSpaceReflectionHistoryConfidence },
  { id: "final-reflection", kind: "static", view: RenderDebugView.LinearHdr, captureHdr: true },
  { id: "screen-miss-fallback", kind: "screen-miss", view: RenderDebugView.LinearHdr, captureHdr: true },
  { id: "offscreen-target", kind: "offscreen", view: RenderDebugView.LinearHdr, captureHdr: true },
  { id: "camera-pan", kind: "pan", view: RenderDebugView.ScreenSpaceReflectionHistoryConfidence },
  { id: "disocclusion", kind: "disocclusion", view: RenderDebugView.ScreenSpaceReflectionHistoryConfidence },
  { id: "feature-off", kind: "feature-off", view: RenderDebugView.None },
  { id: "feature-restored", kind: "static", view: RenderDebugView.LinearHdr, captureHdr: true }
];

let advance: (() => void) | null = null;
let eventIndex = 0;
window.__OENGINE_FX_08_ADVANCE__ = () => advance?.();
required<HTMLButtonElement>("advance").addEventListener("click", () => advance?.());
void run();

async function run(): Promise<void> {
  const status = required("status");
  const detail = required("detail");
  const output = required("result");
  try {
    const canvas = required<HTMLCanvasElement>("gpu-canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    canvas.style.width = `${WIDTH}px`;
    canvas.style.height = `${HEIGHT}px`;
    const context = canvas.getContext("webgpu");
    if (context === null) throw new Error("WebGPU canvas context unavailable");
    const renderer = new Renderer();
    await renderer.initialize({ context, pixelRatio: 1 });
    renderer.resize(WIDTH, HEIGHT);
    configureRenderer(renderer);
    renderer.profiler.configure({
      enabled: true,
      gpuSampleInterval: contract.gpuSampleInterval,
      gpuCounterSampleInterval: 1_000_003,
      readbackRingSlots: 3,
      historyCapacity: stages.length * TOTAL + 48
    });
    const scene = await createFixture(renderer);
    const camera = new PerspectiveCamera();
    camera.aspect = WIDTH / HEIGHT;
    camera.near = 0.1;
    camera.far = 100;
    setBaselineCamera(camera);
    const resolution = renderer.output_resolution;
    const environment = createEnvironmentManifest({
      engine: { commit: __BUILD_COMMIT__, dirty: __BUILD_DIRTY__, dirtyReasons: __BUILD_DIRTY_REASONS__ },
      platform: { os: navigator.platform || "unknown", browser: navigator.userAgent, userAgent: navigator.userAgent },
      adapter: renderer.adapter_info,
      webgpu: {
        features: renderer.device.features,
        limits: captureWebGpuLimits(renderer.device.limits),
        powerPreference: "high-performance"
      },
      frame: {
        canvasWidth: WIDTH,
        canvasHeight: HEIGHT,
        internalWidth: resolution.x,
        internalHeight: resolution.y,
        dpr: 1
      },
      run: {
        baselineRole: "engine-generality-c",
        featureSet: "C",
        warmupFrames: WARMUP,
        sampleFrames: SAMPLES,
        gpuSampleInterval: contract.gpuSampleInterval,
        gpuCounterSampleInterval: 1_000_003,
        readbackRingSlots: 3
      }
    });

    const stageResults: StageResult[] = [];
    for (const definition of stages) {
      prepareStage(renderer, camera, definition);
      const frameBegin = renderer.frame_count;
      let firstEvidence: ScreenSpaceReflectionsRuntimeEvidence | null = null;
      let hdrPending: Promise<Awaited<ReturnType<Renderer["requestLinearHdrCapture"]>>> | null = null;
      for (let ordinal = 0; ordinal < TOTAL; ordinal++) {
        updateStage(camera, definition, ordinal);
        if (definition.captureHdr && ordinal === TOTAL - 1) {
          hdrPending = renderer.requestLinearHdrCapture({ x: 320, y: 180, width: 640, height: 360 });
        }
        if (!renderer.render(camera, scene, 1 / 60)) throw new Error("GPU device lost");
        if (firstEvidence === null) firstEvidence = renderer.screenSpaceReflectionsEvidence();
        await captureKeyframe(definition, ordinal, status, detail);
        await animationFrame();
      }
      const frameEnd = renderer.frame_count;
      const hdr = hdrPending === null ? null : summarizeHdr(await hdrPending);
      await renderer.device.queue.onSubmittedWorkDone();
      await waitForProfiler(renderer, frameBegin, frameEnd);
      const sampledFrames = renderer.profiler.history.filter(
        (frame) => frame.frameIndex >= frameBegin + WARMUP && frame.frameIndex < frameEnd
      );
      const allFrames = renderer.profiler.history.filter(
        (frame) => frame.frameIndex >= frameBegin && frame.frameIndex < frameEnd
      );
      stageResults.push(summarizeStage(
        definition,
        frameBegin,
        frameEnd,
        firstEvidence!,
        renderer.screenSpaceReflectionsEvidence(),
        hdr,
        sampledFrames,
        allFrames
      ));
    }

    renderer.profiler.configure({ enabled: false });
    const issues = validate(stageResults, renderer.profiler.diagnostics);
    const result: Fx08Result = Object.freeze({
      completed: true,
      passed: issues.length === 0,
      issues,
      build: {
        commit: __BUILD_COMMIT__,
        dirty: __BUILD_DIRTY__,
        dirtyReasons: __BUILD_DIRTY_REASONS__,
        contentHash: __BUILD_CONTENT_HASH__
      },
      contract,
      environment,
      diagnostics: renderer.profiler.diagnostics,
      stages: stageResults
    });
    window.__OENGINE_FX_08_STATE__ = { completed: true, result };
    status.textContent = result.passed ? "PASS" : "FAIL";
    detail.textContent = result.passed ? "FX-08 production sequence 完成" : issues.join("；");
    output.textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    status.textContent = "FAIL";
    detail.textContent = error instanceof Error ? error.message : String(error);
    window.__OENGINE_FX_08_STATE__ = { completed: true };
    console.error(error);
  }
}

function configureRenderer(renderer: Renderer): void {
  renderer.configure({ features: {
    shadows: false, screenSpaceReflections: true, ambientOcclusion: false,
    temporalAntiAliasing: false, bloom: false, automaticExposure: false,
    motionBlur: false, sharpening: false
  } });
}

function prepareStage(renderer: Renderer, camera: PerspectiveCamera, stage: Stage): void {
  renderer.configure({ features: { screenSpaceReflections:
    stage.kind !== "feature-off" && stage.id !== "roughness-0-05-1"
  } });
  renderer.render_debug_view = stage.view;
  if (stage.kind === "screen-miss") {
    setCamera(camera, 4.8, 2.4, 7.4, 2.5, -0.65, 0.4);
  } else if (stage.kind === "offscreen") {
    setCamera(camera, -3.8, 2.8, 7.2, -1.5, -0.55, 0.2);
  } else if (stage.kind === "pan") {
    setCamera(camera, -4.2, 2.7, 7.4, -1.2, -0.55, 0);
  } else if (stage.kind === "disocclusion") {
    setCamera(camera, -4.5, 2.8, 7.3, -1.6, -0.6, 0);
  } else {
    setBaselineCamera(camera);
  }
  renderer.indicate_view_change();
}

function updateStage(camera: PerspectiveCamera, stage: Stage, ordinal: number): void {
  if (stage.kind === "pan") {
    const t = Math.min(1, ordinal / Math.max(1, WARMUP + 48));
    setCamera(camera, -4.2 + t * 8.4, 2.7, 7.4, -1.2 + t * 2.4, -0.55, 0);
  } else if (stage.kind === "disocclusion" && ordinal === WARMUP) {
    setCamera(camera, 4.5, 2.8, 7.3, 1.6, -0.6, 0);
  }
}

function keyframes(stage: Stage): readonly Keyframe[] {
  if (SMOKE) return [{ ordinal: TOTAL - 1, label: "end", role: "stage-end" }];
  if (stage.kind === "pan") {
    const stop = Math.min(TOTAL - 1, WARMUP + 48);
    return [0, 8, 16, 32, 64].map((offset) => ({
      ordinal: Math.min(TOTAL - 1, stop + offset),
      label: `settle-${offset}`,
      role: "settle" as const,
      framesSinceEvent: offset
    }));
  }
  if (stage.kind === "disocclusion") {
    return [0, 8, 16, 32, 64].map((offset) => ({
      ordinal: Math.min(TOTAL - 1, WARMUP + offset),
      label: `settle-${offset}`,
      role: "settle" as const,
      framesSinceEvent: offset
    }));
  }
  return [{ ordinal: TOTAL - 1, label: "end", role: "stage-end" }];
}

async function captureKeyframe(stage: Stage, ordinal: number, status: HTMLElement, detail: HTMLElement): Promise<void> {
  const keyframe = keyframes(stage).find((entry) => entry.ordinal === ordinal);
  if (keyframe === undefined) return;
  const current = eventIndex;
  window.__OENGINE_FX_08_STATE__ = {
    completed: false,
    stageReady: true,
    eventIndex: current,
    stageId: stage.id,
    keyframe
  };
  status.textContent = `FX-08 · ${stage.id} · ${keyframe.label}`;
  detail.textContent = `固定关键帧 ${current + 1} · stage frame ${ordinal}`;
  if (new URLSearchParams(location.search).get("auto") !== "1") {
    await new Promise<void>((resolve) => { advance = resolve; });
    advance = null;
  }
  eventIndex++;
  window.__OENGINE_FX_08_STATE__ = { completed: false, stageReady: false, eventIndex, stageId: stage.id };
}

function summarizeStage(
  definition: Stage,
  frameBegin: number,
  frameEnd: number,
  firstEvidence: ScreenSpaceReflectionsRuntimeEvidence,
  finalEvidence: ScreenSpaceReflectionsRuntimeEvidence,
  hdr: HdrMetrics | null,
  frames: readonly FrameProfileSnapshot[],
  allFrames: readonly FrameProfileSnapshot[]
): StageResult {
  const sampled = frames.filter((frame) => frame.gpu.sampled && !frame.gpu.pending);
  const patterns = [
    ["trace", /SSR trace/i],
    ["prefilter", /SSR prefilter/i],
    ["resolve", /SSR reflection resolve/i],
    ["denoise", /SSR spatial|SSR temporal/i],
    ["composite", /Indirect composite/i]
  ] as const;
  const gpu: Record<string, { p50: number | null; p95: number | null; p99: number | null }> = {};
  for (const [name, pattern] of patterns) {
    gpu[name] = distribution(sampled.map((frame) => frame.gpu.segments
      .filter((segment) => pattern.test(segment.label))
      .reduce((sum, segment) => sum + segment.durationMs, 0))
      .filter((value) => value > 0));
  }
  return Object.freeze({
    definition,
    frameBegin,
    frameEnd,
    firstEvidence,
    finalEvidence,
    hdr,
    gpu,
    graphBuilds: allFrames.reduce((sum, frame) => sum + frame.graph.builds, 0),
    graphExecutes: allFrames.reduce((sum, frame) => sum + frame.graph.executes, 0),
    maxSubmits: maximum(allFrames.map((frame) => frame.submits.count)),
    maxReadbacks: maximum(allFrames.map((frame) => frame.readbacks.count)),
    readbackLabels: sumRecords(allFrames.map((frame) => frame.readbacks.labels)),
    timestampLabels: [...new Set(sampled.flatMap((frame) => frame.gpu.segments
      .filter((segment) => /SSR|Indirect composite/i.test(segment.label))
      .map((segment) => segment.label)))]
  });
}

function validate(results: readonly StageResult[], diagnostics: FrameProfilerDiagnostics): string[] {
  const issues: string[] = [];
  if (diagnostics.validationErrorCount || diagnostics.uncapturedErrorCount || diagnostics.deviceLostCount || diagnostics.failedGpuTimestampBatches) {
    issues.push("WebGPU/timestamp diagnostics are non-zero");
  }
  for (const stage of results) {
    const evidence = stage.finalEvidence;
    if (stage.maxSubmits !== 1) issues.push(`${stage.definition.id}: main submit is not exactly one`);
    const privateReadbacks = Object.keys(stage.readbackLabels).filter((label) => /ssr|reflection.?history/i.test(label));
    if (privateReadbacks.length !== 0) issues.push(`${stage.definition.id}: private SSR readback ${privateReadbacks.join(", ")}`);
    if (stage.definition.kind === "feature-off") {
      if (
        evidence.tracePasses !== 0 || evidence.prefilterPasses !== 0 || evidence.resolvePasses !== 0 ||
        evidence.spatialPasses !== 0 || evidence.temporalPasses !== 0 || evidence.compositePasses !== 0 ||
        evidence.historyTextureCount !== 0 || evidence.historyBytes !== 0 ||
        stage.timestampLabels.some((label) => /SSR/i.test(label))
      ) issues.push("feature-off retained SSR pass/resource/history/timestamp");
      continue;
    }
    const hitMissOnly = stage.definition.view === RenderDebugView.ScreenSpaceReflectionHitMiss;
    const roughnessOnly = stage.definition.view === RenderDebugView.Roughness;
    const historyOnly = stage.definition.view === RenderDebugView.ScreenSpaceReflectionHistoryConfidence;
    if (hitMissOnly) {
      if (
        evidence.tracePasses !== 1 || evidence.prefilterPasses !== 1 || evidence.resolvePasses !== 1 ||
        evidence.spatialPasses !== 1 || evidence.temporalPasses !== 1 || evidence.compositePasses !== 0
      ) {
        issues.push("hit-miss debug did not retain the shared history producer contract");
      }
    } else if (roughnessOnly) {
      if (
        evidence.tracePasses || evidence.prefilterPasses || evidence.resolvePasses || evidence.spatialPasses ||
        evidence.temporalPasses || evidence.compositePasses || evidence.historyTextureCount || evidence.historyBytes
      ) {
        issues.push("roughness-only debug retained SSR work or ownership");
      }
    } else if (
      evidence.tracePasses !== 1 || evidence.prefilterPasses !== 1 || evidence.resolvePasses !== 1 ||
      evidence.spatialPasses !== 1 || evidence.temporalPasses !== 1 ||
      evidence.compositePasses !== (historyOnly ? 0 : 1)
    ) issues.push(`${stage.definition.id}: production SSR graph shape mismatch`);
    if (!roughnessOnly && evidence.historyTextureCount !== 2) {
      issues.push(`${stage.definition.id}: SSR history textures are incomplete`);
    }
    if (!roughnessOnly && evidence.historyBytes !== evidence.internalPixels * contract.historyBytesPerPixel) {
      issues.push(`${stage.definition.id}: SSR history byte contract mismatch`);
    }
    if (stage.hdr !== null && (!stage.hdr.finite || stage.hdr.nearBlackFraction > 0.08)) {
      issues.push(`${stage.definition.id}: scene-linear fallback contains non-finite or black-hole pixels`);
    }
  }
  const restored = results.find((stage) => stage.definition.id === "feature-restored");
  if (restored?.finalEvidence.historyValid !== true) issues.push("feature restore did not settle SSR history");
  return issues;
}

async function createFixture(renderer: Renderer): Promise<Scene> {
  const sources = [
    buildBoxSourceGeometry(2.45, 0.12, 6),
    buildBoxSourceGeometry(0.9, 1.5, 0.9),
    buildBoxSourceGeometry(0.75, 0.75, 0.75)
  ];
  const geometries = await Promise.all(sources.map(async (source) =>
    (await cookGeometryAssetPackage(source, createGeometryCookRecipe())).asset
  ));
  const materials = [
    material([0.52, 0.55, 0.58], 0, 1),
    material([0.52, 0.55, 0.58], 0.5, 1),
    material([0.52, 0.55, 0.58], 1, 1),
    material([0.95, 0.12, 0.08], 0.2, 0, [0.25, 0.015, 0.01]),
    material([0.08, 0.75, 0.18], 0.2, 0, [0.01, 0.18, 0.02]),
    material([0.08, 0.18, 0.95], 0.2, 0, [0.01, 0.02, 0.25]),
    material([0.95, 0.75, 0.06], 0.15, 0, [0.3, 0.2, 0.01])
  ];
  const instances = [
    { geometry: 0, material: 0, position: [-2.55, -1.15, 0] },
    { geometry: 0, material: 1, position: [0, -1.15, 0] },
    { geometry: 0, material: 2, position: [2.55, -1.15, 0] },
    { geometry: 1, material: 3, position: [-2.55, -0.3, -1.6] },
    { geometry: 1, material: 4, position: [0, -0.3, -1.6] },
    { geometry: 1, material: 5, position: [2.55, -0.3, -1.6] },
    { geometry: 2, material: 6, position: [7.2, -0.55, -0.4] }
  ] as const;
  const transforms = new Float32Array(instances.length * 16);
  const spheres = new Float32Array(instances.length * 4);
  const boundsMin = new Float32Array(instances.length * 3);
  const boundsMax = new Float32Array(instances.length * 3);
  for (let index = 0; index < instances.length; index++) {
    const instance = instances[index]!;
    writeTransform(
      transforms,
      index * 16,
      instance.position[0],
      instance.position[1],
      instance.position[2]
    );
    spheres.set(sources[instance.geometry]!.bounds.sphere, index * 4);
    boundsMin.set(sources[instance.geometry]!.bounds.box.subarray(0, 3), index * 3);
    boundsMax.set(sources[instance.geometry]!.bounds.box.subarray(3, 6), index * 3);
  }
  const scene = new Scene();
  scene.lights.environment = environmentTexture();
  await renderer.uploadPackedScene(scene, {
    geometries,
    materials,
    count: instances.length,
    geometryIndices: Uint32Array.from(instances.map((entry) => entry.geometry)),
    materialIndices: Uint32Array.from(instances.map((entry) => entry.material)),
    currentTransforms: transforms,
    previousTransforms: transforms.slice(),
    boundsSpheres: spheres,
    boundsMin,
    boundsMax,
    flags: new Uint32Array(instances.length),
    debugIds: Uint32Array.from(instances.map((_, index) => index + 1))
  });
  return scene;
}

function material(
  color: readonly [number, number, number],
  roughness: number,
  metallic: number,
  emissive: readonly [number, number, number] = [0, 0, 0]
): StandardShadeMaterial {
  const value = new StandardShadeMaterial();
  value.diffuse_color.set(color[0], color[1], color[2], 1);
  value.roughness_factor = roughness;
  value.metallic_factor = metallic;
  value.emissive_factor.set(emissive[0], emissive[1], emissive[2]);
  return value;
}

function environmentTexture(): ShadeTexture {
  const image = ShadeImage.fromArrayBuffer(
    new Uint16Array([0x3400, 0x3800, 0x3a00, 0x3c00]).buffer,
    4,
    ShadeDataType.Float16,
    1,
    1,
    1
  );
  image.color_space = 2;
  return ShadeTexture.from(image);
}

function summarizeHdr(capture: Awaited<ReturnType<Renderer["requestLinearHdrCapture"]>>): HdrMetrics {
  const sum = [0, 0, 0];
  const minimum = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const maximum = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  let finite = true;
  let nearBlack = 0;
  const pixels = capture.width * capture.height;
  for (let pixel = 0; pixel < pixels; pixel++) {
    let luma = 0;
    for (let channel = 0; channel < 3; channel++) {
      const value = capture.rgba[pixel * 4 + channel]!;
      finite &&= Number.isFinite(value);
      sum[channel]! += value;
      minimum[channel] = Math.min(minimum[channel]!, value);
      maximum[channel] = Math.max(maximum[channel]!, value);
      luma += value * [0.2126, 0.7152, 0.0722][channel]!;
    }
    if (luma < 0.002) nearBlack++;
  }
  return {
    region: { x: capture.x, y: capture.y, width: capture.width, height: capture.height },
    finite,
    meanRgb: sum.map((value) => value / pixels),
    minimumRgb: minimum,
    maximumRgb: maximum,
    nearBlackFraction: nearBlack / pixels
  };
}

function writeTransform(target: Float32Array, offset: number, x: number, y: number, z: number): void {
  target.fill(0, offset, offset + 16);
  target[offset] = 1;
  target[offset + 5] = 1;
  target[offset + 10] = 1;
  target[offset + 12] = x;
  target[offset + 13] = y;
  target[offset + 14] = z;
  target[offset + 15] = 1;
}

function setBaselineCamera(camera: PerspectiveCamera): void {
  setCamera(camera, 0, 2.7, 7.5, 0, -0.55, 0);
}

function setCamera(camera: PerspectiveCamera, x: number, y: number, z: number, tx: number, ty: number, tz: number): void {
  camera.transform.position.set(x, y, z);
  camera.transform.lookAt({ x: tx, y: ty, z: tz });
  camera.update();
}

async function waitForProfiler(renderer: Renderer, begin: number, end: number): Promise<void> {
  const deadline = performance.now() + 20_000;
  while (performance.now() < deadline) {
    const sampled = renderer.profiler.history.filter(
      (frame) => frame.frameIndex >= begin && frame.frameIndex < end && frame.gpu.sampled
    );
    if (sampled.length > 0 && sampled.every((frame) => !frame.gpu.pending)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`GPU timestamp frames ${begin}-${end} did not settle`);
}

function distribution(values: readonly number[]) {
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99) };
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

function maximum(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

function sumRecords(records: readonly Readonly<Record<string, number>>[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) result[key] = (result[key] ?? 0) + value;
  }
  return result;
}

function animationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function required<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (value === null) throw new Error(`Missing #${id}`);
  return value as T;
}

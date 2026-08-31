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
  type AmbientOcclusionRuntimeEvidence,
  type FrameProfileSnapshot,
  type FrameProfilerDiagnostics
} from "../../OEngine/src/index.ts";

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DIRTY__: boolean;
declare const __BUILD_DIRTY_REASONS__: string[];
declare const __BUILD_CONTENT_HASH__: string;

const WIDTH = 1280;
const HEIGHT = 720;
const SMOKE = new URLSearchParams(location.search).get("profile") === "smoke";
const WARMUP = SMOKE ? 2 : 30;
const SAMPLES = SMOKE ? 4 : 120;
const TOTAL = WARMUP + SAMPLES;

type StageKind = "static" | "pan" | "disocclusion" | "feature-off";
type Stage = Readonly<{
  id: string;
  kind: StageKind;
  scale: 0.5 | 1;
  temporal: boolean;
  view: (typeof RenderDebugView)[keyof typeof RenderDebugView];
}>;

type Keyframe = Readonly<{
  ordinal: number;
  label: string;
  role: "variance" | "settle" | "stage-end";
  framesSinceEvent?: number;
}>;

type StageResult = Readonly<{
  definition: Stage;
  frameBegin: number;
  frameEnd: number;
  firstEvidence: AmbientOcclusionRuntimeEvidence;
  finalEvidence: AmbientOcclusionRuntimeEvidence;
  gpu: Readonly<Record<string, { p50: number | null; p95: number | null; p99: number | null }>>;
  graphBuilds: number;
  graphExecutes: number;
  maxSubmits: number;
  maxReadbacks: number;
  maxReadbackBytes: number;
  readbackLabels: Readonly<Record<string, number>>;
  timestampLabels: readonly string[];
}>;

type Fx07Result = Readonly<{
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
    __OENGINE_FX_07_STATE__?: {
      completed: boolean;
      stageReady?: boolean;
      eventIndex?: number;
      stageId?: string;
      keyframe?: Keyframe;
      result?: Fx07Result;
    };
    __OENGINE_FX_07_ADVANCE__?: () => void;
  }
}

const contract = Object.freeze({
  width: WIDTH,
  height: HEIGHT,
  dpr: 1,
  warmupFramesPerStage: WARMUP,
  sampleFramesPerStage: SAMPLES,
  gpuSampleInterval: 2,
  historyBytesPerAoPixel: 8,
  sequence: "static/full-half/temporal-off-on/pan/disocclusion/off-on"
});

const stages: readonly Stage[] = [
  { id: "full-raw", kind: "static", scale: 1, temporal: false, view: RenderDebugView.AmbientOcclusionRaw },
  { id: "full-denoised", kind: "static", scale: 1, temporal: false, view: RenderDebugView.AmbientOcclusionDenoised },
  { id: "full-temporal-off", kind: "static", scale: 1, temporal: false, view: RenderDebugView.AmbientOcclusionTemporal },
  { id: "full-temporal-on", kind: "static", scale: 1, temporal: true, view: RenderDebugView.AmbientOcclusionTemporal },
  { id: "half-raw", kind: "static", scale: 0.5, temporal: false, view: RenderDebugView.AmbientOcclusionRaw },
  { id: "half-denoised", kind: "static", scale: 0.5, temporal: false, view: RenderDebugView.AmbientOcclusionDenoised },
  { id: "half-temporal", kind: "static", scale: 0.5, temporal: true, view: RenderDebugView.AmbientOcclusionTemporal },
  { id: "camera-pan", kind: "pan", scale: 0.5, temporal: true, view: RenderDebugView.AmbientOcclusionTemporal },
  { id: "disocclusion", kind: "disocclusion", scale: 0.5, temporal: true, view: RenderDebugView.AmbientOcclusionTemporal },
  { id: "final-hdr", kind: "static", scale: 0.5, temporal: true, view: RenderDebugView.LinearHdr },
  { id: "feature-off", kind: "feature-off", scale: 1, temporal: false, view: RenderDebugView.None },
  { id: "feature-restored", kind: "static", scale: 0.5, temporal: true, view: RenderDebugView.LinearHdr }
];

let advance: (() => void) | null = null;
let eventIndex = 0;
window.__OENGINE_FX_07_ADVANCE__ = () => advance?.();
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
      historyCapacity: stages.length * TOTAL + 32
    });
    const scene = await createFixture(renderer);
    const camera = new PerspectiveCamera();
    camera.aspect = WIDTH / HEIGHT;
    camera.near = 0.1;
    camera.far = 100;
    setCamera(camera, 5.2, 3.2, 7.2, 0, 0, 0);
    const resolution = renderer.output_resolution;
    const environment = createEnvironmentManifest({
      engine: {
        commit: __BUILD_COMMIT__,
        dirty: __BUILD_DIRTY__,
        dirtyReasons: __BUILD_DIRTY_REASONS__
      },
      platform: {
        os: navigator.platform || "unknown",
        browser: navigator.userAgent,
        userAgent: navigator.userAgent
      },
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
      let firstEvidence: AmbientOcclusionRuntimeEvidence | null = null;
      for (let ordinal = 0; ordinal < TOTAL; ordinal++) {
        updateStage(camera, definition, ordinal);
        if (!renderer.render(camera, scene, 1 / 60)) throw new Error("GPU device lost");
        if (firstEvidence === null) firstEvidence = renderer.ambientOcclusionEvidence();
        await captureKeyframe(definition, ordinal, status, detail);
        await animationFrame();
      }
      const frameEnd = renderer.frame_count;
      await renderer.device.queue.onSubmittedWorkDone();
      await waitForProfiler(renderer, frameBegin, frameEnd);
      const frames = renderer.profiler.history.filter(
        (frame) => frame.frameIndex >= frameBegin + WARMUP && frame.frameIndex < frameEnd
      );
      const allStageFrames = renderer.profiler.history.filter(
        (frame) => frame.frameIndex >= frameBegin && frame.frameIndex < frameEnd
      );
      const result = summarizeStage(
        definition,
        frameBegin,
        frameEnd,
        firstEvidence!,
        renderer.ambientOcclusionEvidence(),
        frames,
        allStageFrames
      );
      stageResults.push(result);
      detail.textContent = `${definition.id} · AO ${result.gpu.total.p50?.toFixed(3) ?? "n/a"} ms`;
    }

    renderer.profiler.configure({ enabled: false });
    const issues = validate(stageResults, renderer.profiler.diagnostics);
    const result: Fx07Result = Object.freeze({
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
    window.__OENGINE_FX_07_STATE__ = { completed: true, result };
    status.textContent = result.passed ? "PASS" : "FAIL";
    detail.textContent = result.passed ? "FX-07 production sequence 完成" : issues.join("；");
    output.textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    status.textContent = "FAIL";
    detail.textContent = error instanceof Error ? error.message : String(error);
    window.__OENGINE_FX_07_STATE__ = { completed: true };
    console.error(error);
  }
}

function configureRenderer(renderer: Renderer): void {
  renderer.feature_shadows_enabled = false;
  renderer.feature_ssr_enabled = false;
  renderer.feature_ssao_enabled = true;
  renderer.feature_taa_enabled = false;
  renderer.feature_bloom_enabled = false;
  renderer.feature_automatic_exposure_enabled = false;
  renderer.feature_motion_blur_enabled = false;
  renderer.feature_sharpening_enabled = false;
}

function prepareStage(renderer: Renderer, camera: PerspectiveCamera, stage: Stage): void {
  renderer.feature_ssao_enabled = stage.kind !== "feature-off";
  renderer.ssao_resolution_scale = stage.scale;
  renderer.ssao_temporal_enabled = stage.temporal;
  renderer.render_debug_view = stage.view;
  if (stage.kind === "disocclusion") {
    setCamera(camera, -4.8, 2.8, 6.4, 0, -0.1, -0.2);
    renderer.indicate_view_change();
  } else {
    setCamera(camera, 5.2, 3.2, 7.2, 0, 0, 0);
  }
}

function updateStage(camera: PerspectiveCamera, stage: Stage, ordinal: number): void {
  if (stage.kind === "pan") {
    const motionEnd = WARMUP + 48;
    const t = Math.min(1, ordinal / motionEnd);
    setCamera(camera, 5.2 - t * 4.2, 3.2, 7.2, 0, 0, -0.1);
  }
  if (stage.kind === "disocclusion" && ordinal === WARMUP) {
    setCamera(camera, 4.6, 2.4, 5.8, 0.2, -0.2, -0.4);
  }
}

function keyframes(stage: Stage): readonly Keyframe[] {
  if (SMOKE) return [{ ordinal: TOTAL - 1, label: "end", role: "stage-end" }];
  if (stage.id === "full-temporal-off" || stage.id === "full-temporal-on") {
    const varianceFrames: Keyframe[] = Array.from({ length: 16 }, (_, index) => ({
      ordinal: WARMUP + index * 4,
      label: `variance-${String(index).padStart(2, "0")}`,
      role: "variance" as const
    }));
    varianceFrames.push({ ordinal: TOTAL - 1, label: "end", role: "stage-end" });
    return varianceFrames;
  }
  if (stage.kind === "pan") {
    const stop = WARMUP + 48;
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

async function captureKeyframe(
  stage: Stage,
  ordinal: number,
  status: HTMLElement,
  detail: HTMLElement
): Promise<void> {
  const keyframe = keyframes(stage).find((entry) => entry.ordinal === ordinal);
  if (keyframe === undefined) return;
  const current = eventIndex;
  window.__OENGINE_FX_07_STATE__ = {
    completed: false,
    stageReady: true,
    eventIndex: current,
    stageId: stage.id,
    keyframe
  };
  status.textContent = `FX-07 ${stage.id} · ${keyframe.label}`;
  detail.textContent = `固定关键帧 ${current + 1} · stage frame ${ordinal}`;
  if (new URLSearchParams(location.search).get("auto") !== "1") {
    await new Promise<void>((resolve) => { advance = resolve; });
    advance = null;
  }
  eventIndex++;
  window.__OENGINE_FX_07_STATE__ = {
    completed: false,
    stageReady: false,
    eventIndex,
    stageId: stage.id
  };
}

function summarizeStage(
  definition: Stage,
  frameBegin: number,
  frameEnd: number,
  firstEvidence: AmbientOcclusionRuntimeEvidence,
  finalEvidence: AmbientOcclusionRuntimeEvidence,
  frames: readonly FrameProfileSnapshot[],
  allFrames: readonly FrameProfileSnapshot[]
): StageResult {
  const sampled = frames.filter((frame) => frame.gpu.sampled && !frame.gpu.pending);
  const labels = [
    ["raw", /SSAO raw GTAO/i],
    ["spatial", /SSAO spatial filter/i],
    ["temporal", /SSAO temporal resolve/i],
    ["composite", /SSAO alpha-min composite/i],
    ["bentNormalUpsample", /SSAO bent-normal upsample/i]
  ] as const;
  const gpu: Record<string, { p50: number | null; p95: number | null; p99: number | null }> = {};
  for (const [name, pattern] of labels) {
    const values = sampled.map((frame) => frame.gpu.segments
      .filter((segment) => pattern.test(segment.label))
      .reduce((sum, segment) => sum + segment.durationMs, 0))
      .filter((value) => value > 0);
    gpu[name] = distribution(values);
  }
  const totals = sampled.map((frame) => frame.gpu.segments
    .filter((segment) => /SSAO/i.test(segment.label))
    .reduce((sum, segment) => sum + segment.durationMs, 0))
    .filter((value) => value > 0);
  gpu.total = distribution(totals);
  return Object.freeze({
    definition,
    frameBegin,
    frameEnd,
    firstEvidence,
    finalEvidence,
    gpu,
    graphBuilds: allFrames.reduce((sum, frame) => sum + frame.graph.builds, 0),
    graphExecutes: allFrames.reduce((sum, frame) => sum + frame.graph.executes, 0),
    maxSubmits: maximum(allFrames.map((frame) => frame.submits.count)),
    maxReadbacks: maximum(allFrames.map((frame) => frame.readbacks.count)),
    maxReadbackBytes: maximum(allFrames.map((frame) => frame.readbacks.bytes)),
    readbackLabels: sumRecords(allFrames.map((frame) => frame.readbacks.labels)),
    timestampLabels: [...new Set(sampled.flatMap((frame) => frame.gpu.segments
      .filter((segment) => /SSAO/i.test(segment.label))
      .map((segment) => segment.label)))]
  });
}

function validate(
  results: readonly StageResult[],
  diagnostics: FrameProfilerDiagnostics
): string[] {
  const issues: string[] = [];
  if (
    diagnostics.validationErrorCount || diagnostics.uncapturedErrorCount ||
    diagnostics.deviceLostCount || diagnostics.failedGpuTimestampBatches
  ) issues.push("WebGPU/timestamp diagnostics are non-zero");
  for (const stage of results) {
    const evidence = stage.finalEvidence;
    if (stage.maxSubmits !== 1) issues.push(`${stage.definition.id}: main submit is not exactly one`);
    const privateAoReadbacks = Object.keys(stage.readbackLabels)
      .filter((label) => /ssao|ambient.?occlusion|ao.?history/i.test(label));
    if (privateAoReadbacks.length !== 0) {
      issues.push(`${stage.definition.id}: private AO readback ${privateAoReadbacks.join(", ")}`);
    }
    if (stage.definition.kind === "feature-off") {
      if (
        evidence.rawPasses !== 0 || evidence.spatialPasses !== 0 ||
        evidence.temporalPasses !== 0 || evidence.compositePasses !== 0 ||
        evidence.historyTextureCount !== 0 || evidence.historyBytes !== 0 ||
        stage.timestampLabels.length !== 0
      ) issues.push("feature-off retained AO pass/resource/history/timestamp");
      continue;
    }
    const rawOnly = stage.definition.view === RenderDebugView.AmbientOcclusionRaw;
    const denoisedOnly = stage.definition.view === RenderDebugView.AmbientOcclusionDenoised;
    const temporalOnly = stage.definition.view === RenderDebugView.AmbientOcclusionTemporal;
    const completeComposition = !rawOnly && !denoisedOnly && !temporalOnly;
    const expectedSpatial = rawOnly ? 0 : 1;
    const expectedTemporal = stage.definition.temporal && !rawOnly && !denoisedOnly ? 1 : 0;
    const expectedComposite = completeComposition ? 1 : 0;
    const expectedUpsample = completeComposition && stage.definition.scale === 0.5 ? 1 : 0;
    if (
      evidence.rawPasses !== 1 || evidence.spatialPasses !== expectedSpatial ||
      evidence.temporalPasses !== expectedTemporal ||
      evidence.compositePasses !== expectedComposite ||
      evidence.bentNormalUpsamplePasses !== expectedUpsample
    ) issues.push(`${stage.definition.id}: debug/production AO graph shape mismatch`);
    if (stage.definition.temporal) {
      if (evidence.historyTextureCount !== 2) {
        issues.push(`${stage.definition.id}: temporal history chain incomplete`);
      }
      const expected = evidence.aoPixels * contract.historyBytesPerAoPixel;
      if (evidence.historyBytes !== expected) {
        issues.push(`${stage.definition.id}: history bytes ${evidence.historyBytes} != ${expected}`);
      }
    } else if (
      evidence.temporalPasses !== 0 || evidence.historyTextureCount !== 0 || evidence.historyBytes !== 0
    ) issues.push(`${stage.definition.id}: temporal-off retained history work`);
  }
  const restored = results.find((stage) => stage.definition.id === "feature-restored");
  if (restored?.finalEvidence.historyValid !== true) issues.push("feature restore did not settle AO history");
  return issues;
}

async function createFixture(renderer: Renderer): Promise<Scene> {
  const sources = [
    buildBoxSourceGeometry(8, 0.16, 8),
    buildBoxSourceGeometry(8, 4, 0.16),
    buildBoxSourceGeometry(1.25, 1.25, 1.25),
    buildBoxSourceGeometry(0.55, 0.55, 0.55)
  ];
  const geometries = await Promise.all(sources.map(async (source) =>
    (await cookGeometryAssetPackage(source, createGeometryCookRecipe())).asset
  ));
  const transforms = new Float32Array(4 * 16);
  writeTransform(transforms, 0, 0, -1.08, 0);
  writeTransform(transforms, 16, 0, 0.92, -2.55);
  writeTransform(transforms, 32, -1.15, -0.38, -1.65);
  writeTransform(transforms, 48, 1.7, -0.72, 1.55);
  const spheres = new Float32Array(4 * 4);
  const boundsMin = new Float32Array(4 * 3);
  const boundsMax = new Float32Array(4 * 3);
  for (let index = 0; index < 4; index++) {
    spheres.set(sources[index]!.bounds.sphere, index * 4);
    boundsMin.set(sources[index]!.bounds.box.subarray(0, 3), index * 3);
    boundsMax.set(sources[index]!.bounds.box.subarray(3, 6), index * 3);
  }
  const material = new StandardShadeMaterial();
  material.diffuse_color.set(0.62, 0.66, 0.7, 1);
  material.roughness_factor = 0.82;
  material.metallic_factor = 0;
  const scene = new Scene();
  scene.lights.environment = environmentTexture();
  await renderer.uploadPackedScene(scene, {
    geometries,
    materials: [material],
    count: 4,
    geometryIndices: Uint32Array.from([0, 1, 2, 3]),
    materialIndices: new Uint32Array(4),
    currentTransforms: transforms,
    previousTransforms: transforms.slice(),
    boundsSpheres: spheres,
    boundsMin,
    boundsMax,
    flags: new Uint32Array(4),
    debugIds: Uint32Array.from([1, 2, 3, 4])
  });
  return scene;
}

function environmentTexture(): ShadeTexture {
  const image = ShadeImage.fromArrayBuffer(
    new Uint16Array([0x3800, 0x3800, 0x3800, 0x3c00]).buffer,
    4,
    ShadeDataType.Float16,
    1,
    1,
    1
  );
  image.color_space = 2;
  return ShadeTexture.from(image);
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

function setCamera(
  camera: PerspectiveCamera,
  x: number,
  y: number,
  z: number,
  tx: number,
  ty: number,
  tz: number
): void {
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
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99)
  };
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
    for (const [key, value] of Object.entries(record)) {
      result[key] = (result[key] ?? 0) + value;
    }
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

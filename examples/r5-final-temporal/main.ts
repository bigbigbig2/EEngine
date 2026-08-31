import {
  PerspectiveCamera,
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
  type GpuCounterFieldName,
  type ScreenSpaceReflectionsRuntimeEvidence,
  type TemporalRuntimeEvidence
} from "../../OEngine/src/index.ts";
import { ShadeTransparencyMode } from "../../OEngine/src/material/enums.ts";

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DIRTY__: boolean;
declare const __BUILD_DIRTY_REASONS__: string[];
declare const __BUILD_CONTENT_HASH__: string;

const OUTPUT_WIDTH = 1920;
const OUTPUT_HEIGHT = 1080;
const SMOKE = new URLSearchParams(location.search).get("profile") === "smoke";
const WARMUP_FRAMES = SMOKE ? 2 : 30;
const SAMPLE_FRAMES = SMOKE ? 5 : 120;
const TOTAL_FRAMES = WARMUP_FRAMES + SAMPLE_FRAMES;
const GPU_SAMPLE_INTERVAL = 4;
const GPU_COUNTER_SAMPLE_INTERVAL = 4;
const MOTION_STOP_ORDINAL = WARMUP_FRAMES + Math.floor(SAMPLE_FRAMES / 2);
const DISOCCLUSION_ORDINAL = WARMUP_FRAMES + 30;

type StageKind =
  | "static"
  | "slow-pan"
  | "fast-pan"
  | "moving-object"
  | "disocclusion"
  | "transparent-motion"
  | "lod-transition"
  | "camera-cut"
  | "resize"
  | "resolution"
  | "static-no-history"
  | "feature-off";

interface StageDefinition {
  readonly id: string;
  readonly kind: StageKind;
  readonly scale?: number;
  readonly temporal?: boolean;
  readonly ssao?: boolean;
  readonly ssr?: boolean;
  readonly expectInvalidFirst?: boolean;
}

interface KeyframeDefinition {
  readonly ordinal: number;
  readonly label: string;
  readonly role: "first-frame" | "variance" | "motion-settle" | "stage-end";
  readonly framesSinceEvent?: number;
}

interface StageResult {
  readonly definition: StageDefinition;
  readonly frameBegin: number;
  readonly frameEnd: number;
  readonly firstHistoryValid: number;
  readonly finalEvidence: TemporalRuntimeEvidence;
  readonly aoEvidence: AmbientOcclusionRuntimeEvidence;
  readonly ssrEvidence: ScreenSpaceReflectionsRuntimeEvidence;
  readonly sampledCounterFrames: number;
  readonly reactivePixelsMedian: number;
  readonly disoccludedPixelsMedian: number;
  readonly rejectedPixelsMedian: number;
  readonly acceptedHistoryPixelsMedian: number;
  readonly historyRejectPercentMedian: number;
  readonly temporalGpuP50Ms: number | null;
  readonly temporalGpuP95Ms: number | null;
  readonly temporalGpuP99Ms: number | null;
  readonly temporalGpuP50MsPerOutputMp: number | null;
  readonly temporalGpuP50MsPerInternalMp: number | null;
  readonly internalPixels: number;
  readonly outputPixels: number;
  readonly historyBytes: number;
  readonly historySettlingFrames: number | null;
  readonly maxSubmits: number;
  readonly maxReadbackBytes: number;
  readonly maxReadbacks: number;
  readonly readbackLabels: Readonly<Record<string, number>>;
  readonly timestampLabels: readonly string[];
  readonly graphBuilds: number;
  readonly graphExecutes: number;
  readonly selectedClustersMin: number;
  readonly selectedClustersMax: number;
}

interface GateState {
  completed: boolean;
  stageReady: boolean;
  eventIndex: number;
  stageIndex: number;
  stageId: string;
  keyframe?: KeyframeDefinition;
  result?: Record<string, unknown>;
}

declare global {
  interface Window {
    __OENGINE_FX_06B_STATE__?: GateState;
    __OENGINE_FX_06B_ADVANCE__?: () => void;
  }
}

const COMBINED = Object.freeze({ ssao: true, ssr: true });
const stages: readonly StageDefinition[] = [
  { id: "taa-only", kind: "static", scale: 1, expectInvalidFirst: true },
  { id: "ao-temporal", kind: "static", scale: 1, ssao: true, expectInvalidFirst: true },
  { id: "ssr-temporal", kind: "static", scale: 1, ssr: true, expectInvalidFirst: true },
  { id: "static-a", kind: "static", scale: 1, ...COMBINED, expectInvalidFirst: true },
  { id: "static-b", kind: "static", scale: 1, ...COMBINED },
  { id: "static-no-history", kind: "static-no-history", scale: 1, ...COMBINED, expectInvalidFirst: true },
  { id: "slow-pan", kind: "slow-pan", scale: 1, ...COMBINED },
  { id: "disocclusion", kind: "disocclusion", scale: 1, ...COMBINED },
  { id: "transparent-motion", kind: "transparent-motion", scale: 1, ...COMBINED },
  { id: "camera-cut", kind: "camera-cut", scale: 1, ...COMBINED, expectInvalidFirst: true },
  { id: "resize", kind: "resize", scale: 1, ...COMBINED, expectInvalidFirst: true },
  { id: "resolution-1", kind: "resolution", scale: 1, ...COMBINED, expectInvalidFirst: true },
  { id: "resolution-085", kind: "resolution", scale: 0.85, ...COMBINED, expectInvalidFirst: true },
  { id: "resolution-067", kind: "resolution", scale: 0.67, ...COMBINED, expectInvalidFirst: true },
  { id: "resolution-05", kind: "resolution", scale: 0.5, ...COMBINED, expectInvalidFirst: true },
  { id: "resolution-return-1", kind: "resolution", scale: 1, ...COMBINED, expectInvalidFirst: true },
  { id: "feature-off-a", kind: "feature-off", temporal: false, scale: 1, expectInvalidFirst: true },
  { id: "feature-off-b", kind: "feature-off", temporal: false, scale: 1 },
  { id: "feature-restored", kind: "static", temporal: true, scale: 1, ...COMBINED, expectInvalidFirst: true },
  { id: "static-settled", kind: "static", scale: 1, ...COMBINED }
] as const;

let advanceStage: (() => void) | null = null;
let eventIndex = 0;
window.__OENGINE_FX_06B_ADVANCE__ = () => advanceStage?.();
required<HTMLButtonElement>("advance").addEventListener("click", () => advanceStage?.());

void run();

async function run(): Promise<void> {
  const status = required("status");
  const detail = required("detail");
  const output = required("result");
  try {
    const canvas = required<HTMLCanvasElement>("gpu-canvas");
    const context = canvas.getContext("webgpu");
    if (context === null) throw new Error("WebGPU canvas context unavailable");
    const renderer = new Renderer();
    await renderer.initialize({ context, pixelRatio: 1 });
    renderer.resize(OUTPUT_WIDTH, OUTPUT_HEIGHT);
    configureRenderer(renderer);
    renderer.profiler.configure({
      enabled: true,
      gpuSampleInterval: GPU_SAMPLE_INTERVAL,
      gpuCounterSampleInterval: GPU_COUNTER_SAMPLE_INTERVAL,
      readbackRingSlots: 3,
      historyCapacity: 4096
    });
    const drs = renderer.dynamic_resolution_scaling;
    drs.enabled = true;
    drs.target_frame_rate = 60;
    drs.min_scale = 0.5;
    drs.max_scale = 1;
    // Browser sequence validates delayed consumption. The deterministic scale
    // sweep below owns scale changes; the unit seam validates DRS decisions.
    drs.warmup_frames = 10000;

    const fixture = await createFixture(renderer);
    const camera = new PerspectiveCamera();
    camera.aspect = OUTPUT_WIDTH / OUTPUT_HEIGHT;
    camera.near = 0.1;
    camera.far = 100;
    setCamera(camera, 0, 0, 7);

    const stageResults: StageResult[] = [];
    for (let stageIndex = 0; stageIndex < stages.length; stageIndex++) {
      const definition = stages[stageIndex]!;
      const keyframes = keyframesForStage(definition);
      const warmupFrameBegin = renderer.frame_count;
      prepareStage(renderer, camera, fixture, definition);
      for (let ordinal = 0; ordinal < WARMUP_FRAMES; ordinal++) {
        updateStage(renderer, camera, fixture, definition, ordinal);
        if (!renderer.render(camera, fixture.scene, 1 / 60)) {
          throw new Error("GPU device lost");
        }
        await animationFrame();
        await captureKeyframe(stageIndex, definition, ordinal, keyframes, status, detail);
      }
      const frameBegin = renderer.frame_count;
      for (
        let ordinal = WARMUP_FRAMES;
        ordinal < WARMUP_FRAMES + SAMPLE_FRAMES;
        ordinal++
      ) {
        updateStage(renderer, camera, fixture, definition, ordinal);
        if (!renderer.render(camera, fixture.scene, 1 / 60)) {
          throw new Error("GPU device lost");
        }
        await animationFrame();
        await captureKeyframe(stageIndex, definition, ordinal, keyframes, status, detail);
      }
      const frameEnd = renderer.frame_count;
      await renderer.device.queue.onSubmittedWorkDone();
      await waitForProfiler(renderer, warmupFrameBegin, frameEnd);
      const stageFrames = renderer.profiler.history.filter(
        (frame) => frame.frameIndex >= warmupFrameBegin && frame.frameIndex < frameEnd
      );
      const frames = renderer.profiler.history.filter(
        (frame) => frame.frameIndex >= frameBegin && frame.frameIndex < frameEnd
      );
      const result = summarizeStage(
        definition,
        frameBegin,
        frameEnd,
        frames,
        stageFrames,
        renderer
      );
      stageResults.push(result);
      status.textContent = `FX-06B ${definition.id} 已完成`;
      detail.textContent = `${stageIndex + 1}/${stages.length} · ` +
        `history=${result.finalEvidence.historyValid} · ` +
        `temporal=${result.temporalGpuP50Ms?.toFixed(3) ?? "n/a"} ms`;
      output.textContent = JSON.stringify(result, null, 2);
    }

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
        canvasWidth: OUTPUT_WIDTH,
        canvasHeight: OUTPUT_HEIGHT,
        internalWidth: OUTPUT_WIDTH,
        internalHeight: OUTPUT_HEIGHT,
        dpr: 1
      },
      run: {
        baselineRole: "engine-generality-c",
        featureSet: [
          "hardware-visibility",
          "packed-instances",
          "hierarchy-sse-lod",
          "single-material-resolve",
          "clustered-lighting",
          "ibl",
          "packed-mboit-transparency",
          "ambient-occlusion",
          "screen-space-reflections",
          "final-taa-taau"
        ],
        warmupFrames: WARMUP_FRAMES,
        sampleFrames: SAMPLE_FRAMES * stages.length,
        gpuSampleInterval: GPU_SAMPLE_INTERVAL,
        gpuCounterSampleInterval: GPU_COUNTER_SAMPLE_INTERVAL,
        readbackRingSlots: 3
      }
    });
    const issues = validate(stageResults, renderer);
    const result = {
      completed: true,
      passed: issues.length === 0,
      issues,
      contract: {
        task: "FX-06B",
        finalTaaUpscaleClosed: true,
        composition: "opaque + AO + SSR/IBL fallback + transparency reactive -> output-resolution TAA/TAAU",
        temporalSourceOwner: "TemporalHistoryRegistry",
        warmupFramesPerStage: WARMUP_FRAMES,
        sampleFramesPerStage: SAMPLE_FRAMES,
        motion: "current-minus-previous internal-pixel; projection jitter included",
        historyCommit: "submission-aware ping-pong",
        historyClip: "YCoCg neighborhood variance envelope",
        historyLock: "bounded output-history alpha lock",
        upscale: "bounded five-tap current reconstruction at output resolution",
        drsFeedback: "completed timestamp; minimum one-frame latency"
      },
      build: {
        commit: __BUILD_COMMIT__,
        dirty: __BUILD_DIRTY__,
        dirtyReasons: __BUILD_DIRTY_REASONS__,
        contentHash: __BUILD_CONTENT_HASH__
      },
      environment,
      stages: stageResults,
      diagnostics: renderer.profiler.diagnostics
    };
    window.__OENGINE_FX_06B_STATE__ = {
      completed: true,
      stageReady: false,
      eventIndex,
      stageIndex: stages.length,
      stageId: "complete",
      result
    };
    status.textContent = result.passed
      ? "FX-06B production Gate passed"
      : "FX-06B production Gate failed";
    status.className = result.passed ? "ok" : "error";
    detail.textContent = `${stageResults.length} stages · ${issues.length} issues`;
    output.textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    window.__OENGINE_FX_06B_STATE__ = {
      completed: true,
      stageReady: false,
      eventIndex,
      stageIndex: -1,
      stageId: "error",
      result: {
        completed: true,
        passed: false,
        issues: [message],
        build: {
          commit: __BUILD_COMMIT__,
          dirty: __BUILD_DIRTY__,
          dirtyReasons: __BUILD_DIRTY_REASONS__,
          contentHash: __BUILD_CONTENT_HASH__
        }
      }
    };
    status.textContent = "FX-06B production Gate failed";
    status.className = "error";
    detail.textContent = message;
    output.textContent = message;
    console.error(error);
  }
}

function keyframesForStage(stage: StageDefinition): readonly KeyframeDefinition[] {
  if (SMOKE) {
    return [{ ordinal: TOTAL_FRAMES - 1, label: "end", role: "stage-end" }];
  }
  const entries: KeyframeDefinition[] = [];
  if (stage.expectInvalidFirst) {
    entries.push({ ordinal: 0, label: "first", role: "first-frame" });
  }
  if (stage.kind === "static" && stage.id === "static-b") {
    for (let phase = 0; phase < 16; phase++) {
      entries.push({
        ordinal: TOTAL_FRAMES - 16 + phase,
        label: `variance-${String(phase).padStart(2, "0")}`,
        role: "variance"
      });
    }
  } else if (stage.kind === "static-no-history") {
    for (let phase = 0; phase < 16; phase++) {
      entries.push({
        ordinal: TOTAL_FRAMES - 16 + phase,
        label: `variance-${String(phase).padStart(2, "0")}`,
        role: "variance"
      });
    }
  } else if (
    stage.kind === "moving-object" ||
    stage.kind === "transparent-motion" ||
    stage.kind === "disocclusion"
  ) {
    const eventOrdinal = stage.kind === "disocclusion"
      ? DISOCCLUSION_ORDINAL
      : MOTION_STOP_ORDINAL;
    for (const offset of [0, 8, 16, 32]) {
      entries.push({
        ordinal: eventOrdinal + offset,
        label: `settle-${offset}`,
        role: "motion-settle",
        framesSinceEvent: offset
      });
    }
    const settledOffset = Math.floor((TOTAL_FRAMES - 1 - eventOrdinal) / 16) * 16;
    entries.push({
      ordinal: eventOrdinal + settledOffset,
      label: "settled",
      role: "motion-settle",
      framesSinceEvent: settledOffset
    });
    entries.push({ ordinal: TOTAL_FRAMES - 1, label: "end", role: "stage-end" });
  } else {
    entries.push({ ordinal: TOTAL_FRAMES - 1, label: "end", role: "stage-end" });
  }
  return entries.sort((left, right) => left.ordinal - right.ordinal);
}

async function captureKeyframe(
  stageIndex: number,
  stage: StageDefinition,
  ordinal: number,
  keyframes: readonly KeyframeDefinition[],
  status: HTMLElement,
  detail: HTMLElement
): Promise<void> {
  const keyframe = keyframes.find((entry) => entry.ordinal === ordinal);
  if (keyframe === undefined) return;
  const currentEvent = eventIndex;
  window.__OENGINE_FX_06B_STATE__ = {
    completed: false,
    stageReady: true,
    eventIndex: currentEvent,
    stageIndex,
    stageId: stage.id,
    keyframe
  };
  status.textContent = `FX-06B ${stage.id} · ${keyframe.label}`;
  detail.textContent = `固定关键帧 ${currentEvent + 1} · stage frame ${ordinal}`;
  if (new URLSearchParams(location.search).get("auto") !== "1") {
    await new Promise<void>((resolve) => { advanceStage = resolve; });
    advanceStage = null;
  }
  eventIndex++;
  window.__OENGINE_FX_06B_STATE__ = {
    completed: false,
    stageReady: false,
    eventIndex,
    stageIndex,
    stageId: stage.id
  };
}

function configureRenderer(renderer: Renderer): void {
  renderer.feature_shadows_enabled = false;
  renderer.feature_ssr_enabled = true;
  renderer.feature_ssao_enabled = true;
  renderer.ssao_temporal_enabled = true;
  renderer.feature_taa_enabled = true;
  renderer.feature_bloom_enabled = false;
  renderer.feature_automatic_exposure_enabled = false;
  renderer.feature_motion_blur_enabled = false;
  renderer.feature_sharpening_enabled = false;
}

async function createFixture(renderer: Renderer) {
  const source = buildBoxSourceGeometry(1.2, 1.2, 1.2, 16, 16, 16);
  const geometry = (await cookGeometryAssetPackage(
    source,
    createGeometryCookRecipe()
  )).asset;
  const materials = [
    material([0.85, 0.12, 0.04], false),
    material([0.04, 0.55, 0.95], false),
    material([0.2, 0.95, 0.15], false),
    material([0.95, 0.25, 0.8], true)
  ];
  const positions = [
    [-1.4, 0, 0],
    [1.4, 0, -0.4],
    [0, 1.35, 0.2],
    [0, -1.35, 0.1]
  ] as const;
  const count = positions.length;
  const transforms = new Float32Array(count * 16);
  const boundsSpheres = new Float32Array(count * 4);
  const boundsMin = new Float32Array(count * 3);
  const boundsMax = new Float32Array(count * 3);
  for (let index = 0; index < count; index++) {
    const position = positions[index]!;
    writeTransform(transforms, index * 16, position[0], position[1], position[2], 1);
    boundsSpheres.set(source.bounds.sphere, index * 4);
    boundsMin.set(source.bounds.box.subarray(0, 3), index * 3);
    boundsMax.set(source.bounds.box.subarray(3, 6), index * 3);
  }
  const baseTransforms = transforms.slice();
  const scene = new Scene();
  scene.lights.environment = environmentTexture();
  await renderer.uploadPackedScene(scene, {
    geometries: [geometry],
    materials,
    count,
    geometryIndices: new Uint32Array(count),
    materialIndices: Uint32Array.from([0, 1, 2, 3]),
    currentTransforms: transforms,
    previousTransforms: transforms.slice(),
    boundsSpheres,
    boundsMin,
    boundsMax,
    flags: new Uint32Array(count),
    debugIds: Uint32Array.from([1, 2, 3, 4])
  });
  return { scene, baseTransforms, positions };
}

function prepareStage(
  renderer: Renderer,
  camera: PerspectiveCamera,
  fixture: Awaited<ReturnType<typeof createFixture>>,
  stage: StageDefinition
): void {
  renderer.feature_taa_enabled = stage.temporal ?? true;
  renderer.feature_ssao_enabled = stage.ssao === true;
  renderer.feature_ssr_enabled = stage.ssr === true;
  if (stage.kind === "resize") {
    renderer.resize(1600, 900);
    camera.aspect = 1600 / 900;
  } else {
    renderer.resize(OUTPUT_WIDTH, OUTPUT_HEIGHT);
    camera.aspect = OUTPUT_WIDTH / OUTPUT_HEIGHT;
  }
  if (stage.scale !== undefined) renderer.internal_resolution_scale = stage.scale;
  if (stage.kind === "camera-cut") {
    setCamera(camera, 2.5, 1.5, 5.5);
    renderer.indicate_view_change();
  } else {
    setCamera(camera, 0, 0, 7);
  }
  if (
    stage.kind !== "moving-object" &&
    stage.kind !== "disocclusion" &&
    stage.kind !== "transparent-motion" &&
    stage.kind !== "lod-transition"
  ) resetFixtureTransforms(renderer, fixture, [2, 3]);
}

function updateStage(
  renderer: Renderer,
  camera: PerspectiveCamera,
  fixture: Awaited<ReturnType<typeof createFixture>>,
  stage: StageDefinition,
  ordinal: number
): void {
  const t = ordinal / Math.max(1, TOTAL_FRAMES - 1);
  if (stage.kind === "slow-pan") setCamera(camera, (t - 0.5) * 1.2, 0, 7);
  if (stage.kind === "fast-pan") setCamera(camera, Math.sin(t * Math.PI * 4) * 2.5, 0, 6.5);
  if (stage.kind === "moving-object") {
    const motion = Math.min(ordinal, MOTION_STOP_ORDINAL - 1) /
      Math.max(1, MOTION_STOP_ORDINAL - 1);
    patchTransforms(renderer, fixture.scene, [
      [2, Math.sin(motion * Math.PI * 2) * 1.8, 1.35, 0.2, 1],
      ...(ordinal === 0 ? [[3, 0, -1.35, 0.1, 1] as const] : [])
    ]);
  }
  if (stage.kind === "disocclusion") {
    patchTransforms(renderer, fixture.scene, [
      [2, ordinal < DISOCCLUSION_ORDINAL ? 0 : 8, 1.35, 0.2, 1],
      ...(ordinal === 0 ? [[3, 0, -1.35, 0.1, 1] as const] : [])
    ]);
  }
  if (stage.kind === "transparent-motion") {
    const motion = Math.min(ordinal, MOTION_STOP_ORDINAL - 1) /
      Math.max(1, MOTION_STOP_ORDINAL - 1);
    patchTransforms(renderer, fixture.scene, [
      [3, Math.sin(motion * Math.PI * 2) * 1.8, -1.35, 0.1, 1],
      ...(ordinal === 0 ? [[2, 0, 1.35, 0.2, 1] as const] : [])
    ]);
  }
  if (stage.kind === "lod-transition") {
    const scale = 0.08 + (0.5 + 0.5 * Math.sin(t * Math.PI * 2)) * 5.92;
    patchTransforms(renderer, fixture.scene, [
      [2, 0, 1.35, 0.2, scale],
      ...(ordinal === 0 ? [[3, 0, -1.35, 0.1, 1] as const] : [])
    ]);
  }
  if (stage.kind === "static-no-history") renderer.indicate_view_change();
  camera.update();
}

function resetFixtureTransforms(
  renderer: Renderer,
  fixture: Awaited<ReturnType<typeof createFixture>>,
  sourceIndices: readonly number[]
): void {
  const indices = Uint32Array.from(sourceIndices);
  const transforms = new Float32Array(indices.length * 16);
  for (let targetIndex = 0; targetIndex < sourceIndices.length; targetIndex++) {
    const sourceIndex = sourceIndices[targetIndex]!;
    transforms.set(
      fixture.baseTransforms.subarray(sourceIndex * 16, (sourceIndex + 1) * 16),
      targetIndex * 16
    );
  }
  renderer.queuePackedScenePatch(fixture.scene, {
    frameId: renderer.frame_count + 1,
    transforms: { indices, transforms }
  });
}

function patchTransform(
  renderer: Renderer,
  scene: Scene,
  index: number,
  x: number,
  y: number,
  z: number,
  scale: number
): void {
  patchTransforms(renderer, scene, [[index, x, y, z, scale]]);
}

function patchTransforms(
  renderer: Renderer,
  scene: Scene,
  updates: readonly (readonly [number, number, number, number, number])[]
): void {
  const indices = new Uint32Array(updates.length);
  const transforms = new Float32Array(updates.length * 16);
  for (let updateIndex = 0; updateIndex < updates.length; updateIndex++) {
    const [index, x, y, z, scale] = updates[updateIndex]!;
    indices[updateIndex] = index;
    writeTransform(transforms, updateIndex * 16, x, y, z, scale);
  }
  renderer.queuePackedScenePatch(scene, {
    frameId: renderer.frame_count + 1,
    transforms: { indices, transforms }
  });
}

function summarizeStage(
  definition: StageDefinition,
  frameBegin: number,
  frameEnd: number,
  frames: readonly FrameProfileSnapshot[],
  stageFrames: readonly FrameProfileSnapshot[],
  renderer: Renderer
): StageResult {
  const sampled = frames.filter(
    (frame) => frame.gpuCounters.sampled &&
      !frame.gpuCounters.pending &&
      !frame.gpuCounters.dropped
  );
  const counter = (field: GpuCounterFieldName): number => median(
    sampled.map((frame) => frame.gpuCounters.values[field] ?? 0)
  );
  const temporalGpu = frames
    .filter((frame) => frame.gpu.sampled && !frame.gpu.pending)
    .map((frame) => frame.gpu.segments
      .filter((segment) => segment.phase === "temporal")
      .reduce((sum, segment) => sum + segment.durationMs, 0))
    .filter((value) => value > 0);
  const rejected = counter("temporalHistoryRejectedPixels");
  const internalPixels = median(
    frames.map((frame) => frame.counters["temporal.internalPixels"] ?? 0)
  );
  const firstHistoryValid = stageFrames[0]?.counters["temporal.historyValid"] ?? -1;
  const historySettlingIndex = stageFrames.findIndex(
    (frame) => frame.counters["temporal.historyValid"] === 1
  );
  const finalEvidence = renderer.temporalEvidence();
  const aoEvidence = renderer.ambientOcclusionEvidence();
  const ssrEvidence = renderer.screenSpaceReflectionsEvidence();
  const temporalGpuP50Ms = percentile(temporalGpu, 0.5);
  const outputMp = finalEvidence.outputPixels / 1_000_000;
  const internalMp = finalEvidence.internalPixels / 1_000_000;
  return {
    definition,
    frameBegin,
    frameEnd,
    firstHistoryValid,
    finalEvidence,
    aoEvidence,
    ssrEvidence,
    sampledCounterFrames: sampled.length,
    reactivePixelsMedian: counter("temporalReactivePixels"),
    disoccludedPixelsMedian: counter("temporalDisoccludedPixels"),
    rejectedPixelsMedian: rejected,
    acceptedHistoryPixelsMedian: definition.temporal === false
      ? 0
      : Math.max(0, internalPixels - rejected),
    historyRejectPercentMedian: internalPixels > 0 ? rejected / internalPixels * 100 : 0,
    temporalGpuP50Ms,
    temporalGpuP95Ms: percentile(temporalGpu, 0.95),
    temporalGpuP99Ms: percentile(temporalGpu, 0.99),
    temporalGpuP50MsPerOutputMp: temporalGpuP50Ms === null || outputMp <= 0
      ? null
      : temporalGpuP50Ms / outputMp,
    temporalGpuP50MsPerInternalMp: temporalGpuP50Ms === null || internalMp <= 0
      ? null
      : temporalGpuP50Ms / internalMp,
    internalPixels: finalEvidence.internalPixels,
    outputPixels: finalEvidence.outputPixels,
    historyBytes: finalEvidence.historyBytes,
    historySettlingFrames: historySettlingIndex < 0 ? null : historySettlingIndex,
    maxSubmits: maximum(frames.map((frame) => frame.submits.count)),
    maxReadbackBytes: maximum(frames.map((frame) => frame.readbacks.bytes)),
    maxReadbacks: maximum(frames.map((frame) => frame.readbacks.count)),
    readbackLabels: sumRecords(frames.map((frame) => frame.readbacks.labels)),
    timestampLabels: [...new Set(frames
      .filter((frame) => frame.gpu.sampled && !frame.gpu.pending)
      .flatMap((frame) => frame.gpu.segments.map((segment) => segment.label)))],
    graphBuilds: frames.reduce((sum, frame) => sum + frame.graph.builds, 0),
    graphExecutes: frames.reduce((sum, frame) => sum + frame.graph.executes, 0),
    selectedClustersMin: minimum(sampled.map(
      (frame) => frame.gpuCounters.values.selectedClusters ?? 0
    )),
    selectedClustersMax: maximum(sampled.map(
      (frame) => frame.gpuCounters.values.selectedClusters ?? 0
    ))
  };
}

function validate(stages: readonly StageResult[], renderer: Renderer): string[] {
  const issues: string[] = [];
  const diagnostics = renderer.profiler.diagnostics;
  if (
    diagnostics.validationErrorCount ||
    diagnostics.uncapturedErrorCount ||
    diagnostics.deviceLostCount ||
    diagnostics.failedGpuTimestampBatches ||
    diagnostics.droppedGpuCounterSamples ||
    diagnostics.failedGpuCounterSamples
  ) issues.push("WebGPU/timestamp/counter diagnostics are non-zero");
  for (const stage of stages) {
    if (stage.maxSubmits !== 1) issues.push(`${stage.definition.id}: main submit count is not one`);
    if (stage.maxReadbackBytes > 262144) issues.push(`${stage.definition.id}: readback cap exceeded`);
    if (stage.graphExecutes !== SAMPLE_FRAMES) issues.push(`${stage.definition.id}: graph did not execute once per measured frame`);
    if (stage.definition.expectInvalidFirst && stage.firstHistoryValid !== 0) {
      issues.push(`${stage.definition.id}: first frame reused stale history`);
    }
    const totalHistoryBytes = stage.finalEvidence.historyBytes +
      stage.aoEvidence.historyBytes + stage.ssrEvidence.historyBytes;
    if (stage.definition.temporal !== false && totalHistoryBytes > 134217728) {
      issues.push(`${stage.definition.id}: history memory cap exceeded`);
    }
    const privateReadbacks = Object.keys(stage.readbackLabels).filter(
      (label) => /temporal|taa|ssao|ambient.?occlusion|ssr|reflection.?history/i.test(label)
    );
    if (privateReadbacks.length !== 0) {
      issues.push(`${stage.definition.id}: private temporal readback ${privateReadbacks.join(", ")}`);
    }
  }
  const off = stages.find((stage) => stage.definition.id === "feature-off-a");
  if (
    off === undefined ||
    off.finalEvidence.taaPasses !== 0 ||
    off.finalEvidence.classificationPasses !== 0 ||
    off.finalEvidence.historyTextureCount !== 0 ||
    off.finalEvidence.historyBytes !== 0 ||
    off.aoEvidence.rawPasses !== 0 ||
    off.aoEvidence.spatialPasses !== 0 ||
    off.aoEvidence.temporalPasses !== 0 ||
    off.aoEvidence.historyTextureCount !== 0 ||
    off.aoEvidence.historyBytes !== 0 ||
    off.ssrEvidence.tracePasses !== 0 ||
    off.ssrEvidence.prefilterPasses !== 0 ||
    off.ssrEvidence.resolvePasses !== 0 ||
    off.ssrEvidence.spatialPasses !== 0 ||
    off.ssrEvidence.temporalPasses !== 0 ||
    off.ssrEvidence.historyTextureCount !== 0 ||
    off.ssrEvidence.historyBytes !== 0 ||
    off.timestampLabels.some((label) => /FX-06B|TAA|Temporal|SSAO|SSR/i.test(label))
  ) issues.push("feature-off retained Temporal/AO/SSR pass, history, or timestamp");
  const restored = stages.find((stage) => stage.definition.id === "feature-restored");
  if (restored?.finalEvidence.historyValid !== true) issues.push("feature restore did not settle history");
  const stable = stages.find((stage) => stage.definition.id === "static-b");
  if ((stable?.acceptedHistoryPixelsMedian ?? 0) <= 0) {
    issues.push("stable Temporal never accepted production history");
  }
  if (
    stable === undefined ||
    stable.aoEvidence.temporalPasses !== 1 ||
    stable.ssrEvidence.temporalPasses !== 1 ||
    !stable.aoEvidence.historyValid ||
    !stable.ssrEvidence.historyValid ||
    stable.finalEvidence.historyRevision !== stable.aoEvidence.historyRevision ||
    stable.finalEvidence.historyRevision !== stable.ssrEvidence.historyRevision
  ) issues.push("combined final composition did not converge under one shared history revision");
  const taaOnly = stages.find((stage) => stage.definition.id === "taa-only");
  if (
    taaOnly === undefined ||
    taaOnly.aoEvidence.historyTextureCount !== 0 ||
    taaOnly.ssrEvidence.historyTextureCount !== 0
  ) issues.push("TAA-only stage retained AO/SSR history owners");
  const aoOnly = stages.find((stage) => stage.definition.id === "ao-temporal");
  if (
    aoOnly === undefined ||
    aoOnly.aoEvidence.temporalPasses !== 1 ||
    aoOnly.ssrEvidence.historyTextureCount !== 0
  ) issues.push("AO + Temporal single-feature stage has wrong owners");
  const ssrOnly = stages.find((stage) => stage.definition.id === "ssr-temporal");
  if (
    ssrOnly === undefined ||
    ssrOnly.ssrEvidence.temporalPasses !== 1 ||
    ssrOnly.aoEvidence.historyTextureCount !== 0
  ) issues.push("SSR + Temporal single-feature stage has wrong owners");
  const transparent = stages.find((stage) => stage.definition.id === "transparent-motion");
  if ((transparent?.reactivePixelsMedian ?? 0) <= 0) issues.push("transparent reactive coverage is empty");
  if ((transparent?.selectedClustersMin ?? 0) < 3) {
    issues.push("transparent sequence inherited a missing opaque fixture instance");
  }
  for (const scale of [1, 0.85, 0.67, 0.5]) {
    const id = `resolution-${String(scale).replace(".", "")}`;
    const stage = stages.find((entry) => entry.definition.id === id);
    if (stage === undefined) issues.push(`missing C-resolution scale ${scale}`);
    else if (Math.abs(stage.finalEvidence.internalScale - scale) > 1e-6) {
      issues.push(`${id}: internal scale mismatch`);
    } else if (
      stage.temporalGpuP50MsPerOutputMp === null ||
      stage.temporalGpuP50MsPerInternalMp === null
    ) {
      issues.push(`${id}: normalized temporal timing is missing`);
    }
  }
  for (const [id, scale] of [
    ["resolution-1", 1],
    ["resolution-067", 0.67],
    ["resolution-return-1", 1]
  ] as const) {
    const stage = stages.find((entry) => entry.definition.id === id);
    if (stage === undefined || Math.abs(stage.finalEvidence.internalScale - scale) > 1e-6) {
      issues.push(`render-scale transition is missing ${id}`);
    }
  }
  const native = stages.find((stage) => stage.definition.id === "resolution-1");
  if (!SMOKE && (native?.temporalGpuP50Ms ?? Number.POSITIVE_INFINITY) > 2) {
    issues.push("native temporal GPU P50 exceeds 2 ms budget");
  }
  if (renderer.dynamic_resolution_scaling.last_feedback_latency_frames < 1) {
    issues.push("DRS did not consume delayed timestamp feedback");
  }
  return issues;
}

async function waitForProfiler(
  renderer: Renderer,
  begin: number,
  end: number
): Promise<void> {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    const frames = renderer.profiler.history.filter(
      (frame) => frame.frameIndex >= begin && frame.frameIndex < end && frame.gpu.sampled
    );
    if (
      frames.length > 0 &&
      frames.every((frame) => !frame.gpu.pending) &&
      frames.every((frame) => !frame.gpuCounters.sampled || !frame.gpuCounters.pending)
    ) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`GPU timestamp frames ${begin}-${end} did not settle`);
}

function material(color: readonly [number, number, number], transparent: boolean) {
  const value = new StandardShadeMaterial();
  value.diffuse_color.set(color[0], color[1], color[2], transparent ? 0.45 : 1);
  value.emissive_factor.setRGB(color[0] * 0.35, color[1] * 0.35, color[2] * 0.35);
  value.roughness_factor = 0.4;
  value.metallic_factor = 0;
  value.transparency_mode = transparent
    ? ShadeTransparencyMode.Transparent
    : ShadeTransparencyMode.Opaque;
  return value;
}

function environmentTexture(): ShadeTexture {
  const image = ShadeImage.fromArrayBuffer(
    new Uint16Array([0x3266, 0x3466, 0x3666, 0x3c00]).buffer,
    4,
    ShadeDataType.Float16,
    1,
    1,
    1
  );
  image.color_space = 2;
  return ShadeTexture.from(image);
}

function setCamera(camera: PerspectiveCamera, x: number, y: number, z: number): void {
  camera.transform.position.set(x, y, z);
  camera.transform.lookAt({ x: 0, y: 0, z: 0 });
  camera.update();
}

function writeTransform(
  target: Float32Array,
  offset: number,
  x: number,
  y: number,
  z: number,
  scale: number
): void {
  target.fill(0, offset, offset + 16);
  target[offset] = scale;
  target[offset + 5] = scale;
  target[offset + 10] = scale;
  target[offset + 12] = x;
  target[offset + 13] = y;
  target[offset + 14] = z;
  target[offset + 15] = 1;
}

function animationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
}

function median(values: readonly number[]): number {
  return percentile(values, 0.5) ?? 0;
}

function maximum(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

function minimum(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.min(...values);
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

function required<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (value === null) throw new Error(`Missing #${id}`);
  return value as T;
}

import {
  BenchmarkRunController,
  PerspectiveCamera,
  Renderer,
  captureWebGpuLimits,
  createEnvironmentManifest,
  type BenchmarkResult,
  type FrameProfileSnapshot,
  type GpuCounterFieldName
} from "../../OEngine/src/index.ts";
import { createBenchmarkSceneFixture } from "../benchmark-shared/BenchmarkScenes.ts";
import { loadBenchmarkSceneManifest } from "../benchmark-shared/manifest-loader.ts";

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DIRTY__: boolean;
declare const __BUILD_DIRTY_REASONS__: string[];
declare const __BUILD_CONTENT_HASH__: string;

interface Fx04Result {
  completed: true;
  passed: boolean;
  issues: string[];
  build: { commit: string; dirty: boolean; dirtyReasons: string[]; contentHash: string };
  statistics: ReturnType<typeof summarize>;
  sequence: Record<string, unknown>;
  result: BenchmarkResult;
}

declare global {
  interface Window {
    __OENGINE_FX_04_RESULT__?: Fx04Result;
    __OENGINE_FX_04__?: { renderFeature(enabled: boolean): Promise<Record<string, unknown>> };
  }
}

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
    renderer.resize(1280, 720);
    configureRenderer(renderer);
    renderer.profiler.configure({
      enabled: true,
      gpuSampleInterval: 4,
      gpuCounterSampleInterval: 4,
      readbackRingSlots: 3,
      historyCapacity: 48
    });
    const manifest = await loadBenchmarkSceneManifest(
      new URL("../benchmark-shared/manifests/benchmark-c.json", import.meta.url)
    );
    const fixture = await createBenchmarkSceneFixture(renderer, manifest, "smoke");
    const camera = new PerspectiveCamera();
    camera.aspect = 16 / 9;
    camera.near = 0.1;
    // Keep the frozen C smoke geometry represented in every practical split.
    // This is a cascade-coverage oracle, not the product camera far distance.
    camera.far = 100;
    camera.transform.position.set(18, 14, 22);
    camera.transform.lookAt({ x: 0, y: 0, z: 0 });
    camera.update();
    const runConfig = {
      warmupFrames: 8,
      sampleFrames: 24,
      gpuSampleInterval: 4,
      gpuCounterSampleInterval: 4,
      readbackRingSlots: 3
    };
    const resolution = renderer.output_resolution;
    const environment = createEnvironmentManifest({
      engine: { commit: __BUILD_COMMIT__, dirty: __BUILD_DIRTY__, dirtyReasons: __BUILD_DIRTY_REASONS__ },
      platform: { os: navigator.platform || "unknown", browser: navigator.userAgent, userAgent: navigator.userAgent },
      adapter: renderer.adapter_info,
      webgpu: { features: renderer.device.features, limits: captureWebGpuLimits(renderer.device.limits), powerPreference: "high-performance" },
      frame: { canvasWidth: canvas.width, canvasHeight: canvas.height, internalWidth: resolution.x, internalHeight: resolution.y, dpr: 1 },
      run: {
        baselineRole: "engine-generality-c",
        featureSet: [
          "hardware-visibility", "packed-instances", "hierarchy-sse-lod",
          "single-material-resolve", "clustered-lighting", "ibl", "packed-csm-shadow"
        ],
        ...runConfig
      }
    });
    const controller = new BenchmarkRunController(renderer.profiler, environment, {
      id: "FX-04-C-shadow",
      name: "Packed CSM directional cascade sequence",
      sceneAssetHashes: manifest.assets.map((asset) => asset.sha256),
      seed: manifest.seed,
      cameraPathHash: "fx04-c-shadow-static-v1"
    });
    const benchmark = await controller.run({
      frame: (ordinal) => {
        fixture.update(ordinal);
        if (!renderer.render(camera, fixture.scene, 1 / 60)) throw new Error("GPU device lost");
      },
      settle: () => renderer.device.queue.onSubmittedWorkDone(),
      gpuWaitTimeoutMs: 20_000
    });
    const statistics = summarize(benchmark);
    const shadowContext = renderer.scenes.obtain(fixture.scene).lights.shadow_context;
    const featureOn = shadowEvidence(shadowContext);
    renderer.profiler.configure({
      enabled: true,
      gpuSampleInterval: 1,
      gpuCounterSampleInterval: 1,
      readbackRingSlots: 3,
      historyCapacity: 48
    });
    const patchedIndices = Uint32Array.from(
      { length: fixture.runtimeCounts.instances },
      (_, index) => index
    );
    renderer.queuePackedScenePatch(fixture.scene, {
      frameId: renderer.frame_count + 1,
      materials: {
        indices: patchedIndices,
        materialIndices: new Uint32Array(patchedIndices.length).fill(1)
      }
    });
    const patchEvidencePending = waitForGpuCounterFrame(
      renderer,
      renderer.frame_count
    );
    if (!renderer.render(camera, fixture.scene, 1 / 60)) throw new Error("GPU device lost");
    await renderer.device.queue.onSubmittedWorkDone();
    const patchFrame = await patchEvidencePending;
    const patchedCaster = {
      patchedInstances: patchedIndices.length,
      cascadeWork: [
        patchFrame.gpuCounters.values.shadowCascade0RasterWork ?? 0,
        patchFrame.gpuCounters.values.shadowCascade1RasterWork ?? 0,
        patchFrame.gpuCounters.values.shadowCascade2RasterWork ?? 0
      ],
      overflowMask: patchFrame.gpuCounters.values.shadowQueueOverflowMask ?? 0,
      mainSubmits: patchFrame.submits.count,
      packedCascadeDraws: shadowContext.packed_cascade_draw_count
    };
    renderer.configure({ features: { shadows: false } });
    for (let index = 0; index < 3; index++) {
      if (!renderer.render(camera, fixture.scene, 1 / 60)) throw new Error("GPU device lost");
    }
    await renderer.device.queue.onSubmittedWorkDone();
    const featureOff = shadowEvidence(shadowContext);
    renderer.configure({ features: { shadows: true } });
    for (let index = 0; index < 3; index++) {
      if (!renderer.render(camera, fixture.scene, 1 / 60)) throw new Error("GPU device lost");
    }
    await renderer.device.queue.onSubmittedWorkDone();
    const featureRestored = shadowEvidence(shadowContext);
    const sequence = { featureOn, patchedCaster, featureOff, featureRestored };
    const issues = validate(benchmark, statistics, sequence);
    const result: Fx04Result = {
      completed: true,
      passed: issues.length === 0,
      issues,
      build: { commit: __BUILD_COMMIT__, dirty: __BUILD_DIRTY__, dirtyReasons: __BUILD_DIRTY_REASONS__, contentHash: __BUILD_CONTENT_HASH__ },
      statistics,
      sequence,
      result: benchmark
    };
    window.__OENGINE_FX_04_RESULT__ = result;
    window.__OENGINE_FX_04__ = {
      renderFeature: async (enabled) => {
        renderer.configure({ features: { shadows: enabled } });
        for (let index = 0; index < 2; index++) renderer.render(camera, fixture.scene, 1 / 60);
        await renderer.device.queue.onSubmittedWorkDone();
        return shadowEvidence(shadowContext);
      }
    };
    status.textContent = result.passed ? "FX-04 production Gate passed" : "FX-04 production Gate failed";
    status.className = result.passed ? "ok" : "error";
    detail.textContent = `cascades=${statistics.cascadeWork.join("/")} atlas=${statistics.atlasPixels} overflow=${statistics.overflowMask}`;
    output.textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    status.textContent = "FX-04 production Gate failed";
    status.className = "error";
    detail.textContent = error instanceof Error ? error.message : String(error);
    console.error(error);
  }
}

function summarize(result: BenchmarkResult) {
  const samples = result.frames.filter((frame) => frame.gpuCounters.sampled && !frame.gpuCounters.dropped);
  const value = (field: GpuCounterFieldName) => median(
    samples.map((frame) => frame.gpuCounters.values[field] ?? 0)
  );
  return {
    sampledFrames: samples.length,
    cascadeWork: [
      value("shadowCascade0RasterWork"),
      value("shadowCascade1RasterWork"),
      value("shadowCascade2RasterWork")
    ],
    atlasPixels: value("shadowAtlasPixelsUpdated"),
    alphaWork: value("shadowAlphaRasterWork"),
    overflowMask: value("shadowQueueOverflowMask"),
    shadowGpuP50Ms: result.summary.gpuPhaseMs.shadow?.p50 ?? null,
    shadowGpuP95Ms: result.summary.gpuPhaseMs.shadow?.p95 ?? null,
    submitMean: result.summary.submits.mean,
    readbackMean: result.summary.readbacks.mean
  };
}

function validate(
  result: BenchmarkResult,
  stats: ReturnType<typeof summarize>,
  sequence: Record<string, any>
): string[] {
  const issues: string[] = [];
  const d = result.diagnostics;
  if (d.validationErrorCount || d.uncapturedErrorCount || d.deviceLostCount) issues.push("WebGPU diagnostics are non-zero");
  if (d.failedGpuTimestampBatches || d.droppedGpuCounterSamples || d.failedGpuCounterSamples) issues.push("GPU evidence diagnostics are non-zero");
  if (stats.sampledFrames < 1) issues.push("no sampled shadow counters");
  if (stats.cascadeWork.some((value) => value <= 0)) issues.push("one or more CSM cascades produced no RasterWork");
  if (stats.atlasPixels <= 0) issues.push("shadow atlas update evidence is empty");
  if (stats.alphaWork <= 0) issues.push("alpha-tested caster evidence is empty");
  if (stats.overflowMask !== 0) issues.push("SecondaryRasterWork queue overflowed");
  if (stats.shadowGpuP50Ms === null || stats.shadowGpuP95Ms === null) issues.push("shadow GPU timestamp phase is missing");
  if (sequence.featureOn.packedCascadeDraws !== 3) issues.push("feature-on did not issue exactly three cascade indirect draws");
  if (sequence.featureOn.atlasBytes <= 0 || sequence.featureOn.atlasBytes > 134_217_728) issues.push("feature-on atlas violates memory budget");
  if (sequence.patchedCaster.cascadeWork.some((value: number) => value <= 0) ||
    sequence.patchedCaster.packedCascadeDraws !== 3) {
    issues.push("material-patched CastsShadow instances stopped producing ShadowRasterWork");
  }
  if (sequence.patchedCaster.overflowMask !== 0 ||
    sequence.patchedCaster.mainSubmits !== 1) {
    issues.push("material-patch shadow frame overflowed or changed the one-submit contract");
  }
  if (sequence.featureOff.atlasBytes !== 0 || sequence.featureOff.packedCascadeDraws !== 0) issues.push("feature-off retained shadow GPU owner/work");
  if (sequence.featureRestored.packedCascadeDraws !== 3) issues.push("feature restore did not rebuild the packed cascade path");
  return issues;
}

function shadowEvidence(context: {
  atlas_allocated_bytes: number;
  packed_cascade_draw_count: number;
  packed_atlas_pixels_updated: number;
}) {
  return {
    atlasBytes: context.atlas_allocated_bytes,
    packedCascadeDraws: context.packed_cascade_draw_count,
    atlasPixelsUpdated: context.packed_atlas_pixels_updated
  };
}

function waitForGpuCounterFrame(renderer: Renderer, minimumFrame: number) {
  return new Promise<FrameProfileSnapshot>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for material-patch shadow counters"));
    }, 20_000);
    const unsubscribe = renderer.profiler.subscribe((snapshot) => {
      if (snapshot.frameIndex < minimumFrame || !snapshot.gpuCounters.sampled ||
        snapshot.gpuCounters.pending || snapshot.gpuCounters.dropped) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(snapshot);
    });
  });
}

function configureRenderer(renderer: Renderer): void {
  renderer.configure({ features: {
    shadows: true, screenSpaceReflections: false, ambientOcclusion: false,
    temporalAntiAliasing: false, bloom: false, automaticExposure: false,
    motionBlur: false, sharpening: false
  } });
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function required<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (value === null) throw new Error(`Missing #${id}`);
  return value as T;
}

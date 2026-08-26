import {
  BenchmarkRunController,
  Renderer,
  captureWebGpuLimits,
  createEnvironmentManifest,
  serializeBenchmarkResult,
  type BenchmarkAdapterIdentity,
  type BenchmarkResult
} from "../../OEngine/src/index.ts";

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DIRTY__: boolean;
declare const __BUILD_DIRTY_REASONS__: string[];

const WARMUP_FRAMES = 4;
const SAMPLE_FRAMES = 20;
const GPU_SAMPLE_INTERVAL = 1000;
const GPU_COUNTER_SAMPLE_INTERVAL = 1000;
const READBACK_RING_SLOTS = 3;

const canvas = requiredElement<HTMLCanvasElement>("gpu-canvas");
const status = requiredElement<HTMLElement>("status");
const detail = requiredElement<HTMLElement>("detail");
const statusDot = requiredElement<HTMLElement>("status-dot");
const frames = requiredElement<HTMLElement>("frames");
const cpuP50 = requiredElement<HTMLElement>("cpu-p50");
const submitMean = requiredElement<HTMLElement>("submit-mean");
const uploadP50 = requiredElement<HTMLElement>("upload-p50");
const resultOutput = requiredElement<HTMLElement>("result");
const download = requiredElement<HTMLButtonElement>("download");

let completedResult: BenchmarkResult | null = null;

download.addEventListener("click", () => {
  if (completedResult === null) return;
  const blob = new Blob([serializeBenchmarkResult(completedResult)], {
    type: "application/json"
  });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `oengine-r0-observability-${__BUILD_COMMIT__.slice(0, 8)}.json`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
});

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  status.textContent = "验证失败";
  detail.textContent = message;
  statusDot.classList.add("error");
  resultOutput.textContent = error instanceof Error && error.stack
    ? error.stack
    : message;
  console.error(error);
});

async function run(): Promise<void> {
  const context = canvas.getContext("webgpu");
  if (context === null) {
    throw new Error("当前浏览器没有可用的 WebGPU canvas context");
  }

  const renderer = new Renderer();
  await renderer.initialize({ context, pixelRatio: 1 });
  renderer.profiler.configure({
    enabled: true,
    gpuSampleInterval: GPU_SAMPLE_INTERVAL,
    gpuCounterSampleInterval: GPU_COUNTER_SAMPLE_INTERVAL,
    readbackRingSlots: READBACK_RING_SLOTS,
    historyCapacity: WARMUP_FRAMES + SAMPLE_FRAMES + 4
  });

  const output = renderer.output_resolution;
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
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      internalWidth: output.x,
      internalHeight: output.y,
      dpr: 1
    },
    run: {
      baselineRole: "observability-smoke",
      featureSet: ["graphics-update-observability-smoke"],
      warmupFrames: WARMUP_FRAMES,
      sampleFrames: SAMPLE_FRAMES,
      gpuSampleInterval: GPU_SAMPLE_INTERVAL,
      gpuCounterSampleInterval: GPU_COUNTER_SAMPLE_INTERVAL,
      readbackRingSlots: READBACK_RING_SLOTS
    }
  });
  const controller = new BenchmarkRunController(renderer.profiler, environment, {
    id: "R0-SMOKE",
    name: "GraphicsContext observability smoke",
    sceneAssetHashes: ["none:empty"],
    seed: 0,
    cameraPathHash: "none:static"
  });
  status.textContent = "正在采集";
  detail.textContent = adapterDescription(renderer.adapter_info);
  completedResult = await controller.run({
    frame: (ordinal) => {
      const frameIndex = ordinal + 1;
      renderer.profiler.beginFrame(frameIndex);
      renderer.profiler.measure("example.graphics-update", () => {
        renderer.graphics.update();
      });
      renderer.profiler.recordCounter("example.frameIndex", frameIndex);
      renderer.profiler.endFrame();
    },
    settle: () => renderer.device.queue.onSubmittedWorkDone(),
    onProgress: (progress) => {
      frames.textContent = `${progress.measuredFrames} / ${SAMPLE_FRAMES}`;
    }
  });
  const summary = completedResult.summary;
  cpuP50.textContent = `${summary.cpuMs.frame.p50.toFixed(3)} ms`;
  submitMean.textContent = summary.submits.mean.toFixed(2);
  uploadP50.textContent = formatBytes(summary.uploadBytes.p50);
  resultOutput.textContent = serializeBenchmarkResult(completedResult);
  download.disabled = false;
  const diagnostics = completedResult.diagnostics;
  const failed = diagnostics.validationErrorCount > 0 ||
    diagnostics.uncapturedErrorCount > 0 ||
    diagnostics.deviceLostCount > 0 ||
    diagnostics.failedGpuTimestampBatches > 0 ||
    diagnostics.droppedGpuCounterSamples > 0 ||
    diagnostics.failedGpuCounterSamples > 0;
  status.textContent = failed ? "采集完成（存在错误）" : "采集完成";
  detail.textContent = failed
    ? [
        adapterDescription(renderer.adapter_info),
        `uncaptured=${diagnostics.uncapturedErrorCount}`,
        `deviceLost=${diagnostics.deviceLostCount}`
      ].join(" · ")
    : `${adapterDescription(renderer.adapter_info)} · uncaptured=0, deviceLost=0`;
  statusDot.classList.add(failed ? "error" : "ok");
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id}`);
  return element as T;
}

function adapterDescription(adapter: BenchmarkAdapterIdentity | null): string {
  if (adapter === null) return "GPU adapter identity unavailable";
  return [adapter.vendor, adapter.architecture, adapter.device, adapter.description]
    .filter((value) => value.length > 0)
    .join(" · ") || "GPU adapter identity unavailable";
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value.toFixed(0)} B`;
  return `${(value / 1024).toFixed(2)} KiB`;
}

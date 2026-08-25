import {
  BenchmarkHarness,
  Renderer,
  captureWebGpuLimits,
  createEnvironmentManifest,
  serializeBenchmarkResult,
  type BenchmarkAdapterIdentity,
  type BenchmarkResult
} from "../../OEngine/src/index.ts";

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DIRTY__: boolean;

const WARMUP_FRAMES = 4;
const SAMPLE_FRAMES = 20;

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
    gpuSampleInterval: 1000,
    historyCapacity: WARMUP_FRAMES + SAMPLE_FRAMES + 4
  });

  const output = renderer.output_resolution;
  const environment = createEnvironmentManifest({
    engine: { commit: __BUILD_COMMIT__, dirty: __BUILD_DIRTY__ },
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
      featureSet: ["graphics-update-observability-smoke"],
      warmupFrames: WARMUP_FRAMES,
      sampleFrames: SAMPLE_FRAMES
    }
  });
  const harness = new BenchmarkHarness(environment, {
    id: "R0-SMOKE",
    name: "GraphicsContext observability smoke",
    sceneAssetHashes: ["none:empty"],
    seed: 0,
    cameraPathHash: "none:static"
  });
  const unsubscribe = renderer.profiler.subscribe((frame) => {
    harness.recordFrame(frame);
    frames.textContent = `${harness.completeFrameCount} / ${SAMPLE_FRAMES}`;
  });

  status.textContent = "正在采集";
  detail.textContent = adapterDescription(renderer.adapter_info);
  for (
    let frameIndex = 1;
    frameIndex <= WARMUP_FRAMES + SAMPLE_FRAMES;
    frameIndex++
  ) {
    await nextAnimationFrame();
    renderer.profiler.beginFrame(frameIndex);
    renderer.profiler.measure("example.graphics-update", () => {
      renderer.graphics.update();
    });
    renderer.profiler.recordCounter("example.frameIndex", frameIndex);
    renderer.profiler.endFrame();
  }
  await renderer.device.queue.onSubmittedWorkDone();
  unsubscribe();

  completedResult = harness.complete();
  const summary = completedResult.summary;
  cpuP50.textContent = `${summary.cpuMs.frame.p50.toFixed(3)} ms`;
  submitMean.textContent = summary.submits.mean.toFixed(2);
  uploadP50.textContent = formatBytes(summary.uploadBytes.p50);
  resultOutput.textContent = serializeBenchmarkResult(completedResult);
  download.disabled = false;
  status.textContent = "采集完成";
  detail.textContent = `${adapterDescription(renderer.adapter_info)} · 未发现同步异常`;
  statusDot.classList.add("ok");
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id}`);
  return element as T;
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
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

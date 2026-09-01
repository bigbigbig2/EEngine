import {
  BenchmarkRunController,
  BoxGeometry,
  DirectionalLight,
  Mesh,
  PerspectiveCamera,
  RENDER_DEBUG_VIEW_OPTIONS,
  Renderer,
  RenderDebugView,
  Scene,
  ShadeDataType,
  ShadeImage,
  ShadeTexture,
  StandardShadeMaterial,
  captureWebGpuLimits,
  createEnvironmentManifest,
  serializeBenchmarkResult,
  type BenchmarkAdapterIdentity,
  type BenchmarkResult,
  type RenderDebugViewName
} from "../../OEngine/src/index.ts";

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DIRTY__: boolean;
declare const __BUILD_DIRTY_REASONS__: string[];

const WARMUP_FRAMES = 8;
const SAMPLE_FRAMES = 24;
const GPU_SAMPLE_INTERVAL = 4;
const GPU_COUNTER_SAMPLE_INTERVAL = 4;
const READBACK_RING_SLOTS = 3;
const GRID_SIZE = 9;

const canvas = requiredElement<HTMLCanvasElement>("gpu-canvas");
const status = requiredElement<HTMLElement>("status");
const detail = requiredElement<HTMLElement>("detail");
const statusDot = requiredElement<HTMLElement>("status-dot");
const frames = requiredElement<HTMLElement>("frames");
const cpuP50 = requiredElement<HTMLElement>("cpu-p50");
const gpuSamples = requiredElement<HTMLElement>("gpu-samples");
const submitMean = requiredElement<HTMLElement>("submit-mean");
const resultOutput = requiredElement<HTMLElement>("result");
const download = requiredElement<HTMLButtonElement>("download");
const debugViewSelect = requiredElement<HTMLSelectElement>("debug-view");
const debugStatus = requiredElement<HTMLElement>("debug-status");

let completedResult: BenchmarkResult | null = null;

for (const entry of RENDER_DEBUG_VIEW_OPTIONS) {
  const option = document.createElement("option");
  option.value = entry.view;
  option.textContent = entry.status === "unsupported"
    ? `${entry.label} · unsupported`
    : entry.label;
  debugViewSelect.append(option);
}
debugViewSelect.value = RenderDebugView.None;

download.addEventListener("click", () => {
  if (completedResult === null) return;
  const blob = new Blob([serializeBenchmarkResult(completedResult)], {
    type: "application/json"
  });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `oengine-r0-frame-smoke-${__BUILD_COMMIT__.slice(0, 8)}.json`;
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
  configureComparablePipeline(renderer);
  renderer.profiler.configure({
    enabled: true,
    gpuSampleInterval: GPU_SAMPLE_INTERVAL,
    gpuCounterSampleInterval: GPU_COUNTER_SAMPLE_INTERVAL,
    readbackRingSlots: READBACK_RING_SLOTS,
    historyCapacity: WARMUP_FRAMES + SAMPLE_FRAMES + 8
  });

  const scene = createScene();
  const camera = createCamera(renderer.aspect_ratio);
  debugViewSelect.addEventListener("change", () => {
    renderer.render_debug_view = debugViewSelect.value as RenderDebugViewName;
    const viewStatus = renderer.render_debug_view_status;
    debugStatus.textContent = `${viewStatus.status} · ${viewStatus.reason}`;
    if (completedResult !== null) {
      renderer.render(camera, scene, 1 / 60);
    }
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
      baselineRole: "frame-smoke",
      featureSet: [
        "hardware-visibility",
        "hzb-culling",
        "material-expand",
        "clustered-lighting",
        "ibl"
      ],
      warmupFrames: WARMUP_FRAMES,
      sampleFrames: SAMPLE_FRAMES,
      gpuSampleInterval: GPU_SAMPLE_INTERVAL,
      gpuCounterSampleInterval: GPU_COUNTER_SAMPLE_INTERVAL,
      readbackRingSlots: READBACK_RING_SLOTS
    }
  });
  const controller = new BenchmarkRunController(renderer.profiler, environment, {
    id: "R0-FRAME-SMOKE",
    name: "Fixed box grid main frame",
    sceneAssetHashes: ["procedural:box-grid-9x9-v1"],
    seed: 0,
    cameraPathHash: "procedural:static-camera-v1"
  });

  status.textContent = "正在预热并采集";
  detail.textContent = adapterDescription(renderer.adapter_info);
  completedResult = await controller.run({
    frame: () => {
      if (!renderer.render(camera, scene, 1 / 60)) {
        throw new Error("Renderer stopped because the GPU device was lost");
      }
    },
    settle: () => renderer.device.queue.onSubmittedWorkDone(),
    gpuWaitTimeoutMs: 15000,
    onProgress: (progress) => {
      frames.textContent = `${progress.measuredFrames} / ${SAMPLE_FRAMES}`;
      if (progress.pendingGpuFrames > 0) {
        detail.textContent = [
          adapterDescription(renderer.adapter_info),
          `等待 ${progress.pendingGpuFrames} 个 GPU 样本`
        ].join(" · ");
      }
    }
  });

  const summary = completedResult.summary;
  const sampledFrames = completedResult.frames.filter(
    (frame) => frame.gpu.segments.length > 0
  ).length;
  cpuP50.textContent = `${summary.cpuMs.frame.p50.toFixed(3)} ms`;
  gpuSamples.textContent = renderer.profiler.gpuTimestampAvailable
    ? String(sampledFrames)
    : "unavailable";
  submitMean.textContent = summary.submits.mean.toFixed(2);
  resultOutput.textContent = serializeBenchmarkResult(completedResult);
  download.disabled = false;
  debugViewSelect.disabled = false;
  debugStatus.textContent = renderer.render_debug_view_status.reason;
  const diagnostics = completedResult.diagnostics;
  const expectedPixelCount = environment.frame.internalWidth *
    environment.frame.internalHeight;
  const counterSamples = completedResult.frames.filter(
    (frame) => frame.gpuCounters.sampled && !frame.gpuCounters.dropped
  );
  const invalidCounterSamples = counterSamples.filter((frame) => {
    const counters = frame.gpuCounters.values;
    const required = [
      "candidateInstances",
      "visibleInstances",
      "candidateClusters",
      "selectedClusters",
      "hwClusters",
      "alphaClusters",
      "hwTriangles",
      "rejectedFrustum",
      "rejectedHzb",
      "shadedPixels",
      "emptyVisibilityPixels",
      "activeMaterials",
      "activeLights",
      "queueOverflowMask"
    ] as const;
    if (required.some((field) => counters[field] === undefined)) return true;
    return counters.shadedPixels! + counters.emptyVisibilityPixels! !==
        expectedPixelCount ||
      counters.candidateInstances !==
        counters.visibleInstances! + counters.rejectedFrustum! ||
      counters.selectedClusters !==
        counters.hwClusters! + counters.alphaClusters! ||
      counters.hwTriangles !== counters.selectedClusters! * 128 ||
      counters.activeMaterials !== 1 ||
      counters.activeLights !== 0 ||
      counters.queueOverflowMask !== 0;
  });
  const failed = diagnostics.validationErrorCount > 0 ||
    diagnostics.uncapturedErrorCount > 0 ||
    diagnostics.deviceLostCount > 0 ||
    diagnostics.failedGpuTimestampBatches > 0 ||
    diagnostics.droppedGpuCounterSamples > 0 ||
    diagnostics.failedGpuCounterSamples > 0 ||
    counterSamples.length === 0 ||
    invalidCounterSamples.length > 0;
  status.textContent = failed ? "采集完成（存在错误）" : "采集完成";
  detail.textContent = [
    adapterDescription(renderer.adapter_info),
    `${GRID_SIZE * GRID_SIZE} instances`,
    `counterSamples=${counterSamples.length}`,
    `counterMismatches=${invalidCounterSamples.length}`,
    `uncaptured=${diagnostics.uncapturedErrorCount}`,
    `deviceLost=${diagnostics.deviceLostCount}`
  ].join(" · ");
  statusDot.classList.add(failed ? "error" : "ok");
}

function createScene(): Scene {
  const scene = new Scene();
  scene.lights.environment = createEnvironmentTexture();
  const geometry = new BoxGeometry(1, 1, 1);
  const material = new StandardShadeMaterial();
  material.diffuse_color.set(0.78, 0.34, 0.12, 1);
  material.roughness_factor = 0.7;
  material.metallic_factor = 0.05;
  const center = (GRID_SIZE - 1) * 0.5;
  for (let z = 0; z < GRID_SIZE; z++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const mesh = Mesh.from(geometry, material);
      mesh.position = [(x - center) * 1.6, 0, (z - center) * 1.6];
      mesh.updateMatrices();
      scene.addChild(mesh);
    }
  }
  const sun = new DirectionalLight();
  sun.intensity = 4;
  sun.casts_shadow = false;
  sun.forward = [0.45, -1, -0.35];
  scene.addChild(sun);
  return scene;
}

function createEnvironmentTexture(): ShadeTexture {
  const halfFloatRgba = new Uint16Array([
    0x2a66,
    0x2e66,
    0x3266,
    0x3c00
  ]);
  const image = ShadeImage.fromArrayBuffer(
    halfFloatRgba.buffer,
    4,
    ShadeDataType.Float16,
    1,
    1,
    1
  );
  image.color_space = 2;
  return ShadeTexture.from(image);
}

function createCamera(aspect: number): PerspectiveCamera {
  const camera = new PerspectiveCamera();
  camera.aspect = aspect;
  camera.near = 0.1;
  camera.transform.position.set(0, 9, 17);
  camera.transform.lookAt({ x: 0, y: 0, z: 0 });
  camera.update();
  return camera;
}

function configureComparablePipeline(renderer: Renderer): void {
  renderer.configure({ features: {
    shadows: false, screenSpaceReflections: false, ambientOcclusion: false,
    temporalAntiAliasing: false, bloom: false, automaticExposure: false,
    motionBlur: false, sharpening: false
  } });
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

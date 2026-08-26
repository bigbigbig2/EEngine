import {
  BenchmarkRunController,
  PerspectiveCamera,
  Renderer,
  captureWebGpuLimits,
  createBenchmarkCaseManifest,
  createEnvironmentManifest,
  serializeBenchmarkResult,
  validateBenchmarkEvidence,
  type BenchmarkAdapterIdentity,
  type BenchmarkResult,
  type BenchmarkSceneManifest
} from "../../OEngine/src/index.ts";
import {
  createBenchmarkSceneFixture,
  type BenchmarkRuntimeProfile
} from "./BenchmarkScenes.ts";
import { loadBenchmarkSceneManifest } from "./manifest-loader.ts";

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DIRTY__: boolean;
declare const __BUILD_DIRTY_REASONS__: string[];

export async function startBenchmarkPage(manifestUrl: URL): Promise<void> {
  const elements = pageElements();
  try {
    const manifest = await loadBenchmarkSceneManifest(manifestUrl);
    const profile = readProfile();
    renderManifest(elements, manifest, profile);
    const canvas = elements.canvas;
    canvas.width = manifest.frame.width;
    canvas.height = manifest.frame.height;
    canvas.style.width = `${manifest.frame.width}px`;
    canvas.style.height = `${manifest.frame.height}px`;
    const context = canvas.getContext("webgpu");
    if (context === null) throw new Error("当前浏览器没有可用的 WebGPU canvas context");

    const renderer = new Renderer();
    await renderer.initialize({ context, pixelRatio: manifest.frame.dpr });
    configurePipeline(renderer, manifest.id);
    const run = profileRun(manifest, profile);
    renderer.profiler.configure({
      enabled: true,
      gpuSampleInterval: run.gpuSampleInterval,
      gpuCounterSampleInterval: run.gpuCounterSampleInterval,
      readbackRingSlots: run.readbackRingSlots,
      historyCapacity: run.warmupFrames + run.sampleFrames + 8
    });
    elements.status.textContent = "正在构建固定场景";
    elements.detail.textContent = adapterDescription(renderer.adapter_info);
    const fixture = await createBenchmarkSceneFixture(manifest, profile);
    const camera = createCamera(manifest, renderer.aspect_ratio);
    renderCounts(elements, manifest, fixture.runtimeCounts, profile);

    const dirtyReasons = [...__BUILD_DIRTY_REASONS__];
    if (profile === "smoke") dirtyReasons.push("benchmark-profile-smoke-not-gate");
    const output = renderer.output_resolution;
    const environment = createEnvironmentManifest({
      engine: {
        commit: __BUILD_COMMIT__,
        dirty: __BUILD_DIRTY__ || profile === "smoke",
        dirtyReasons
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
        dpr: manifest.frame.dpr
      },
      run: {
        baselineRole: manifest.baselineRole,
        featureSet: manifest.featureSet,
        ...run
      }
    });
    const controller = new BenchmarkRunController(
      renderer.profiler,
      environment,
      createBenchmarkCaseManifest(manifest)
    );
    elements.status.textContent = "正在预热并采集统一主管线";
    const result = await controller.run({
      frame: (ordinal) => {
        fixture.update(ordinal);
        if (!renderer.render(camera, fixture.scene, 1 / 60)) {
          throw new Error("Renderer stopped because the GPU device was lost");
        }
      },
      settle: () => renderer.device.queue.onSubmittedWorkDone(),
      gpuWaitTimeoutMs: 20000,
      onProgress: (progress) => {
        elements.progress.textContent = `${progress.measuredFrames} / ${run.sampleFrames}`;
        if (progress.pendingGpuFrames > 0) {
          elements.detail.textContent = `等待 ${progress.pendingGpuFrames} 个延迟 GPU 样本`;
        }
      }
    });
    finishPage(elements, manifest, profile, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    elements.status.textContent = "运行失败";
    elements.detail.textContent = message;
    elements.statusDot.classList.add("error");
    elements.result.textContent = error instanceof Error && error.stack ? error.stack : message;
    console.error(error);
  }
}

function finishPage(
  elements: PageElements,
  manifest: BenchmarkSceneManifest,
  profile: BenchmarkRuntimeProfile,
  result: BenchmarkResult
): void {
  const evidence = validateBenchmarkEvidence(result);
  const counterIssues = validateCounterInvariants(result);
  const diagnostics = result.diagnostics;
  const runtimeClean = diagnostics.validationErrorCount === 0 &&
    diagnostics.uncapturedErrorCount === 0 &&
    diagnostics.deviceLostCount === 0 &&
    diagnostics.failedGpuTimestampBatches === 0 &&
    diagnostics.droppedGpuCounterSamples === 0 &&
    diagnostics.failedGpuCounterSamples === 0 &&
    counterIssues.length === 0;
  elements.status.textContent = runtimeClean ? "采集完成" : "采集完成（证据错误）";
  elements.statusDot.classList.add(runtimeClean ? "ok" : "error");
  elements.detail.textContent = [
    `profile=${profile}`,
    `gateEligible=${evidence.gateEligible}`,
    `capabilityComplete=${evidence.capabilityComplete}`,
    `blockers=${evidence.blockedCapabilities.length}`,
    `counterIssues=${counterIssues.length}`
  ].join(" · ");
  elements.cpu.textContent = `${result.summary.cpuMs.frame.p50.toFixed(3)} ms`;
  elements.submit.textContent = result.summary.submits.mean.toFixed(2);
  elements.gate.textContent = evidence.gateEligible ? "eligible" : "not eligible";
  elements.capability.textContent = evidence.capabilityComplete
    ? "complete"
    : `${evidence.blockedCapabilities.length} blocked`;
  elements.result.textContent = serializeBenchmarkResult(result);
  elements.download.disabled = false;
  elements.download.onclick = () => downloadResult(manifest, profile, result);
  console.info("OBS-02 benchmark evidence", { manifest, profile, evidence, counterIssues });
}

function validateCounterInvariants(result: BenchmarkResult): string[] {
  const issues: string[] = [];
  const expectedPixels = result.environment.frame.internalWidth * result.environment.frame.internalHeight;
  for (const frame of result.frames) {
    const counters = frame.gpuCounters.values;
    if (!frame.gpuCounters.sampled || frame.gpuCounters.dropped) continue;
    if (
      counters.shadedPixels !== undefined &&
      counters.emptyVisibilityPixels !== undefined &&
      counters.shadedPixels + counters.emptyVisibilityPixels !== expectedPixels
    ) issues.push(`frame ${frame.frameIndex}: visibility pixel sum`);
    if (
      counters.candidateInstances !== undefined &&
      counters.visibleInstances !== undefined &&
      counters.rejectedFrustum !== undefined &&
      counters.candidateInstances !== counters.visibleInstances + counters.rejectedFrustum
    ) issues.push(`frame ${frame.frameIndex}: instance partition`);
    if (
      counters.selectedClusters !== undefined &&
      counters.hwClusters !== undefined &&
      counters.alphaClusters !== undefined &&
      counters.selectedClusters !== counters.hwClusters + counters.alphaClusters
    ) issues.push(`frame ${frame.frameIndex}: cluster partition`);
    if (
      counters.hwTriangles !== undefined &&
      counters.selectedClusters !== undefined &&
      counters.hwTriangles !== counters.selectedClusters * 128
    ) issues.push(`frame ${frame.frameIndex}: hardware triangle count`);
  }
  return issues;
}

function profileRun(
  manifest: BenchmarkSceneManifest,
  profile: BenchmarkRuntimeProfile
): BenchmarkSceneManifest["run"] {
  if (profile === "full") return manifest.run;
  return {
    warmupFrames: 4,
    sampleFrames: 12,
    gpuSampleInterval: 4,
    gpuCounterSampleInterval: 4,
    readbackRingSlots: 3
  };
}

function createCamera(manifest: BenchmarkSceneManifest, aspect: number): PerspectiveCamera {
  const first = manifest.camera.keyframes[0]!;
  const camera = new PerspectiveCamera();
  camera.aspect = aspect;
  camera.near = 0.1;
  camera.far = 5000;
  camera.transform.position.set(...first.position);
  camera.transform.lookAt({ x: first.target[0], y: first.target[1], z: first.target[2] });
  camera.update();
  return camera;
}

function configurePipeline(renderer: Renderer, caseId: BenchmarkSceneManifest["id"]): void {
  renderer.feature_shadows_enabled = caseId === "C";
  renderer.feature_ssr_enabled = false;
  renderer.feature_ssao_enabled = false;
  renderer.feature_taa_enabled = false;
  renderer.feature_bloom_enabled = false;
  renderer.feature_automatic_exposure_enabled = false;
  renderer.feature_motion_blur_enabled = false;
  renderer.feature_sharpening_enabled = false;
}

function readProfile(): BenchmarkRuntimeProfile {
  return new URLSearchParams(location.search).get("profile") === "smoke"
    ? "smoke"
    : "full";
}

function renderManifest(
  elements: PageElements,
  manifest: BenchmarkSceneManifest,
  profile: BenchmarkRuntimeProfile
): void {
  document.title = `OEngine Benchmark ${manifest.id}`;
  elements.title.textContent = manifest.name;
  elements.role.textContent = manifest.baselineRole;
  elements.profile.textContent = profile;
  elements.manifest.textContent = JSON.stringify(manifest, null, 2);
  elements.limitations.innerHTML = "";
  for (const limitation of manifest.currentLimitations) {
    const item = document.createElement("li");
    item.textContent = limitation;
    elements.limitations.append(item);
  }
}

function renderCounts(
  elements: PageElements,
  manifest: BenchmarkSceneManifest,
  actual: { instances: number; consumedGeometries: number; materials: number; localLights: number },
  profile: BenchmarkRuntimeProfile
): void {
  elements.counts.textContent = [
    `instances=${actual.instances}/${manifest.counts.instances}`,
    `geometry inputs consumed=${actual.consumedGeometries}/${manifest.counts.geometries}`,
    `materials=${actual.materials}/${manifest.counts.materials}`,
    `local lights=${actual.localLights}/${manifest.counts.localLights}`,
    profile === "smoke" ? "缩小验证，不可作为 gate artifact" : "full contract"
  ].join(" · ");
}

function downloadResult(
  manifest: BenchmarkSceneManifest,
  profile: BenchmarkRuntimeProfile,
  result: BenchmarkResult
): void {
  const blob = new Blob([serializeBenchmarkResult(result)], { type: "application/json" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `oengine-benchmark-${manifest.id.toLowerCase()}-${profile}-${__BUILD_COMMIT__.slice(0, 8)}.json`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

interface PageElements {
  canvas: HTMLCanvasElement;
  title: HTMLElement;
  status: HTMLElement;
  detail: HTMLElement;
  statusDot: HTMLElement;
  role: HTMLElement;
  profile: HTMLElement;
  progress: HTMLElement;
  cpu: HTMLElement;
  submit: HTMLElement;
  gate: HTMLElement;
  capability: HTMLElement;
  counts: HTMLElement;
  limitations: HTMLUListElement;
  manifest: HTMLElement;
  result: HTMLElement;
  download: HTMLButtonElement;
}

function pageElements(): PageElements {
  return {
    canvas: requiredElement("gpu-canvas"),
    title: requiredElement("page-title"),
    status: requiredElement("status"),
    detail: requiredElement("detail"),
    statusDot: requiredElement("status-dot"),
    role: requiredElement("role"),
    profile: requiredElement("profile"),
    progress: requiredElement("progress"),
    cpu: requiredElement("cpu-p50"),
    submit: requiredElement("submit-mean"),
    gate: requiredElement("gate"),
    capability: requiredElement("capability"),
    counts: requiredElement("counts"),
    limitations: requiredElement("limitations"),
    manifest: requiredElement("manifest"),
    result: requiredElement("result"),
    download: requiredElement("download")
  };
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

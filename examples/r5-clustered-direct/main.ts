import {
  BenchmarkRunController,
  PerspectiveCamera,
  Renderer,
  captureWebGpuLimits,
  createBenchmarkCaseManifest,
  createEnvironmentManifest,
  type BenchmarkResult,
  type GpuCounterFieldName
} from "../../OEngine/src/index.ts";
import {
  configureClusteredLightingFixture,
  createBenchmarkSceneFixture,
  type ClusteredLightKind,
  type ClusteredLightLayout
} from "../benchmark-shared/BenchmarkScenes.ts";
import { loadBenchmarkSceneManifest } from "../benchmark-shared/manifest-loader.ts";

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DIRTY__: boolean;
declare const __BUILD_DIRTY_REASONS__: string[];
declare const __BUILD_CONTENT_HASH__: string;

type ClusterStatistics = ReturnType<typeof summarizeClusterStatistics>;
type Fx02Result = {
  completed: true;
  passed: boolean;
  issues: string[];
  build: { commit: string; dirty: boolean; dirtyReasons: string[]; contentHash: string };
  case: { count: number; layout: ClusteredLightLayout; kind: ClusteredLightKind };
  statistics: ClusterStatistics;
  listMicro: Awaited<ReturnType<typeof runBoundedListGpuMicro>> | null;
  result: BenchmarkResult;
  sequence?: Awaited<ReturnType<typeof runDynamicLightSequence>>;
};

declare global { interface Window { __OENGINE_FX_02_RESULT__?: Fx02Result; } }

const query = new URLSearchParams(location.search);
const count = Math.max(0, Number.parseInt(query.get("count") ?? "0", 10) || 0);
const layout: ClusteredLightLayout = query.get("layout") === "overlap" ? "overlap" : "spread";
const kind: ClusteredLightKind = query.get("kind") === "spot" ? "spot" : query.get("kind") === "directional" ? "directional" : "point";
const smoke = query.get("profile") === "smoke";
const sequence = query.get("sequence") === "1";
void run();

async function run(): Promise<void> {
  const status = required("status");
  const detail = required("detail");
  const output = required("result");
  try {
    const manifest = await loadBenchmarkSceneManifest(new URL("../benchmark-shared/manifests/benchmark-c.json", import.meta.url));
    const canvas = required<HTMLCanvasElement>("gpu-canvas");
    canvas.width = manifest.frame.width;
    canvas.height = manifest.frame.height;
    canvas.style.width = `${manifest.frame.width}px`;
    canvas.style.height = `${manifest.frame.height}px`;
    const context = canvas.getContext("webgpu");
    if (context === null) throw new Error("WebGPU canvas context unavailable");
    const renderer = new Renderer();
    await renderer.initialize({ context, pixelRatio: 1 });
    renderer.configure({ features: {
      shadows: false, screenSpaceReflections: false, ambientOcclusion: false,
      temporalAntiAliasing: false, bloom: false, automaticExposure: false,
      motionBlur: false, sharpening: false
    } });
    const runConfig = sequence
      ? { warmupFrames: 2, sampleFrames: 4, gpuSampleInterval: 1,
          gpuCounterSampleInterval: 1, readbackRingSlots: 8 }
      : smoke
        ? { warmupFrames: 4, sampleFrames: 12, gpuSampleInterval: 4,
            gpuCounterSampleInterval: 4, readbackRingSlots: 3 }
        : manifest.run;
    renderer.profiler.configure({ enabled: true, gpuSampleInterval: runConfig.gpuSampleInterval, gpuCounterSampleInterval: runConfig.gpuCounterSampleInterval, readbackRingSlots: runConfig.readbackRingSlots, historyCapacity: runConfig.warmupFrames + runConfig.sampleFrames + 8 });
    const fixture = await createBenchmarkSceneFixture(renderer, manifest, "full");
    configureClusteredLightingFixture(fixture, count, layout, kind);
    const camera = new PerspectiveCamera();
    const keyframe = manifest.camera.keyframes[0]!;
    camera.aspect = renderer.aspect_ratio;
    camera.near = 0.1;
    camera.far = 5000;
    camera.transform.position.set(...keyframe.position);
    camera.transform.lookAt({ x: keyframe.target[0], y: keyframe.target[1], z: keyframe.target[2] });
    camera.update();
    const resolution = renderer.output_resolution;
    const environment = createEnvironmentManifest({
      engine: { commit: __BUILD_COMMIT__, dirty: __BUILD_DIRTY__ || smoke, dirtyReasons: [...__BUILD_DIRTY_REASONS__, ...(smoke ? ["fx02-smoke"] : [])] },
      platform: { os: navigator.platform || "unknown", browser: navigator.userAgent, userAgent: navigator.userAgent },
      adapter: renderer.adapter_info,
      webgpu: { features: renderer.device.features, limits: captureWebGpuLimits(renderer.device.limits), powerPreference: "high-performance" },
      frame: { canvasWidth: canvas.width, canvasHeight: canvas.height, internalWidth: resolution.x, internalHeight: resolution.y, dpr: 1 },
      run: { baselineRole: manifest.baselineRole, featureSet: manifest.featureSet, ...runConfig }
    });
    if (sequence) {
      status.textContent = "动态序列采集";
      const sequenceResult = await runDynamicLightSequence(
        renderer,
        fixture,
        camera,
        environment,
        layout,
        kind
      );
      renderer.profiler.configure({ enabled: false });
      const issues = [...sequenceResult.issues];
      const last = sequenceResult.states.at(-1)!;
      const pageResult: Fx02Result = {
        completed: true,
        passed: issues.length === 0,
        issues,
        build: { commit: __BUILD_COMMIT__, dirty: __BUILD_DIRTY__,
          dirtyReasons: __BUILD_DIRTY_REASONS__, contentHash: __BUILD_CONTENT_HASH__ },
        case: { count: last.count, layout, kind },
        statistics: last.statistics,
        listMicro: null,
        result: last.result,
        sequence: sequenceResult
      };
      window.__OENGINE_FX_02_RESULT__ = pageResult;
      status.textContent = pageResult.passed ? "PASS" : "FAIL";
      detail.textContent = `dynamic 0→1→16→256→0 · reject=${sequenceResult.capacityRejection.rejected}`;
      output.textContent = JSON.stringify(pageResult, null, 2);
      return;
    }
    const controller = new BenchmarkRunController(renderer.profiler, environment, createBenchmarkCaseManifest(manifest));
    status.textContent = "采集";
    const result = await controller.run({
      frame: (ordinal) => { fixture.update(ordinal); if (!renderer.render(camera, fixture.scene, 1 / 60)) throw new Error("GPU device lost"); },
      settle: () => renderer.device.queue.onSubmittedWorkDone(),
      gpuWaitTimeoutMs: 20_000
    });
    renderer.profiler.configure({ enabled: false });
    const listMicro = query.get("micro") === "1"
      ? await runBoundedListGpuMicro(renderer.device)
      : null;
    const statistics = summarizeClusterStatistics(result);
    const issues = validate(count, layout, kind, result, statistics);
    if (listMicro !== null && !listMicro.passed) issues.push(...listMicro.issues);
    const pageResult: Fx02Result = { completed: true, passed: issues.length === 0, issues, build: { commit: __BUILD_COMMIT__, dirty: __BUILD_DIRTY__, dirtyReasons: __BUILD_DIRTY_REASONS__, contentHash: __BUILD_CONTENT_HASH__ }, case: { count, layout, kind }, statistics, listMicro, result };
    window.__OENGINE_FX_02_RESULT__ = pageResult;
    status.textContent = pageResult.passed ? "PASS" : "FAIL";
    detail.textContent = `${kind} ${count} ${layout} · overflow=${statistics.overflowClusters} · fallback=${statistics.fallbackLights}`;
    output.textContent = JSON.stringify(pageResult, null, 2);
  } catch (error) {
    status.textContent = "FAIL";
    detail.textContent = error instanceof Error ? error.message : String(error);
    console.error(error);
  }
}

function summarizeClusterStatistics(result: BenchmarkResult) {
  const samples = result.frames.filter((frame) => frame.gpuCounters.sampled && !frame.gpuCounters.dropped);
  const value = (field: GpuCounterFieldName) => median(samples.map((frame) => frame.gpuCounters.values[field] ?? 0));
  const clusterCount = result.summary.counters["lighting.clusterCount"]?.p50 ?? 0;
  const references = value("clusterLightReferences");
  const histogram = [[0, value("clusterHistogram0")], [1, value("clusterHistogram1")], [4, value("clusterHistogram4")], [8, value("clusterHistogram8")], [16, value("clusterHistogram16")], [32, value("clusterHistogram32")], [64, value("clusterHistogram64")], [128, value("clusterHistogram128")], [256, value("clusterHistogram256")]] as const;
  let cumulative = 0;
  let p95 = 0;
  for (const [upper, frequency] of histogram) { cumulative += frequency; if (cumulative >= clusterCount * 0.95) { p95 = upper; break; } }
  const direct = Object.entries(result.summary.gpuMs).find(([name]) => name.endsWith("/Direct lighting Ch"))?.[1] ?? null;
  return {
    activeLights: value("activeLights"), activeAttempted: value("activeLightsAttempted"), candidateAttempted: value("candidateLightsAttempted"), candidateWritten: value("candidateLightsWritten"), testedLights: value("clusterTestedLights"), writtenIndices: value("clusterLightIndicesWritten"), attemptedIndices: value("clusterLightIndicesAttempted"), averageLightsPerCluster: clusterCount === 0 ? 0 : references / clusterCount, p95LightsPerCluster: p95, p95Method: "GPU histogram upper bound", maxLightsPerCluster: value("clusterMaxLights"), overflowClusters: value("clusterOverflowClusters"), fallbackLights: value("clusterFallbackLights"), clusterCount, histogram: Object.fromEntries(histogram.map(([upper, frequency]) => [String(upper), frequency])), clusterBuildGpuMs: result.summary.gpuPhaseMs["light-cluster"] ?? null, directLightingGpuMs: direct
  };
}

function validate(countValue: number, layoutValue: ClusteredLightLayout, kindValue: ClusteredLightKind, result: BenchmarkResult, stats: ClusterStatistics): string[] {
  const issues: string[] = [];
  const d = result.diagnostics;
  if (d.validationErrorCount || d.uncapturedErrorCount || d.deviceLostCount) issues.push("WebGPU diagnostics are non-zero");
  if (d.failedGpuTimestampBatches || d.droppedGpuCounterSamples || d.failedGpuCounterSamples) issues.push("GPU timestamp/counter diagnostics are non-zero");
  if (stats.candidateAttempted !== stats.candidateWritten) issues.push("candidate LightList overflowed");
  if (stats.activeAttempted !== stats.activeLights) issues.push("active LightList overflowed");
  if (stats.writtenIndices > stats.attemptedIndices) issues.push("cluster data written exceeds attempted");
  if (Object.values(stats.histogram).reduce((sum, value) => sum + value, 0) !== stats.clusterCount) issues.push("cluster histogram does not cover every cluster");
  if (countValue === 0 && (stats.activeLights !== 0 || stats.maxLightsPerCluster !== 0)) issues.push("zero-light case has local direct lights");
  if (layoutValue === "overlap" && kindValue !== "directional" && countValue > 128 && (stats.overflowClusters === 0 || stats.fallbackLights === 0)) issues.push("overlap pressure did not trigger conservative fallback");
  return issues;
}

async function runDynamicLightSequence(
  renderer: Renderer,
  fixture: Awaited<ReturnType<typeof createBenchmarkSceneFixture>>,
  camera: PerspectiveCamera,
  environment: ReturnType<typeof createEnvironmentManifest>,
  layoutValue: ClusteredLightLayout,
  kindValue: ClusteredLightKind
) {
  const counts = [0, 1, 16, 256, 0] as const;
  const states = [];
  const issues: string[] = [];
  for (const countValue of counts) {
    configureClusteredLightingFixture(fixture, countValue, layoutValue, kindValue);
    const firstFrame = renderer.frame_count;
    const controller = new BenchmarkRunController(renderer.profiler, environment, {
      id: `FX-02-dynamic-${countValue}-${firstFrame}`,
      name: `FX-02 same-graph dynamic ${countValue} lights`,
      sceneAssetHashes: [],
      seed: 0x46583032,
      cameraPathHash: "fx02-same-renderer-dynamic-v1"
    });
    const result = await controller.run({
      scheduleFrame: async () => {},
      frame: (ordinal) => {
        fixture.update(firstFrame + ordinal);
        if (!renderer.render(camera, fixture.scene, 1 / 60)) {
          throw new Error("GPU device lost");
        }
      },
      settle: () => renderer.device.queue.onSubmittedWorkDone(),
      gpuWaitTimeoutMs: 20_000
    });
    const statistics = summarizeClusterStatistics(result);
    const frameEvidence = renderer.profiler.history.filter(
      (frame) => frame.frameIndex >= firstFrame && frame.frameIndex < renderer.frame_count
    );
    const graphBuilds = frameEvidence.reduce((sum, frame) => sum + frame.graph.builds, 0);
    const graphCompiles = frameEvidence.reduce((sum, frame) => sum + frame.graph.compiles, 0);
    const graphCacheHits = frameEvidence.reduce((sum, frame) => sum + frame.graph.cacheHits, 0);
    const expectedLocalComputeLabels = [
      "LightCluster/list",
      "LightCluster/nE",
      "LightCluster/yh"
    ] as const;
    const localComputeLabels = [...new Set(result.frames.flatMap((frame) =>
      frame.gpu.segments.flatMap((segment) =>
        expectedLocalComputeLabels.filter((label) => segment.label.endsWith(label))
      )
    ))];
    const stateIssues = validate(
      countValue,
      layoutValue,
      kindValue,
      result,
      statistics
    );
    if (statistics.activeLights !== (kindValue === "directional" ? 0 : countValue)) {
      stateIssues.push(`activeLights mismatch for ${countValue}`);
    }
    if (countValue === 0 && localComputeLabels.length !== 0) {
      stateIssues.push("zero-light state encoded local LightCluster compute work");
    }
    if (countValue > 0 && kindValue !== "directional" && localComputeLabels.length !== 3) {
      stateIssues.push(`local LightCluster compute evidence incomplete for ${countValue}`);
    }
    if (states.length === 0) {
      if (graphBuilds !== 1 || graphCompiles !== 1) {
        stateIssues.push(`first state expected one graph build/compile, got ${graphBuilds}/${graphCompiles}`);
      }
    } else if (graphBuilds !== 0 || graphCompiles !== 0) {
      stateIssues.push(`dynamic count ${countValue} rebuilt/recompiled the graph`);
    }
    if (graphCacheHits < frameEvidence.length - 1) {
      stateIssues.push(`dynamic count ${countValue} did not reuse the compiled graph`);
    }
    issues.push(...stateIssues.map((issue) => `${countValue}: ${issue}`));
    states.push({
      count: countValue,
      statistics,
      graph: { builds: graphBuilds, compiles: graphCompiles, cacheHits: graphCacheHits },
      localComputeLabels,
      mainSubmits: result.frames.map((frame) => frame.submits.count),
      issues: stateIssues,
      result
    });
  }

  // Capacity is an intentional CPU-side rejection probe. Keep profiler frame
  // accounting, but do not create timestamp/counter readbacks for the two
  // boundary renders, otherwise the aborted command context reports an
  // expected rejection as an asynchronous readback error.
  renderer.profiler.configure({
    gpuSampleInterval: 1_000_003,
    gpuCounterSampleInterval: 1_000_003
  });
  configureClusteredLightingFixture(fixture, 16_380, layoutValue, "point");
  let capacityAccepted = false;
  try {
    capacityAccepted = renderer.render(camera, fixture.scene, 1 / 60);
    await renderer.device.queue.onSubmittedWorkDone();
  } catch (error) {
    issues.push(`capacity boundary 16380 was rejected: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!capacityAccepted) issues.push("capacity boundary 16380 did not render");

  configureClusteredLightingFixture(fixture, 16_381, layoutValue, "point");
  let rejectionMessage: string | null = null;
  try {
    renderer.render(camera, fixture.scene, 1 / 60);
  } catch (error) {
    rejectionMessage = describeErrorChain(error);
  }
  const rejected = rejectionMessage?.includes(
    "exceeds the explicit LightList capacity 16380"
  ) ?? false;
  const rejectedFrame = renderer.profiler.latest;
  const capacityRejection = {
    requested: 16_381,
    capacity: 16_380,
    capacityAccepted,
    rejected,
    message: rejectionMessage,
    submits: rejectedFrame?.submits.count ?? -1
  };
  if (!rejected) issues.push("16381 local lights were not rejected by the runtime-bound capacity guard");
  if ((rejectedFrame?.submits.count ?? -1) !== 0) {
    issues.push("capacity rejection submitted partial GPU work");
  }
  return { counts, states, capacityRejection, issues };
}

function describeErrorChain(error: unknown): string {
  const messages: string[] = [];
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && current !== undefined && !visited.has(current)) {
    visited.add(current);
    messages.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error
      ? (current as Error & { cause?: unknown }).cause
      : undefined;
  }
  return messages.join(": ");
}

function median(values: number[]): number { if (values.length === 0) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]!; }
function required<T extends HTMLElement = HTMLElement>(id: string): T { const value = document.getElementById(id); if (value === null) throw new Error(`Missing #${id}`); return value as T; }

async function runBoundedListGpuMicro(device: GPUDevice) {
  const cases = [{ capacity: 2, attempts: 1 }, { capacity: 2, attempts: 2 }, { capacity: 2, attempts: 3 }];
  const results: { capacity: number; attempts: number; header: number[]; passed: boolean }[] = [];
  const issues: string[] = [];
  for (const item of cases) {
    const byteLength = 16 + item.capacity * 4;
    const output = device.createBuffer({ size: byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const readback = device.createBuffer({ size: byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const module = device.createShaderModule({ code: `
struct List { attempted: atomic<u32>, written: atomic<u32>, capacity: atomic<u32>, overflow: atomic<u32>, data: array<u32>, }
@group(0) @binding(0) var<storage, read_write> output: List;
fn append(value: u32) {
  let capacity = arrayLength(&output.data);
  atomicStore(&output.capacity, capacity);
  atomicAdd(&output.attempted, 1u);
  loop {
    let current = atomicLoad(&output.written);
    if (current >= capacity) { atomicStore(&output.overflow, 1u); return; }
    let reservation = atomicCompareExchangeWeak(&output.written, current, current + 1u);
    if (reservation.exchanged) { output.data[current] = value; return; }
  }
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < ${item.attempts}u) { append(id.x); }
}` });
    const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: output } }] });
    const encoder = device.createCommandEncoder();
    encoder.clearBuffer(output);
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, byteLength);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const header = Array.from(new Uint32Array(readback.getMappedRange().slice(0, 16)));
    readback.unmap();
    const expectedWritten = Math.min(item.capacity, item.attempts);
    const passed = header[0] === item.attempts && header[1] === expectedWritten && header[2] === item.capacity && header[3] === (item.attempts > item.capacity ? 1 : 0);
    if (!passed) issues.push(`GPU bounded-list ${item.attempts}/${item.capacity} mismatch: ${header.join(",")}`);
    results.push({ ...item, header, passed });
    output.destroy();
    readback.destroy();
  }
  return { passed: issues.length === 0, issues, cases: results };
}

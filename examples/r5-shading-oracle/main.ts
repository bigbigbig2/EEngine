import {
  BenchmarkRunController,
  PerspectiveCamera,
  Renderer,
  RenderDebugView,
  captureWebGpuLimits,
  createEnvironmentManifest,
  type BenchmarkResult
} from "../../OEngine/src/index.ts";
import { createFx03ShadingOracleFixture } from "../benchmark-shared/BenchmarkScenes.ts";
import { ENVIRONMENT_PREFILTER_WGSL } from "../../OEngine/src/shaders/environment_prefilter.ts";
import { floatToHalf, halfToFloat } from "../../OEngine/src/loaders/float16.ts";
import { STATIC_GRAPHICS_ENGINE_ASSETS } from "../../OEngine/src/render/STATIC_GRAPHICS_ENGINE_ASSETS.ts";
import { iblMaterialTerms, iblRoughnessToLod } from "../../OEngine/src/render/IblAlignment.ts";

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DIRTY__: boolean;
declare const __BUILD_DIRTY_REASONS__: string[];
declare const __BUILD_CONTENT_HASH__: string;

const VIEWS = {
  FinalTonemapped: RenderDebugView.None,
  BaseColor: RenderDebugView.BaseColor,
  Normal: RenderDebugView.ShadingNormal,
  Roughness: RenderDebugView.Roughness,
  Metallic: RenderDebugView.Metallic,
  DiffuseIbl: RenderDebugView.IndirectDiffuse,
  SpecularIbl: RenderDebugView.IndirectSpecular,
  LinearHdr: RenderDebugView.LinearHdr
} as const;

type ViewName = keyof typeof VIEWS;
type Fx03Result = {
  completed: true;
  passed: boolean;
  issues: string[];
  build: { commit: string; dirty: boolean; dirtyReasons: string[]; contentHash: string };
  contract: Record<string, unknown>;
  statistics: Record<string, unknown>;
  numeric: Record<string, unknown>;
  result: BenchmarkResult;
};

declare global {
  interface Window {
    __OENGINE_FX_03_RESULT__?: Fx03Result;
    __OENGINE_FX_03__?: { renderView(name: ViewName): Promise<{ name: ViewName; frame: number }> };
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
    renderer.resize(960, 720);
    configureRenderer(renderer);
    renderer.profiler.configure({
      enabled: true,
      gpuSampleInterval: 4,
      gpuCounterSampleInterval: 4,
      readbackRingSlots: 3,
      historyCapacity: 40
    });
    const fixture = await createFx03ShadingOracleFixture(renderer);
    const camera = new PerspectiveCamera();
    camera.aspect = 4 / 3;
    camera.near = 0.05;
    camera.far = 100;
    camera.transform.position.set(0, 0, 3.2);
    camera.transform.lookAt({ x: 0, y: -1, z: 0 });
    camera.update();

    window.__OENGINE_FX_03__ = {
      renderView: async (name) => {
        renderer.render_debug_view = VIEWS[name];
        for (let index = 0; index < 3; index++) {
          if (!renderer.render(camera, fixture.scene, 1 / 60)) throw new Error("GPU device lost");
        }
        await renderer.device.queue.onSubmittedWorkDone();
        return { name, frame: renderer.frame_count };
      }
    };

    const runConfig = { warmupFrames: 6, sampleFrames: 18, gpuSampleInterval: 4,
      gpuCounterSampleInterval: 4, readbackRingSlots: 3 };
    const resolution = renderer.output_resolution;
    const environment = createEnvironmentManifest({
      engine: { commit: __BUILD_COMMIT__, dirty: __BUILD_DIRTY__, dirtyReasons: __BUILD_DIRTY_REASONS__ },
      platform: { os: navigator.platform || "unknown", browser: navigator.userAgent, userAgent: navigator.userAgent },
      adapter: renderer.adapter_info,
      webgpu: { features: renderer.device.features, limits: captureWebGpuLimits(renderer.device.limits), powerPreference: "high-performance" },
      frame: { canvasWidth: canvas.width, canvasHeight: canvas.height, internalWidth: resolution.x, internalHeight: resolution.y, dpr: 1 },
      run: { baselineRole: "minimum-b", featureSet: ["hardware-visibility", "packed-instances", "single-material-resolve", "ibl"], ...runConfig }
    });
    const controller = new BenchmarkRunController(renderer.profiler, environment, {
      id: "FX-03-B-shading-oracle",
      name: "Damaged Helmet fixed linear HDR IBL",
      sceneAssetHashes: ["30dcaef780c6233a235ccadba761a7e0b50d8a98705a1d8b80f2b3b52e0fe57a"],
      seed: 0x46583033,
      cameraPathHash: "fx03-fixed-camera-v1"
    });
    const benchmark = await controller.run({
      frame: (ordinal) => {
        fixture.update(ordinal);
        if (!renderer.render(camera, fixture.scene, 1 / 60)) throw new Error("GPU device lost");
      },
      settle: () => renderer.device.queue.onSubmittedWorkDone(),
      gpuWaitTimeoutMs: 20_000
    });
    const numeric = await runIblGpuMicro(renderer.device);
    const statistics = summarize(benchmark);
    const issues = validate(benchmark, statistics);
    if (!numeric.passed) issues.push(...numeric.issues);
    const result: Fx03Result = {
      completed: true,
      passed: issues.length === 0,
      issues,
      build: { commit: __BUILD_COMMIT__, dirty: __BUILD_DIRTY__, dirtyReasons: __BUILD_DIRTY_REASONS__, contentHash: __BUILD_CONTENT_HASH__ },
      contract: {
        environment: "64x64 rgba16float octahedral working-linear scene-referred",
        specular: "GGX importance sampling; perceptual roughness -> dynamic mip chain",
        diffuse: "independent cosine-weighted irradiance integral; composite applies 1/PI",
        directLights: 0,
        disabled: ["shadow", "SSR", "SSAO", "TAA", "bloom", "auto-exposure", "motion-blur", "sharpening"],
        captureViews: Object.keys(VIEWS)
      },
      statistics,
      numeric,
      result: benchmark
    };
    window.__OENGINE_FX_03_RESULT__ = result;
    status.textContent = result.passed ? "FX-03 production Gate passed" : "FX-03 production Gate failed";
    status.className = result.passed ? "ok" : "error";
    detail.textContent = `mips=${statistics.mipLevelCount} sampled=${statistics.sampledPixels}`;
    output.textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    status.textContent = "FX-03 production Gate failed";
    status.className = "error";
    detail.textContent = error instanceof Error ? error.message : String(error);
    console.error(error);
  }
}

async function runIblGpuMicro(device: GPUDevice) {
  const expected = [0.25, 0.5, 2] as const;
  // Keep the upload portable by honoring a 256-byte row pitch. rgba16float is
  // 8 bytes/texel, so each four-texel row occupies 16 u16 values followed by
  // padding up to 128 u16 values.
  const row = new Uint16Array(4 * 128);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const offset = y * 128 + x * 4;
    row[offset] = floatToHalf(expected[0]);
    row[offset + 1] = floatToHalf(expected[1]);
    row[offset + 2] = floatToHalf(expected[2]);
    row[offset + 3] = floatToHalf(1);
  }
  const source = device.createTexture({
    label: "FX-03 constant HDR oracle", size: [4, 4], format: "rgba16float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
  });
  device.queue.writeTexture({ texture: source }, row, { bytesPerRow: 256, rowsPerImage: 4 }, [4, 4]);
  const module = device.createShaderModule({ label: "FX-03 production environment prefilter micro", code: ENVIRONMENT_PREFILTER_WGSL });
  const shaderMessages = [...(await module.getCompilationInfo()).messages].map((message) => ({
    type: message.type, message: message.message, lineNum: message.lineNum, linePos: message.linePos
  }));
  const cases = [];
  for (const entryPoint of ["prefilter_specular", "convolve_diffuse"] as const) {
    device.pushErrorScope("validation");
    const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint } });
    const output = device.createTexture({ label: `FX-03 ${entryPoint} output`, size: [1, 1], format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
    const uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
    const parameters = new DataView(uniform.getMappedRange());
    parameters.setFloat32(0, 0.5, true);
    parameters.setUint32(4, 64, true);
    parameters.setUint32(8, 4, true);
    parameters.setUint32(12, 0, true);
    uniform.unmap();
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: source.createView() },
      { binding: 2, resource: output.createView() }
    ] });
    const readback = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder({ label: `FX-03 ${entryPoint} micro` });
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end();
    encoder.copyTextureToBuffer({ texture: output }, { buffer: readback, bytesPerRow: 256 }, [1, 1]);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const half = new Uint16Array(readback.getMappedRange().slice(0, 8));
    const actual = Array.from(half.slice(0, 3), halfToFloat);
    readback.unmap();
    const validationError = await device.popErrorScope();
    const target = entryPoint === "convolve_diffuse" ? expected.map((value) => value * Math.PI) : [...expected];
    const tolerance = entryPoint === "convolve_diffuse" ? 0.04 : 0.02;
    const passed = validationError === null && actual.every((value, index) => Math.abs(value - target[index]!) <= tolerance);
    cases.push({ entryPoint, actual, expected: target, tolerance, passed, validationError: validationError?.message ?? null });
    output.destroy(); uniform.destroy(); readback.destroy();
  }
  source.destroy();
  const roughnessCases = [0, 0.5, 1].map((roughness) => ({
    roughness,
    mipLevelCount: 7,
    lod: iblRoughnessToLod(roughness, 7)
  }));
  const metallicCases = [0, 1].map((metallic) => ({
    metallic,
    ...iblMaterialTerms([0.8, 0.4, 0.2], metallic)
  }));
  const brdfLut = inspectSplitSumLut();
  const issues = [
    ...cases.filter((entry) => !entry.passed).map((entry) => `${entry.entryPoint} GPU numeric oracle mismatch`),
    ...shaderMessages.filter((entry) => entry.type === "error").map((entry) => `shader: ${entry.message}`),
    ...(brdfLut.passed ? [] : ["split-sum BRDF LUT contract mismatch"])
  ];
  return {
    passed: issues.length === 0,
    issues,
    source: "production ENVIRONMENT_PREFILTER_WGSL + resident split_sum.bin",
    shaderMessages,
    cases,
    roughnessCases,
    metallicCases,
    brdfLut
  };
}

function inspectSplitSumLut() {
  const image = STATIC_GRAPHICS_ENGINE_ASSETS.split_sum.image;
  if (image === undefined || !(image.source instanceof ArrayBuffer)) {
    return { passed: false, reason: "split-sum CPU source unavailable" };
  }
  const encoded = new Uint16Array(image.source);
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  let sumMinimum = Number.POSITIVE_INFINITY;
  let sumMaximum = Number.NEGATIVE_INFINITY;
  let finite = true;
  for (let index = 0; index < encoded.length; index += 2) {
    const x = halfToFloat(encoded[index]!);
    const y = halfToFloat(encoded[index + 1]!);
    finite &&= Number.isFinite(x) && Number.isFinite(y);
    minimum = Math.min(minimum, x, y);
    maximum = Math.max(maximum, x, y);
    sumMinimum = Math.min(sumMinimum, x + y);
    sumMaximum = Math.max(sumMaximum, x + y);
  }
  const passed = image.width === 64 && image.height === 64 && image.depth === 1 &&
    image.channel_count === 2 && image.data_type === "float16" &&
    encoded.length === 64 * 64 * 2 && finite && minimum >= 0 && maximum <= 1 &&
    sumMinimum >= 0 && sumMaximum <= 1.001;
  return {
    passed,
    width: image.width,
    height: image.height,
    channels: image.channel_count,
    dataType: image.data_type,
    sampleCount: encoded.length / 2,
    finite,
    minimum,
    maximum,
    sumMinimum,
    sumMaximum
  };
}

function summarize(result: BenchmarkResult) {
  const sampled = result.frames.filter((frame) => frame.gpuCounters.sampled && !frame.gpuCounters.dropped);
  const median = (name: string) => {
    const values = sampled.map((frame) => Number(frame.gpuCounters.values[name as keyof typeof frame.gpuCounters.values] ?? 0)).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)] ?? 0;
  };
  const counter = (name: string) => result.summary.counters[name]?.p50 ?? 0;
  const histogram = Array.from({ length: 9 }, (_, mip) => median(`iblMip${mip}`));
  return {
    sampledFrames: sampled.length,
    sampledPixels: median("iblSampledPixels"),
    histogram,
    histogramTotal: histogram.reduce((sum, value) => sum + value, 0),
    mipLevelCount: counter("lighting.environment.specularMipLevelCount"),
    specularAllocatedBytes: counter("lighting.environment.specularAllocatedBytes"),
    diffuseAllocatedBytes: counter("lighting.environment.diffuseAllocatedBytes"),
    residentBytes: counter("gpu.residentBytes")
  };
}

function validate(result: BenchmarkResult, stats: ReturnType<typeof summarize>): string[] {
  const issues: string[] = [];
  const diagnostics = result.diagnostics;
  if (diagnostics.validationErrorCount || diagnostics.uncapturedErrorCount || diagnostics.deviceLostCount) issues.push("WebGPU diagnostics are non-zero");
  if (diagnostics.failedGpuTimestampBatches || diagnostics.droppedGpuCounterSamples || diagnostics.failedGpuCounterSamples) issues.push("GPU evidence diagnostics are non-zero");
  if (stats.sampledFrames < 1 || stats.sampledPixels < 1) issues.push("IBL sampled-pixel evidence is empty");
  if (stats.histogramTotal !== stats.sampledPixels) issues.push("IBL mip histogram does not cover sampled pixels");
  if (stats.mipLevelCount !== 7) issues.push(`expected 7 specular mips, got ${stats.mipLevelCount}`);
  if (stats.specularAllocatedBytes <= 0 || stats.diffuseAllocatedBytes <= 0) issues.push("environment owner memory evidence is missing");
  return issues;
}

function configureRenderer(renderer: Renderer): void {
  renderer.feature_shadows_enabled = false;
  renderer.feature_ssr_enabled = false;
  renderer.feature_ssao_enabled = false;
  renderer.feature_taa_enabled = false;
  renderer.feature_bloom_enabled = false;
  renderer.feature_automatic_exposure_enabled = false;
  renderer.feature_motion_blur_enabled = false;
  renderer.feature_sharpening_enabled = false;
}

function required<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (value === null) throw new Error(`Missing #${id}`);
  return value as T;
}

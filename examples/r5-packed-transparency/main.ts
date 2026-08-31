import {
  BenchmarkRunController,
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
  createSourceGeometry,
  createEnvironmentManifest,
  createGeometryCookRecipe,
  type BenchmarkResult,
  type GpuCounterFieldName
} from "../../OEngine/src/index.ts";
import { ShadeTransparencyMode } from "../../OEngine/src/material/enums.ts";
import { sortedAlphaComposite } from "../../OEngine/src/render/MomentOitReference.ts";

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DIRTY__: boolean;
declare const __BUILD_DIRTY_REASONS__: string[];
declare const __BUILD_CONTENT_HASH__: string;

interface CaseConfig {
  coverage: 0 | 10 | 50;
  layers: 1 | 4 | 8 | 16;
  materials: 1 | 8 | 64;
  order: "forward" | "reverse";
  mode: "standard" | "order-probe" | "emissive-probe";
}

declare global {
  interface Window {
    __OENGINE_FX_05_RESULT__?: Record<string, unknown>;
  }
}

void run();

async function run(): Promise<void> {
  const status = required("status");
  const detail = required("detail");
  const output = required("result");
  try {
    const config = readConfig();
    const canvas = required<HTMLCanvasElement>("gpu-canvas");
    const context = canvas.getContext("webgpu");
    if (context === null) throw new Error("WebGPU canvas context unavailable");
    const renderer = new Renderer();
    await renderer.initialize({ context, pixelRatio: 1 });
    renderer.resize(960, 720);
    configureRenderer(renderer);
    renderer.profiler.configure({
      enabled: true,
      gpuSampleInterval: 2,
      gpuCounterSampleInterval: 2,
      readbackRingSlots: 3,
      historyCapacity: 40
    });
    const fixture = await createFixture(renderer, config);
    const camera = new PerspectiveCamera();
    camera.aspect = 4 / 3;
    camera.near = 0.1;
    camera.far = 100;
    camera.transform.position.set(0, 0, 5.5);
    camera.transform.lookAt({ x: 0, y: 0, z: 0 });
    camera.update();
    const runConfig = {
      warmupFrames: 6,
      sampleFrames: 18,
      gpuSampleInterval: 2,
      gpuCounterSampleInterval: 2,
      readbackRingSlots: 3
    };
    const resolution = renderer.output_resolution;
    const transparent = config.coverage > 0;
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
        internalWidth: resolution.x,
        internalHeight: resolution.y,
        dpr: 1
      },
      run: {
        baselineRole: "engine-generality-c",
        featureSet: transparent
          ? ["hardware-visibility", "packed-instances", "hierarchy-sse-lod",
              "single-material-resolve", "clustered-lighting", "ibl",
              "packed-mboit-transparency"]
          : ["hardware-visibility", "packed-instances", "hierarchy-sse-lod",
              "single-material-resolve", "clustered-lighting", "ibl"],
        ...runConfig
      }
    });
    const controller = new BenchmarkRunController(renderer.profiler, environment, {
      id: caseId(config),
      name: "FX-05 C-transparent bounded MBOIT",
      sceneAssetHashes: [],
      seed: 0x46583035,
      cameraPathHash: `fx05-static-${config.order}-v1`
    });
    const benchmark = await controller.run({
      frame: () => {
        if (!renderer.render(camera, fixture.scene, 1 / 60)) throw new Error("GPU device lost");
      },
      settle: () => renderer.device.queue.onSubmittedWorkDone(),
      gpuWaitTimeoutMs: 20_000
    });
    const hdrNumeric = await captureHdrNumeric(renderer, fixture.scene, camera, config);
    const statistics = { ...summarize(benchmark, renderer, config), hdrNumeric,
      fixtureContract: fixture.contract };
    const issues = validate(benchmark, statistics, config);
    const result = {
      completed: true,
      passed: issues.length === 0,
      issues,
      config,
      build: {
        commit: __BUILD_COMMIT__,
        dirty: __BUILD_DIRTY__,
        dirtyReasons: __BUILD_DIRTY_REASONS__,
        contentHash: __BUILD_CONTENT_HASH__
      },
      statistics,
      result: benchmark
    };
    window.__OENGINE_FX_05_RESULT__ = result;
    status.textContent = result.passed ? "FX-05 production Gate passed" : "FX-05 production Gate failed";
    status.className = result.passed ? "ok" : "error";
    detail.textContent = `coverage=${config.coverage}% layers=${config.layers} materials=${config.materials} work=${statistics.transparentRasterWork}`;
    output.textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    window.__OENGINE_FX_05_RESULT__ = {
      completed: true,
      passed: false,
      issues: [message],
      build: {
        commit: __BUILD_COMMIT__,
        dirty: __BUILD_DIRTY__,
        dirtyReasons: __BUILD_DIRTY_REASONS__,
        contentHash: __BUILD_CONTENT_HASH__
      }
    };
    status.textContent = "FX-05 production Gate failed";
    status.className = "error";
    detail.textContent = message;
    output.textContent = JSON.stringify(window.__OENGINE_FX_05_RESULT__, null, 2);
    console.error(error);
  }
}

async function createFixture(renderer: Renderer, config: CaseConfig) {
  const materialSweep = config.mode === "standard" && config.materials > config.layers;
  const count = config.mode === "order-probe"
    ? 4
    : config.mode === "emissive-probe"
      ? 1
      : config.coverage === 0 ? 1 : materialSweep ? config.materials : config.layers;
  const extent = config.mode === "order-probe"
    ? 2.2
    : config.mode === "emissive-probe"
      ? 1.8
      : config.coverage === 10 ? 1.8 : config.coverage === 50 ? 4.0 : 0.5;
  const grid = materialSweep ? Math.ceil(Math.sqrt(count)) : 1;
  const elementExtent = materialSweep ? extent / grid * 0.88 : extent;
  // The order oracle needs one fragment layer per logical record. A thin box
  // contributes both its front and back faces, producing an ill-conditioned
  // eight-fragment moment set that is not the four-layer contract below.
  const source = config.mode === "order-probe"
    ? buildOrderProbePlaneSourceGeometry(elementExtent)
    : buildBoxSourceGeometry(elementExtent, elementExtent, 0.025);
  const geometry = (await cookGeometryAssetPackage(source, createGeometryCookRecipe())).asset;
  const materials = config.mode === "order-probe"
    ? Array.from({ length: 4 }, (_, index) => orderProbeMaterial(index))
    : config.mode === "emissive-probe"
      ? [emissiveProbeMaterial()]
      : Array.from({ length: config.coverage === 0 ? 1 : config.materials },
          (_, index) => material(index, config.coverage > 0));
  const geometryIndices = new Uint32Array(count);
  const materialIndices = new Uint32Array(count);
  const currentTransforms = new Float32Array(count * 16);
  const boundsSpheres = new Float32Array(count * 4);
  const boundsMin = new Float32Array(count * 3);
  const boundsMax = new Float32Array(count * 3);
  const order = Array.from({ length: count }, (_, index) => index);
  if (config.order === "reverse") order.reverse();
  const records: { record: number; logicalLayer: number; materialIndex: number;
    x: number; y: number; z: number }[] = [];
  for (let outputIndex = 0; outputIndex < count; outputIndex++) {
    const sourceIndex = order[outputIndex]!;
    materialIndices[outputIndex] = sourceIndex % materials.length;
    const gridX = materialSweep ? sourceIndex % grid : 0;
    const gridY = materialSweep ? Math.floor(sourceIndex / grid) : 0;
    const x = config.coverage === 0 ? 100 : materialSweep
      ? (gridX - (grid - 1) * 0.5) * (extent / grid)
      : 0;
    const y = materialSweep
      ? ((grid - 1) * 0.5 - gridY) * (extent / grid)
      : 0;
    const z = materialSweep ? 0 : (sourceIndex - (count - 1) * 0.5) * 0.07;
    records.push({ record: outputIndex, logicalLayer: sourceIndex,
      materialIndex: materialIndices[outputIndex]!, x, y, z });
    setTranslation(currentTransforms, outputIndex * 16, x, y, z);
    boundsSpheres.set(source.bounds.sphere, outputIndex * 4);
    boundsMin.set(source.bounds.box.subarray(0, 3), outputIndex * 3);
    boundsMax.set(source.bounds.box.subarray(3, 6), outputIndex * 3);
  }
  const scene = new Scene();
  scene.lights.environment = config.mode === "emissive-probe" ||
    config.mode === "order-probe"
    ? blackEnvironmentTexture()
    : environmentTexture();
  await renderer.uploadPackedScene(scene, {
    geometries: [geometry],
    materials,
    count,
    geometryIndices,
    materialIndices,
    currentTransforms,
    previousTransforms: currentTransforms.slice(),
    boundsSpheres,
    boundsMin,
    boundsMax,
    flags: new Uint32Array(count),
    debugIds: Uint32Array.from({ length: count }, (_, index) => index + 1)
  });
  return {
    scene,
    contract: {
      mode: config.mode,
      sameXyFootprint: records.every((record) => record.x === 0 && record.y === 0),
      distinctDepthCount: new Set(records.map((record) => record.z)).size,
      records
    }
  };
}

function material(index: number, transparent: boolean): StandardShadeMaterial {
  const palette = [
    [0.95, 0.08, 0.04], [0.04, 0.8, 0.12], [0.04, 0.18, 0.95],
    [0.95, 0.65, 0.04], [0.75, 0.04, 0.9], [0.04, 0.8, 0.85]
  ] as const;
  const value = new StandardShadeMaterial();
  const color = palette[index % palette.length]!;
  value.diffuse_color.set(color[0], color[1], color[2], transparent ? 0.34 + (index % 4) * 0.1 : 1);
  value.emissive_factor.setRGB(color[0] * 0.08, color[1] * 0.08, color[2] * 0.08);
  value.roughness_factor = 0.25 + (index % 5) * 0.14;
  value.metallic_factor = index % 3 === 0 ? 0.75 : 0;
  value.transparency_mode = transparent
    ? ShadeTransparencyMode.Transparent
    : ShadeTransparencyMode.Opaque;
  return value;
}

function orderProbeMaterial(index: number): StandardShadeMaterial {
  const colors = [
    [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0.8, 0]
  ] as const;
  const alphas = [0.25, 0.4, 0.55, 0.7] as const;
  const value = new StandardShadeMaterial();
  const color = colors[index]!;
  value.diffuse_color.set(color[0], color[1], color[2], alphas[index]!);
  value.roughness_factor = 0.5;
  value.metallic_factor = 0;
  value.emissive_factor.setRGB(0, 0, 0);
  value.is_unlit = true;
  value.transparency_mode = ShadeTransparencyMode.Transparent;
  return value;
}

function emissiveProbeMaterial(): StandardShadeMaterial {
  const value = new StandardShadeMaterial();
  value.diffuse_color.set(0, 0, 0, 0.5);
  value.roughness_factor = 0.5;
  value.metallic_factor = 0;
  value.emissive_factor.setRGB(1, 0.25, 0);
  value.transparency_mode = ShadeTransparencyMode.Transparent;
  return value;
}

function buildOrderProbePlaneSourceGeometry(extent: number) {
  const half = extent * 0.5;
  return createSourceGeometry({
    sourceId: `fx05-order-plane:${extent}`,
    indices: [0, 1, 2, 0, 2, 3],
    attributes: [
      {
        semantic: "position",
        componentCount: 3,
        data: new Float32Array([
          -half, -half, 0,
          half, -half, 0,
          half, half, 0,
          -half, half, 0
        ])
      },
      {
        semantic: "normal",
        componentCount: 3,
        data: new Float32Array([
          0, 0, 1,
          0, 0, 1,
          0, 0, 1,
          0, 0, 1
        ])
      },
      {
        semantic: "uv0",
        componentCount: 2,
        data: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0])
      }
    ]
  });
}

function summarize(result: BenchmarkResult, renderer: Renderer, config: CaseConfig) {
  const samples = result.frames.filter((frame) => frame.gpuCounters.sampled && !frame.gpuCounters.dropped);
  const value = (field: GpuCounterFieldName) => median(
    samples.map((frame) => frame.gpuCounters.values[field] ?? 0)
  );
  const pass = renderer.packedTransparencyEvidence();
  return {
    sampledFrames: samples.length,
    transparentRasterWork: value("transparentRasterWork"),
    transparentTriangles: value("transparentTriangles"),
    transparentReactivePixels: value("transparentReactivePixels"),
    transparentMomentFiniteFailures: value("transparentMomentFiniteFailures"),
    transparentQueueOverflowMask: value("transparentQueueOverflowMask"),
    momentGpuP50Ms: findGpu(result, "FX-05 Packed MBOIT moment drawIndirect"),
    forwardGpuP50Ms: findGpu(result, "FX-05 Packed MBOIT forward drawIndirect"),
    compositeGpuP50Ms: findGpu(result, "FX-05 Packed MBOIT composite"),
    transparencyGpuP50Ms: result.summary.gpuPhaseMs.transparency?.p50 ?? null,
    transientBytes: pass === null ? 0 : 960 * 720 * pass.transientBytesPerPixel,
    pass,
    activeMaterialRequest: config.materials
  };
}

function validate(
  result: BenchmarkResult,
  stats: ReturnType<typeof summarize> & {
    hdrNumeric: Awaited<ReturnType<typeof captureHdrNumeric>>;
    fixtureContract: { mode: string; sameXyFootprint: boolean; distinctDepthCount: number };
  },
  config: CaseConfig
): string[] {
  const issues: string[] = [];
  const diagnostics = result.diagnostics;
  if (diagnostics.validationErrorCount || diagnostics.uncapturedErrorCount || diagnostics.deviceLostCount) {
    issues.push("WebGPU diagnostics are non-zero");
  }
  if (diagnostics.failedGpuTimestampBatches || diagnostics.droppedGpuCounterSamples ||
    diagnostics.failedGpuCounterSamples) issues.push("GPU evidence diagnostics are non-zero");
  if (config.coverage === 0) {
    if (stats.pass !== null || stats.transientBytes !== 0) issues.push("coverage=0 retained transparency owner/resources");
    return issues;
  }
  if (stats.sampledFrames < 1) issues.push("no sampled transparency counters");
  if (stats.transparentRasterWork <= 0 || stats.transparentTriangles <= 0) issues.push("transparent work/triangles are empty");
  if (stats.transparentReactivePixels <= 0) issues.push("transparent reactive coverage is empty");
  if (stats.transparentMomentFiniteFailures !== 0) issues.push("power moments contain NaN/Inf");
  if (stats.transparentQueueOverflowMask !== 0) issues.push("TransparentRasterWork overflowed");
  if (stats.pass?.rasterStateBinLimit !== 1 || stats.pass.drawCount !== 3 ||
    stats.pass.momentPasses !== 1 || stats.pass.forwardPasses !== 1 ||
    stats.pass.compositePasses !== 1) issues.push("fixed bin/pass/draw contract changed");
  if (stats.pass?.motionContract !== "reactive-all-velocity-invalid-v1") issues.push("reactive/velocity contract changed");
  if (stats.momentGpuP50Ms === null || stats.forwardGpuP50Ms === null ||
    stats.compositeGpuP50Ms === null) issues.push("per-stage GPU timestamps are missing");
  if (config.mode === "order-probe") {
    if (!stats.fixtureContract.sameXyFootprint || stats.fixtureContract.distinctDepthCount !== 4) {
      issues.push("order probe is not four truly overlapping world-space layers");
    }
    if (stats.hdrNumeric === null || !stats.hdrNumeric.finite) {
      issues.push("order probe Linear HDR ROI is missing or non-finite");
    } else {
      const reference = stats.hdrNumeric.sortedAlphaReference!;
      // Four-moment OIT is approximate. This predeclared quality bound is wide
      // enough for moment reconstruction but rejects missing/wildly wrong layers.
      if (maxRgbError(stats.hdrNumeric.meanRgb, reference) > 0.2) {
        issues.push("MBOIT RGB exceeds the frozen sorted-alpha quality bound 0.2");
      }
      if (Math.abs(stats.hdrNumeric.meanAlpha - (1 - reference[3])) > 0.12) {
        issues.push("MBOIT transmittance exceeds the frozen sorted-alpha bound 0.12");
      }
    }
  }
  if (config.mode === "emissive-probe") {
    if (stats.hdrNumeric === null || !stats.hdrNumeric.finite) {
      issues.push("emissive Linear HDR ROI is missing or non-finite");
    } else {
      const expected = [0.5, 0.125, 0] as const;
      const doubled = [1, 0.25, 0] as const;
      const expectedError = maxRgbError(stats.hdrNumeric.meanRgb, expected);
      const doubledError = maxRgbError(stats.hdrNumeric.meanRgb, doubled);
      if (expectedError > 0.04 || expectedError >= doubledError) {
        issues.push(`transparent emissive is not exactly-once: error=${expectedError}`);
      }
    }
  }
  return issues;
}

function findGpu(result: BenchmarkResult, label: string): number | null {
  const exact = result.summary.gpuMs[label];
  if (exact !== undefined) return exact.p50;
  const entry = Object.entries(result.summary.gpuMs).find(([key]) => key.includes(label));
  return entry?.[1].p50 ?? null;
}

function readConfig(): CaseConfig {
  const params = new URLSearchParams(location.search);
  const coverage = numberChoice(params.get("coverage"), [0, 10, 50] as const, 50);
  const layers = numberChoice(params.get("layers"), [1, 4, 8, 16] as const, 4);
  const materials = numberChoice(params.get("materials"), [1, 8, 64] as const, 1);
  const order = params.get("order") === "reverse" ? "reverse" : "forward";
  const mode = params.get("mode") === "order-probe"
    ? "order-probe"
    : params.get("mode") === "emissive-probe"
      ? "emissive-probe"
      : "standard";
  return { coverage, layers, materials, order, mode };
}

function numberChoice<T extends number>(value: string | null, choices: readonly T[], fallback: T): T {
  const parsed = Number(value);
  return choices.includes(parsed as T) ? parsed as T : fallback;
}

function caseId(config: CaseConfig): string {
  return `FX-05-${config.mode}-c${config.coverage}-l${config.layers}-m${config.materials}-${config.order}`;
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

async function captureHdrNumeric(
  renderer: Renderer,
  scene: Scene,
  camera: PerspectiveCamera,
  config: CaseConfig
) {
  if (config.mode === "standard") return null;
  const region = { x: 472, y: 352, width: 16, height: 16 } as const;
  const pending = renderer.requestLinearHdrCapture(region);
  if (!renderer.render(camera, scene, 1 / 60)) throw new Error("GPU device lost");
  const capture = await pending;
  const rgb = new Array<number>(capture.width * capture.height * 3);
  const sum = [0, 0, 0, 0];
  let finite = true;
  for (let pixel = 0; pixel < capture.width * capture.height; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      const value = capture.rgba[pixel * 4 + channel]!;
      finite &&= Number.isFinite(value);
      rgb[pixel * 3 + channel] = value;
      sum[channel]! += value;
    }
    const alpha = capture.rgba[pixel * 4 + 3]!;
    finite &&= Number.isFinite(alpha);
    sum[3]! += alpha;
  }
  const pixelCount = capture.width * capture.height;
  return {
    source: "production scene-linear rgba16float after transparent composite",
    region,
    finite,
    meanRgb: sum.slice(0, 3).map((value) => value / pixelCount),
    meanAlpha: sum[3]! / pixelCount,
    rgb,
    sortedAlphaReference: config.mode === "order-probe"
      ? sortedAlphaComposite([
          { depth: 0, opacity: 0.25, color: [1, 0, 0] },
          { depth: 1, opacity: 0.4, color: [0, 1, 0] },
          { depth: 2, opacity: 0.55, color: [0, 0, 1] },
          { depth: 3, opacity: 0.7, color: [1, 0.8, 0] }
        ])
      : null
  };
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

function blackEnvironmentTexture(): ShadeTexture {
  const image = ShadeImage.fromArrayBuffer(
    new Uint16Array([0, 0, 0, 0x3c00]).buffer,
    4,
    ShadeDataType.Float16,
    1,
    1,
    1
  );
  image.color_space = 2;
  return ShadeTexture.from(image);
}

function maxRgbError(actual: readonly number[], expected: readonly number[]): number {
  return Math.max(
    Math.abs(actual[0]! - expected[0]!),
    Math.abs(actual[1]! - expected[1]!),
    Math.abs(actual[2]! - expected[2]!)
  );
}

function setTranslation(target: Float32Array, offset: number, x: number, y: number, z: number): void {
  target[offset] = 1;
  target[offset + 5] = 1;
  target[offset + 10] = 1;
  target[offset + 12] = x;
  target[offset + 13] = y;
  target[offset + 14] = z;
  target[offset + 15] = 1;
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

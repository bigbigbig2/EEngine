import type {
  Renderer,
  Scene,
  PerspectiveCamera,
  MultiProductSceneHandles,
} from "../../../OEngine/src/index.ts";
import {
  FrameGraph,
  CompiledFrameGraph,
  FrameGraphBindingLayout,
} from "../../../OEngine/src/framegraph/FrameGraph.ts";
import { ShadeGPUCommandContext } from "../../../OEngine/src/framegraph/ShadeGPUCommandContext.ts";
import { GeometryPageStreamingRuntimeV1 } from "../../../OEngine/src/gpu/GeometryPageStreamingRuntime.ts";
import { GeometryPageSchedulerV1 } from "../../../OEngine/src/gpu/GeometryPageScheduler.ts";
import { VirtualGeometryResidency } from "../../../OEngine/src/gpu/VirtualGeometryResidency.ts";
import { GeometryProductMultiRuntimeV1 } from "../../../OEngine/src/gpu/GeometryProductMultiRuntime.ts";
import { GpuNativeMaterialScene } from "../../../OEngine/src/gpu/GpuNativeMaterialScene.ts";
import { PackedVisibilityPass } from "../../../OEngine/src/render/passes/PackedVisibilityPass.ts";
import { HierarchicalWorkGenerator } from "../../../OEngine/src/render/HierarchicalWorkGenerator.ts";
import { ShadowGeometryWork } from "../../../OEngine/src/render/ShadowGeometryWork.ts";
import { FrameGeometryArena } from "../../../OEngine/src/render/FrameGeometryArena.ts";
import { GPUViewContext } from "../../../OEngine/src/render/ViewContext.ts";
import { NativeExecutionBins } from "../../../OEngine/src/render/surface/NativeExecutionBins.ts";
import type { SurfaceV4, NativeSurfaceFrame } from "../../../OEngine/src/render/surface/SurfaceV4.ts";
import { decodeFloat16 } from "../../../OEngine/src/core/Float16.ts";
import { createCpuAttribution } from "./cpu-attribution.ts";
import type { createValidationController } from "../../harness/browser.ts";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function distribution(values: number[]) {
  check(values.length > 0 && values.every(Number.isFinite), "Missing finite CPU samples");
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1]!,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    max: sorted.at(-1)!,
  };
}
type Sample = { frame: number; ms: number; inclusive: number[]; exclusive: number[]; calls: number[] };

/** One case-local experiment, using the authored production Renderer unchanged. */
export async function runCpuHostMeasurement(
  renderer: Renderer,
  camera: PerspectiveCamera,
  scene: Scene,
  handles: MultiProductSceneHandles,
  controller: ReturnType<typeof createValidationController>,
) {
  const timing = createCpuAttribution();
  const calibration = timing.calibration();
  const hooks: string[] = [];
  function wrap(target: object, prefix: string, methods: string[]) {
    for (const method of methods) {
      check(typeof Reflect.get(target, method) === "function", `Missing CPU owner ${prefix}/${method}`);
      timing.wrap(target, method, `${prefix}/${method}`);
      hooks.push(`${prefix}/${method}`);
    }
  }
  const privateOwner = (key: string): object => {
    const owner: unknown = Reflect.get(renderer, key);
    check(typeof owner === "object" && owner !== null, `Missing Renderer owner ${key}`);
    return owner;
  };
  function install() {
    timing.cache(privateOwner("_programCache"), "frameprogram");
    timing.cache(privateOwner("_graphCache"), "graph-cache");
    timing.resolvers(FrameGraphBindingLayout.prototype);
    wrap(FrameGraph.prototype, "framegraph", ["compile", "executeCompiled"]);
    wrap(CompiledFrameGraph.prototype, "framegraph", ["execute", "dump"]);
    wrap(ShadeGPUCommandContext, "command", ["create"]);
    wrap(ShadeGPUCommandContext.prototype, "command", [
      "createFrameGraphContext",
      "encodeCompiledGraph",
      "finish",
      "writeBuffer",
    ]);
    wrap(privateOwner("_frameCoordinator"), "submission", ["beginFrame", "submitFrame"]);
    wrap(renderer.profiler, "profiler", [
      "beginFrame",
      "endFrame",
      "encodeGpuCounterClear",
      "encodeGpuCounterReadback",
      "attachGpuTimingContext",
      "recordGpuTimings",
      "recordGpuCounters",
    ]);
    if (renderer.profiler.historyStore)
      wrap(renderer.profiler.historyStore, "profiler-history", ["add", "patch"]);
    wrap(renderer.graphics.resource_accounting, "resource-accounting", ["snapshot"]);
    wrap(renderer.graphics, "graphics", [
      "encodeFrameMaintenance",
      "memoryEvidence",
      "profilingResourceSnapshot",
    ]);
    wrap(renderer.graphics.render_world, "scene-publication", [
      "encodePendingPatch",
      "prepareNativeMaterials",
    ]);
    wrap(GpuNativeMaterialScene.prototype, "material-publication", [
      "canPrepareFrame",
      "snapshot",
      "obtainMaterialBindings",
      "prepareFrame",
      "prepareRasterPrograms",
    ]);
    wrap(GeometryPageStreamingRuntimeV1.prototype, "streaming", [
      "evidence",
      "updatePressure",
      "consumeAfterCompletion",
      "consumeCompleted",
      "recordResidencyFeedback",
    ]);
    wrap(GeometryPageSchedulerV1.prototype, "streaming-scheduler", [
      "setPressure",
      "tick",
      "pump",
      "ingestDemandReadback",
      "ingestDemands",
      "drainUploadBudget",
      "evidence",
    ]);
    wrap(VirtualGeometryResidency.prototype, "residency", [
      "evidence",
      "uploadCost",
      "tryUploadPage",
      "selectEvictionCandidates",
    ]);
    wrap(GeometryProductMultiRuntimeV1.prototype, "multi-product", [
      "evidence",
      "bindings",
      "acceptDemand",
      "publishPageLocation",
    ]);
    wrap(privateOwner("_visibilityFeature"), "geometry", ["prepare"]);
    wrap(PackedVisibilityPass.prototype, "visibility", ["prepareHierarchy", "encodeHierarchy"]);
    wrap(HierarchicalWorkGenerator.prototype, "hierarchy", ["prepare", "rebind", "encode"]);
    wrap(ShadowGeometryWork.prototype, "shadow-geometry", ["prepare", "encode"]);
    wrap(FrameGeometryArena.prototype, "frame-geometry", ["prepare", "encodeMetadataPublication"]);
    wrap(GPUViewContext.prototype, "view", ["update", "update_uniforms", "finish_frame"]);
    wrap(privateOwner("_views"), "view", ["obtain"]);
    wrap(privateOwner("_environments"), "scene-environment", ["obtain"]);
    const physical = Reflect.get(renderer, "_environmentRuntime");
    if (physical) wrap(physical, "physical-environment", ["record", "writeParameters", "commit"]);
    wrap(privateOwner("_surface"), "surface", [
      "prepareFrameNow",
      "validate",
      "validateProfiles",
      "encode",
      "createState",
      "commit",
    ]);
    wrap(NativeExecutionBins.prototype, "execution-bins", ["createBindings", "updateGeneration", "encode"]);
    wrap(privateOwner("_temporal"), "temporal", ["begin", "commit"]);
    wrap(privateOwner("_temporalFacts"), "temporal-facts", ["prepareFrame", "commit"]);
    wrap(privateOwner("_fsr3"), "fsr", ["prepareFrame", "commit"]);
    wrap(privateOwner("_radiometry"), "radiometry", ["beginFrame"]);
    wrap(privateOwner("_gpuRadiometry"), "radiometry", ["prepareFrame", "commit"]);
    // These pass owners are wrapped at their real encode entry, not shader time.
    for (const key of [
      "_lightCluster",
      "_vsmReceiverDemand",
      "_vsmAllocatePages",
      "_vsmCasterRecords",
      "_vsmAtlasRaster",
      "_vsmInvalidation",
      "_physicalSky",
      "_aerialPerspective",
      "_bloom",
      "_present",
    ]) {
      const owner = Reflect.get(renderer, key);
      if (!owner) continue;
      const methods = ["encode", "prepareFrame", "prepare", "execute"].filter(
        (method) => typeof Reflect.get(owner, method) === "function",
      );
      wrap(owner, `pass${key}`, methods);
    }
    wrap(privateOwner("_vsmGeneration"), "vsm", ["begin"]);
    wrap(GPUDevice.prototype, "webgpu", [
      "createCommandEncoder",
      "createBindGroup",
      "createComputePipeline",
      "createRenderPipeline",
      "createComputePipelineAsync",
      "createRenderPipelineAsync",
      "createBuffer",
      "createTexture",
    ]);
    wrap(GPUTexture.prototype, "webgpu", ["createView"]);
    wrap(GPUCommandEncoder.prototype, "webgpu", ["finish", "beginComputePass", "beginRenderPass"]);
    wrap(GPUQueue.prototype, "webgpu", ["submit", "onSubmittedWorkDone", "writeBuffer"]);
  }
  function configure(full: boolean) {
    renderer.profiler.setMode("record");
    renderer.profiler.configure({
      enabled: full,
      warmupFrames: 0,
      gpuSampleInterval: 1,
      gpuCounterSampleInterval: 1,
      gpuTimingMode: full ? "full" : "production",
      historyCapacity: 512,
      cpuPassTimings: full,
    });
    renderer.perf_gpu_counters_enabled = full;
  }
  const raf = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  let deferred = 0;
  async function tick(attributed: boolean): Promise<Sample> {
    for (let attempt = 0; attempt < 600; ++attempt) {
      await raf();
      const frame = renderer.frame_count;
      timing.startFrame(attributed);
      const started = performance.now();
      const healthy = renderer.render(camera, scene, 1 / 60);
      const ms = performance.now() - started;
      const values = timing.endFrame();
      check(healthy, "Renderer device unavailable");
      if (renderer.frame_count !== frame) return { frame, ms, ...values };
      ++deferred;
    }
    throw new Error("Authored production Renderer never advanced");
  }
  const records: unknown[] = [];
  async function inspect() {
    const surface = Reflect.get(renderer, "_surface") as SurfaceV4;
    const prepare = surface.prepareFrameNow;
    const encode = surface.encode;
    let frame: NativeSurfaceFrame | undefined;
    let hdr: GPUBuffer | undefined;
    let winner: GPUBuffer | undefined;
    surface.prepareFrameNow = function (value, bins) {
      frame = value;
      prepare.call(this, value, bins);
    };
    surface.encode = function (encoder) {
      encode.call(this, encoder);
      check(frame?.output, "Missing authored HDR");
      const row = Math.ceil((frame.width * 8) / 256) * 256;
      const winnerRow = Math.ceil((frame.width * 4) / 256) * 256;
      hdr = renderer.device.createBuffer({
        size: row * frame.height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      winner = renderer.device.createBuffer({
        size: winnerRow * frame.height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      encoder.copyTextureToBuffer({ texture: frame.output }, { buffer: hdr, bytesPerRow: row }, [
        frame.width,
        frame.height,
      ]);
      encoder.copyTextureToBuffer({ texture: frame.visibility }, { buffer: winner, bytesPerRow: winnerRow }, [
        frame.width,
        frame.height,
      ]);
    };
    try {
      await tick(false);
      check(hdr && winner && frame, "Inspection did not encode");
      await Promise.all([hdr.mapAsync(GPUMapMode.READ), winner.mapAsync(GPUMapMode.READ)]);
      const pixels = new Uint16Array(hdr.getMappedRange());
      const keys = new Uint32Array(winner.getMappedRange());
      let nonzero = 0;
      let visible = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const r = decodeFloat16(pixels[i]!);
        const g = decodeFloat16(pixels[i + 1]!);
        const b = decodeFloat16(pixels[i + 2]!);
        check(Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b), "Nonfinite authored HDR");
        if (r > 0 || g > 0 || b > 0) ++nonzero;
      }
      for (const key of keys) if (key !== 0xffffffff) ++visible;
      check(visible > 0 && nonzero > 0, "Empty authored production output");
      return { visible, nonzero, width: frame.width, height: frame.height };
    } finally {
      surface.prepareFrameNow = prepare;
      surface.encode = encode;
      hdr?.destroy();
      winner?.destroy();
    }
  }
  // A single unwrapped control precedes instrumentation. All later baseline
  // wrappers merely forward; paired controls expose timer perturbation.
  camera.transform.position.set(0, 5, 10);
  camera.transform.lookAt({ x: 0, y: 5, z: 0 });
  camera.update();
  configure(false);
  for (let i = 0; i < 30; ++i) await tick(false);
  const unwrapped: number[] = [];
  for (let i = 0; i < 48; ++i) unwrapped.push((await tick(false)).ms);
  await renderer.device.queue.onSubmittedWorkDone();
  install();
  // Resolve closures are captured when lowering; rebuild once outside samples
  // after installing the observer, then warm every block before measurement.
  Reflect.get(renderer, "_graphCache").destroy();
  controller.transition("sampling");
  try {
    for (const [cameraName, distance] of [
      ["near", 10],
      ["far", 35],
    ] as const) {
      camera.transform.position.set(0, 5, distance);
      camera.transform.lookAt({ x: 0, y: 5, z: 0 });
      camera.update();
      // Reverse A/B order for far to expose warmed resource/thermal drift.
      const order = cameraName === "near" ? [false, true] : [true, false];
      for (const full of order) {
        for (const attributed of [false, true]) {
          configure(full);
          for (let i = 0; i < 30; ++i) await tick(attributed);
          timing.resetBackground();
          const beforeDeferred = deferred;
          const samples: Sample[] = [];
          const observation: number[] = [];
          const serialization: number[] = [];
          const validationElapsed: number[] = [];
          const blockStarted = performance.now();
          for (let i = 0; i < 48; ++i) {
            const sample = await tick(attributed);
            samples.push(sample);
            if (full) {
              // Explicit validation observations are outside synchronous render.
              // No publication, resources or GPU shading settings are changed.
              const start = performance.now();
              const snapshot = {
                memory: renderer.memoryEvidence(),
                ledger: renderer.graphics.resource_accounting.snapshot(),
                products: handles.runtime.evidence(),
                streaming: handles.streaming?.evidence() ?? null,
              };
              const observeMs = performance.now() - start;
              const jsonStart = performance.now();
              const bytes = JSON.stringify(snapshot).length;
              const jsonMs = performance.now() - jsonStart;
              check(bytes > 0, "Missing full-validation snapshot");
              observation.push(observeMs);
              serialization.push(jsonMs);
              validationElapsed.push(sample.ms + observeMs + jsonMs);
            }
          }
          const blockElapsedMs = performance.now() - blockStarted;
          await renderer.device.queue.onSubmittedWorkDone();
          const background = timing.backgroundSnapshot();
          timing.setEnabled(false);
          const profiles = renderer.profiler.history.filter((p) =>
            samples.some((s) => s.frame === p.frameIndex),
          );
          if (full) {
            for (let attempt = 0; attempt < 200; ++attempt) {
              if (samples.every((s) => renderer.profiler.getFrame(s.frame)?.gpu.pending === false)) break;
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
            check(
              samples.every((s) => {
                const p = renderer.profiler.getFrame(s.frame);
                return (
                  p?.gpu.sampled &&
                  !p.gpu.pending &&
                  p.gpu.mode === "full" &&
                  p.submits.count === 1 &&
                  !p.counters["gpu.timing.truncated"]
                );
              }),
              "Incomplete full-profile capture / extra submit",
            );
          }
          const breakdown = attributed
            ? timing.names.map((name, id) => ({
                name,
                inclusiveMs: distribution(samples.map((s) => s.inclusive[id] ?? 0)),
                exclusiveMs: distribution(samples.map((s) => s.exclusive[id] ?? 0)),
                calls: distribution(samples.map((s) => s.calls[id] ?? 0)),
                backgroundExclusiveMs: background.exclusive[id] ?? 0,
                backgroundCalls: background.calls[id] ?? 0,
              }))
            : [];
          const unknown = attributed
            ? distribution(samples.map((s) => Math.max(0, s.ms - s.exclusive.reduce((a, b) => a + b, 0))))
            : null;
          const output = await inspect();
          records.push({
            camera: cameraName,
            distance,
            mode: full ? "full-validation" : "normal-production",
            attributed,
            output,
            renderMs: distribution(samples.map((s) => s.ms)),
            unknownMs: unknown,
            breakdown,
            observationMs: full ? distribution(observation) : null,
            serializationMs: full ? distribution(serialization) : null,
            validationSynchronousTotalMs: full ? distribution(validationElapsed) : null,
            internalProfilerFrameMs: full ? distribution(profiles.map((p) => p.cpuMs.frame!)) : null,
            deferredTicks: deferred - beforeDeferred,
            blockElapsedMs,
            samples,
            profiles: full ? profiles : [],
          });
          controller.addEvidence("cpuHostProgress", { records });
        }
      }
    }
  } finally {
    timing.restore();
  }
  return {
    calibration,
    hooks,
    unwrappedNearNormalMs: distribution(unwrapped),
    unwrapped,
    records,
    policy:
      "RAF; actual submitted frames only; no GPU wait inside render stopwatch; async timers measure synchronous prefix only; nested exclusive times avoid double counting",
    backgroundLimit:
      "Captured method CPU excludes await durations; unwrapped async continuation glue is UNKNOWN, not synchronous render CPU",
  };
}

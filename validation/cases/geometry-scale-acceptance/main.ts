import {
  Renderer,
  Scene,
  PerspectiveCamera,
  createDefaultWebCookWorker,
  load_gltf,
  type WebCookRuntimeAsset,
  type MultiProductSceneHandles
} from "../../../OEngine/src/index.ts";
import { decodeFloat16 } from "../../../OEngine/src/core/Float16.ts";
import { summarizeGpuTimingCost } from "../../../OEngine/src/debug/GpuTimingCost.ts";
import { geometryProductGpuBudgetEvidence } from "../../../OEngine/src/gpu/GeometryProductGpuBudget.ts";
import type { SurfaceV4, NativeSurfaceFrame } from "../../../OEngine/src/render/surface/SurfaceV4.ts";
import { createValidationController, attachGpuErrorCollection } from "../../harness/browser.ts";

const MiB = 1024 * 1024;
const frozen = {
  url: "/assets/web-authored-large/large.glb",
  bytes: 477591060,
  triangles: 4871612,
  primitives: 1920,
  sha256: "54b608872aec11ce07b26fad6c0ad14a662314e6480bf8d833e5088b59c9851f"
};
const canvas = document.querySelector<HTMLCanvasElement>("#output")!;
const status = document.querySelector<HTMLPreElement>("#status")!;
let renderer: Renderer | undefined;
let asset: WebCookRuntimeAsset | undefined;
let handles: MultiProductSceneHandles | undefined;
let errors: ReturnType<typeof attachGpuErrorCollection> | undefined;
let disposed = false;
let intentionalLoss = false;
let recovered = false;
let releaseRecoveredScene: (() => Promise<void>) | undefined;
const controller = createValidationController(
  { caseId: "geometry-scale-acceptance", workloadId: "geometry-scale-acceptance-v1" },
  dispose
);
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function distribution(values: readonly number[]) {
  check(values.length > 0 && values.every(Number.isFinite), "Missing finite cost measurements");
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1)
  };
}
async function dispose() {
  if (!disposed) {
    if (recovered) {
      await releaseRecoveredScene?.();
      const released = geometryProductGpuBudgetEvidence(renderer!.device);
      check(
        released.totalBytes === 0 && released.allocations === 0 && released.metadataAllocations === 0,
        "Recovered Scene unload retained Product GPU ownership before Renderer destruction"
      );
      controller.addEvidence("releasedSceneProductCapacity", released);
      await releaseRecoveredScene?.(); // Repeat unload must be safe.
    }
    else await handles?.release();
    errors?.remove();
    intentionalLoss = true;
    renderer?.destroy();
    await asset?.disposeAsync();
    disposed = true;
  }
  return { disposed, producer: asset?.evidence() ?? null };
}
void run();
async function run() {
  try {
    controller.transition("negotiating");
    const mounted = await fetch(frozen.url, { headers: { Range: "bytes=0-11" }, cache: "no-store" });
    check(
      mounted.status === 206 &&
        mounted.headers.get("x-source-sha256") === frozen.sha256 &&
        mounted.headers.get("content-range") === `bytes 0-11/${frozen.bytes}`,
      "Frozen source unavailable"
    );
    controller.addEvidence("source", frozen);
    // Frozen catalog image headers and the mapper's image/sampler/usage keys:
    // 4 <=256px routes, 514 >256px routes. Four compatible 512px physical
    // banks provide 516 usable layers; quality and the existing 2GiB cap stay.
    const textureBankMaxCapacities = [64, 130, 130, 130, 130] as const;
    // Complete K0 packing measured 1,332 pinned slots (333MiB). The default
    // 128MiB is a valid negative admission case, not a complete-scene budget.
    // Four 96MiB banks leave 204 slots (51MiB) for demand-driven refinement.
    const geometryCapacityBytes = 384 * MiB;
    controller.addEvidence("geometryCapacityPlan", {
      activationPages: 655,
      activationSlots: 1332,
      activationPhysicalBytes: 349175808,
      activationUploadBytes: 194076588,
      configuredCapacityBytes: geometryCapacityBytes,
      refinementHeadroomBytes: 51 * MiB,
      metadataBytes: 64 * MiB,
      policy: "Measured complete activation footprint; existing application configuration, unchanged 512MiB bank ceiling"
    });
    controller.addEvidence("textureCapacityPlan", {
      uniqueTextureRoutes: 518,
      smallRoutes: 4,
      largeRoutes: 514,
      textureBankMaxCapacities,
      maximumRgbaBankBytes: 749381536,
      policy: "Existing application capacity configuration; no TextureResidency owner change"
    });
    const started = performance.now();
    renderer = new Renderer({
      autoExposure: false,
      fixedExposure: 1,
      textureMaxResolution: 512,
      textureBankMaxCapacities,
      requiredFeatures: ["timestamp-query"]
    });
    const context = canvas.getContext("webgpu");
    check(context, "WebGPU canvas unavailable");
    await renderer.initialize({ context });
    renderer.resize(1920, 1080);
    errors = attachGpuErrorCollection(renderer.device, controller, () => intentionalLoss);
    controller.addEvidence("capability", renderer.capabilities);
    const scene = new Scene();
    releaseRecoveredScene = () => renderer!.releaseScene(scene);
    const camera = new PerspectiveCamera();
    camera.aspect = 1920 / 1080;
    camera.fov_degrees = 60;
    const publications: unknown[] = [];
    asset = load_gltf(frozen.url, {
      worker: createDefaultWebCookWorker({
        runtimeProfile: "portable-single",
        maxSourceWindowBytes: 64 * MiB,
        maxCanonicalInputBytes: 32 * MiB,
        maxDecodedProductBytes: 128 * MiB,
        maxSessionSpillBytes: 1024 * MiB,
        maxTrianglesPerProduct: 131072,
        maxVerticesPerProduct: 524288,
        maxDomainsPerProduct: 64
      }),
      runtimeProfile: "portable-single",
      sessionId: `geometry-scale-${crypto.randomUUID()}`,
      sessionGeneration: 1,
      budgets: {
        maxConcurrentWorkers: 1,
        maxSourceBytes: 128 * MiB,
        maxWasmBytes: 512 * MiB,
        maxOutputBytes: 128 * MiB,
        maxQueuedEvents: 2048
      },
      initialOutputPageCredits: 128,
      maxBufferedPages: 128,
      maxBufferedBytes: 32 * MiB,
      onProductTaskTrace: (trace) => controller.addEvidence("currentTask", trace)
    });
    handles = await renderer.uploadWebCookedMultiProductScene(scene, asset, {
      fitHeight: 10,
      fitBase: [0, 0, 0],
      stream: true,
      residency: { configuredCapacityBytes: geometryCapacityBytes },
      onProductPublicationTiming: (timing) => {
        publications.push(timing);
        status.textContent = `Published ${timing.shardIndex} Products (not yet settled)`;
      }
    });
    await handles.settled();
    const catalog = asset.catalog;
    check(catalog && catalog.primitiveCount === frozen.primitives, "Incomplete authored catalog");
    const traces = asset.evidence().productTaskTrace;
    const completed = traces.filter((event) => event.kind === "completed");
    const covered = new Map<number, number>();
    const shards = new Map<number, Set<number>>();
    for (const { task } of completed) {
      if (task.spatial) {
        check(
          task.sceneAssetIndices.length === 1 && task.shardOrdinal !== undefined && task.shardCount,
          "Missing spatial task identity"
        );
        const index = task.sceneAssetIndices[0]!;
        const set = shards.get(index) ?? new Set<number>();
        check(!set.has(task.shardOrdinal), "Duplicate authored spatial shard");
        set.add(task.shardOrdinal);
        shards.set(index, set);
        covered.set(index, (covered.get(index) ?? 0) + task.triangles);
      } else {
        let triangles = 0;
        for (const index of task.sceneAssetIndices) {
          check(!covered.has(index) && catalog.primitives[index], "Duplicate ordinary primitive");
          const count = catalog.primitives[index]!.triangleCount;
          covered.set(index, count);
          triangles += count;
        }
        check(triangles === task.triangles, "Ordinary triangle count differs from source");
      }
    }
    for (const { task } of completed.filter((event) => event.task.spatial)) {
      check(shards.get(task.sceneAssetIndices[0]!)?.size === task.shardCount, "Missing planned shard");
    }
    check(
      covered.size === frozen.primitives &&
        [...covered.values()].reduce((a, b) => a + b, 0) === frozen.triangles &&
        catalog.primitives.every((p) => covered.get(p.catalogIndex) === p.triangleCount),
      "Authored source triangle union incomplete"
    );
    check(
      handles.current().shardCount === completed.length &&
        handles.runtime.evidence().active === completed.length,
      "Not every cooked Product is active"
    );
    controller.addEvidence("publication", {
      settledMs: performance.now() - started,
      products: completed.length,
      coveredPrimitives: covered.size,
      triangles: frozen.triangles,
      instanceCount: handles.current().source.count,
      timings: publications,
      runtime: handles.runtime.evidence(),
      producer: asset.evidence()
    });
    controller.transition("ready");
    controller.transition("warming");
    let gpu = renderer.device;
    const tick = async () => {
      const first = renderer!.frame_count;
      for (let retry = 0; retry < 300; ++retry) {
        const before = performance.now();
        renderer!.render(camera, scene, 1 / 60);
        const ms = performance.now() - before;
        await gpu.queue.onSubmittedWorkDone();
        if (renderer!.frame_count !== first) return ms;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Complete authored publication never became renderable");
    };
    // Observe the actual producer without replacing any shader/product or
    // consumer. Readback copies only run in separate untimed inspection frames.
    let prepared: NativeSurfaceFrame | undefined;
    let capture: GPUBuffer | undefined;
    let winnerCapture: GPUBuffer | undefined;
    let inspectNext = false;
    const instrumentSurface = () => {
      const surface = Reflect.get(renderer!, "_surface") as SurfaceV4;
      const prepare = surface.prepareFrameNow.bind(surface);
      surface.prepareFrameNow = (frame, bins) => {
        prepared = frame;
        prepare(frame, bins);
      };
      const encode = surface.encode.bind(surface);
      surface.encode = (encoder) => {
        encode(encoder);
        if (!inspectNext) return;
        check(prepared?.output, "Missing actual production HDR");
        const row = Math.ceil((prepared.width * 8) / 256) * 256;
        capture = gpu.createBuffer({
          size: row * prepared.height,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });
        encoder.copyTextureToBuffer({ texture: prepared.output }, { buffer: capture, bytesPerRow: row }, [
          prepared.width,
          prepared.height
        ]);
        const winnerRow = Math.ceil((prepared.width * 4) / 256) * 256;
        winnerCapture = gpu.createBuffer({
          size: winnerRow * prepared.height,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });
        encoder.copyTextureToBuffer(
          { texture: prepared.visibility },
          { buffer: winnerCapture, bytesPerRow: winnerRow },
          [prepared.width, prepared.height]
        );
      };
    };
    instrumentSurface();
    const inspect = async () => {
      inspectNext = true;
      await tick();
      inspectNext = false;
      check(capture && winnerCapture && prepared, "Production HDR/winner capture not encoded");
      await Promise.all([capture.mapAsync(GPUMapMode.READ), winnerCapture.mapAsync(GPUMapMode.READ)]);
      const values = new Uint16Array(capture.getMappedRange());
      const keys = new Uint32Array(winnerCapture.getMappedRange());
      let visible = 0;
      const winnerStride = Math.ceil((prepared.width * 4) / 256) * 64;
      for (let y = 0; y < prepared.height; ++y)
        for (let x = 0; x < prepared.width; ++x) {
          if (keys[y * winnerStride + x] !== 0xffffffff) ++visible;
        }
      let nonzero = 0;
      for (let pixel = 0; pixel < values.length; pixel += 4) {
        const color = [0, 1, 2].map((c) => decodeFloat16(values[pixel + c]!));
        check(color.every(Number.isFinite), "Nonfinite HDR in complete authored scene");
        if (color.some((c) => c > 0)) ++nonzero;
      }
      capture.unmap();
      capture.destroy();
      capture = undefined;
      winnerCapture.unmap();
      winnerCapture.destroy();
      winnerCapture = undefined;
      check(nonzero > 0 && visible > 0, "Authored scene produced empty HDR/Geometry winners");
      return { nonzero, visible, width: prepared.width, height: prepared.height };
    };
    renderer.profiler.setMode("record");
    renderer.profiler.configure({
      enabled: true,
      warmupFrames: 0,
      gpuSampleInterval: 1,
      gpuCounterSampleInterval: 1,
      gpuTimingMode: "full",
      historyCapacity: 512
    });
    renderer.perf_gpu_counters_enabled = true;
    const records = [];
    controller.transition("sampling");
    for (const [name, distance] of [
      ["near", 10],
      ["far", 35]
    ] as const) {
      camera.transform.position.set(0, 5, distance);
      camera.transform.lookAt({ x: 0, y: 5, z: 0 });
      camera.update();
      for (let frame = 0; frame < 30; ++frame) await tick();
      const first = renderer.frame_count;
      const cpu = [];
      for (let frame = 0; frame < 48; ++frame) cpu.push(await tick());
      for (let attempt = 0; attempt < 100; ++attempt) {
        const count = renderer.profiler.history.filter(
          (p) => p.frameIndex >= first && p.frameIndex < first + 48 && p.gpu.sampled && !p.gpu.pending
        ).length;
        if (count === 48) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const profiles = renderer.profiler.history.filter(
        (p) => p.frameIndex >= first && p.frameIndex < first + 48
      );
      check(
        profiles.length === 48 &&
          profiles.every(
            (p) =>
              p.gpu.sampled && !p.gpu.pending && !p.counters["gpu.timing.truncated"] && p.submits.count === 1
          ),
        "Incomplete production timing or extra submit"
      );
      const costs = profiles.map((p) => summarizeGpuTimingCost(p.gpu.segments));
      records.push({
        name,
        cpuEncodeMs: distribution(cpu),
        gpuFrameMs: distribution(
          costs.map((c) => {
            check(c.commandSpanMs !== null, "No frame span");
            return c.commandSpanMs;
          })
        ),
        profiles,
        output: await inspect(),
        memory: renderer.memoryEvidence(),
        productCapacity: geometryProductGpuBudgetEvidence(gpu),
        resourceLedger: renderer.graphics.resource_accounting.snapshot(),
        runtime: handles.runtime.evidence(),
        streaming: handles.streaming?.evidence() ?? null
      });
      controller.addEvidence("scale", records);
    }
    // Fast motion/cut and extent changes use the same complete publication.
    for (let frame = 0; frame < 20; ++frame) {
      camera.transform.position.set(Math.sin(frame * 0.3) * 8, 5, 12);
      camera.transform.lookAt({ x: 0, y: 5, z: 0 });
      camera.update();
      await tick();
    }
    canvas.width = 1280;
    canvas.height = 720;
    renderer.resize(1280, 720);
    await inspect();
    canvas.width = 1920;
    canvas.height = 1080;
    renderer.resize(1920, 1080);
    await inspect();
    controller.addEvidence("finalMemory", renderer.memoryEvidence());
    controller.addEvidence("finalProductCapacity", geometryProductGpuBudgetEvidence(gpu));
    check(renderer.geometryStreamingError() === null, "Authored streaming failed");
    const beforeRecovery = renderer.geometryStreamingEvidence(scene);
    check(beforeRecovery?.products.length === completed.length, "Incomplete pre-loss Product registration");
    await gpu.queue.onSubmittedWorkDone();
    intentionalLoss = true;
    gpu.destroy();
    await errors.lost;
    errors.remove();
    renderer = await renderer.recoverAfterDeviceLoss();
    recovered = true;
    gpu = renderer.device;
    intentionalLoss = false;
    errors = attachGpuErrorCollection(gpu, controller, () => intentionalLoss);
    instrumentSurface();
    for (let frame = 0; frame < 8; ++frame) await tick();
    const afterRecovery = renderer.geometryStreamingEvidence(scene);
    check(
      Reflect.get(renderer, "deviceEpoch") === 2 && afterRecovery?.products.length === completed.length,
      "Device recovery did not replay every authored Product"
    );
    check(
      new Set(afterRecovery.products.map((p) => p.productGeneration)).size === completed.length,
      "Recovered Product identities alias generations"
    );
    check(renderer.geometryStreamingError() === null, "Recovered source replay/streaming failed");
    controller.addEvidence("recovery", {
      before: beforeRecovery,
      after: afterRecovery,
      output: await inspect(),
      memory: renderer.memoryEvidence(),
      productCapacity: geometryProductGpuBudgetEvidence(gpu),
      limitation: "Controlled device destruction; not a driver fault"
    });
    controller.transition("draining");
    await gpu.queue.onSubmittedWorkDone();
    controller.addEvidence("cleanup", await dispose());
    const released = geometryProductGpuBudgetEvidence(gpu);
    check(
      released.totalBytes === 0 && released.allocations === 0 && released.metadataAllocations === 0,
      "Authored Product GPU ownership retained after teardown"
    );
    controller.addEvidence("releasedProductCapacity", released);
    controller.pass();
    status.textContent = "Complete authored Geometry runtime acceptance passed";
  } catch (error) {
    controller.addEvidence("failureOwners", {
      runtime: handles?.runtime.evidence() ?? null,
      producer: asset?.evidence() ?? null,
      memory: renderer?.memoryEvidence() ?? null,
      textures: renderer?.graphics.texture_residency_if_created?.evidence() ?? null,
      productCapacity: renderer ? geometryProductGpuBudgetEvidence(renderer.device) : null
    });
    controller.fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
}

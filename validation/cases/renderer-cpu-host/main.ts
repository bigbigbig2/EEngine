import {
  Renderer,
  Scene,
  PerspectiveCamera,
  createDefaultWebCookWorker,
  load_gltf,
  type WebCookRuntimeAsset,
  type MultiProductSceneHandles,
} from "../../../OEngine/src/index.ts";
import { runCpuHostMeasurement } from "./measure.ts";
import { geometryProductGpuBudgetEvidence } from "../../../OEngine/src/gpu/GeometryProductGpuBudget.ts";
import { createValidationController, attachGpuErrorCollection } from "../../harness/browser.ts";

const MiB = 1024 * 1024;
const frozen = {
  url: "/assets/web-authored-large/large.glb",
  bytes: 477591060,
  triangles: 4871612,
  primitives: 1920,
  sha256: "54b608872aec11ce07b26fad6c0ad14a662314e6480bf8d833e5088b59c9851f",
};
const canvas = document.querySelector<HTMLCanvasElement>("#output")!;
const status = document.querySelector<HTMLPreElement>("#status")!;
let renderer: Renderer | undefined;
let asset: WebCookRuntimeAsset | undefined;
let handles: MultiProductSceneHandles | undefined;
let errors: ReturnType<typeof attachGpuErrorCollection> | undefined;
let disposed = false;
let intentionalLoss = false;
const controller = createValidationController(
  { caseId: "renderer-cpu-host", workloadId: "renderer-cpu-host-v1" },
  dispose,
);
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function dispose() {
  if (!disposed) {
    await handles?.release();
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
      "Frozen source unavailable",
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
      policy:
        "Measured complete activation footprint; existing application configuration, unchanged 512MiB bank ceiling",
    });
    controller.addEvidence("textureCapacityPlan", {
      uniqueTextureRoutes: 518,
      smallRoutes: 4,
      largeRoutes: 514,
      textureBankMaxCapacities,
      maximumRgbaBankBytes: 749381536,
      policy: "Existing application capacity configuration; no TextureResidency owner change",
    });
    const started = performance.now();
    renderer = new Renderer({
      autoExposure: false,
      fixedExposure: 1,
      textureMaxResolution: 512,
      textureBankMaxCapacities,
      requiredFeatures: ["timestamp-query"],
    });
    const context = canvas.getContext("webgpu");
    check(context, "WebGPU canvas unavailable");
    await renderer.initialize({ context });
    renderer.resize(1920, 1080);
    errors = attachGpuErrorCollection(renderer.device, controller, () => intentionalLoss);
    controller.addEvidence("capability", renderer.capabilities);
    const scene = new Scene();
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
        maxDomainsPerProduct: 64,
      }),
      runtimeProfile: "portable-single",
      sessionId: `renderer-cpu-host-${crypto.randomUUID()}`,
      sessionGeneration: 1,
      budgets: {
        maxConcurrentWorkers: 1,
        maxSourceBytes: 128 * MiB,
        maxWasmBytes: 512 * MiB,
        maxOutputBytes: 128 * MiB,
        maxQueuedEvents: 2048,
      },
      initialOutputPageCredits: 128,
      maxBufferedPages: 128,
      maxBufferedBytes: 32 * MiB,
      onProductTaskTrace: (trace) => controller.addEvidence("currentTask", trace),
    });
    handles = await renderer.uploadWebCookedMultiProductScene(scene, asset, {
      fitHeight: 10,
      fitBase: [0, 0, 0],
      stream: true,
      residency: { configuredCapacityBytes: geometryCapacityBytes },
      onProductPublicationTiming: (timing) => {
        publications.push(timing);
        status.textContent = `Published ${timing.shardIndex} Products (not yet settled)`;
      },
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
          "Missing spatial task identity",
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
      "Authored source triangle union incomplete",
    );
    check(
      completed.length === 66 &&
        handles.current().shardCount === completed.length &&
        handles.runtime.evidence().active === completed.length,
      "Not every cooked Product is active",
    );
    controller.addEvidence("publication", {
      settledMs: performance.now() - started,
      products: completed.length,
      coveredPrimitives: covered.size,
      triangles: frozen.triangles,
      instanceCount: handles.current().source.count,
      timings: publications,
      runtime: handles.runtime.evidence(),
      producer: asset.evidence(),
    });
    controller.transition("ready");
    controller.transition("warming");
    const gpu = renderer.device;
    const results = await runCpuHostMeasurement(renderer, camera, scene, handles, controller);
    controller.addEvidence("cpuHost", results);
    controller.transition("draining");
    await gpu.queue.onSubmittedWorkDone();
    controller.addEvidence("cleanup", await dispose());
    const released = geometryProductGpuBudgetEvidence(gpu);
    check(
      released.totalBytes === 0 && released.allocations === 0 && released.metadataAllocations === 0,
      "CPU attribution retained authored Product ownership",
    );
    controller.addEvidence("releasedProductCapacity", released);
    controller.pass();
    status.textContent = "Authored Renderer CPU host attribution passed";
  } catch (error) {
    controller.fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
}

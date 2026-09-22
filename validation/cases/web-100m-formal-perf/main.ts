import {
  DirectionalLight,
  PerspectiveCamera,
  Renderer,
  Scene,
  createDefaultWebCookWorker,
  load_gltf_web_product,
  resolveWebCookRuntimeProfile,
  type MultiProductSceneHandles,
  type WebCookRuntimeAsset
} from "../../../OEngine/src/index.ts";
import {
  aggregateFormalPerfRuns,
  assertFormalPerfFreeze,
  assertFormalPerfRun,
  type FormalPerfFreezeV1,
  type FormalPerfRunV1,
  type FormalPerfSampleV1
} from "../../../OEngine/src/debug/FormalPerfFreeze.ts";
import { createValidationController, attachGpuErrorCollection } from "../../harness/browser.ts";

const SOURCE_URL = "/assets/web-100m/single-giant-100m.glb";
const SOURCE_SHA256 = "730da7cd55ee00b1f98bff58e83e7081e33d7972f56bfdafc24f2b68d234b6a0";
const SOURCE_BYTES = 2_800_457_176;
const SOURCE_TRIANGLES = 100_000_000;
const CAMERA_PATH_ID = "web-100m-formal-camera-v1";
const CAMERA_PATH_SHA256 = "7b9f7501b7e0a2f726d403a8fc4b0dc5b8a0b9c71a4ec1cae4f3d35a4f1ef211";
const WIDTH = 1920, HEIGHT = 1080, WARMUP_FRAMES = 120, SAMPLE_FRAMES = 480, RUNS = 3;
const MiB = 1024 * 1024;

const canvas = document.querySelector<HTMLCanvasElement>("#canvas")!;
const status = document.querySelector<HTMLElement>("#status")!;
const query = new URLSearchParams(location.search);
let renderer: Renderer | undefined;
let scene: Scene | undefined;
let camera: PerspectiveCamera | undefined;
let asset: WebCookRuntimeAsset | undefined;
let handles: MultiProductSceneHandles | undefined;
let gpuErrors: ReturnType<typeof attachGpuErrorCollection> | undefined;
let intentionalDeviceTeardown = false;
let rafPending = 0;
let lastProgressLogAt = 0;

const controller = createValidationController({
  caseId: "web-100m-formal-perf",
  workloadId: "web-100m-formal-perf-v1"
}, disposeCase);

const nextFrame = (): Promise<void> => new Promise((resolve) => {
  rafPending++;
  requestAnimationFrame(() => { rafPending--; resolve(); });
});

void run();

async function run(): Promise<void> {
  try {
    controller.transition("negotiating");
    const mounted = await fetch(SOURCE_URL, { method: "HEAD", cache: "no-store" });
    controller.addEvidence("formalSource", {
      url: SOURCE_URL,
      mounted: mounted.ok,
      contentLength: Number(mounted.headers.get("content-length") ?? 0),
      sha256: SOURCE_SHA256,
      triangles: SOURCE_TRIANGLES
    });
    if (!mounted.ok) {
      status.textContent = "unsupported: formal 100M source is not mounted";
      controller.unsupported(`Formal 100M source is not mounted at ${SOURCE_URL}`);
      return;
    }
    if (Number(mounted.headers.get("content-length") ?? 0) !== SOURCE_BYTES) {
      throw new Error("Formal 100M source byte length does not match the frozen workload");
    }

    const commit = requiredQuery("revision", /^[0-9a-f]{40}$/u);
    const tree = requiredQuery("tree", /^[0-9a-f]{40}$/u);
    const dirty = requiredQuery("dirty", /^(?:true|false)$/u) === "true";
    const browserExecutableSha256 = requiredQuery("browserExecutableSha256", /^[0-9a-f]{64}$/u);
    const workloadSha256 = requiredQuery("workloadSha256", /^[0-9a-f]{64}$/u);
    if (dirty) throw new Error("Formal 100M PERF refuses a dirty revision");

    if (!globalThis.isSecureContext || !navigator.gpu) {
      controller.unsupported("Formal 100M PERF requires WebGPU in a secure context");
      return;
    }
    const context = canvas.getContext("webgpu");
    if (!context) {
      controller.unsupported("Formal 100M PERF could not create a WebGPU canvas context");
      return;
    }
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    renderer = new Renderer({
      debug: false,
      requiredFeatures: ["timestamp-query"],
      requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
      renderSettings: {
        resolution: { mode: "fixed", internalScale: 1 },
        features: {
          shadows: false,
          screenSpaceDiffuseMode: "off",
          screenSpaceReflections: false,
          temporalAntiAliasing: false,
          bloom: false,
          automaticExposure: false,
          motionBlur: false,
          sharpening: false
        }
      }
    });
    try {
      await renderer.initialize({ context, pixelRatio: 1 });
    } catch (error) {
      if (/timestamp|feature|adapter/i.test(error instanceof Error ? error.message : String(error))) {
        controller.unsupported(`Formal timestamp-query device is unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      throw error;
    }
    renderer.resize(WIDTH, HEIGHT);
    renderer.internal_resolution_scale = 1;
    renderer.packed_visibility_current_hzb_late_recheck_enabled = true;
    renderer.profiler.configure({
      enabled: true,
      warmupFrames: 0,
      gpuSampleInterval: 1,
      gpuCounterSampleInterval: 1,
      historyCapacity: 4096,
      cpuPassTimings: true
    });
    renderer.profiler.setMode("deep-capture");
    if (!renderer.capabilities.features.includes("timestamp-query")) {
      controller.unsupported("Formal 100M PERF requires timestamp-query capability");
      return;
    }
    gpuErrors = attachGpuErrorCollection(renderer.device, controller, () => intentionalDeviceTeardown);

    const adapter = renderer.adapter_info;
    const userAgent = navigator.userAgent;
    const freeze: FormalPerfFreezeV1 = {
      schemaVersion: 1,
      commit,
      tree,
      dirty,
      browser: {
        channel: "chrome-stable",
        version: /(?:Chrome|Chromium)\/([0-9.]+)/u.exec(userAgent)?.[1] ?? "unavailable",
        executableSha256: browserExecutableSha256,
        userAgent
      },
      adapter: {
        vendor: adapter?.vendor || "unavailable",
        architecture: adapter?.architecture || "unavailable",
        device: adapter?.device || "unavailable",
        description: adapter?.description || "unavailable"
      },
      capability: {
        featureSet: renderer.capabilities.features,
        limits: renderer.capabilities.limits,
        timestampQuery: renderer.capabilities.features.includes("timestamp-query")
      },
      resolution: { width: WIDTH, height: HEIGHT, devicePixelRatio: 1, renderScale: 1 },
      cameraPath: { id: CAMERA_PATH_ID, sha256: CAMERA_PATH_SHA256 },
      featureSet: renderer.capabilities.features,
      workload: {
        id: "web-100m-formal-perf-v1",
        sha256: workloadSha256,
        sourceSha256: SOURCE_SHA256,
        sourceTriangles: SOURCE_TRIANGLES
      }
    };
    assertFormalPerfFreeze(freeze, { requireClean: true, requireGpuTimestamps: true });
    controller.addEvidence("freeze", freeze);

    status.textContent = "loading and cooking 100M Product shards";
    const loadStarted = performance.now();
    const runtimeProfile = resolveWebCookRuntimeProfile("portable-single");
    const worker = createDefaultWebCookWorker({
      maxSourceWindowBytes: 64 * MiB,
      maxCanonicalInputBytes: 224 * MiB,
      maxDecodedProductBytes: 256 * MiB,
      runtimeProfile: runtimeProfile.selected
    });
    asset = load_gltf_web_product(SOURCE_URL, {
      worker,
      runtimeProfile: runtimeProfile.selected,
      sessionId: `formal-100m-${crypto.randomUUID()}`,
      sessionGeneration: 1,
      budgets: {
        maxConcurrentWorkers: 1,
        maxSourceBytes: 128 * MiB,
        maxWasmBytes: 512 * MiB,
        maxOutputBytes: 256 * MiB,
        maxQueuedEvents: 2048
      },
      initialOutputPageCredits: 512,
      maxBufferedPages: 512,
      maxBufferedBytes: 128 * MiB,
      onProgress: (progress) => {
        controller.addEvidence("cookProgress", progress);
        const denominator = progress.catalogPrimitives > 0 ? `/${progress.catalogPrimitives}` : "";
        status.textContent = `cooking 100M Product shards: ${progress.stage} ${progress.units}${denominator}`;
        const now = performance.now();
        if (now - lastProgressLogAt >= 5_000) {
          lastProgressLogAt = now;
          console.info(`[formal-perf-progress] ${JSON.stringify(progress)}`);
        }
      }
    });
    scene = new Scene();
    const light = new DirectionalLight();
    light.intensity = 3;
    scene.add(light);
    handles = await renderer.uploadWebCookedMultiProductScene(scene, asset, {
      fitHeight: 10,
      fitBase: [0, -5, 0],
      multiProductMetadataBytes: 128 * MiB,
      multiProductSlotCapacity: 128
    });
    camera = new PerspectiveCamera();
    camera.near = 0.01;
    camera.far = 100_000;
    camera.aspect = WIDTH / HEIGHT;
    const firstBounds = sceneBounds(handles.current().source);
    placeCamera(camera, firstBounds, 0, 2.4);
    let firstRendered = false;
    for (let attempt = 0; attempt < 300 && !firstRendered; attempt++) {
      firstRendered = renderer.render(camera, scene, 1 / 60);
      if (!firstRendered) await nextFrame();
    }
    if (!firstRendered) throw new Error("100M scene did not produce a first meaningful frame");
    const ttfmfMs = performance.now() - loadStarted;
    controller.addEvidence("ttfmfMs", ttfmfMs);

    status.textContent = "finishing Product-per-Shard cook";
    await handles.settled();
    const active = handles.current();
    const bounds = sceneBounds(active.source);
    if (active.shardCount < 2) throw new Error(`100M primitive produced only ${active.shardCount} Product shard`);
    controller.addEvidence("multiProduct", {
      shardCount: active.shardCount,
      runtime: handles.runtime.evidence(),
      streaming: handles.streaming?.evidence() ?? null,
      cook: asset.evidence()
    });

    controller.transition("ready");
    controller.transition("warming");
    const runs: FormalPerfRunV1[] = [];
    for (let runIndex = 0; runIndex < RUNS; runIndex++) {
      status.textContent = `formal run ${runIndex + 1}/${RUNS}: warmup`;
      for (let frame = 0; frame < WARMUP_FRAMES; frame++) {
        placeCamera(camera, bounds, frame / (WARMUP_FRAMES + SAMPLE_FRAMES), 2.1);
        renderer.render(camera, scene, 1 / 60);
        await nextFrame();
      }
      if (runIndex === 0) controller.transition("sampling");
      status.textContent = `formal run ${runIndex + 1}/${RUNS}: sampling`;
      const drafts: Array<{
        profilerFrame: number;
        cpuFrame: number;
        cpuBuild: number;
        cpuSubmit: number;
        ownerPeaks: FormalPerfSampleV1["ownerPeaks"];
        pages: FormalPerfSampleV1["pages"];
        cut: boolean;
      }> = [];
      let jsPeak = currentJsHeapBytes();
      let gpuPeak = renderer.memoryEvidence().allocatedBytes;
      for (let frame = 0; frame < SAMPLE_FRAMES; frame++) {
        const cut = frame === Math.floor(SAMPLE_FRAMES / 2);
        const path = (WARMUP_FRAMES + frame) / (WARMUP_FRAMES + SAMPLE_FRAMES);
        placeCamera(camera, bounds, cut ? path + 0.5 : path, cut ? 1.25 : 2.1);
        if (cut) renderer.indicate_view_change();
        const rendered = renderer.render(camera, scene, 1 / 60);
        if (!rendered) throw new Error(`formal sample ${frame} was not renderable`);
        const profile = renderer.profiler.latest;
        if (!profile) throw new Error("formal sample has no profiler snapshot");
        jsPeak = Math.max(jsPeak, currentJsHeapBytes());
        gpuPeak = Math.max(gpuPeak, renderer.memoryEvidence().allocatedBytes);
        const budget = asset.evidence().budget;
        const stream = handles.streaming?.evidence();
        const scheduler = stream?.scheduler;
        drafts.push({
          profilerFrame: profile.frameIndex,
          cpuFrame: profile.cpuMs.frame ?? 0,
          cpuBuild: (profile.cpuMs["command-build"] ?? 0) + (profile.cpuMs["graph-build"] ?? 0),
          cpuSubmit: profile.cpuMs.submit ?? 0,
          ownerPeaks: {
            sourceBytes: budget?.peakSourceBytes ?? 0,
            wasmBytes: budget?.peakWasmBytes ?? 0,
            jsBytes: jsPeak,
            gpuGeometryBytes: gpuPeak
          },
          pages: {
            demand: scheduler?.requested ?? 0,
            churn: handles.runtime.evidence().evictions,
            overflow: (scheduler?.demandOverflow ?? 0) + (stream?.readback.overflow ?? 0)
          },
          cut
        });
        await nextFrame();
      }
      await renderer.device.queue.onSubmittedWorkDone();
      await waitForGpuProfiles(renderer, drafts.map((draft) => draft.profilerFrame));
      const history = new Map(renderer.profiler.history.map((profile) => [profile.frameIndex, profile]));
      const samples: FormalPerfSampleV1[] = drafts.map((draft) => {
        const profile = history.get(draft.profilerFrame);
        if (!profile || !profile.gpu.available || !profile.gpu.sampled || profile.gpu.pending) {
          throw new Error(`GPU timestamp sample ${draft.profilerFrame} is unavailable`);
        }
        const gpuMs = profile.gpu.segments.reduce((sum, segment) => sum + segment.durationMs, 0);
        return {
          frameIndex: draft.profilerFrame + 1,
          cpuMs: { frame: draft.cpuFrame, build: draft.cpuBuild, submit: draft.cpuSubmit },
          gpuMs,
          ownerPeaks: draft.ownerPeaks,
          pages: draft.pages,
          cameraCut: draft.cut
            ? { triggered: true, recoveryMs: Math.max(draft.cpuFrame, gpuMs), recoveryFrames: 1 }
            : { triggered: false, recoveryMs: null, recoveryFrames: null }
        };
      });
      const formalRun: FormalPerfRunV1 = {
        freeze,
        ttfmfMs,
        gpuTimestampAvailable: true,
        samples
      };
      assertFormalPerfRun(formalRun, {
        requireClean: true,
        requireGpuTimestamps: true,
        minimumSamples: SAMPLE_FRAMES
      });
      runs.push(formalRun);
    }
    const summary = aggregateFormalPerfRuns(runs, {
      requireClean: true,
      requireGpuTimestamps: true,
      minimumSamples: SAMPLE_FRAMES
    });
    controller.addEvidence("samples", runs);
    controller.addEvidence("summary", summary);
    controller.addEvidence("final", {
      shardCount: handles.current().shardCount,
      cook: asset.evidence(),
      streaming: handles.streaming?.evidence() ?? null,
      memory: renderer.memoryEvidence(),
      gpuErrors: gpuErrors.errors
    });
    if (gpuErrors.errors.length > 0) throw new Error(JSON.stringify(gpuErrors.errors));
    status.textContent = "passed";
    controller.transition("draining");
    await renderer.device.queue.onSubmittedWorkDone();
    controller.pass();
  } catch (error) {
    controller.fail(error instanceof Error ? error.stack ?? error.message : String(error));
  }
}

function sceneBounds(source: { readonly count: number; readonly boundsSpheres: Float32Array }): Readonly<{ center: readonly [number, number, number]; radius: number }> {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let index = 0; index < source.count; index++) {
    const at = index * 4;
    const x = source.boundsSpheres[at]!, y = source.boundsSpheres[at + 1]!, z = source.boundsSpheres[at + 2]!, r = source.boundsSpheres[at + 3]!;
    minX = Math.min(minX, x - r); minY = Math.min(minY, y - r); minZ = Math.min(minZ, z - r);
    maxX = Math.max(maxX, x + r); maxY = Math.max(maxY, y + r); maxZ = Math.max(maxZ, z + r);
  }
  if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) throw new Error("100M scene bounds are invalid");
  const center = [(minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5] as const;
  return Object.freeze({ center, radius: Math.max(0.01, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 0.5) });
}

function placeCamera(target: PerspectiveCamera, bounds: Readonly<{ center: readonly [number, number, number]; radius: number }>, phase: number, distance: number): void {
  const angle = phase * Math.PI * 2;
  const [x, y, z] = bounds.center;
  target.transform.position.set(
    x + Math.cos(angle) * bounds.radius * distance,
    y + Math.sin(angle * 0.5) * bounds.radius * 0.35,
    z + Math.sin(angle) * bounds.radius * distance
  );
  target.transform.lookAt({ x, y, z });
  target.update();
}

async function waitForGpuProfiles(target: Renderer, frameIndices: readonly number[]): Promise<void> {
  const required = new Set(frameIndices);
  const deadline = performance.now() + 20_000;
  while (performance.now() < deadline) {
    const ready = target.profiler.history.filter((profile) => required.has(profile.frameIndex) && profile.gpu.sampled && !profile.gpu.pending).length;
    if (ready === required.size) return;
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  throw new Error("Timed out waiting for formal GPU timestamp samples");
}

function currentJsHeapBytes(): number {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  const value = memory?.usedJSHeapSize ?? 0;
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function requiredQuery(name: string, pattern: RegExp): string {
  const value = query.get(name) ?? "";
  if (!pattern.test(value)) throw new Error(`Formal PERF query '${name}' is invalid`);
  return value;
}

async function disposeCase(): Promise<Record<string, unknown>> {
  intentionalDeviceTeardown = true;
  await handles?.release().catch(() => undefined);
  handles = undefined;
  asset?.dispose();
  asset = undefined;
  scene = undefined;
  camera = undefined;
  renderer?.destroy();
  renderer = undefined;
  await gpuErrors?.lost.catch(() => undefined);
  gpuErrors?.remove();
  gpuErrors = undefined;
  return { listeners: 0, rafPending, gpuOwners: 0, rendererDestroyed: true };
}

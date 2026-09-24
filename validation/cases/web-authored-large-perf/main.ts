import {
  DirectionalLight,
  PerspectiveCamera,
  Renderer,
  Scene,
  createDefaultWebCookWorker,
  load_gltf,
  resolveWebCookRuntimeProfile,
  type MultiProductSceneHandles,
  type WebCookedSceneOptions,
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

type FormalSource = Readonly<{
  label: string;
  url: string;
  sha256: string;
  bytes: number;
  triangles: number;
  catalogPrimitives: number;
  productSlotCapacity: number;
  maxSourceWindowBytes: number;
  maxCanonicalInputBytes: number;
  maxDecodedProductBytes: number;
  maxSessionSpillBytes: number;
  maxTrianglesPerProduct: number;
  maxVerticesPerProduct: number;
  maxDomainsPerProduct: number;
}>;

const SOURCES: Readonly<Record<string, FormalSource>> = Object.freeze({
  "authored-large": Object.freeze({
    label: "authored large multi-primitive",
    url: "/assets/web-authored-large/large.glb",
    sha256: "54b608872aec11ce07b26fad6c0ad14a662314e6480bf8d833e5088b59c9851f",
    bytes: 477_591_060,
    triangles: 4_871_612,
    catalogPrimitives: 1_920,
    productSlotCapacity: 2_048,
    maxSourceWindowBytes: 64 * 1024 * 1024,
    maxCanonicalInputBytes: 32 * 1024 * 1024,
    maxDecodedProductBytes: 128 * 1024 * 1024,
    maxSessionSpillBytes: 1024 * 1024 * 1024,
    maxTrianglesPerProduct: 128 * 1024,
    maxVerticesPerProduct: 512 * 1024,
    maxDomainsPerProduct: 64
  })
});
const CAMERA_PATH_ID = "web-authored-large-formal-camera-v1";
const CAMERA_PATH_SHA256 = "7b9f7501b7e0a2f726d403a8fc4b0dc5b8a0b9c71a4ec1cae4f3d35a4f1ef211";
const AUTHORED_COOK_HEARTBEAT_TIMEOUT_MS = 120_000;
const COOK_HEARTBEAT_POLL_MS = 5_000;
const MiB = 1024 * 1024;

const canvas = document.querySelector<HTMLCanvasElement>("#canvas")!;
const status = document.querySelector<HTMLElement>("#status")!;
const query = new URLSearchParams(location.search);
const caseId = query.get("case") ?? "web-authored-large-perf";
const workloadId = query.get("workload") ?? "web-authored-large-perf-v1";
const sourceKey = query.get("asset") ?? "authored-large";
const isRuntimeSmoke = caseId === "web-authored-large-runtime-k1";
const WIDTH = isRuntimeSmoke ? 1280 : 1920, HEIGHT = isRuntimeSmoke ? 720 : 1080;
const WARMUP_FRAMES = isRuntimeSmoke ? 1 : 120, SAMPLE_FRAMES = isRuntimeSmoke ? 1 : 480, RUNS = isRuntimeSmoke ? 1 : 3;
let renderer: Renderer | undefined;
let scene: Scene | undefined;
let camera: PerspectiveCamera | undefined;
let asset: WebCookRuntimeAsset | undefined;
let handles: MultiProductSceneHandles | undefined;
const publicationTimings: Array<Parameters<NonNullable<WebCookedSceneOptions["onProductPublicationTiming"]>>[0]> = [];
let gpuErrors: ReturnType<typeof attachGpuErrorCollection> | undefined;
let intentionalDeviceTeardown = false;
let rafPending = 0;
let lastProgressLogAt = 0;
let cookHeartbeatTimer: number | undefined;
let cookHeartbeatAbort: AbortController | undefined;
let lastCookProgressAt = 0;
let lastCookProgress: Record<string, unknown> | undefined;
let terminalCookTimings: Readonly<Record<string, number>> | undefined;
let cookHeartbeatTriggered = false;
let cookSettled = false;

const controller = createValidationController({
  caseId,
  workloadId
}, disposeCase);

const nextFrame = (): Promise<void> => new Promise((resolve) => {
  rafPending++;
  requestAnimationFrame(() => { rafPending--; resolve(); });
});

void run();

async function run(): Promise<void> {
  try {
    const source = SOURCES[sourceKey];
    if (source === undefined) throw new Error(`Unknown formal PERF asset '${sourceKey}'`);
    controller.transition("negotiating");
    const mounted = await fetch(source.url, { headers: { Range: "bytes=0-11" }, cache: "no-store" });
    const sourceHeader = mounted.status === 206 ? await mounted.arrayBuffer() : null;
    const sourceValid = mounted.status === 206 &&
      mounted.headers.get("content-range") === `bytes 0-11/${source.bytes}` &&
      sourceHeader?.byteLength === 12 &&
      new DataView(sourceHeader).getUint32(8, true) === source.bytes &&
      mounted.headers.get("x-source-sha256") === source.sha256;
    controller.addEvidence("formalSource", {
      key: sourceKey,
      label: source.label,
      url: source.url,
      mounted: sourceValid,
      contentLength: source.bytes,
      verification: "host-streamed-sha256",
      sha256: source.sha256,
      triangles: source.triangles
    });
    if (!mounted.ok) {
      status.textContent = `unsupported: ${source.label} source is not mounted`;
      controller.unsupported(`Formal source is not mounted at ${source.url}`);
      return;
    }
    if (!sourceValid) {
      throw new Error(`Formal ${source.label} source identity does not match the frozen workload`);
    }

    const commit = requiredQuery("revision", /^[0-9a-f]{40}$/u);
    const tree = requiredQuery("tree", /^[0-9a-f]{40}$/u);
    const dirty = requiredQuery("dirty", /^(?:true|false)$/u) === "true";
    const browserExecutableSha256 = requiredQuery("browserExecutableSha256", /^[0-9a-f]{64}$/u);
    const workloadSha256 = requiredQuery("workloadSha256", /^[0-9a-f]{64}$/u);
    if (dirty && !isRuntimeSmoke) throw new Error("Formal PERF refuses a dirty revision");

    if (!globalThis.isSecureContext || !navigator.gpu) {
      controller.unsupported("Formal PERF requires WebGPU in a secure context");
      return;
    }
    const context = canvas.getContext("webgpu");
    if (!context) {
      controller.unsupported("Formal PERF could not create a WebGPU canvas context");
      return;
    }
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    renderer = new Renderer({
      debug: false,
      textureMaxResolution: 512 as const,
      textureBankMaxCapacities: [192, 192, 192, 192, 192] as const,
      requiredFeatures: isRuntimeSmoke ? [] : ["timestamp-query"],
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
      if (!isRuntimeSmoke && /timestamp|feature|adapter/i.test(error instanceof Error ? error.message : String(error))) {
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
      gpuSampleInterval: isRuntimeSmoke ? 10 : 1,
      gpuCounterSampleInterval: isRuntimeSmoke ? 10 : 1,
      historyCapacity: isRuntimeSmoke ? 256 : 4096,
      cpuPassTimings: true
    });
    renderer.profiler.setMode("deep-capture");
    if (!isRuntimeSmoke && !renderer.capabilities.features.includes("timestamp-query")) {
      controller.unsupported("Formal PERF requires timestamp-query capability");
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
        id: workloadId,
        sha256: workloadSha256,
        sourceSha256: source.sha256,
        sourceTriangles: source.triangles
      }
    };
    if (!isRuntimeSmoke) assertFormalPerfFreeze(freeze, { requireClean: true, requireGpuTimestamps: true });
    controller.addEvidence("freeze", freeze);

    status.textContent = `loading and cooking ${source.label} Products`;
    const loadStarted = performance.now();
    const cookHeartbeatTimeoutMs = AUTHORED_COOK_HEARTBEAT_TIMEOUT_MS;
    cookHeartbeatAbort = new AbortController();
    lastCookProgressAt = performance.now();
    const runtimeProfile = resolveWebCookRuntimeProfile("portable-single");
    const worker = createDefaultWebCookWorker({
      maxSourceWindowBytes: source.maxSourceWindowBytes,
      maxCanonicalInputBytes: source.maxCanonicalInputBytes,
      maxDecodedProductBytes: source.maxDecodedProductBytes,
      maxSessionSpillBytes: source.maxSessionSpillBytes,
      maxTrianglesPerProduct: source.maxTrianglesPerProduct,
      maxVerticesPerProduct: source.maxVerticesPerProduct,
      maxDomainsPerProduct: source.maxDomainsPerProduct,
      runtimeProfile: runtimeProfile.selected
    });
    asset = load_gltf(source.url, {
      worker,
      runtimeProfile: runtimeProfile.selected,
      sessionId: `formal-${sourceKey}-${crypto.randomUUID()}`,
      sessionGeneration: 1,
      budgets: {
        maxConcurrentWorkers: 1,
        maxSourceBytes: Math.max(128 * MiB, source.maxSourceWindowBytes),
        maxWasmBytes: 512 * MiB,
        maxOutputBytes: 256 * MiB,
        maxQueuedEvents: 2048
      },
      initialOutputPageCredits: 512,
      maxBufferedPages: 512,
      maxBufferedBytes: 128 * MiB,
      onProgress: (progress) => {
        lastCookProgressAt = performance.now();
        lastCookProgress = { ...progress };
        if (progress.stage === "cook-complete") terminalCookTimings = progress.timings;
        controller.addEvidence("cookProgress", progress);
        const denominator = progress.catalogPrimitives > 0 ? `/${progress.catalogPrimitives}` : "";
        status.textContent = `cooking ${source.label} Products: ${progress.stage} ${progress.units}${denominator}`;
        const now = performance.now();
        if (now - lastProgressLogAt >= 5_000) {
          lastProgressLogAt = now;
          console.info(`[formal-perf-progress] ${JSON.stringify(progress)}`);
        }
      },
      onProductTaskTrace: (trace) => {
        lastCookProgressAt = performance.now();
        lastCookProgress = { type: "ProductTaskTrace", trace };
        controller.addEvidence("currentProductTask", trace);
      }
    });
    cookHeartbeatTimer = window.setInterval(() => {
      const idleMs = performance.now() - lastCookProgressAt;
      if (idleMs <= cookHeartbeatTimeoutMs || cookHeartbeatTriggered) return;
      cookHeartbeatTriggered = true;
      const message = `${source.label} cook heartbeat stalled for ${Math.round(idleMs)}ms`;
      controller.addEvidence("cookHeartbeat", {
        timeoutMs: cookHeartbeatTimeoutMs,
        idleMs,
        lastProgress: lastCookProgress ?? null,
        aborted: true
      });
      cookHeartbeatAbort?.abort(message);
      asset?.cancel(message);
    }, COOK_HEARTBEAT_POLL_MS);
    scene = new Scene();
    const light = new DirectionalLight();
    light.intensity = 3;
    if (isRuntimeSmoke) {
      light.transform_local.position.set(10, 20, 10);
      light.transform_local.lookAt({ x: 0, y: 0, z: 0 });
    }
    scene.add(light);
    handles = await renderer.uploadWebCookedMultiProductScene(scene, asset, {
      signal: cookHeartbeatAbort.signal,
      fitHeight: 10,
      fitBase: [0, -5, 0],
      multiProductMetadataBytes: 128 * MiB,
      multiProductSlotCapacity: source.productSlotCapacity,
      onProductPublicationTiming: timing => {
        publicationTimings.push(timing);
        lastCookProgressAt = performance.now();
        lastCookProgress = { type: "ProductPublicationTiming", shardIndex: timing.shardIndex, scenePublishMs: timing.scenePublishMs };
        controller.addEvidence("currentPublication", lastCookProgress);
      }
    });
    camera = new PerspectiveCamera();
    camera.near = 0.01;
    camera.far = 100_000;
    camera.aspect = WIDTH / HEIGHT;
    const firstBounds = isRuntimeSmoke ? sceneBoxBounds(handles.current().source) : sceneBounds(handles.current().source);
    if (isRuntimeSmoke) controller.addEvidence("firstSceneBounds", firstBounds);
    placeCamera(camera, firstBounds, 0, 2.4);
    let firstRendered = false;
    for (let attempt = 0; attempt < 300 && !firstRendered; attempt++) {
      firstRendered = renderer.render(camera, scene, 1 / 60);
      if (!firstRendered) await nextFrame();
    }
    if (!firstRendered) throw new Error(`${source.label} scene did not produce a first meaningful frame`);
    const ttfmfMs = performance.now() - loadStarted;
    const firstFrameShardCount = handles.current().shardCount;
    controller.addEvidence("ttfmfMs", ttfmfMs);

    status.textContent = "finishing Product-per-Shard cook";
    await handles.settled();
    cookSettled = true;
    const settledMs = performance.now() - loadStarted;
    controller.addEvidence("settledMs", settledMs);
    if (cookHeartbeatTimer !== undefined) {
      window.clearInterval(cookHeartbeatTimer);
      cookHeartbeatTimer = undefined;
    }
    const active = handles.current();
    if (publicationTimings.length !== active.shardCount) throw new Error("Product publication timing coverage is incomplete");
    controller.addEvidence("publicationTimings", publicationTimings);
    const bounds = isRuntimeSmoke ? sceneBoxBounds(active.source) : sceneBounds(active.source);
    if (isRuntimeSmoke) controller.addEvidence("conservativeSphereBounds", sceneBounds(active.source));
    if (isRuntimeSmoke) controller.addEvidence("settledSceneBounds", bounds);
    const taskReceipt = assertProductTaskReceipt(asset.evidence(), source.catalogPrimitives, active.shardCount);
    controller.addEvidence("multiProduct", {
      shardCount: active.shardCount,
      catalogCoverage: taskReceipt.coveredSceneAssets,
      taskReceipt,
      runtime: handles.runtime.evidence(),
      streaming: handles.streaming?.evidence() ?? null,
      cook: asset.evidence()
    });

    if (isRuntimeSmoke) {
      if (firstFrameShardCount >= active.shardCount) throw new Error("Runtime smoke did not render before the final Product publication");
      const materialReceipt = assertAuthoredMaterials(asset, active.source);
      controller.addEvidence("materialReceipt", materialReceipt);
      const instances = renderer.gpuSceneEvidence();
      if (instances.instanceSetCount !== 1 || instances.activeInstanceCount !== active.source.count ||
          instances.bulkInstantiateCount !== 1 || instances.releaseCount !== 0) {
        throw new Error("Runtime smoke did not preserve one append-only Product instance publication");
      }
      const inspectionBounds = Object.freeze({ center: [-8, 0, -160] as const, radius: 20 });
      controller.addEvidence("inspectionBounds", inspectionBounds);
      const beforeCut = handles.streaming?.evidence().scheduler;
      renderer.indicate_view_change();
      let movingFrames = 0;
      for (let frame = 0; frame < 8; frame++) {
        placeCamera(camera, inspectionBounds, (frame + 1) / 8, 2.4);
        if (renderer.render(camera, scene, 1 / 60)) movingFrames++;
        await nextFrame();
      }
      if (movingFrames !== 8) throw new Error(`Runtime smoke rendered only ${movingFrames}/8 camera movement frames`);
      const coldFallback = await captureHdrStats(renderer, camera, scene, "post-color-grading");
      if (coldFallback.nonzeroPixels < 1_000) throw new Error("Camera-cut view lost visible ancestor fallback");
      const streamingSamples: Array<{ frame: number; requested: number; resident: number; uploadedBytes: number }> = [];
      for (let frame = 0; frame < 120; frame++) {
        renderer.render(camera, scene, 1 / 60);
        await nextFrame();
        if (frame % 20 === 19) {
          await renderer.device.queue.onSubmittedWorkDone();
          const sample = handles.streaming?.evidence();
          streamingSamples.push({ frame: frame + 1, requested: sample?.scheduler.requested ?? 0, resident: sample?.scheduler.resident ?? 0, uploadedBytes: sample?.scheduler.uploadedBytes ?? 0 });
        }
      }
      controller.addEvidence("streamingSamples", streamingSamples);
      const afterRecovery = handles.streaming?.evidence().scheduler;
      if (beforeCut === undefined || afterRecovery === undefined ||
          afterRecovery.requested <= beforeCut.requested ||
          afterRecovery.resident <= beforeCut.resident ||
          streamingSamples.some((sample, index) => index > 0 && sample.resident < streamingSamples[index - 1]!.resident)) {
        throw new Error("Camera-cut demand did not produce monotonic page recovery");
      }
      controller.addEvidence("cameraCutRecovery", {
        requestedBefore: beforeCut.requested,
        requestedAfter: afterRecovery.requested,
        residentBefore: beforeCut.resident,
        residentAfter: afterRecovery.resident,
        coldFallback
      });
      controller.addEvidence("scenePublication", { world: renderer.gpuRenderWorldEvidence(), instances: renderer.gpuSceneEvidence() });
      const recentProfiles = renderer.profiler.history.slice(-10);
      controller.addEvidence("gpuCounterSamples", recentProfiles.map(profile => ({ frame: profile.frameIndex, sampled: profile.gpuCounters.sampled, pending: profile.gpuCounters.pending, dropped: profile.gpuCounters.dropped, candidateInstances: profile.gpuCounters.values.candidateInstances, visibleInstances: profile.gpuCounters.values.visibleInstances, selectedClusters: profile.gpuCounters.values.selectedClusters, shadedPixels: profile.gpuCounters.values.shadedPixels, activeLights: profile.gpuCounters.values.activeLights, shadingBinErrors: profile.gpuCounters.values.shadingBinErrors })));
      controller.addEvidence("profilerDiagnostics", renderer.profiler.diagnostics);
      const lighting = await captureHdrStats(renderer, camera, scene, "lighting");
      const postColor = await captureHdrStats(renderer, camera, scene, "post-color-grading");
      controller.addEvidence("hdrPixels", { lighting, postColor });
      if (lighting.nonzeroPixels < 1_000 || postColor.nonzeroPixels < 1_000 || postColor.maximumRgb < 0.05 ||
          postColor.nonzeroPixels < coldFallback.nonzeroPixels * 0.8) {
        throw new Error(`Runtime smoke has insufficient visible HDR content: ${JSON.stringify({ lighting, postColor })}`);
      }
      controller.addEvidence("k1", {
        settled: true,
        firstFrameShardCount,
        productCount: active.shardCount,
        catalogPrimitives: source.catalogPrimitives,
        taskReceipt,
        materialReceipt,
        cameraCutRecovery: true,
        movingFrames,
        ttfmfMs,
        memory: renderer.memoryEvidence(),
        streaming: handles.streaming?.evidence() ?? null,
        gpuErrors: gpuErrors.errors
      });
      if (gpuErrors.errors.length > 0) throw new Error(JSON.stringify(gpuErrors.errors));
      controller.transition("ready");
      controller.transition("warming");
      controller.transition("sampling");
      controller.transition("draining");
      await renderer.device.queue.onSubmittedWorkDone();
      status.textContent = "passed authored-large runtime smoke";
      controller.pass();
      return;
    }

    const cookTimings = terminalCookTimings;
    const cookOwners = Object.freeze({
      sourcePeakBytes: cookTimings?.peakSourceWindowBytes ?? 0,
      canonicalPeakBytes: cookTimings?.peakCanonicalWindowBytes ?? 0,
      wasmBytes: cookTimings?.wasmMemoryBytes ?? 0,
      spillPeakBytes: cookTimings?.spillPeakBytes ?? 0,
      totalCookMs: cookTimings?.totalCookMs ?? 0
    });
    if (Object.values(cookOwners).some(value => !Number.isFinite(value) || value <= 0)) {
      throw new Error("Formal PERF is missing positive cook owner peaks or total cook time");
    }
    controller.addEvidence("cookOwners", cookOwners);

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
        const stream = handles.streaming?.evidence();
        const scheduler = stream?.scheduler;
        drafts.push({
          profilerFrame: profile.frameIndex,
          cpuFrame: profile.cpuMs.frame ?? 0,
          cpuBuild: (profile.cpuMs["command-build"] ?? 0) + (profile.cpuMs["graph-build"] ?? 0),
          cpuSubmit: profile.cpuMs.submit ?? 0,
          ownerPeaks: {
            sourceBytes: cookOwners.sourcePeakBytes,
            wasmBytes: cookOwners.wasmBytes,
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
      cookHeartbeat: {
        timeoutMs: cookHeartbeatTimeoutMs,
        triggered: cookHeartbeatTriggered,
        lastProgress: lastCookProgress ?? null
      },
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

function assertProductTaskReceipt(
  evidence: ReturnType<WebCookRuntimeAsset["evidence"]>,
  expectedCatalogPrimitives: number,
  expectedProducts: number
): Readonly<Record<string, unknown>> {
  const events = evidence.productTaskTrace;
  const started = events.filter(event => event.kind === "task-started");
  const terminal = events.filter(event => event.kind === "completed" || event.kind === "failed" || event.kind === "cancelled");
  const completed = terminal.filter(event => event.kind === "completed");
  if (started.length !== expectedProducts || terminal.length !== expectedProducts || completed.length !== expectedProducts) {
    throw new Error(`Product task trace is incomplete: started=${started.length}, terminal=${terminal.length}, completed=${completed.length}, Products=${expectedProducts}`);
  }
  const startedIds = new Set(started.map(event => event.task.taskId));
  if (startedIds.size !== expectedProducts || terminal.some(event => !startedIds.has(event.task.taskId))) throw new Error("Product task trace start/terminal identity is inconsistent");
  const requiredPhases = ["canonicalize", "wasm-plan", "spill", "publish"] as const;
  for (const task of completed) {
    for (const phase of requiredPhases) {
      const began = events.some(event => event.task.taskId === task.task.taskId && event.kind === "phase-started" && event.phase === phase);
      const ended = events.some(event => event.task.taskId === task.task.taskId && event.kind === "phase-completed" && event.phase === phase);
      if (!began || !ended) throw new Error(`Product task ${task.task.taskId} is missing ${phase} trace`);
    }
    const identity = task.task;
    if (identity.canonicalBytes > identity.limits.maxCanonicalBytes || identity.triangles > identity.limits.maxTriangles || identity.vertices > identity.limits.maxVertices || identity.domains > identity.limits.maxDomains) {
      throw new Error(`Product task ${identity.taskId} exceeds its declared work budget`);
    }
  }
  const covered = new Set(completed.flatMap(event => [...event.task.sceneAssetIndices]));
  if (covered.size !== expectedCatalogPrimitives || Array.from({ length: expectedCatalogPrimitives }, (_, index) => index).some(index => !covered.has(index))) {
    throw new Error(`Product sceneAssetIndices cover ${covered.size}/${expectedCatalogPrimitives} catalog primitives`);
  }
  const spillPeakBytes = Math.max(0, ...completed.map(event => event.metrics.spillPeakBytes));
  const spillLimitBytes = Math.max(0, ...completed.map(event => event.metrics.spillLimitBytes));
  if (spillLimitBytes <= 0 || spillPeakBytes > spillLimitBytes) throw new Error(`Session spill evidence is invalid: peak=${spillPeakBytes}, limit=${spillLimitBytes}`);
  const slowest = completed.reduce((current, event) => event.elapsedMs! > (current?.elapsedMs ?? -1) ? event : current, undefined as typeof completed[number] | undefined);
  return Object.freeze({
    productCount: expectedProducts,
    taskEvents: events.length,
    coveredSceneAssets: Object.freeze([...covered].sort((left, right) => left - right)),
    spillPeakBytes,
    spillLimitBytes,
    slowestTaskId: slowest?.task.taskId ?? null,
    slowestProductMs: slowest?.elapsedMs ?? 0,
    slowestWasmPlanMs: Math.max(0, ...completed.map(event => event.metrics.wasmPlanMs))
  });
}

function assertAuthoredMaterials(
  asset: WebCookRuntimeAsset,
  source: ReturnType<MultiProductSceneHandles["current"]>["source"]
): Readonly<{ materialCount: number; texturedMaterialCount: number; referencedMaterialCount: number }> {
  const catalog = asset.catalog;
  if (!catalog) throw new Error("Runtime material check requires the settled catalog");
  const authored = new Map<number, Readonly<Record<string, unknown>>>();
  for (const primitive of catalog.primitives) {
    authored.set(primitive.materialIndex === 0xffffffff ? 0 : primitive.materialIndex, primitive.material);
  }
  const referenced = new Set(source.materialIndices);
  let texturedMaterialCount = 0;
  for (const index of referenced) {
    const material = source.materials[index];
    const expected = authored.get(index);
    if (material === undefined || expected === undefined) {
      throw new Error(`Authored material ${index} is absent from the Scene publication`);
    }
    const color = expected.baseColorFactor;
    if (Array.isArray(color) && color.length === 4 &&
        [material.diffuse_color.r, material.diffuse_color.g, material.diffuse_color.b,
          material.diffuse_color.a].some((value, lane) => Math.abs(value - Number(color[lane])) > 1e-5)) {
      throw new Error(`Authored material ${index} base color differs from the catalog`);
    }
    const textured = expected.baseColorTexture !== undefined;
    if (textured !== (material.texture_albedo !== undefined)) {
      throw new Error(`Authored material ${index} base color texture binding differs from the catalog`);
    }
    const unlit = expected.unlit === true;
    if (material.is_unlit !== unlit ||
        Math.abs(material.metallic_factor - authoredScalar(expected.metallicFactor, 0)) > 1e-5 ||
        Math.abs(material.roughness_factor - authoredScalar(expected.roughnessFactor, 1)) > 1e-5 ||
        Math.abs(material.alpha_cutoff - authoredScalar(expected.alphaCutoff, 0.5)) > 1e-5) {
      throw new Error(`Authored material ${index} shading factors differ from the catalog`);
    }
    for (const [key, bound] of [
      ["normalTexture", material.texture_normal !== undefined],
      ["metallicRoughnessTexture", material.texture_orm !== undefined],
      ["occlusionTexture", material.texture_occlusion !== undefined],
      ["emissiveTexture", material.texture_emissive !== undefined]
    ] as const) {
      const expectedBound = expected[key] !== undefined && (!unlit || key === "emissiveTexture");
      if (bound !== expectedBound) {
        throw new Error(`Authored material ${index} ${key} binding differs from the catalog`);
      }
    }
    if (textured) texturedMaterialCount++;
  }
  return Object.freeze({
    materialCount: source.materials.length,
    texturedMaterialCount,
    referencedMaterialCount: referenced.size
  });
}

function authoredScalar(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sceneBounds(source: { readonly count: number; readonly boundsSpheres: Float32Array }): Readonly<{ center: readonly [number, number, number]; radius: number }> {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let index = 0; index < source.count; index++) {
    const at = index * 4;
    const x = source.boundsSpheres[at]!, y = source.boundsSpheres[at + 1]!, z = source.boundsSpheres[at + 2]!, r = source.boundsSpheres[at + 3]!;
    minX = Math.min(minX, x - r); minY = Math.min(minY, y - r); minZ = Math.min(minZ, z - r);
    maxX = Math.max(maxX, x + r); maxY = Math.max(maxY, y + r); maxZ = Math.max(maxZ, z + r);
  }
  if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) throw new Error("formal scene bounds are invalid");
  const center = [(minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5] as const;
  return Object.freeze({ min: [minX, minY, minZ] as const, max: [maxX, maxY, maxZ] as const, center, radius: Math.max(0.01, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 0.5) });
}

function sceneBoxBounds(source: { readonly count: number; readonly boundsMin?: Float32Array; readonly boundsMax?: Float32Array }): Readonly<{ min: readonly [number, number, number]; max: readonly [number, number, number]; center: readonly [number, number, number]; radius: number }> {
  const { boundsMin, boundsMax } = source;
  if (boundsMin === undefined || boundsMax === undefined) throw new Error("Runtime scene source has no instance box bounds");
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let index = 0; index < source.count; index++) {
    const at = index * 3;
    minX = Math.min(minX, boundsMin[at]!); minY = Math.min(minY, boundsMin[at + 1]!); minZ = Math.min(minZ, boundsMin[at + 2]!);
    maxX = Math.max(maxX, boundsMax[at]!); maxY = Math.max(maxY, boundsMax[at + 1]!); maxZ = Math.max(maxZ, boundsMax[at + 2]!);
  }
  if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) throw new Error("Runtime scene box bounds are invalid");
  return Object.freeze({ min: [minX, minY, minZ] as const, max: [maxX, maxY, maxZ] as const, center: [(minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5] as const, radius: Math.max(0.01, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 0.5) });
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

async function captureHdrStats(target: Renderer, view: PerspectiveCamera, world: Scene, stage: "lighting" | "post-color-grading"): Promise<Readonly<{ maximumRgb: number; nonzeroPixels: number }>> {
  const capture = target.requestLinearHdrCapture({ x: 384, y: 104, width: 512, height: 512, stage });
  target.render(view, world, 1 / 60);
  const result = await capture;
  let maximumRgb = 0, nonzeroPixels = 0;
  for (let offset = 0; offset < result.rgba.length; offset += 4) {
    const rgb = Math.max(result.rgba[offset]!, result.rgba[offset + 1]!, result.rgba[offset + 2]!);
    maximumRgb = Math.max(maximumRgb, rgb);
    if (rgb > 0.001) nonzeroPixels++;
  }
  return Object.freeze({ maximumRgb, nonzeroPixels });
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
  if (cookHeartbeatTimer !== undefined) {
    window.clearInterval(cookHeartbeatTimer);
    cookHeartbeatTimer = undefined;
  }
  cookHeartbeatAbort?.abort("validation-dispose");
  await handles?.release();
  handles = undefined;
  const cleanup = asset?.state === "open" && cookSettled ? await asset.disposeAsync() : (asset?.dispose(), null);
  asset = undefined;
  scene = undefined;
  camera = undefined;
  renderer?.destroy();
  renderer = undefined;
  await gpuErrors?.lost.catch(() => undefined);
  gpuErrors?.remove();
  gpuErrors = undefined;
  return { listeners: 0, rafPending, gpuOwners: 0, rendererDestroyed: true, cookSettled, cleanup };
}

/**
 * Validation case: the catalog-priority handshake must reach the bootstrap cut.
 *
 * The automatic first cut is ranked by `sourcePriority` first and by spatial
 * coverage second. That ordering is only observable if the main thread's
 * ranking actually crosses the Worker boundary before cooking starts, which is
 * what `CommitCatalogPriorities` exists for.
 *
 * This case proves it without reading Worker internals: it loads the same GLB
 * twice with an identical camera and identical budgets, once with no priority
 * at all and once promoting the second coverage tier to the top of the ranking.
 * The two cuts are disjoint by construction, so the resulting scenes must
 * contain different instances. If the ranking is silently dropped, both runs
 * select the same coverage-ranked cut, the instance fingerprints match, and the
 * case fails.
 */
import {
  DirectionalLight,
  OrbitControls,
  PerspectiveCamera,
  Renderer,
  Scene,
  WebCookBudgetLedger,
  createDefaultWebCookWorker,
  load_gltf_web_product,
  resolveWebCookRuntimeProfile,
  type ProductSceneHandles,
  type WebCookRuntimeAsset,
  type WebCookSceneCatalogSnapshot
} from "../../../../OEngine/src/index.ts";
import dungeonSourceUrl from "../../../../examples/assets/three/rendering-lab/dungeon_warkarma.glb?url";
import { createValidationController } from "../../host/protocol.ts";
import { attachGpuErrorCollection } from "../../host/webgpu.ts";

/**
 * Mirror of `WebCookCoordinator`'s automatic first-cut bound.
 *
 * The value is not exported, so the case asserts the observed cut size against
 * this mirror: a drift in either direction fails here rather than silently
 * changing what "the bootstrap cut" means to the comparison.
 */
const BOOTSTRAP_UNIT_LIMIT = 24;
/** The case's floor for "this run actually drew the level". */
const LIT_PIXEL_FLOOR = 64;

const canvas = document.querySelector<HTMLCanvasElement>("#output")!;
const statusElement = document.querySelector<HTMLElement>("#status")!;
const metricsElement = document.querySelector<HTMLElement>("#metrics")!;

const query = new URLSearchParams(window.location.search);
const runnerMode = query.has("runId");
const controller = runnerMode
  ? createValidationController(
      { caseId: query.get("case") ?? "glb-bootstrap-priority", workloadId: query.get("workload") ?? "glb-bootstrap-priority-v1" },
      disposeCase
    )
  : undefined;

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

let renderer: Renderer | undefined;
let scene: Scene | undefined;
let camera: PerspectiveCamera | undefined;
let controls: OrbitControls | undefined;
let errorCollection: ReturnType<typeof attachGpuErrorCollection> | undefined;
let intentionalDeviceTeardown = false;

function setStatus(value: string): void { statusElement.textContent = value; }

interface CameraFrame { readonly center: readonly [number, number, number]; readonly radius: number }

interface RunEvidence {
  readonly label: string;
  readonly instanceCount: number;
  readonly assetCount: number;
  readonly fingerprint: string;
  readonly litPixels: number;
  readonly sampledPixels: number;
  readonly promotedKeys: readonly string[];
  readonly catalogPrimitives: number;
  readonly residentPages: number;
  readonly pinnedPages: number;
  readonly cook: ReturnType<WebCookRuntimeAsset["evidence"]>;
}

async function ensureRenderer(): Promise<void> {
  if (renderer) return;
  if (!globalThis.isSecureContext || !navigator.gpu) throw new Error("WebGPU requires a secure context and navigator.gpu");
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("WebGPU canvas context is unavailable");
  // The case reads the shaded result back, which needs COPY_SRC.
  const configure = context.configure.bind(context);
  Object.defineProperty(context, "configure", {
    configurable: true,
    value: (config: GPUCanvasConfiguration) => configure({ ...config, usage: (config.usage ?? GPUTextureUsage.RENDER_ATTACHMENT) | GPUTextureUsage.COPY_SRC })
  });
  renderer = new Renderer({
    debug: false,
    requiredLimits: { maxStorageBuffersPerShaderStage: 16 },
    renderSettings: {
      features: {
        shadows: false, screenSpaceDiffuseMode: "off", screenSpaceReflections: false,
        temporalAntiAliasing: false, bloom: false, automaticExposure: false, motionBlur: false, sharpening: false
      }
    }
  });
  await renderer.initialize({ context, pixelRatio: Math.min(window.devicePixelRatio || 1, 2) });
  resize();
}

function resize(): void {
  if (!renderer || !camera) return;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width * Math.min(window.devicePixelRatio || 1, 2)));
  const height = Math.max(1, Math.floor(rect.height * Math.min(window.devicePixelRatio || 1, 2)));
  canvas.width = width; canvas.height = height;
  renderer.resize(width, height);
  camera.aspect = width / height;
  camera.update();
}

/** Local-AABB max extent: the same coverage the coordinator falls back to. */
function primitiveCoverage(primitive: WebCookSceneCatalogSnapshot["primitives"][number]): number {
  const min = primitive.boundsMin, max = primitive.boundsMax;
  for (let axis = 0; axis < 3; axis++) {
    const low = min[axis], high = max[axis];
    if (!Number.isFinite(low) || !Number.isFinite(high) || (high as number) < (low as number)) return Number.NEGATIVE_INFINITY;
  }
  return Math.max((max[0] as number) - (min[0] as number), (max[1] as number) - (min[1] as number), (max[2] as number) - (min[2] as number));
}

/**
 * The second coverage tier: ranks 24..47 of the coverage-descending order.
 *
 * The unprioritized cut takes the largest primitives by coverage, so ranks
 * 0..23 are exactly the ones that cut contains and ranks 24..47 are exactly the
 * ones it cannot. Promoting the second tier therefore produces a provably
 * disjoint cut while still being large enough to be plainly visible — the
 * smallest primitives are not, and a cut that renders almost nothing could not
 * demonstrate anything about the first frame.
 */
function promotedPrimitives(catalog: WebCookSceneCatalogSnapshot): readonly string[] {
  return catalog.primitives
    .map((primitive, index) => ({ key: primitive.assetKey, index, coverage: primitiveCoverage(primitive) }))
    .sort((left, right) => right.coverage - left.coverage || left.index - right.index)
    .slice(BOOTSTRAP_UNIT_LIMIT, BOOTSTRAP_UNIT_LIMIT * 2)
    .map(entry => entry.key);
}

function transformPoint(matrix: readonly number[], point: readonly [number, number, number]): [number, number, number] {
  return [
    matrix[0]! * point[0] + matrix[4]! * point[1] + matrix[8]! * point[2] + matrix[12]!,
    matrix[1]! * point[0] + matrix[5]! * point[1] + matrix[9]! * point[2] + matrix[13]!,
    matrix[2]! * point[0] + matrix[6]! * point[1] + matrix[10]! * point[2] + matrix[14]!
  ];
}

/**
 * Conservative world bounds of the whole catalog.
 *
 * The camera is framed from the catalog, not from a published cut, so both runs
 * render from an identical viewpoint. Framing per cut would make the runs differ
 * in framing as well as in cut, and the comparison would prove nothing.
 */
function catalogBounds(catalog: WebCookSceneCatalogSnapshot): CameraFrame {
  const instanceMatrices = new Map<number, readonly number[]>();
  for (const instance of catalog.instances) instanceMatrices.set(instance.nodeIndex, instance.worldMatrix);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const primitive of catalog.primitives) {
    const matrix = instanceMatrices.get(primitive.instanceNodeIndices[0] ?? primitive.nodeIndex);
    const min = primitive.boundsMin, max = primitive.boundsMax;
    for (let corner = 0; corner < 8; corner++) {
      const local: [number, number, number] = [
        corner & 1 ? (max[0] as number) : (min[0] as number),
        corner & 2 ? (max[1] as number) : (min[1] as number),
        corner & 4 ? (max[2] as number) : (min[2] as number)
      ];
      const world = matrix === undefined ? local : transformPoint(matrix, local);
      minX = Math.min(minX, world[0]); minY = Math.min(minY, world[1]); minZ = Math.min(minZ, world[2]);
      maxX = Math.max(maxX, world[0]); maxY = Math.max(maxY, world[1]); maxZ = Math.max(maxZ, world[2]);
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) throw new Error("GLB catalog published no finite primitive bounds");
  return {
    center: [(minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5],
    radius: Math.max(0.01, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 0.5)
  };
}

function applyCameraFrame(frame: CameraFrame): void {
  if (!camera || !controls) throw new Error("Camera is not available for framing");
  controls.target.set(frame.center[0], frame.center[1], frame.center[2]);
  camera.transform.position.set(frame.center[0], frame.center[1], frame.center[2] + frame.radius * 2.5);
  camera.transform.lookAt({ x: frame.center[0], y: frame.center[1], z: frame.center[2] });
  camera.update();
  controls.update();
}

/**
 * FNV-1a over the published per-instance bounds.
 *
 * `boundsSpheres` is the scene's own description of which instances it holds,
 * so two cuts hash differently if and only if they contain different instances.
 */
function fingerprint(source: { readonly count: number; readonly boundsSpheres: Float32Array }): string {
  const bytes = new Uint8Array(source.boundsSpheres.buffer, source.boundsSpheres.byteOffset, source.count * 4 * 4);
  let hash = 0x811c9dc5;
  for (const byte of bytes) { hash ^= byte; hash = Math.imul(hash, 0x01000193) >>> 0; }
  return `${source.count.toString(16)}-${hash.toString(16).padStart(8, "0")}`;
}

async function runOnce(label: string, prioritize: boolean, frame: CameraFrame | undefined): Promise<{ readonly evidence: RunEvidence; readonly frame: CameraFrame }> {
  setStatus(`${label}: cooking...`);
  const activeScene = new Scene();
  const activeCamera = new PerspectiveCamera();
  activeCamera.near = 0.01;
  activeCamera.far = 100000;
  activeCamera.transform.position.set(0, 0, 3);
  activeCamera.transform.lookAt({ x: 0, y: 0, z: 0 });
  activeCamera.update();
  const activeControls = new OrbitControls(activeCamera, canvas);
  activeControls.distanceLimits.set(0.01, 100000);
  const light = new DirectionalLight(); light.intensity = 3; activeScene.add(light);
  scene = activeScene; camera = activeCamera; controls = activeControls;

  const runtimeProfile = resolveWebCookRuntimeProfile("portable-single").selected;
  const worker = createDefaultWebCookWorker({ maxCanonicalInputBytes: 64 * 1024 * 1024, maxDecodedProductBytes: 256 * 1024 * 1024, runtimeProfile });
  let catalog: WebCookSceneCatalogSnapshot | undefined;
  let promotedKeys: readonly string[] = [];
  let asset: WebCookRuntimeAsset | undefined;
  asset = load_gltf_web_product(dungeonSourceUrl, {
    worker,
    runtimeProfile,
    sessionId: `priority-${label}-${crypto.randomUUID()}`,
    sessionGeneration: 1,
    budgets: { maxConcurrentWorkers: 1, maxSourceBytes: 512 * 1024 * 1024, maxWasmBytes: 64 * 1024 * 1024, maxOutputBytes: 128 * 1024 * 1024, maxQueuedEvents: 512 },
    initialOutputPageCredits: 32,
    maxBufferedPages: 32,
    maxBufferedBytes: 32 * 262144,
    ledger: new WebCookBudgetLedger({ maxActiveSessions: 2, maxOutputBytes: 256 * 1024 * 1024, maxSourceBytes: 256 * 1024 * 1024, maxWasmBytes: 256 * 1024 * 1024 }),
    onSceneCatalogReady: (ready) => {
      catalog = ready;
      if (!prioritize) return;
      // Run B's ranking, applied inside the catalog hook so it is committed to
      // the Worker before cooking starts.
      promotedKeys = promotedPrimitives(ready);
      for (const key of promotedKeys) asset!.setSourcePriority(key, 1, 0);
    }
  });
  const activeAsset = asset;

  let handles: ProductSceneHandles | undefined;
  try {
    handles = await renderer!.uploadWebCookedScene(activeScene, activeAsset);
    if (catalog === undefined) throw new Error(`${label}: catalog never arrived`);
    const source = handles.source;
    const activeFrame = frame ?? catalogBounds(catalog);
    applyCameraFrame(activeFrame);
    resize();

    let rendered = false;
    for (let attempt = 0; attempt < 240 && !rendered; attempt++) { rendered = renderer!.render(activeCamera, activeScene, 1 / 60); if (!rendered) await nextFrame(); }
    if (!rendered) throw new Error(`${label}: no renderable frame`);
    for (let index = 0; index < 8; index++) { renderer!.render(activeCamera, activeScene, 1 / 60); await nextFrame(); }

    const region = Math.max(8, Math.min(256, canvas.width, canvas.height));
    const capture = renderer!.requestLinearHdrCapture({
      x: Math.max(0, Math.floor((canvas.width - region) / 2)),
      y: Math.max(0, Math.floor((canvas.height - region) / 2)),
      width: region,
      height: region,
      stage: "lighting"
    });
    for (let index = 0; index < 4; index++) { renderer!.render(activeCamera, activeScene, 1 / 60); await nextFrame(); }
    const readback = await capture;
    let litPixels = 0;
    for (let index = 0; index + 3 < readback.rgba.length; index += 4) {
      const luminance = readback.rgba[index]! * 0.2126 + readback.rgba[index + 1]! * 0.7152 + readback.rgba[index + 2]! * 0.0722;
      if (luminance > 0.02) litPixels++;
    }

    const residency = handles.residency.evidence();
    const evidence: RunEvidence = {
      label,
      instanceCount: source.count,
      assetCount: source.assetCount,
      fingerprint: fingerprint(source),
      litPixels,
      sampledPixels: region * region,
      promotedKeys,
      catalogPrimitives: catalog.primitiveCount,
      residentPages: residency.residentPages,
      pinnedPages: residency.pinnedPages,
      cook: activeAsset.evidence()
    };
    setStatus(`${label}: ${evidence.instanceCount} instances, ${litPixels} lit pixels`);
    return { evidence, frame: activeFrame };
  } finally {
    activeControls.pointer.stop(); activeControls.keyboard.stop();
    if (handles !== undefined) { handles.admission.retireActive(); handles.admission.retireReplaced(); }
    if (renderer) await renderer.releaseVirtualGeometryScene(activeScene).catch(() => undefined);
    if (scene === activeScene) { scene = undefined; camera = undefined; controls = undefined; }
    activeAsset.dispose();
  }
}

async function runValidation(): Promise<void> {
  if (controller === undefined) return;
  try {
    controller.transition("negotiating");
    setStatus("negotiating WebGPU...");
    await ensureRenderer();
    errorCollection = attachGpuErrorCollection(renderer!.device, controller, () => intentionalDeviceTeardown);
    renderer!.profiler.configure({ enabled: true, warmupFrames: 0, gpuSampleInterval: 1, gpuCounterSampleInterval: 1, historyCapacity: 16 });

    // Run A: no priority at all, so its cut is the coverage-ranked default.
    const runA = await runOnce("run-a-no-priority", false, undefined);
    controller.transition("ready");
    controller.addEvidence("runA", runA.evidence);
    // Run B: identical camera and budgets, but the smallest primitives are
    // promoted to the top of the ranking.
    const runB = await runOnce("run-b-prioritized", true, runA.frame);
    controller.transition("warming");
    controller.addEvidence("runB", runB.evidence);
    controller.transition("sampling");

    const a = runA.evidence, b = runB.evidence;
    controller.addEvidence("comparison", {
      bootstrapUnitLimit: BOOTSTRAP_UNIT_LIMIT,
      catalogPrimitives: a.catalogPrimitives,
      promotedCount: b.promotedKeys.length,
      promotedSample: b.promotedKeys.slice(0, 4),
      fingerprintsDiffer: a.fingerprint !== b.fingerprint,
      instanceCountsEqual: a.instanceCount === b.instanceCount
    });
    metricsElement.innerHTML = [
      ["run A instances", String(a.instanceCount)],
      ["run A fingerprint", a.fingerprint],
      ["run A lit pixels", `${a.litPixels}/${a.sampledPixels}`],
      ["run B instances", String(b.instanceCount)],
      ["run B fingerprint", b.fingerprint],
      ["run B lit pixels", `${b.litPixels}/${b.sampledPixels}`]
    ].map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`).join("");

    if (a.catalogPrimitives <= BOOTSTRAP_UNIT_LIMIT) throw new Error(`Case requires a catalog larger than the bootstrap cut, got ${a.catalogPrimitives}`);
    if (a.instanceCount !== BOOTSTRAP_UNIT_LIMIT) throw new Error(`run A cut size ${a.instanceCount} does not match the expected bootstrap unit limit ${BOOTSTRAP_UNIT_LIMIT}`);
    if (b.instanceCount !== BOOTSTRAP_UNIT_LIMIT) throw new Error(`run B cut size ${b.instanceCount} does not match the expected bootstrap unit limit ${BOOTSTRAP_UNIT_LIMIT}`);
    if (a.litPixels < LIT_PIXEL_FLOOR) throw new Error(`run A shaded too few lit pixels (${a.litPixels})`);
    if (b.litPixels < LIT_PIXEL_FLOOR) throw new Error(`run B shaded too few lit pixels (${b.litPixels})`);
    if (b.promotedKeys.length !== BOOTSTRAP_UNIT_LIMIT) throw new Error(`run B promoted ${b.promotedKeys.length} primitives instead of ${BOOTSTRAP_UNIT_LIMIT}`);
    if (a.fingerprint === b.fingerprint) {
      throw new Error("The catalog-priority ranking did not change the bootstrap cut: both runs published the same instances, so the priorities never reached the cooker");
    }

    controller.transition("draining");
    await renderer!.device.queue.onSubmittedWorkDone();
    controller.pass();
  } catch (error) {
    controller.fail(error instanceof Error ? error.stack ?? error.message : String(error));
  }
}

async function disposeCase(): Promise<Record<string, unknown>> {
  intentionalDeviceTeardown = true;
  controls?.pointer.stop(); controls?.keyboard.stop(); controls = undefined;
  errorCollection?.remove(); errorCollection = undefined;
  if (renderer && scene) await renderer.releaseVirtualGeometryScene(scene).catch(() => undefined);
  scene = undefined; camera = undefined;
  renderer?.destroy();
  renderer = undefined;
  return { removedGpuErrorCollector: true };
}

if (runnerMode) void runValidation();
else setStatus("Manual mode: this case needs the validation runner to execute its two-load comparison.");

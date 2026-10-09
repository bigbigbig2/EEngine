import {
  Renderer,
  Scene,
  PerspectiveCamera,
  load_gltf,
  createDefaultWebCookWorker,
  type WebCookRuntimeAsset,
  type MultiProductSceneHandles
} from "../../../OEngine/src/index.ts";
import { ShadeTexture } from "../../../OEngine/src/texture/ShadeTexture.ts";
import { PcTexturePreparation } from "../../../OEngine/src/assets/codec/PcTexturePreparation.ts";
import {
  saveTextureProduct,
  openTextureProduct,
  textureProductHash,
  type TextureProduct
} from "../../../OEngine/src/assets/TextureProduct.ts";
import { materialTextureLeaves } from "../../../OEngine/src/assets/PcMaterialTextures.ts";
import { summarizeGpuTimingCost } from "../../../OEngine/src/debug/GpuTimingCost.ts";
import { decodeFloat16 } from "../../../OEngine/src/core/Float16.ts";
import { geometryProductGpuBudgetEvidence } from "../../../OEngine/src/gpu/GeometryProductGpuBudget.ts";
import type { TextureResidencyEvidence } from "../../../OEngine/src/gpu/TextureResidency.ts";
import { GPU_MATERIAL_VISIBILITY_SAMPLER as S } from "../../../OEngine/src/gpu/GpuMaterialVisibilityAbi.ts";
import type { SurfaceV4, NativeSurfaceFrame } from "../../../OEngine/src/render/surface/SurfaceV4.ts";
import { createValidationController, attachGpuErrorCollection } from "../../harness/browser.ts";

const frozen = {
  url: "/assets/texture-dungeon/dungeon.glb",
  bytes: 7990584,
  sha256: "cac0fc8c16d107e7ac4e69efde89c2cb6ef4bc66c34456a4dd0923218e5aafb1",
  primitives: 798,
  triangles: 72137,
  images: 25
};
const canvas = document.querySelector<HTMLCanvasElement>("#output")!;
const status = document.querySelector<HTMLPreElement>("#status")!;
let renderer: Renderer | undefined;
let scene: Scene | undefined;
let asset: WebCookRuntimeAsset | undefined;
let handles: MultiProductSceneHandles | undefined;
let errors: ReturnType<typeof attachGpuErrorCollection> | undefined;
const intentionallyDestroyedDevices = new WeakSet<GPUDevice>();
let disposed = false;
const controller = createValidationController(
  {
    caseId: "texture-compression-acceptance",
    workloadId: "texture-compression-acceptance-v1"
  },
  dispose
);
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function distribution(values: number[]) {
  check(values.length > 0 && values.every(Number.isFinite), "Missing finite samples");
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1)
  };
}
async function drained() {
  await renderer!.device.queue.onSubmittedWorkDone();
  await Promise.resolve();
  await Promise.resolve();
}
function zeroTextureOwner(ledger: TextureResidencyEvidence) {
  check(
    ledger.allocatedBytes === 0 &&
      ledger.residentTextureCount === 0 &&
      ledger.retiringTextureCount === 0 &&
      ledger.pendingTextureCount === 0 &&
      ledger.quarantinedTextureCount === 0,
    "Texture owner did not clear after fence"
  );
}
async function dispose() {
  if (!disposed) {
    if (renderer && scene) {
      await renderer.releaseScene(scene);
      await drained();
      const texture = renderer.graphics.texture_residency.evidence();
      zeroTextureOwner(texture);
      const geometry = geometryProductGpuBudgetEvidence(renderer.device);
      check(
        geometry.totalBytes === 0 && geometry.allocations === 0 && geometry.metadataAllocations === 0,
        "Geometry owner did not clear"
      );
      controller.addEvidence("teardown", { texture, geometry });
      await renderer.releaseScene(scene);
    }
    await asset?.disposeAsync();
    errors?.remove();
    if (renderer) intentionallyDestroyedDevices.add(renderer.device);
    renderer?.destroy();
    disposed = true;
  }
  return { disposed, producer: asset?.evidence() ?? null };
}
const cookResults: Array<{ metadata: TextureProduct["metadata"]; evidence: unknown; identity: string }> = [];
const products = new Map<string, TextureProduct>();
const savedProducts = new Map<string, { identity: string; hash: string; bytes: number }>();
let archiveWriteMs = 0;
// Case-owned cold-only observation. No shader changes or steady-frame instrumentation.
const cookImage = PcTexturePreparation.prototype.cookImage;
PcTexturePreparation.prototype.cookImage = async function (...args) {
  const result = await cookImage.apply(this, args);
  products.set(result.product.identity, result.product);
  cookResults.push({
    metadata: result.product.metadata,
    evidence: result.evidence,
    identity: result.product.identity
  });
  status.textContent = `Cold cook ${cookResults.length}/25 textures completed`;
  controller.addEvidence("coldProgress", cookResults);
  if (!savedProducts.has(result.product.identity)) {
    const started = performance.now();
    const bytes = await saveTextureProduct(result.product);
    const hash = await textureProductHash(new Uint8Array(bytes));
    await put(hash + ".oetex", bytes);
    savedProducts.set(result.product.identity, {
      identity: result.product.identity,
      hash,
      bytes: bytes.byteLength
    });
    archiveWriteMs += performance.now() - started;
    controller.addEvidence("coldArchive", { files: [...savedProducts.values()], ms: archiveWriteMs });
  }
  return result;
};
interface CacheRecord {
  key: string;
  identity: string;
  sampler: {
    minFilter: number;
    magFilter: number;
    mipmapFilter: number;
    wrapS: number;
    wrapT: number;
    wrapR: number;
  };
}
interface Archive {
  sourceHash: string;
  engineSourceHash: string;
  rawRunId: string;
  records: CacheRecord[];
  files: Array<{ identity: string; hash: string; bytes: number }>;
  raw: unknown;
  cooks: typeof cookResults;
}
const archiveRoot = "/texture-acceptance-archive/";
async function put(name: string, body: ArrayBuffer | string) {
  const response = await fetch(archiveRoot + name, { method: "PUT", body });
  check(response.ok, `Could not archive ${name}`);
  const receipt = (await response.json()) as { bytes: number };
  const bytes = typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength;
  check(receipt.bytes === bytes, `Incomplete archive receipt for ${name}`);
}
function observeDeviceErrors() {
  const device = renderer!.device;
  errors = attachGpuErrorCollection(device, controller, () => intentionallyDestroyedDevices.has(device));
}
const camera = new PerspectiveCamera();
function resetCamera() {
  camera.aspect = 1920 / 1080;
  camera.fov_degrees = 60;
  camera.near = 0.05;
  camera.transform.position.set(10, 7, 12);
  camera.transform.lookAt({ x: 0, y: 3, z: 0 });
  camera.update();
}
async function tick() {
  const first = renderer!.frame_count;
  for (let attempt = 0; attempt < 400; attempt++) {
    const start = performance.now();
    renderer!.render(camera, scene!, 1 / 60);
    const cpuMs = performance.now() - start;
    const wait = performance.now();
    await renderer!.device.queue.onSubmittedWorkDone();
    const completionWaitMs = performance.now() - wait;
    if (renderer!.frame_count !== first) return { cpuMs, completionWaitMs };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Published authored scene never became renderable");
}
let prepared: NativeSurfaceFrame | undefined;
let inspection = false;
let capture: GPUBuffer | undefined;
let winners: GPUBuffer | undefined;
function observeSurface() {
  const surface = Reflect.get(renderer!, "_surface") as SurfaceV4;
  const prepare = surface.prepareFrameNow.bind(surface);
  surface.prepareFrameNow = (frame, bins) => {
    prepared = frame;
    prepare(frame, bins);
  };
  const encode = surface.encode.bind(surface);
  surface.encode = (encoder) => {
    encode(encoder);
    if (!inspection) return;
    check(prepared?.output, "Missing production HDR");
    capture = renderer!.device.createBuffer({
      size: Math.ceil((prepared.width * 8) / 256) * 256 * prepared.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    winners = renderer!.device.createBuffer({
      size: Math.ceil((prepared.width * 4) / 256) * 256 * prepared.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    encoder.copyTextureToBuffer(
      { texture: prepared.output },
      { buffer: capture, bytesPerRow: Math.ceil((prepared.width * 8) / 256) * 256 },
      [prepared.width, prepared.height]
    );
    encoder.copyTextureToBuffer(
      { texture: prepared.visibility },
      { buffer: winners, bytesPerRow: Math.ceil((prepared.width * 4) / 256) * 256 },
      [prepared.width, prepared.height]
    );
  };
}
async function inspect() {
  inspection = true;
  await tick();
  inspection = false;
  check(capture && winners && prepared, "No production capture");
  await Promise.all([capture.mapAsync(GPUMapMode.READ), winners.mapAsync(GPUMapMode.READ)]);
  const colors = new Uint16Array(capture.getMappedRange());
  const keys = new Uint32Array(winners.getMappedRange());
  const colorStride = Math.ceil((prepared.width * 8) / 256) * 128;
  const keyStride = Math.ceil((prepared.width * 4) / 256) * 64;
  let visible = 0,
    nonzero = 0;
  let sum = 0;
  for (let y = 0; y < prepared.height; y++) {
    for (let x = 0; x < prepared.width; x++) {
      if (keys[y * keyStride + x] !== 0xffffffff) visible++;
      for (let c = 0; c < 3; c++) {
        const value = decodeFloat16(colors[y * colorStride + x * 4 + c]!);
        check(Number.isFinite(value), "Nonfinite authored HDR");
        if (value > 0) nonzero++;
        sum += value;
      }
    }
  }
  capture.unmap();
  capture.destroy();
  capture = undefined;
  winners.unmap();
  winners.destroy();
  winners = undefined;
  check(visible > 0 && nonzero > 0, "Empty authored surface");
  return { width: prepared.width, height: prepared.height, visible, nonzero, hdrSum: sum };
}
async function costs() {
  const profiler = renderer!.profiler;
  profiler.configure({ enabled: false, gpuTimingMode: "production" });
  renderer!.perf_gpu_counters_enabled = false;
  for (let i = 0; i < 30; i++) await tick();
  const normal = [];
  for (let i = 0; i < 120; i++) normal.push(await tick());
  profiler.setMode("record");
  profiler.configure({
    enabled: true,
    warmupFrames: 0,
    gpuTimingMode: "full",
    gpuSampleInterval: 1,
    gpuCounterSampleInterval: 1,
    historyCapacity: 512
  });
  renderer!.perf_gpu_counters_enabled = true;
  for (let i = 0; i < 30; i++) await tick();
  profiler.configure({ gpuTimingMode: "full" });
  const first = renderer!.frame_count;
  const full = [];
  for (let i = 0; i < 120; i++) full.push(await tick());
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      profiler.history.filter(
        (p) => p.frameIndex >= first && p.frameIndex < first + 120 && p.gpu.sampled && !p.gpu.pending
      ).length === 120
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const profiles = profiler.history.filter((p) => p.frameIndex >= first && p.frameIndex < first + 120);
  check(
    profiles.length === 120 &&
      profiles.every(
        (p) =>
          p.gpu.sampled &&
          !p.gpu.pending &&
          p.gpu.mode === "full" &&
          !p.counters["gpu.timing.truncated"] &&
          p.submits.count === 1
      ),
    "Incomplete full GPU timing or extra frame submit"
  );
  const measured = profiles.map((p) => summarizeGpuTimingCost(p.gpu.segments));
  const stages = Object.keys(measured[0]!.stageMs);
  check(
    measured.every((p) => p.commandSpanMs !== null && p.surfacePassSumMs !== null),
    "No GPU frame/Surface cost"
  );
  return {
    normalCpuMs: distribution(normal.map((p) => p.cpuMs)),
    profilingCpuMs: distribution(full.map((p) => p.cpuMs)),
    completionWaitMs: distribution(normal.map((p) => p.completionWaitMs)),
    gpuFrameMs: distribution(measured.map((p) => p.commandSpanMs!)),
    surfaceMs: distribution(measured.map((p) => p.surfacePassSumMs!)),
    stagesMs: Object.fromEntries(
      stages.map((label) => [label, distribution(measured.map((p) => p.stageMs[label]!))])
    ),
    normalSamples: normal,
    profilingSamples: full,
    gpuSamples: measured,
    gpuCounters: profiles.map((p) => p.gpuCounters),
    frameSubmits: profiles.map((p) => p.submits.count),
    output: await inspect()
  };
}
async function initialize() {
  renderer = new Renderer({ autoExposure: false, fixedExposure: 1, requiredFeatures: ["timestamp-query"] });
  await renderer.initialize({ context: canvas.getContext("webgpu")! });
  renderer.resize(1920, 1080);
  observeDeviceErrors();
  controller.addEvidence("capability", renderer.capabilities);
  scene = new Scene();
  resetCamera();
  observeSurface();
}
async function load(cache: Map<string, Promise<ShadeTexture>>) {
  const start = performance.now();
  asset = load_gltf(`${location.origin}${frozen.url}`, {
    worker: createDefaultWebCookWorker({
      maxCanonicalInputBytes: 128 * 1024 ** 2,
      maxDecodedProductBytes: 256 * 1024 ** 2
    }),
    bootstrap: { unitCount: 1024, maxSourceBytes: 128 * 1024 ** 2 }
  });
  const publication: unknown[] = [];
  handles = await renderer!.uploadWebCookedMultiProductScene(scene!, asset, {
    fitHeight: 8,
    fitBase: [0, 0, 0],
    stream: true,
    residency: { configuredCapacityBytes: 512 * 1024 ** 2 },
    textureCache: cache,
    onProductPublicationTiming: (p) => publication.push(p)
  });
  await handles.settled();
  const settledMs = performance.now() - start;
  const catalog = asset.catalog;
  check(
    catalog &&
      catalog.primitives.length === 798 &&
      catalog.images.length === 25 &&
      catalog.textures.length === 25,
    "Full authored catalog missing"
  );
  const completed = asset.evidence().productTaskTrace.filter((p) => p.kind === "completed");
  const covered = new Map<number, number>();
  const shards = new Map<number, Set<number>>();
  for (const { task } of completed) {
    if (task.spatial) {
      check(
        task.sceneAssetIndices.length === 1 && task.shardOrdinal !== undefined && task.shardCount,
        "Missing shard identity"
      );
      const index = task.sceneAssetIndices[0]!;
      const set = shards.get(index) ?? new Set<number>();
      check(!set.has(task.shardOrdinal), "Duplicate shard");
      set.add(task.shardOrdinal);
      shards.set(index, set);
      covered.set(index, (covered.get(index) ?? 0) + task.triangles);
    } else {
      for (const index of task.sceneAssetIndices) {
        check(!covered.has(index), "Duplicate primitive");
        covered.set(index, catalog.primitives[index]!.triangleCount);
      }
    }
  }
  check(
    covered.size === 798 &&
      [...covered.values()].reduce((a, b) => a + b, 0) === 72137 &&
      catalog.primitives.every((p) => covered.get(p.catalogIndex) === p.triangleCount),
    "Incomplete source triangle union"
  );
  for (const { task } of completed.filter((p) => p.task.spatial)) {
    check(shards.get(task.sceneAssetIndices[0]!)!.size === task.shardCount, "Missing planned shard");
  }
  check(
    handles.runtime.evidence().active === completed.length &&
      handles.current().shardCount === completed.length,
    "Not all Products active"
  );
  const runtime = renderer!.graphics.render_world.runtime(scene!)!;
  check(
    runtime.instanceCount === catalog.primitives.reduce((sum, p) => sum + p.instanceNodeIndices.length, 0) &&
      runtime.materials.length === 25,
    "Incomplete instance/material publication"
  );
  const tail = renderer!.graphics.texture_residency.evidence();
  const leaves = [...new Set(runtime.materials.flatMap((m) => [...materialTextureLeaves(m)]))];
  const uniqueTextureProducts = new Set(leaves.map((t) => t.texture_product?.identity)).size;
  check(
    leaves.length === 25 &&
      uniqueTextureProducts === 24 &&
      tail.residentTextureCount === uniqueTextureProducts,
    "Incomplete authored routes or incorrect content deduplication"
  );
  await tick();
  const firstUsefulFrameMs = performance.now() - start;
  await tick();
  const fullQualityMs = performance.now() - start;
  check(
    leaves.length === 25 &&
      leaves.every(
        (t) =>
          t.texture_product?.metadata.sourceWidth === 2048 && t.texture_product.metadata.sourceHeight === 2048
      ),
    "Authored resolution/product changed"
  );
  const full = renderer!.graphics.texture_residency.evidence();
  check(
    full.uploadBytes >= full.residentTextureBytes && full.mipPromotionCount > 0,
    "Production never uploaded the full mip chain"
  );
  // Actual native constants must consume the live promoted minimum, not just upload the bytes.
  const native = runtime.nativeMaterials!;
  let checkedSamplers = 0;
  for (const binding of native.bindings) {
    for (const match of binding.program.source.matchAll(
      /reference, u32\(native_material_constant\(material_base, (\d+)u\)\)/gu
    )) {
      const value = binding.program.constants[Number(match[1])]!;
      check(
        (value & S.MipMask) >>> S.MipShift === S.FullMipCode,
        "Native consumer still clamps to coarse mip"
      );
      checkedSamplers++;
    }
  }
  check(checkedSamplers >= 25, "Missing native mip clamp observations");
  return {
    settledMs,
    firstUsefulFrameMs,
    fullQualityMs,
    readinessPolicy: "Complete geometry settlement before first submitted frame",
    products: completed.length,
    instances: runtime.instanceCount,
    triangles: 72137,
    primitives: 798,
    authoredTextureCount: leaves.length,
    uniqueTextureProducts,
    diagnosticArchiveWriteMs: archiveWriteMs,
    catalog,
    publication,
    tail,
    full,
    memory: renderer!.memoryEvidence(),
    resourceLedger: renderer!.graphics.resource_accounting.snapshot(),
    geometry: geometryProductGpuBudgetEvidence(renderer!.device),
    textureProducts: leaves.map((t) => ({
      identity: t.texture_product!.identity,
      metadata: t.texture_product!.metadata,
      evidence: t.texture_product!.evidence
    })),
    streaming: renderer!.geometryStreamingEvidence(scene!),
    producer: asset.evidence(),
    frames: await costs()
  };
}
async function releaseRun() {
  await handles!.release();
  await drained();
  zeroTextureOwner(renderer!.graphics.texture_residency.evidence());
  const geometry = geometryProductGpuBudgetEvidence(renderer!.device);
  check(
    geometry.totalBytes === 0 && geometry.allocations === 0 && geometry.metadataAllocations === 0,
    "Run retained Geometry allocations"
  );
  await asset!.disposeAsync();
  errors!.remove();
  intentionallyDestroyedDevices.add(renderer!.device);
  renderer!.destroy();
  renderer = undefined;
  scene = undefined;
  asset = undefined;
  handles = undefined;
}
async function run() {
  try {
    controller.transition("negotiating");
    const response = await fetch(frozen.url);
    const source = await response.arrayBuffer();
    check(
      response.ok &&
        source.byteLength === frozen.bytes &&
        (await textureProductHash(new Uint8Array(source))) === frozen.sha256,
      "Frozen dungeon source unavailable"
    );
    controller.addEvidence("source", frozen);
    const engineSourceHash =
      new URLSearchParams(location.search).get("engineSourceSha256") ?? "see-runner-identity";
    controller.transition("ready");
    controller.transition("warming");
    controller.transition("sampling");
    let archive: Archive;
    const saved = await fetch(archiveRoot + "manifest.json");
    check(saved.ok, "Archive access failed");
    const existingArchive = (await saved.json()) as Archive | null;
    if (existingArchive) {
      archive = existingArchive;
      check(archive.sourceHash === frozen.sha256, "Cook archive belongs to another authored source");
      controller.addEvidence("rawEvidencePolicy", {
        reused: true,
        rawRunId: archive.rawRunId,
        engineSourceHash: archive.engineSourceHash,
        note: "Archived real cold path; not a fresh cold timing in this run"
      });
      // Exercise the repaired browser PUT completion without recooking the scene.
      await put("manifest.json", JSON.stringify(archive));
      controller.addEvidence("archiveReceipt", { manifestWriteVerified: true });
    } else {
      await initialize();
      const cache = new Map<string, Promise<ShadeTexture>>();
      const raw = await load(cache);
      controller.addEvidence("raw", raw);
      check(cookResults.length === 25 && products.size === 24, "Unexpected cold cook product count");
      const records: CacheRecord[] = [];
      for (const [key, pending] of cache) {
        const texture = await pending;
        const hash = await textureProductHash(new Uint8Array(texture.image!.source as ArrayBuffer));
        const usage = (JSON.parse(key) as unknown[])[5];
        const semantic =
          usage === "srgb" ? "base-color-srgb" : usage === "normal" ? "normal-linear" : "orm-linear";
        const product = [...products.values()].find(
          (p) => p.metadata.sourceHash === hash && p.metadata.semantic === semantic
        );
        check(product, "Cold Product cannot be mapped back to authored source/semantic");
        records.push({
          key,
          identity: product.identity,
          sampler: {
            minFilter: texture.minFilter,
            magFilter: texture.magFilter,
            mipmapFilter: texture.mipmapFilter,
            wrapS: texture.wrapS,
            wrapT: texture.wrapT,
            wrapR: texture.wrapR
          }
        });
      }
      const files = [...savedProducts.values()];
      const saveStart = performance.now();
      archive = {
        sourceHash: frozen.sha256,
        engineSourceHash,
        rawRunId: controller.snapshot.runId,
        records,
        files,
        raw,
        cooks: cookResults
      };
      await put("manifest.json", JSON.stringify(archive));
      controller.addEvidence("archiveWrite", {
        ms: performance.now() - saveStart,
        perJobMsIncludedInRawLoad: archiveWriteMs,
        files
      });
      cache.clear();
      products.clear();
      await releaseRun();
    }
    controller.addEvidence("raw", archive.raw);
    controller.addEvidence("coldCook", archive.cooks);
    const cookedStart = performance.now();
    const opened = new Map<string, TextureProduct>();
    let parseMs = 0;
    for (const file of archive.files) {
      const r = await fetch(archiveRoot + file.hash + ".oetex");
      check(r.ok, "Persisted Product missing");
      const bytes = await r.arrayBuffer();
      check(
        bytes.byteLength === file.bytes && (await textureProductHash(new Uint8Array(bytes))) === file.hash,
        "Persisted archive bytes changed"
      );
      const start = performance.now();
      const product = await openTextureProduct(bytes);
      parseMs += performance.now() - start;
      check(product.identity === file.identity, "Reopened Product identity changed");
      opened.set(product.identity, product);
    }
    const cache = new Map<string, Promise<ShadeTexture>>();
    for (const record of archive.records) {
      const product = opened.get(record.identity);
      check(product, "Cooked cache source missing");
      const texture = ShadeTexture.fromProduct(product);
      Object.assign(texture, record.sampler);
      cache.set(record.key, Promise.resolve(texture));
    }
    const callsBefore = cookResults.length;
    const packageReadParseMs = performance.now() - cookedStart;
    const initializeStart = performance.now();
    await initialize();
    const rendererInitializeMs = performance.now() - initializeStart;
    status.textContent = "Cooked direct: complete authored publication and stable frame samples";
    const loadOriginMs = performance.now() - cookedStart;
    const cooked = await load(cache);
    check(cookResults.length === callsBefore, "Cooked load unexpectedly started texture decode/encode");
    const mapping = cooked.publication as Array<{
      mapping: {
        textureCacheHits: number;
        textureCacheMisses: number;
        imageReadMs: number;
        imageDecodeMs: number;
      };
    }>;
    check(
      mapping.length > 0 &&
        mapping.reduce((sum, p) => sum + p.mapping.textureCacheHits, 0) >= 25 &&
        mapping.every(
          (p) =>
            p.mapping.textureCacheMisses === 0 && p.mapping.imageReadMs === 0 && p.mapping.imageDecodeMs === 0
        ),
      "Cooked publication unexpectedly read or decoded authored images"
    );
    controller.addEvidence("cooked", {
      ...cooked,
      packageBytes: archive.files.reduce((sum, f) => sum + f.bytes, 0),
      packageReadParseMs,
      parseMs,
      rendererInitializeMs,
      endToEndFirstUsefulFrameMs: loadOriginMs + cooked.firstUsefulFrameMs,
      endToEndFullQualityMs: loadOriginMs + cooked.fullQualityMs,
      textureColdTasks: 0,
      textureTranscodeMs: 0,
      runtimeMipGeneration: 0
    });
    check(
      cooked.frames.output.visible === (archive.raw as typeof cooked).frames.output.visible &&
        cooked.frames.output.hdrSum === (archive.raw as typeof cooked).frames.output.hdrSum,
      "Raw/cooked Geometry winner coverage or HDR differs"
    );
    for (let i = 0; i < 20; i++) {
      camera.transform.position.set(10 + Math.sin(i * 0.3) * 3, 7, 12);
      camera.transform.lookAt({ x: 0, y: 3, z: 0 });
      camera.update();
      await tick();
    }
    renderer!.resize(1280, 720);
    camera.aspect = 1280 / 720;
    camera.update();
    const resized = await inspect();
    renderer!.resize(1920, 1080);
    resetCamera();
    const restored = await inspect();
    controller.addEvidence("resizeMotion", { motionFrames: 20, resized, restored });
    const oldOwner = renderer!.graphics.texture_residency;
    const oldDevice = renderer!.device;
    await drained();
    intentionallyDestroyedDevices.add(oldDevice);
    oldDevice.destroy();
    check((await errors!.lost).reason === "destroyed", "Unexpected device loss reason");
    errors!.remove();
    renderer = await renderer!.recoverAfterDeviceLoss();
    zeroTextureOwner(oldOwner.evidence());
    const oldGeometry = geometryProductGpuBudgetEvidence(oldDevice);
    check(
      oldGeometry.totalBytes === 0 && oldGeometry.allocations === 0 && oldGeometry.metadataAllocations === 0,
      "Lost epoch retained Geometry"
    );
    observeDeviceErrors();
    observeSurface();
    for (let i = 0; i < 8; i++) await tick();
    check(
      cookResults.length === callsBefore &&
        renderer.graphics.texture_residency.evidence().residentTextureCount ===
          cooked.uniqueTextureProducts &&
        renderer.geometryStreamingError() === null &&
        renderer.geometryStreamingEvidence(scene!)?.products.length === cooked.products,
      "Recovery lost authored Products or recooked textures"
    );
    controller.addEvidence("recovery", {
      output: await inspect(),
      texture: renderer.graphics.texture_residency.evidence(),
      oldTexture: oldOwner.evidence(),
      oldGeometry,
      epoch: Reflect.get(renderer, "deviceEpoch"),
      limitation: "Controlled device destruction, not native driver fault"
    });
    controller.addEvidence("readback", {
      matches: true,
      raw: (archive.raw as typeof cooked).frames.output,
      cooked: cooked.frames.output,
      recovery: "finite/nonempty HDR and Geometry winners"
    });
    controller.transition("draining");
    // Runner screenshots the live recovered output, then calls the real fenced teardown.
    controller.pass();
    status.textContent = "Complete dungeon BC acceptance passed";
  } catch (error) {
    controller.fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
}
void run();

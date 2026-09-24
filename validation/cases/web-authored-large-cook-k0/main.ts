import { createDefaultWebCookWorker, load_gltf, type WebCookRuntimeAsset } from "../../../OEngine/src/index.ts";
import { assertGeometryProductDescriptorV1, GEOMETRY_PRODUCT_PAGE_RECORD_STRIDE } from "../../../OEngine/src/assets/geometry-product/GeometryProductV1.ts";
import { createValidationController } from "../../harness/browser.ts";

const MiB = 1024 * 1024;
const source = { url: "/assets/web-authored-large/large.glb", bytes: 477_591_060, triangles: 4_871_612, primitives: 1_920,
  sha256: "54b608872aec11ce07b26fad6c0ad14a662314e6480bf8d833e5088b59c9851f" };
const status = document.querySelector<HTMLElement>("#status")!;
let asset: WebCookRuntimeAsset | undefined;
let cleanup: Readonly<Record<string, number>> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let lastActivity = performance.now();
let settled = false;
const controller = createValidationController({ caseId: "web-authored-large-cook-k0", workloadId: "web-authored-large-cook-k0-v1" }, async () => {
  if (timer !== undefined) clearInterval(timer);
  if (asset?.state === "open" && settled && cleanup === undefined) cleanup = await asset.disposeAsync();
  else asset?.dispose();
  return { disposed: asset === undefined || asset.state === "disposed", settled, cleanup: cleanup ?? null, client: asset?.evidence() ?? null };
});
void run();

async function run(): Promise<void> {
  try {
    controller.transition("negotiating");
    const mounted = await fetch(source.url, { headers: { Range: "bytes=0-11" }, cache: "no-store" });
    const header = await mounted.arrayBuffer();
    if (mounted.status !== 206 || mounted.headers.get("content-range") !== `bytes 0-11/${source.bytes}` || header.byteLength !== 12 || new DataView(header).getUint32(8, true) !== source.bytes) throw new Error("Frozen authored source is unavailable or has incorrect length");
    if (mounted.headers.get("x-source-sha256") !== source.sha256) throw new Error("Mounted source hash differs from the frozen authored workload");
    controller.addEvidence("source", { ...source, verification: "host-streamed-sha256" });
    controller.addEvidence("storageBefore", await navigator.storage.estimate());
    const started = performance.now();
    let firstActivationMs: number | undefined;
    let terminalMetrics: Readonly<Record<string, number>> | undefined;
    asset = load_gltf(source.url, {
      worker: createDefaultWebCookWorker({ runtimeProfile: "portable-single", maxSourceWindowBytes: 64 * MiB, maxCanonicalInputBytes: 32 * MiB,
        maxDecodedProductBytes: 128 * MiB, maxSessionSpillBytes: 1024 * MiB, maxTrianglesPerProduct: 131072, maxVerticesPerProduct: 524288, maxDomainsPerProduct: 64 }),
      runtimeProfile: "portable-single", sessionId: `authored-k0-${crypto.randomUUID()}`, sessionGeneration: 1,
      budgets: { maxConcurrentWorkers: 1, maxSourceBytes: 128 * MiB, maxWasmBytes: 512 * MiB, maxOutputBytes: 128 * MiB, maxQueuedEvents: 2048 },
      initialOutputPageCredits: 128, maxBufferedPages: 128, maxBufferedBytes: 32 * MiB,
      onProgress: progress => {
        controller.addEvidence("progress", progress);
        if (progress.stage === "cook-complete") terminalMetrics = progress.timings;
      },
      onProductTaskTrace: trace => {
        lastActivity = performance.now();
        controller.addEvidence("currentTask", trace);
        if (trace.kind === "completed") console.info(`[k0] ${trace.task.taskId} completed ${Math.round(trace.elapsedMs ?? 0)}ms`);
      }
    });
    timer = setInterval(() => { if (performance.now() - lastActivity > 120_000) asset?.cancel("K0 producer/page watchdog exceeded 120 seconds"); }, 5000);
    const products: Array<{ id: string; mapping: readonly number[]; pages: number }> = [];
    const identities = new Set<string>();
    let readPages = 0;
    for await (const revision of asset.revisions()) {
      const descriptor = revision.descriptor;
      assertGeometryProductDescriptorV1(descriptor);
      const id = hex(descriptor.productId);
      if (identities.has(id)) throw new Error(`Duplicate Product identity ${id}`);
      identities.add(id);
      const pages = descriptor.pageRecords.byteLength / GEOMETRY_PRODUCT_PAGE_RECORD_STRIDE;
      const mapping = revision.sceneAssetIndices;
      if (!mapping?.length) throw new Error("Product lacks catalog mapping");
      const activation = new Set(descriptor.activationPageIds);
      const order = [...activation, ...Array.from({ length: pages }, (_, i) => i).filter(i => !activation.has(i))];
      for (const pageId of order) {
        const first = await revision.readPage(pageId);
        const firstDigest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", first.bytes)));
        if (firstDigest.slice(0, 32) !== hex(first.decodedPageHash128)) throw new Error(`Page checksum mismatch ${id}/${pageId}`);
        const repeated = await revision.readPage(pageId);
        const repeatedDigest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", repeated.bytes)));
        if (firstDigest !== repeatedDigest || repeatedDigest.slice(0, 32) !== hex(repeated.decodedPageHash128)) throw new Error(`Page reread mismatch ${id}/${pageId}`);
        readPages++;
        activation.delete(pageId);
        if (firstActivationMs === undefined && activation.size === 0) firstActivationMs = performance.now() - started;
        lastActivity = performance.now();
      }
      products.push({ id, mapping, pages });
      revision.release();
      status.textContent = `${products.length} Products, ${readPages} pages verified twice`;
    }
    if (!terminalMetrics || !asset.catalog || asset.catalog.primitiveCount !== source.primitives) throw new Error("Missing full producer settlement/catalog");
    const events = asset.evidence().productTaskTrace;
    const began = events.filter(e => e.kind === "task-started"), completed = events.filter(e => e.kind === "completed");
    if (began.length !== products.length || completed.length !== products.length || events.some(e => e.kind === "failed" || e.kind === "cancelled")) throw new Error("Product task terminal coverage is incomplete");
    const ids = new Set(began.map(e => e.task.taskId));
    if (ids.size !== products.length || new Set(completed.map(e => e.task.taskId)).size !== ids.size) throw new Error("Duplicate task terminal");
    const triangles = new Map<number, number>();
    const shardOrdinals = new Map<number, Set<number>>();
    for (let i = 0; i < completed.length; i++) {
      const event = completed[i]!, task = event.task;
      if (!ids.has(task.taskId) || JSON.stringify(task.sceneAssetIndices) !== JSON.stringify(products[i]!.mapping) || event.metrics.pageCount !== products[i]!.pages) throw new Error(`Task/Product mismatch ${task.taskId}`);
      for (const phase of ["canonicalize", "wasm-plan", "spill", "publish"] as const) {
        const starts = events.filter(e => e.task.taskId === task.taskId && e.phase === phase && e.kind === "phase-started");
        const ends = events.filter(e => e.task.taskId === task.taskId && e.phase === phase && e.kind === "phase-completed");
        if (starts.length !== 1 || ends.length !== 1 || ends[0]!.endedAt! < starts[0]!.startedAt) throw new Error(`Incomplete phase ${task.taskId}/${phase}`);
      }
      if (task.triangles > task.limits.maxTriangles || task.vertices > task.limits.maxVertices || task.domains > task.limits.maxDomains || task.canonicalBytes > task.limits.maxCanonicalBytes) throw new Error(`Work limit exceeded ${task.taskId}`);
      if (task.spatial) {
        const index = task.sceneAssetIndices[0]!;
        const ordinals = shardOrdinals.get(index) ?? new Set<number>();
        if (task.sceneAssetIndices.length !== 1 || task.shardOrdinal === undefined || !task.shardCount || task.shardOrdinal >= task.shardCount || ordinals.has(task.shardOrdinal)) throw new Error(`Invalid shard ${task.taskId}`);
        ordinals.add(task.shardOrdinal); shardOrdinals.set(index, ordinals);
        triangles.set(index, (triangles.get(index) ?? 0) + task.triangles);
      } else {
        let expected = 0;
        for (const index of task.sceneAssetIndices) {
          if (triangles.has(index) || !asset.catalog.primitives[index]) throw new Error(`Duplicate/invalid ordinary primitive ${index}`);
          const count = asset.catalog.primitives[index]!.triangleCount;
          triangles.set(index, count); expected += count;
        }
        if (expected !== task.triangles) throw new Error(`Ordinary triangle coverage mismatch ${task.taskId}`);
      }
    }
    for (const event of completed.filter(e => e.task.spatial)) if (shardOrdinals.get(event.task.sceneAssetIndices[0]!)!.size !== event.task.shardCount) throw new Error(`Missing planned shard ${event.task.taskId}`);
    for (const primitive of asset.catalog.primitives) if (triangles.get(primitive.catalogIndex) !== primitive.triangleCount) throw new Error(`Incomplete triangle coverage ${primitive.catalogIndex}`);
    if (triangles.size !== source.primitives || [...triangles.values()].reduce((a, b) => a + b, 0) !== source.triangles) throw new Error("Frozen authored triangle coverage mismatch");
    for (const [peak, limit] of [["peakSourceWindowBytes", "maxSourceWindowBytes"], ["peakCanonicalWindowBytes", "maxCanonicalWindowBytes"], ["spatialScratchPeakBytes", "spatialScratchCapacityBytes"], ["spillPeakBytes", "spillLimitBytes"]]) {
      if (!(terminalMetrics[limit!]! > 0) || !(terminalMetrics[peak!]! <= terminalMetrics[limit!]!)) throw new Error(`Invalid owner budget ${peak}`);
    }
    if (!(terminalMetrics.wasmMemoryBytes! <= 512 * MiB)) throw new Error("WASM memory exceeds declared session cap");
    settled = true;
    clearInterval(timer); timer = undefined;
    controller.addEvidence("k0", { settled, products, taskTrace: events, coveredPrimitives: triangles.size, triangles: source.triangles,
      verifiedPages: readPages, rereadPages: readPages, firstActivationMs, totalElapsedMs: performance.now() - started, ownerMetrics: terminalMetrics,
      slowestProductMs: Math.max(...completed.map(e => e.elapsedMs ?? 0)), slowestWasmPlanMs: Math.max(...completed.map(e => e.metrics.wasmPlanMs)) });
    cleanup = await asset.disposeAsync();
    if (cleanup.spillCurrentBytes !== 0 || cleanup.spillOwnerCount !== 0 || asset.evidence().provider.bufferedBytes !== 0) throw new Error("Producer disposal retained ownership");
    controller.addEvidence("cleanup", cleanup);
    controller.transition("ready"); controller.transition("warming"); controller.transition("sampling"); controller.transition("draining"); controller.pass();
    status.textContent = `Passed: ${products.length} Products, ${source.primitives} primitives, ${readPages} pages reread and disposed`;
  } catch (error) {
    if (timer !== undefined) clearInterval(timer);
    controller.addEvidence("failedClient", asset?.evidence() ?? null);
    controller.fail(error instanceof Error ? error.stack ?? error.message : String(error));
  }
}
function hex(bytes: Uint8Array): string { return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join(""); }

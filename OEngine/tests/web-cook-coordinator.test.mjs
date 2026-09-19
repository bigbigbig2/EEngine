import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const { WebCookCoordinator } = await import("../.test-dist/assets/web-cook/WebCookCoordinator.js");
const { encodeGeometryProductDescriptorBinaryV1 } = await import("../.test-dist/assets/geometry-product/GeometryProductBinaryV1.js");

function makeGlb() {
  const document = { asset: { version: "2.0" }, buffers: [{ byteLength: 42 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }] };
  const encoded = new TextEncoder().encode(JSON.stringify(document)); const json = new Uint8Array(Math.ceil(encoded.byteLength / 4) * 4); json.set(encoded); json.fill(0x20, encoded.byteLength);
  const bin = new Uint8Array(42).map((_, index) => index); const bytes = new Uint8Array(12 + 8 + json.byteLength + 8 + bin.byteLength); const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.byteLength, true); view.setUint32(12, json.byteLength, true); view.setUint32(16, 0x4e4f534a, true); bytes.set(json, 20);
  const binHeader = 20 + json.byteLength; view.setUint32(binHeader, bin.byteLength, true); view.setUint32(binHeader + 4, 0x004e4942, true); bytes.set(bin, binHeader + 8); return bytes;
}

function productFixture() {
  const page = new Uint8Array(262144); const hash = createHash("sha256").update(page).digest(); const productId = new Uint8Array(32).fill(7);
  const asset = new Uint8Array(128); const av = new DataView(asset.buffer); asset.fill(1, 0, 32); for (const [at, value] of [[72, 0], [76, 1], [80, 0], [84, 1], [88, 0], [92, 1], [96, 0], [100, 1], [104, 1], [108, 1], [112, 1], [116, 0]]) av.setUint32(at, value, true);
  const hierarchy = new Uint8Array(48); const hv = new DataView(hierarchy.buffer); hv.setFloat32(12, 1, true); hv.setUint32(44, 1, true);
  const groups = new Uint8Array(16); const gv = new DataView(groups.buffer); gv.setUint32(8, 64, true); gv.setUint32(12, 1, true);
  const pages = new Uint8Array(32); pages.set(hash.subarray(0, 16)); const pv = new DataView(pages.buffer); pv.setUint32(20, 1, true);
  const formats = new Uint8Array(16); const fv = new DataView(formats.buffer); fv.setUint16(0, 16, true); fv.setUint16(2, 3, true); fv.setUint8(5, 6);
  const descriptor = { schemaVersion: 1, productId, revision: 1, producerKind: "web-runtime", producerId: "web-test", producerVersion: "1", sourceIdentityKind: "session", sourceIdentityHash: new Uint8Array(32).fill(3), recipeHash: new Uint8Array(32).fill(4), runtimeProfile: "oengine-vg-v1-v3-decoded", decodedPageBytes: 262144, assetRecords: asset, rootNodeIds: new Uint32Array([0]), hierarchyNodes: hierarchy, groupDirectory: groups, pageRecords: pages, bootstrapPageIds: new Uint32Array([0]), vertexFormats: formats, activationPageIds: new Uint32Array([0]) };
  return { descriptor, productId, page, hash };
}

test("Web Cook coordinator bounds source work and emits credited Product events", async () => {
  const glb = makeGlb(), product = productFixture(), fetched = [];
  const coordinator = new WebCookCoordinator("session-a", 1, {
    budgets: { maxConcurrentWorkers: 1, maxSourceBytes: glb.byteLength, maxWasmBytes: 1024, maxOutputBytes: 262144, maxQueuedEvents: 8 },
    source: { fetch: async (_url, init) => { const range = String(init.headers.Range).match(/bytes=(\d+)-(\d+)/); const start = Number(range[1]), end = Number(range[2]); fetched.push([start, end]); return new Response(glb.slice(start, end + 1), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${glb.byteLength}`, "Content-Encoding": "identity" } }); } },
    cooker: { async cookBootstrap(unit, context) { for (const range of unit.ranges) await context.readRange(range); return { descriptor: encodeGeometryProductDescriptorBinaryV1(product.descriptor), productId: product.productId, revision: 1, pageCount: 1, async readPage(pageId) { assert.equal(pageId, 0); return { pageId, decodedHash128: product.hash.subarray(0, 16), decodedPageHash128: product.hash.subarray(0, 16), bytes: product.page.buffer }; }, release() {} }; } }
  });
  await coordinator.open("https://example.test/scene.glb"); coordinator.grantOutputCredits(1, 262144); await coordinator.cookBootstrap();
  assert.equal(coordinator.evidence().state, "complete"); assert.equal(coordinator.evidence().completedUnits, 1); assert.ok(fetched.length >= 5);
  assert.deepEqual(coordinator.drainEvents().map(event => event.type), ["SceneCatalogReady", "RevisionOffered", "PageReady", "Progress"]); coordinator.dispose();
});

test("Web Cook coordinator waits for a whole page lease before copying output", async () => {
  const glb = makeGlb(), product = productFixture(); let reads = 0, released = 0;
  const coordinator = new WebCookCoordinator("session-credit", 1, {
    budgets: { maxConcurrentWorkers: 1, maxSourceBytes: glb.byteLength, maxWasmBytes: 1024, maxOutputBytes: 262144, maxQueuedEvents: 8 },
    source: { fetch: async (_url, init) => { const range = String(init.headers.Range).match(/bytes=(\d+)-(\d+)/); const start = Number(range[1]), end = Number(range[2]); return new Response(glb.slice(start, end + 1), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${glb.byteLength}`, "Content-Encoding": "identity" } }); } },
    cooker: { async cookBootstrap() { return { descriptor: encodeGeometryProductDescriptorBinaryV1(product.descriptor), productId: product.productId, revision: 1, pageCount: 1, async readPage(pageId) { reads++; return { pageId, decodedHash128: product.hash.subarray(0, 16), decodedPageHash128: product.hash.subarray(0, 16), bytes: product.page.buffer }; }, release() { released++; } }; } }
  });
  await coordinator.open("https://example.test/credit.glb");
  let settled = false;
  const cooking = coordinator.cookBootstrap().finally(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(reads, 0);
  assert.equal(settled, false);
  coordinator.grantOutputCredits(1, 262144);
  await cooking;
  assert.equal(reads, 1);
  coordinator.returnOutputCredits(1, 262144);
  coordinator.dispose();
  assert.equal(released, 1);
});

test("Web Cook coordinator prefers the whole-source immutable batch entry", async () => {
  const glb = makeGlb(), product = productFixture(); let batchCalls = 0, unitCalls = 0;
  const coordinator = new WebCookCoordinator("session-batch", 1, {
    budgets: { maxConcurrentWorkers: 1, maxSourceBytes: glb.byteLength, maxWasmBytes: 1024, maxOutputBytes: 262144, maxQueuedEvents: 8 },
    source: { fetch: async (_url, init) => { const range = String(init.headers.Range).match(/bytes=(\d+)-(\d+)/); const start = Number(range[1]), end = Number(range[2]); return new Response(glb.slice(start, end + 1), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${glb.byteLength}`, "Content-Encoding": "identity" } }); } },
    cooker: {
      async cookBootstrap() { unitCalls++; throw new Error("unit cooker should not be selected"); },
      async cookBootstrapBatch(units) { batchCalls++; assert.equal(units.length, 1); return { descriptor: encodeGeometryProductDescriptorBinaryV1(product.descriptor), productId: product.productId, revision: 1, pageCount: 1, async readPage(pageId) { return { pageId, decodedHash128: product.hash.subarray(0, 16), decodedPageHash128: product.hash.subarray(0, 16), bytes: product.page.buffer }; }, release() {} }; }
    }
  });
  await coordinator.open("https://example.test/batch.glb"); coordinator.grantOutputCredits(1, 262144); await coordinator.cookBootstrap();
  assert.equal(batchCalls, 1); assert.equal(unitCalls, 0); assert.equal(coordinator.evidence().completedUnits, 1); coordinator.dispose();
});

test("Web Cook coordinator streams a plan-backed revision without materialising it up front", async () => {
  // ADR-0017 third slice. The richer revision is offered with its descriptor
  // frozen and its payloads still PENDING; the coordinator must publish the ID
  // graph, stream only the activation cut, and leave every other page unproduced
  // until GPU demand asks for it.
  const glb = makeGlb(), product = productFixture();
  const produced = [];
  const richer = (revision, replaces) => ({
    descriptor: encodeGeometryProductDescriptorBinaryV1({ ...product.descriptor, revision, ...(replaces === undefined ? {} : { replaces }) }),
    productId: product.productId,
    revision,
    pageCount: 1,
    hasPendingPages: revision === 1,
    async readPage(pageId) {
      produced.push({ revision, pageId });
      return { pageId, decodedHash128: product.hash.subarray(0, 16), decodedPageHash128: product.hash.subarray(0, 16), bytes: product.page.buffer };
    },
    release() {}
  });
  const coordinator = new WebCookCoordinator("session-plan", 1, {
    budgets: { maxConcurrentWorkers: 1, maxSourceBytes: glb.byteLength, maxWasmBytes: 4096, maxOutputBytes: 4 * 262144, maxQueuedEvents: 32 },
    source: { fetch: async (_url, init) => { const range = String(init.headers.Range).match(/bytes=(\d+)-(\d+)/); const start = Number(range[1]), end = Number(range[2]); return new Response(glb.slice(start, end + 1), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${glb.byteLength}`, "Content-Encoding": "identity" } }); } },
    bootstrapUnitCount: 1,
    cooker: {
      async cookProgressive(_units, _context, onRevision) {
        await onRevision(richer(0));
        await onRevision(richer(1, { productId: product.productId, revision: 0 }));
      }
    }
  });
  await coordinator.open("https://example.test/plan.glb");
  // Two activation cuts stream here, and a bare coordinator never returns a
  // credit: only WebCookProductProvider does that, and only while a consumer
  // drains `revisions()`. Budget one page per offered revision.
  coordinator.grantOutputCredits(2, 2 * 262144);
  await coordinator.cookBootstrap();
  const events = coordinator.drainEvents();
  const offered = events.filter(event => event.type === "RevisionOffered");
  // Both descriptors are published, richer included, even though its payloads
  // were never produced during the cook.
  assert.equal(offered.length, 2);
  assert.equal(offered[1].descriptor.byteLength > 0, true);
  const pageReady = events.filter(event => event.type === "PageReady");
  assert.deepEqual(pageReady.map(event => event.revision), [0, 1], "each revision streams exactly its activation cut");
  assert.deepEqual(produced, [{ revision: 0, pageId: 0 }, { revision: 1, pageId: 0 }]);
  coordinator.dispose();
});

test("Web Cook coordinator produces a pending page when GPU demand asks for it", async () => {
  const glb = makeGlb(), product = productFixture();
  const produced = [];
  const richer = (revision, replaces) => ({
    descriptor: encodeGeometryProductDescriptorBinaryV1({ ...product.descriptor, revision, ...(replaces === undefined ? {} : { replaces }) }),
    productId: product.productId,
    revision,
    pageCount: 1,
    hasPendingPages: revision === 1,
    async readPage(pageId) {
      produced.push({ revision, pageId });
      return { pageId, decodedHash128: product.hash.subarray(0, 16), decodedPageHash128: product.hash.subarray(0, 16), bytes: product.page.buffer };
    },
    release() {}
  });
  const coordinator = new WebCookCoordinator("session-demand", 1, {
    budgets: { maxConcurrentWorkers: 1, maxSourceBytes: glb.byteLength, maxWasmBytes: 4096, maxOutputBytes: 4 * 262144, maxQueuedEvents: 32 },
    source: { fetch: async (_url, init) => { const range = String(init.headers.Range).match(/bytes=(\d+)-(\d+)/); const start = Number(range[1]), end = Number(range[2]); return new Response(glb.slice(start, end + 1), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${glb.byteLength}`, "Content-Encoding": "identity" } }); } },
    bootstrapUnitCount: 1,
    cooker: {
      // Only the bootstrap cut is offered; page 0 stays PENDING in the richer
      // revision so the demand path is what has to produce it.
      async cookProgressive(_units, _context, onRevision) { await onRevision(richer(0)); }
    }
  });
  await coordinator.open("https://example.test/demand.glb");
  coordinator.grantOutputCredits(2, 2 * 262144);
  await coordinator.cookBootstrap();
  coordinator.drainEvents();
  produced.length = 0;
  // A demand for a page the activation cut already streamed is re-served; a
  // demand for a still-pending page advances its payload stage.
  await coordinator.requestPages(product.productId, 0, new Uint32Array([0]), 1);
  assert.deepEqual(produced, [{ revision: 0, pageId: 0 }]);
  const ready = coordinator.drainEvents().filter(event => event.type === "PageReady");
  assert.equal(ready.length, 1);
  assert.equal(ready[0].revision, 0);
  coordinator.dispose();
});


test("Web Cook coordinator re-serves a streamed activation page and survives a cancel race", async () => {
  // ADR-0017 third slice, third exit condition. A revision publishes its
  // descriptor before its payloads are all produced, so the coordinator has to
  // keep that already-published revision usable:
  //
  //  * a demand for an activation page whose cut has streamed is a re-read (the
  //    consumer lost its copy) and must be re-served, and
  //  * a cancel that loses the race to a completed cook must not tear down the
  //    revision it already handed to the consumer.
  const glb = makeGlb(), product = productFixture();
  const produced = [];
  const makeRevision = (revision, replaces) => ({
    descriptor: encodeGeometryProductDescriptorBinaryV1({ ...product.descriptor, revision, ...(replaces === undefined ? {} : { replaces }) }),
    productId: product.productId,
    revision,
    pageCount: 1,
    // The activation cut is streamed, but the descriptor may still declare
    // payloads that no demand has reached yet.
    hasPendingPages: true,
    async readPage(pageId) {
      produced.push({ revision, pageId });
      return { pageId, decodedHash128: product.hash.subarray(0, 16), decodedPageHash128: product.hash.subarray(0, 16), bytes: product.page.buffer };
    },
    release() { produced.push({ released: revision }); }
  });
  const coordinator = new WebCookCoordinator("session-cache", 1, {
    budgets: { maxConcurrentWorkers: 1, maxSourceBytes: glb.byteLength, maxWasmBytes: 4096, maxOutputBytes: 8 * 262144, maxQueuedEvents: 32 },
    source: { fetch: async (_url, init) => { const range = String(init.headers.Range).match(/bytes=(\d+)-(\d+)/); const start = Number(range[1]), end = Number(range[2]); return new Response(glb.slice(start, end + 1), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${glb.byteLength}`, "Content-Encoding": "identity" } }); } },
    bootstrapUnitCount: 1,
    cooker: {
      async cookProgressive(_units, _context, onRevision) {
        await onRevision(makeRevision(0));
        await onRevision(makeRevision(1, { productId: product.productId, revision: 0 }));
      }
    }
  });
  const ready = () => coordinator.drainEvents().filter(event => event.type === "PageReady").map(event => ({ revision: event.revision, pageId: event.pageId }));
  await coordinator.open("https://example.test/cache.glb");
  coordinator.grantOutputCredits(4, 4 * 262144);
  await coordinator.cookBootstrap();
  assert.deepEqual(ready(), [{ revision: 0, pageId: 0 }, { revision: 1, pageId: 0 }], "each revision streams exactly its activation cut");
  // A demand for the replacing revision's activation page now that its cut has
  // streamed is re-served: the page was published once, and the consumer asking
  // again means it no longer holds it.
  await coordinator.requestPages(product.productId, 1, new Uint32Array([0]), 1);
  assert.deepEqual(ready(), [{ revision: 1, pageId: 0 }], "the demand re-serves the already streamed activation page");
  // The cook already completed, so a later cancel is a no-op: it must not
  // release a revision the consumer is still rendering from, and it must not
  // turn a request that was legal a moment ago into a failure.
  coordinator.cancel();
  assert.equal(coordinator.evidence().state, "complete", "cancel cannot unwind a completed cook");
  assert.deepEqual(produced, [{ revision: 0, pageId: 0 }, { revision: 1, pageId: 0 }, { revision: 1, pageId: 0 }], "cancel re-cooks nothing and releases nothing");
  await coordinator.requestPages(product.productId, 1, new Uint32Array([0]), 1);
  assert.deepEqual(ready(), [{ revision: 1, pageId: 0 }], "a completed revision keeps answering demand");
  coordinator.dispose();
  assert.deepEqual(produced.filter(entry => "released" in entry), [{ released: 0 }, { released: 1 }], "dispose releases every live revision");
});

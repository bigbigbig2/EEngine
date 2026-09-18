import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const { WebCookCoordinator } = await import("../.test-dist/assets/web-cook/WebCookCoordinator.js");
const { WebCookProductProvider } = await import("../.test-dist/assets/web-cook/WebCookProductProvider.js");
const { encodeGeometryProductDescriptorBinaryV1 } = await import("../.test-dist/assets/geometry-product/GeometryProductBinaryV1.js");

const PAGE_BYTES = 262144;

function makeGlb() {
  const document = { asset: { version: "2.0" }, buffers: [{ byteLength: 42 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }] };
  const encoded = new TextEncoder().encode(JSON.stringify(document));
  const json = new Uint8Array(Math.ceil(encoded.byteLength / 4) * 4); json.set(encoded); json.fill(0x20, encoded.byteLength);
  const bin = new Uint8Array(42).map((_, index) => index);
  const bytes = new Uint8Array(12 + 8 + json.byteLength + 8 + bin.byteLength); const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, json.byteLength, true); view.setUint32(16, 0x4e4f534a, true); bytes.set(json, 20);
  const binHeader = 20 + json.byteLength;
  view.setUint32(binHeader, bin.byteLength, true); view.setUint32(binHeader + 4, 0x004e4942, true); bytes.set(bin, binHeader + 8);
  return bytes;
}

/** Two-page Product: page 0 and page 1 are both activation pages. */
function productFixture(revision = 1, productIdFill = 7) {
  const pages = [new Uint8Array(PAGE_BYTES).fill(1), new Uint8Array(PAGE_BYTES).fill(2)];
  const hashes = pages.map(bytes => createHash("sha256").update(bytes).digest());
  const productId = new Uint8Array(32).fill(productIdFill);
  const asset = new Uint8Array(128); const av = new DataView(asset.buffer); asset.fill(1, 0, 32);
  for (const [at, value] of [[72, 0], [76, 1], [80, 0], [84, 1], [88, 0], [92, 2], [96, 0], [100, 1], [104, 1], [108, 1], [112, 1], [116, 0]]) av.setUint32(at, value, true);
  const hierarchy = new Uint8Array(48); const hv = new DataView(hierarchy.buffer); hv.setFloat32(12, 1, true); hv.setUint32(44, 1, true);
  const groups = new Uint8Array(32); const gv = new DataView(groups.buffer);
  gv.setUint32(8, 64, true); gv.setUint32(12, 1, true);
  gv.setUint32(16, 1, true); gv.setUint32(24, 64, true);
  const records = new Uint8Array(64); const pv = new DataView(records.buffer);
  records.set(hashes[0].subarray(0, 16), 0); records.set(hashes[1].subarray(0, 16), 32);
  pv.setUint32(16, 0, true); pv.setUint32(20, 1, true);
  pv.setUint32(48, 1, true); pv.setUint32(52, 1, true);
  const formats = new Uint8Array(16); const fv = new DataView(formats.buffer); fv.setUint16(0, 16, true); fv.setUint16(2, 3, true); fv.setUint8(5, 6);
  const descriptor = { schemaVersion: 1, productId, revision, producerKind: "web-runtime", producerId: "web-test", producerVersion: "1", sourceIdentityKind: "session", sourceIdentityHash: new Uint8Array(32).fill(3), recipeHash: new Uint8Array(32).fill(4), runtimeProfile: "oengine-vg-v1-v3-decoded", decodedPageBytes: PAGE_BYTES, assetRecords: asset, rootNodeIds: new Uint32Array([0]), hierarchyNodes: hierarchy, groupDirectory: groups, pageRecords: records, bootstrapPageIds: new Uint32Array([0]), vertexFormats: formats, activationPageIds: new Uint32Array([0, 1]) };
  return { descriptor, productId, pages, hashes, revision };
}

function revisionHandle(product) {
  return {
    descriptor: encodeGeometryProductDescriptorBinaryV1(product.descriptor),
    productId: product.productId,
    revision: product.revision,
    pageCount: 2,
    async readPage(pageId) { return { pageId, decodedHash128: product.hashes[pageId].subarray(0, 16), bytes: product.pages[pageId].buffer }; },
    release() {}
  };
}

function makeCoordinator(product, { maxOutputBytes = PAGE_BYTES * 8, cook } = {}) {
  const glb = makeGlb();
  return new WebCookCoordinator("session-reserve", 1, {
    budgets: { maxConcurrentWorkers: 1, maxSourceBytes: glb.byteLength, maxWasmBytes: 1024, maxOutputBytes, maxQueuedEvents: 32 },
    source: { fetch: async (_url, init) => { const range = String(init.headers.Range).match(/bytes=(\d+)-(\d+)/); const start = Number(range[1]), end = Number(range[2]); return new Response(glb.slice(start, end + 1), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${glb.byteLength}`, "Content-Encoding": "identity" } }); } },
    cooker: { async cookBootstrap() { return revisionHandle(product); }, ...(cook ?? {}) }
  });
}

const pageEvents = events => events.filter(event => event.type === "PageReady").map(event => event.pageId);

/** Push-based CookSession event stream that never ends until `finish()`. */
function eventStream(header) {
  const queued = [], waiters = [];
  const push = event => { const waiter = waiters.shift(); const value = { ...header, ...event }; if (waiter) waiter({ done: false, value }); else queued.push(value); };
  const finish = () => { for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined }); };
  const iterable = { [Symbol.asyncIterator]() { return { next() { if (queued.length > 0) return Promise.resolve({ done: false, value: queued.shift() }); if (finished) return Promise.resolve({ done: true, value: undefined }); return new Promise(resolve => waiters.push(resolve)); } }; } };
  let finished = false;
  return { push, finish: () => { finished = true; finish(); }, iterable };
}

test("Web Cook coordinator re-serves an activation page re-read after the cut streamed", async () => {
  const product = productFixture();
  const coordinator = makeCoordinator(product);
  await coordinator.open("https://example.test/activation.glb");
  coordinator.grantOutputCredits(2, PAGE_BYTES * 2);
  await coordinator.cookBootstrap();
  coordinator.drainEvents();
  // The consumer consumed the cut, so its output credit is back with the session.
  coordinator.returnOutputCredits(2, PAGE_BYTES * 2);

  // The consumer dropped its GPU copy (device loss). The provider must be able
  // to re-serve the activation page through the same request path.
  await coordinator.requestPages(product.productId, product.revision, new Uint32Array([0]), 0);
  assert.deepEqual(pageEvents(coordinator.drainEvents()), [0], "activation page re-read is served exactly once");
  coordinator.dispose();
});

test("Web Cook coordinator conserves output credit across an activation re-read", async () => {
  const product = productFixture();
  const coordinator = makeCoordinator(product);
  await coordinator.open("https://example.test/credit.glb");
  coordinator.grantOutputCredits(3, PAGE_BYTES * 3);
  await coordinator.cookBootstrap();
  coordinator.drainEvents();
  coordinator.returnOutputCredits(2, PAGE_BYTES * 2);
  await coordinator.requestPages(product.productId, product.revision, new Uint32Array([0, 1]), 0);
  const events = coordinator.drainEvents();
  assert.deepEqual(pageEvents(events), [0, 1]);
  // Two re-served pages stay owned by the consumer until it returns them, so
  // credit plus outstanding must equal the grant with no page leaked.
  coordinator.returnOutputCredits(2, PAGE_BYTES * 2);
  const evidence = coordinator.evidence();
  assert.equal(evidence.emittedPages, 4, "the cut plus the re-read emitted four pages in total");
  coordinator.dispose();
});

test("Web Cook coordinator does not re-emit a page the consumer already holds", async () => {
  const product = productFixture();
  const coordinator = makeCoordinator(product);
  await coordinator.open("https://example.test/precision.glb");
  coordinator.grantOutputCredits(2, PAGE_BYTES * 2);
  await coordinator.cookBootstrap();
  coordinator.drainEvents();
  coordinator.returnOutputCredits(2, PAGE_BYTES * 2);
  await coordinator.requestPages(product.productId, product.revision, new Uint32Array([1]), 0);
  assert.deepEqual(pageEvents(coordinator.drainEvents()), [1], "only the requested page is emitted");
  coordinator.dispose();
});

test("Web Product provider serves a re-read after the first transfer was consumed", async () => {
  const product = productFixture();
  const credits = [], requests = [];
  const stream = eventStream({ protocolVersion: 1, sessionId: "s-reserve", sessionGeneration: 5 });
  const provider = new WebCookProductProvider(stream.iterable, {
    maxBufferedPages: 1,
    maxBufferedBytes: PAGE_BYTES,
    returnOutputCredits: (blocks, bytes) => credits.push([blocks, bytes]),
    requestPage: (productId, revision, pageId) => { requests.push([revision, pageId]); stream.push({ type: "PageReady", productId: productId.slice(), revision, pageId, decodedHash128: product.hashes[pageId].subarray(0, 16), bytes: product.pages[pageId].buffer }); }
  });
  const iterator = provider.revisions()[Symbol.asyncIterator]();
  stream.push({ type: "RevisionOffered", descriptor: encodeGeometryProductDescriptorBinaryV1(product.descriptor) });
  const offered = (await iterator.next()).value;
  const first = await offered.readPage(0);
  assert.strictEqual(first.bytes, product.pages[0].buffer);
  const second = await offered.readPage(0);
  assert.strictEqual(second.bytes, product.pages[0].buffer, "the same page is re-readable");
  const evidence = provider.evidence();
  assert.equal(evidence.deliveredPages, 2);
  assert.equal(evidence.bufferedPages, 0, "a consumed re-read leaves nothing buffered");
  assert.deepEqual(requests, [[product.revision, 0], [product.revision, 0]]);
  assert.equal(credits.length, 2, "each delivered page returns exactly one credit");
  offered.release(); provider.release(); stream.finish();
});

test("Web Product provider keeps a second revision from stranding credit", async () => {
  const first = productFixture(1), second = productFixture(2, 9);
  const credits = [], requests = [];
  const stream = eventStream({ protocolVersion: 1, sessionId: "s-window", sessionGeneration: 6 });
  const byRevision = new Map([[first.revision, first], [second.revision, second]]);
  const provider = new WebCookProductProvider(stream.iterable, {
    maxBufferedPages: 1,
    maxBufferedBytes: PAGE_BYTES,
    returnOutputCredits: (blocks, bytes) => credits.push([blocks, bytes]),
    requestPage: (productId, revision, pageId) => { requests.push([revision, pageId]); const source = byRevision.get(revision); stream.push({ type: "PageReady", productId: productId.slice(), revision, pageId, decodedHash128: source.hashes[pageId].subarray(0, 16), bytes: source.pages[pageId].buffer }); }
  });
  const iterator = provider.revisions()[Symbol.asyncIterator]();
  stream.push({ type: "RevisionOffered", descriptor: encodeGeometryProductDescriptorBinaryV1(first.descriptor) });
  stream.push({ type: "RevisionOffered", descriptor: encodeGeometryProductDescriptorBinaryV1(second.descriptor) });
  const firstOffered = (await iterator.next()).value;
  await firstOffered.readPage(0);
  const secondOffered = (await iterator.next()).value;
  // Activation streaming of the second revision arrives before its consumer
  // starts reading, so it occupies the whole buffering window.
  stream.push({ type: "PageReady", productId: second.productId.slice(), revision: second.revision, pageId: 0, decodedHash128: second.hashes[0].subarray(0, 16), bytes: second.pages[0].buffer });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(provider.evidence().bufferedPages, 1, "the second revision occupies the buffering window");
  // The first revision must still be re-readable although the window is full:
  // a requested page already has a reader, so it never consumes buffer room.
  const reread = await firstOffered.readPage(1);
  assert.strictEqual(reread.bytes, first.pages[1].buffer);
  assert.deepEqual(requests.map(request => [request[0], request[1]]), [[1, 0], [1, 1]]);
  assert.equal(provider.evidence().bufferedPages, 1, "the occupied window does not block a requested page");
  firstOffered.release(); secondOffered.release(); provider.release(); stream.finish();
});

test("Web Product provider discards an unsolicited duplicate of a consumed page", async () => {
  const product = productFixture();
  const credits = [];
  const stream = eventStream({ protocolVersion: 1, sessionId: "s-dup", sessionGeneration: 7 });
  const provider = new WebCookProductProvider(stream.iterable, {
    maxBufferedPages: 1,
    maxBufferedBytes: PAGE_BYTES,
    returnOutputCredits: (blocks, bytes) => credits.push([blocks, bytes])
  });
  const iterator = provider.revisions()[Symbol.asyncIterator]();
  stream.push({ type: "RevisionOffered", descriptor: encodeGeometryProductDescriptorBinaryV1(product.descriptor) });
  const offered = (await iterator.next()).value;
  const ready = () => ({ type: "PageReady", productId: product.productId.slice(), revision: product.revision, pageId: 0, decodedHash128: product.hashes[0].subarray(0, 16), bytes: product.pages[0].buffer });
  stream.push(ready());
  await new Promise(resolve => setImmediate(resolve));
  await offered.readPage(0);
  // A re-served copy can race the in-flight original. Nobody waits for it and
  // the consumer already has the page, so it must not hold buffer credit.
  stream.push(ready());
  await new Promise(resolve => setImmediate(resolve));
  const evidence = provider.evidence();
  assert.equal(evidence.deliveredPages, 1);
  assert.equal(evidence.bufferedPages, 0, "the duplicate does not occupy the buffering window");
  assert.equal(evidence.discardedPages, 1);
  assert.equal(credits.length, 2, "both copies return their credit");
  offered.release(); provider.release(); stream.finish();
});
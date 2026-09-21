import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

globalThis.GPUBufferUsage ??= Object.freeze({ COPY_DST: 8, STORAGE: 128 });
const { WebCookProductProvider } = await import("../.test-dist/assets/web-cook/WebCookProductProvider.js");
const { encodeGeometryProductDescriptorBinaryV1 } = await import("../.test-dist/assets/geometry-product/GeometryProductBinaryV1.js");
const { GeometryProductAdmissionController } = await import("../.test-dist/gpu/GeometryProductAdmission.js");

function fixture() {
  const page = new Uint8Array(262144); const hash = createHash("sha256").update(page).digest(); const productId = new Uint8Array(32).fill(9);
  const asset = new Uint8Array(128); const av = new DataView(asset.buffer); asset.fill(1, 0, 32); for (const [at, value] of [[72, 0], [76, 1], [80, 0], [84, 1], [88, 0], [92, 1], [96, 0], [100, 1], [104, 1], [108, 1], [112, 1], [116, 0]]) av.setUint32(at, value, true);
  const hierarchy = new Uint8Array(48); const hv = new DataView(hierarchy.buffer); hv.setFloat32(12, 1, true); hv.setUint32(44, 1, true);
  const groups = new Uint8Array(16); const gv = new DataView(groups.buffer); gv.setUint32(8, 64, true); gv.setUint32(12, 1, true);
  const pages = new Uint8Array(32); pages.set(hash.subarray(0, 16)); const pv = new DataView(pages.buffer); pv.setUint32(20, 1, true);
  const formats = new Uint8Array(16); const fv = new DataView(formats.buffer); fv.setUint16(0, 16, true); fv.setUint16(2, 3, true); fv.setUint8(5, 6);
  const descriptor = { schemaVersion: 1, productId, revision: 2, producerKind: "web-runtime", producerId: "provider-test", producerVersion: "1", sourceIdentityKind: "session", sourceIdentityHash: new Uint8Array(32).fill(3), recipeHash: new Uint8Array(32).fill(4), runtimeProfile: "oengine-vg-v1-v3-decoded", decodedPageBytes: 262144, assetRecords: asset, rootNodeIds: new Uint32Array([0]), hierarchyNodes: hierarchy, groupDirectory: groups, pageRecords: pages, bootstrapPageIds: new Uint32Array([0]), vertexFormats: formats, activationPageIds: new Uint32Array([0]) };
  return { page, hash, productId, descriptor };
}

test("Web Product provider preserves metadata events and page ownership", async () => {
  const value = fixture(), credits = [], catalogs = [], progress = [];
  async function* events() {
    const header = { protocolVersion: 1, sessionId: "s", sessionGeneration: 1 };
    yield { ...header, type: "SceneCatalogReady", catalog: { primitiveCount: 1, mutable: { rejected: true } } };
    yield { ...header, type: "Progress", stage: "bootstrap", units: 1, bytes: 12, timings: { cook: 1 } };
    yield { ...header, type: "RevisionOffered", descriptor: encodeGeometryProductDescriptorBinaryV1(value.descriptor) };
    yield { ...header, type: "PageReady", productId: value.productId.slice(), revision: 2, pageId: 0, decodedHash128: value.hash.subarray(0, 16), decodedPageHash128: value.hash.subarray(0, 16), bytes: value.page.buffer };
  }
  const provider = new WebCookProductProvider(events(), { maxBufferedPages: 1, maxBufferedBytes: 262144, returnOutputCredits: (blocks, bytes) => credits.push([blocks, bytes]), onSceneCatalogReady: catalog => catalogs.push(catalog), onProgress: value => progress.push(value) });
  const iterator = provider.revisions()[Symbol.asyncIterator](); const offered = await iterator.next(); assert.equal(offered.done, false);
  const page = await offered.value.readPage(0); assert.strictEqual(page.bytes, value.page.buffer); assert.deepEqual(credits, [[1, 262144]]);
  assert.deepEqual(catalogs, [{ primitiveCount: 1, mutable: { rejected: true } }]);
  assert.deepEqual(progress, [{ stage: "bootstrap", units: 1, bytes: 12, timings: { cook: 1 } }]);
  assert.deepEqual(provider.evidence(), { offeredRevisions: 1, bufferedPages: 0, bufferedBytes: 0, deliveredPages: 1, discardedPages: 0, staleEvents: 0, failures: 0 });
  offered.value.release(); provider.release();
});

test("Web Product provider reaches the shared Geometry Product admission and residency owner", async () => {
  const value = fixture(), credits = [], writes = [];
  async function* events() {
    const header = { protocolVersion: 1, sessionId: "s3", sessionGeneration: 4 };
    yield { ...header, type: "RevisionOffered", descriptor: encodeGeometryProductDescriptorBinaryV1(value.descriptor) };
    yield { ...header, type: "PageReady", productId: value.productId.slice(), revision: 2, pageId: 0, decodedHash128: value.hash.subarray(0, 16), decodedPageHash128: value.hash.subarray(0, 16), bytes: value.page.buffer };
  }
  const provider = new WebCookProductProvider(events(), { maxBufferedPages: 1, maxBufferedBytes: 262144, returnOutputCredits: (blocks, bytes) => credits.push([blocks, bytes]) });
  const device = {
    limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024 },
    createBuffer(d) { return { d, destroy() {} }; },
    queue: { writeBuffer(buffer, offset, bytes) { writes.push({ buffer, offset, bytes: bytes.byteLength }); } }
  };
  const controller = new GeometryProductAdmissionController(device);
  await controller.consume(provider);
  assert.equal(controller.evidence().activated, 1, JSON.stringify(controller.evidence()));
  assert.equal(controller.active?.residency.pageLocation(0)?.flags & 1, 1);
  assert.deepEqual(credits, [[1, 262144]]);
  assert.equal(provider.evidence().deliveredPages, 1);
  controller.retireActive();
  provider.release();
});

test("Web Product provider asks the Worker for a page after a consumed transfer", async () => {
  const value = fixture(), credits = [], requests = [];
  let pushEvent;
  const pending = new Promise(resolve => { pushEvent = resolve; });
  async function* events() {
    const header = { protocolVersion: 1, sessionId: "s4", sessionGeneration: 5 };
    yield { ...header, type: "RevisionOffered", descriptor: encodeGeometryProductDescriptorBinaryV1(value.descriptor) };
    await pending;
    yield { ...header, type: "PageReady", productId: value.productId.slice(), revision: 2, pageId: 0, decodedHash128: value.hash.subarray(0, 16), decodedPageHash128: value.hash.subarray(0, 16), bytes: value.page.buffer };
  }
  const provider = new WebCookProductProvider(events(), { maxBufferedPages: 1, maxBufferedBytes: 262144, returnOutputCredits: (blocks, bytes) => credits.push([blocks, bytes]), requestPage: (productId, revision, pageId) => { requests.push([productId, revision, pageId]); pushEvent(); } });
  const iterator = provider.revisions()[Symbol.asyncIterator]();
  const offered = await iterator.next();
  const page = await offered.value.readPage(0);
  assert.strictEqual(page.bytes, value.page.buffer);
  assert.deepEqual(requests.map(request => [request[1], request[2]]), [[2, 0]]);
  assert.deepEqual(credits, [[1, 262144]]);
  offered.value.release(); provider.release();
});

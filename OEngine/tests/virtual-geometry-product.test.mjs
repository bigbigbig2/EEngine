import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

globalThis.GPUBufferUsage ??= Object.freeze({ COPY_DST: 8, STORAGE: 128 });

const {
  assertGeometryProductDescriptorV1,
  validateGeometryProductDescriptorV1
} = await import("../.test-dist/assets/geometry-product/GeometryProductV1.js");
const { VirtualGeometryResidency } = await import("../.test-dist/gpu/VirtualGeometryResidency.js");
const { GEOMETRY_PRODUCT_SHARED_SLOTS_PER_BANK } = await import("../.test-dist/gpu/GeometryProductSlotPool.js");

function fixture() {
  const page = new Uint8Array(262144);
  const hash = createHash("sha256").update(page).digest();
  const asset = new Uint8Array(128); const av = new DataView(asset.buffer);
  asset.fill(1, 0, 32);
  for (const [at, value] of [[72, 0], [76, 1], [80, 0], [84, 1], [88, 0], [92, 1], [96, 0], [100, 1], [104, 1], [108, 1], [112, 1], [116, 0]]) av.setUint32(at, value, true);
  for (const [at, value] of [[32, 0], [36, 0], [37, 0], [38, 1]]) av.setFloat32(at, value, true);
  const hierarchy = new Uint8Array(48); const hv = new DataView(hierarchy.buffer);
  hv.setFloat32(0, 0, true); hv.setFloat32(4, 0, true); hv.setFloat32(8, 0, true); hv.setFloat32(12, 1, true); hv.setFloat32(40, 0, true); hv.setUint32(44, 1, true);
  const groups = new Uint8Array(16); const gv = new DataView(groups.buffer); gv.setUint32(0, 0, true); gv.setUint32(4, 0, true); gv.setUint32(8, 64, true); gv.setUint32(12, 1, true);
  const pages = new Uint8Array(32); pages.set(hash.subarray(0, 16)); const pv = new DataView(pages.buffer); pv.setUint32(16, 0, true); pv.setUint32(20, 1, true);
  const formats = new Uint8Array(16); const fv = new DataView(formats.buffer); fv.setUint16(0, 16, true); fv.setUint16(2, 3, true); fv.setUint8(4, 0); fv.setUint8(5, 6);
  const descriptor = { schemaVersion: 1, productId: new Uint8Array(32).fill(2), revision: 0, producerKind: "offline-native", producerId: "fixture", producerVersion: "1", sourceIdentityKind: "session", sourceIdentityHash: new Uint8Array(32).fill(3), recipeHash: new Uint8Array(32).fill(4), runtimeProfile: "oengine-vg-v1-v3-decoded", decodedPageBytes: 262144, assetRecords: asset, rootNodeIds: new Uint32Array([0]), hierarchyNodes: hierarchy, groupDirectory: groups, pageRecords: pages, bootstrapPageIds: new Uint32Array([0]), vertexFormats: formats, activationPageIds: new Uint32Array([0]) };
  return { descriptor, page };
}

test("Product V1 descriptor validates and rejects reserved/page-cut corruption", () => {
  const { descriptor } = fixture();
  assert.equal(validateGeometryProductDescriptorV1(descriptor).valid, true);
  assertGeometryProductDescriptorV1(descriptor);
  const bad = { ...descriptor, pageRecords: descriptor.pageRecords.slice() };
  new DataView(bad.pageRecords.buffer).setUint32(24, 1, true);
  assert.equal(validateGeometryProductDescriptorV1(bad).valid, false);
});

test("Product-aware residency uploads activation pages with generation-tagged locations", async () => {
  const { descriptor, page } = fixture();
  const writes = [], buffers = [];
  const device = { limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024 }, createBuffer(d) { const b = { d, destroyed: false, destroy() { this.destroyed = true; } }; buffers.push(b); return b; }, queue: { writeBuffer(buffer, offset, bytes) { writes.push({ buffer, offset, bytes: bytes.byteLength }); } } };
  const source = { descriptor, async readPage(pageId) { return { productId: descriptor.productId.slice(), revision: descriptor.revision, pageId, decodedHash128: descriptor.pageRecords.slice(0, 16), decodedPageHash128: descriptor.pageRecords.slice(0, 16), bytes: page.slice().buffer }; }, release() { this.released = true; } };
  const residency = await VirtualGeometryResidency.create(device, source, 7);
  assert.equal(writes.filter(write => write.bytes === 262144).length, 1); assert.equal(writes.find(write => write.bytes === 262144).offset, 0);
  assert.deepEqual(residency.pageLocation(0), { bankIndex: 0, slotIndex: 0, productGeneration: 7, flags: 3 });
  assert.equal(residency.groupAddress(0).byteOffset, 0);
  assert.equal(new DataView(residency.writePageLocation(residency.pageLocation(0))).getUint32(8, true), 7);
  assert.equal(residency.evidence().residentPages, 1);
  assert.equal(residency.bindings().productGeneration, 7); assert.ok(residency.evidence().metadataBytes > 0);
  residency.destroy(); assert.equal(source.released, true); assert.ok(buffers.every(buffer => buffer.destroyed));
});

test("Product-aware residency delays reuse of a retiring slot", async () => {
  const { descriptor, page } = fixture(); const buffers = [];
  const pageRecords = new Uint8Array(64); pageRecords.set(descriptor.pageRecords); pageRecords.set(descriptor.pageRecords.slice(0, 16), 32); const pv = new DataView(pageRecords.buffer); pv.setUint32(52, 0, true); pv.setUint32(56, 0, true);
  const product = { ...descriptor, pageRecords };
  const device = { limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024 }, createBuffer(d) { const b = { d, destroyed: false, destroy() { this.destroyed = true; } }; buffers.push(b); return b; }, queue: { writeBuffer() {} } };
  const source = { descriptor: product, async readPage(pageId) { return { productId: product.productId.slice(), revision: product.revision, pageId, decodedHash128: product.pageRecords.slice(0, 16), decodedPageHash128: product.pageRecords.slice(0, 16), bytes: page.slice().buffer }; }, release() {} };
  const residency = await VirtualGeometryResidency.create(device, source, 8);
  const demanded = { productId: product.productId.slice(), revision: product.revision, pageId: 1, decodedHash128: product.pageRecords.slice(32, 48), decodedPageHash128: product.pageRecords.slice(32, 48), bytes: page.slice().buffer };
  residency.uploadPage(demanded); residency.beginRetirePage(1); assert.equal(residency.evidence().retiringPages, 1); assert.throws(() => residency.uploadPage(demanded), /retiring/);
  residency.completeRetirePage(1); residency.uploadPage(demanded); assert.equal(residency.pageLocation(1).flags, 1); assert.equal(residency.evidence().pinnedPages, 1); assert.equal(residency.evidence().retiringPages, 0); residency.destroy();
});

test("Product-aware residency selects only aged, non-pinned pages for eviction", async () => {
  const { descriptor, page } = fixture(); const buffers = [];
  const pageRecords = new Uint8Array(64); pageRecords.set(descriptor.pageRecords); pageRecords.set(descriptor.pageRecords.slice(0, 16), 32);
  const pv = new DataView(pageRecords.buffer); pv.setUint32(52, 0, true); pv.setUint32(56, 0, true);
  const product = { ...descriptor, pageRecords };
  const device = { limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024 }, createBuffer(d) { const b = { d, destroy() {} }; buffers.push(b); return b; }, queue: { writeBuffer() {} } };
  const source = { descriptor: product, async readPage(pageId) { return { productId: product.productId.slice(), revision: product.revision, pageId, decodedHash128: product.pageRecords.slice(pageId * 32, pageId * 32 + 16), decodedPageHash128: product.pageRecords.slice(pageId * 32, pageId * 32 + 16), bytes: page.slice().buffer }; }, release() {} };
  const residency = await VirtualGeometryResidency.create(device, source, 9);
  const demanded = { productId: product.productId.slice(), revision: product.revision, pageId: 1, decodedHash128: product.pageRecords.slice(32, 48), decodedPageHash128: product.pageRecords.slice(32, 48), bytes: page.slice().buffer };
  residency.uploadPage(demanded);
  assert.deepEqual(residency.selectEvictionCandidates(1, 262144, 2), []);
  residency.touchPage(1, 1);
  assert.deepEqual(residency.selectEvictionCandidates(2, 262144, 2), []);
  assert.deepEqual(residency.selectEvictionCandidates(3, 262144, 2), [1]);
  residency.touchPage(0, 3);
  assert.deepEqual(residency.selectEvictionCandidates(10, 524288, 0), [1]);
  residency.destroy();
});

test("Product residency shares four immutable banks across simultaneous revisions", async () => {
  const { descriptor, page } = fixture();
  const device = { limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024 }, createBuffer(d) { return { d, destroyed: false, destroy() { this.destroyed = true; } }; }, queue: { writeBuffer() {} } };
  const source = () => ({ descriptor, async readPage(pageId) { return { productId: descriptor.productId.slice(), revision: 0, pageId, decodedHash128: descriptor.pageRecords.slice(0, 16), decodedPageHash128: descriptor.pageRecords.slice(0, 16), bytes: page.slice().buffer }; }, release() {} });
  const old = await VirtualGeometryResidency.create(device, source(), 1);
  const next = await VirtualGeometryResidency.create(device, source(), 2);
  assert.equal(old.evidence().bankCount, 4);
  assert.equal(old.evidence().slotCapacity, 4 * GEOMETRY_PRODUCT_SHARED_SLOTS_PER_BANK);
  assert.equal(next.bindings().banks[0], old.bindings().banks[0]);
  assert.notDeepEqual(next.pageLocation(0), old.pageLocation(0));
  const shared = next.bindings().banks[0];
  old.destroy(); assert.equal(shared.destroyed, false);
  next.destroy(); assert.equal(shared.destroyed, true);
});

test("eviction weighs GPU request/visibility, prediction and refetch cost; records thrash", async () => {
  const { descriptor, page } = fixture();
  const records = new Uint8Array(96);
  for (let index = 0; index < 3; index++) records.set(descriptor.pageRecords, index * 32);
  const recordView = new DataView(records.buffer);
  for (const at of [32, 64]) { recordView.setUint32(at + 16, 0, true); recordView.setUint32(at + 20, 0, true); }
  const product = { ...descriptor, pageRecords: records };
  const device = { limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024 }, createBuffer(d) { return { d, destroy() {} }; }, queue: { writeBuffer() {} } };
  const source = { descriptor: product, async readPage(pageId) { return { productId: product.productId.slice(), revision: 0, pageId, decodedHash128: records.slice(pageId * 32, pageId * 32 + 16), decodedPageHash128: records.slice(pageId * 32, pageId * 32 + 16), bytes: page.slice().buffer }; }, release() {} };
  const residency = await VirtualGeometryResidency.create(device, source);
  const upload = (pageId) => residency.uploadPage({ productId: product.productId.slice(), revision: 0, pageId, decodedHash128: records.slice(pageId * 32, pageId * 32 + 16), decodedPageHash128: records.slice(pageId * 32, pageId * 32 + 16), bytes: page.slice().buffer });
  upload(1); upload(2);
  residency.recordDemand(2, 10, true, false, 4);
  assert.deepEqual(residency.selectEvictionCandidates(12, 262144, 2), [1]);
  residency.recordDemand(1, 13, false, true, 1);
  assert.deepEqual(residency.selectEvictionCandidates(15, 262144, 0), [2]);
  assert.deepEqual(residency.selectEvictionCandidates(22, 262144, 0), [1]);
  residency.beginRetirePage(1); residency.completeRetirePage(1);
  residency.recordDemand(1, 23, true, false, 1);
  upload(1);
  const evidence = residency.evidence();
  assert.equal(evidence.shortTermRerequests, 1);
  assert.equal(evidence.reloads, 1);
  assert.equal(evidence.thrashBytes, 262144);
  assert.equal(evidence.averagePageLifetimeFrames, 22);
  assert.deepEqual(residency.selectEvictionCandidates(23, 262144, 0), [2]);
  residency.destroy();
});

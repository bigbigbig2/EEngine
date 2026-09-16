import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

globalThis.GPUBufferUsage ??= Object.freeze({ COPY_DST: 8, STORAGE: 128 });
const { GeometryProductAdmission } = await import("../.test-dist/gpu/GeometryProductAdmission.js");
const { resolveGeometryProductAssetFromHeapV1, unpackGeometryProductMetadataHeapHeaderV1 } = await import("../.test-dist/gpu/GeometryProductGpuAbiV1.js");

function makeFixture() {
  const page = new Uint8Array(262144); const hash = createHash("sha256").update(page).digest();
  const asset = new Uint8Array(128); const av = new DataView(asset.buffer); asset.fill(1, 0, 32); for (const [at, value] of [[72, 0], [76, 1], [80, 0], [84, 1], [88, 0], [92, 1], [96, 0], [100, 1], [104, 1], [108, 1], [112, 1], [116, 0]]) av.setUint32(at, value, true); for (const [at, value] of [[32, 0], [36, 0], [37, 0], [38, 1]]) av.setFloat32(at, value, true);
  const hierarchy = new Uint8Array(48); const hv = new DataView(hierarchy.buffer); hv.setFloat32(12, 1, true); hv.setUint32(44, 1, true);
  const groups = new Uint8Array(16); const gv = new DataView(groups.buffer); gv.setUint32(8, 64, true); gv.setUint32(12, 1, true);
  const pages = new Uint8Array(32); pages.set(hash.subarray(0, 16)); const pv = new DataView(pages.buffer); pv.setUint32(20, 1, true);
  const formats = new Uint8Array(16); const fv = new DataView(formats.buffer); fv.setUint16(0, 16, true); fv.setUint16(2, 3, true); fv.setUint8(5, 6);
  const descriptor = { schemaVersion: 1, productId: new Uint8Array(32).fill(2), revision: 0, producerKind: "offline-native", producerId: "fixture", producerVersion: "1", sourceIdentityKind: "session", sourceIdentityHash: new Uint8Array(32).fill(3), recipeHash: new Uint8Array(32).fill(4), runtimeProfile: "oengine-vg-v1-v3-decoded", decodedPageBytes: 262144, assetRecords: asset, rootNodeIds: new Uint32Array([0]), hierarchyNodes: hierarchy, groupDirectory: groups, pageRecords: pages, bootstrapPageIds: new Uint32Array([0]), vertexFormats: formats, activationPageIds: new Uint32Array([0]) };
  return { descriptor, page };
}

test("GeometryProductAdmission exposes explicit activation states and rollback", async () => {
  const { descriptor, page } = makeFixture(); const buffers = [], writes = [];
  const device = { limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024 }, createBuffer(d) { const b = { d, destroy() { this.destroyed = true; } }; buffers.push(b); return b; }, queue: { writeBuffer(buffer, offset, data) { writes.push({ buffer, offset, bytes: new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.byteLength).slice() }); } } };
  let released = false; const source = { descriptor, async readPage(pageId) { return { productId: descriptor.productId, revision: 0, pageId, decodedHash128: descriptor.pageRecords.slice(0, 16), bytes: page.slice().buffer }; }, release() { released = true; } };
  const admission = new GeometryProductAdmission(device); const transaction = admission.offer(source); assert.equal(transaction.state, "offered");
  await transaction.activate(); assert.equal(transaction.state, "active"); assert.equal(admission.evidence().active, 1);
  const productWrites = writes.filter(write => write.buffer === transaction.residency.bindings().productTable && write.bytes.byteLength === 64); assert.deepEqual(productWrites.map(write => new DataView(write.bytes.buffer).getUint32(4, true)), [1]);
  transaction.beginRetire(); transaction.retire(); assert.equal(transaction.state, "retired"); assert.equal(admission.evidence().active, 0); assert.equal(released, true); assert.ok(buffers.every(buffer => buffer.destroyed));
});

test("non-zero ProductTableSlot addresses the matching sparse table record", async () => {
  const { descriptor, page } = makeFixture(); const writes = [];
  const device = { limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024 }, createBuffer(d) { return { d, destroy() {} }; }, queue: { writeBuffer(buffer, offset, data) { writes.push({ buffer, offset, bytes: new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.byteLength).slice() }); } } };
  const source = () => ({ descriptor, async readPage(pageId) { return { productId: descriptor.productId, revision: 0, pageId, decodedHash128: descriptor.pageRecords.slice(0, 16), bytes: page.slice().buffer }; }, release() {} });
  const admission = new GeometryProductAdmission(device); admission.offer(source()).cancel();
  const transaction = admission.offer(source()); await transaction.activate();
  assert.equal(transaction.productTableSlot, 1);
  const bindings = transaction.residency.bindings();
  assert.equal(bindings.productTableByteOffset, 128);
  const heap = new Uint8Array(bindings.metadataByteLength);
  for (const write of writes.filter(candidate => candidate.buffer === bindings.metadata)) heap.set(write.bytes, write.offset);
  const header = unpackGeometryProductMetadataHeapHeaderV1(heap);
  assert.equal(header.productCount, 2); assert.equal(header.productCapacity, 2);
  assert.equal(new DataView(heap.buffer).getUint32(64, true), 0);
  assert.deepEqual(resolveGeometryProductAssetFromHeapV1(heap, 0, transaction.generation)?.productTableSlot, 1);
  transaction.beginRetire(); transaction.retire();
});

test("activation page failure rolls back GPU ownership and releases Provider exactly once", async () => {
  const { descriptor } = makeFixture(); const buffers = [];
  const device = { limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024 }, createBuffer(d) { const buffer = { d, destroy() { this.destroyed = true; } }; buffers.push(buffer); return buffer; }, queue: { writeBuffer() {} } };
  let releaseCount = 0;
  const transaction = new GeometryProductAdmission(device).offer({ descriptor, async readPage() { throw new Error("source failed"); }, release() { releaseCount++; } });
  await assert.rejects(transaction.activate(), /source failed/);
  assert.equal(transaction.state, "failed"); assert.equal(releaseCount, 1);
  assert.ok(buffers.every(buffer => buffer.destroyed));
});

test("cancel during asynchronous activation prevents late Product publication", async () => {
  const { descriptor, page } = makeFixture(); const writes = [];
  const device = { limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024 }, createBuffer(d) { return { d, destroy() { this.destroyed = true; } }; }, queue: { writeBuffer(buffer, offset, data) { writes.push({ buffer, offset, bytes: new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.byteLength).slice() }); } } };
  let finishRead; const readPending = new Promise(resolve => { finishRead = resolve; }); let releaseCount = 0; let receivedSignal;
  const admission = new GeometryProductAdmission(device);
  const transaction = admission.offer({ descriptor, async readPage(pageId, signal) { receivedSignal = signal; await readPending; return { productId: descriptor.productId, revision: 0, pageId, decodedHash128: descriptor.pageRecords.slice(0, 16), bytes: page.slice().buffer }; }, release() { releaseCount++; } });
  const activation = transaction.activate();
  await Promise.resolve(); assert.ok(receivedSignal); transaction.cancel(); finishRead();
  await assert.rejects(activation, /cancelled/);
  assert.equal(receivedSignal.aborted, true); assert.equal(transaction.state, "cancelled");
  assert.equal(admission.evidence().active, 0); assert.equal(admission.evidence().cancelled, 1);
  assert.equal(releaseCount, 1);
  assert.equal(writes.filter(write => write.bytes.byteLength === 64 && new DataView(write.bytes.buffer).getUint32(4, true) === 1).length, 0);
});

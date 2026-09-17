import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

globalThis.GPUBufferUsage ??= Object.freeze({ COPY_DST: 8, STORAGE: 128 });
const { GeometryProductAdmission, GeometryProductAdmissionController } = await import("../.test-dist/gpu/GeometryProductAdmission.js");
const { GeometryPageSchedulerV1 } = await import("../.test-dist/gpu/GeometryPageScheduler.js");
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

function fakeDevice() {
  const writes = [];
  return {
    writes,
    limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024 },
    createBuffer(d) { return { d, destroy() {} }; },
    queue: { writeBuffer(buffer, offset, data) { writes.push({ buffer, offset, bytes: new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.byteLength).slice() }); } }
  };
}

function sourceFor(descriptor, page, { fail = false } = {}) {
  let released = 0;
  return {
    descriptor,
    async readPage(pageId, signal) {
      if (fail) throw new Error("richer revision failed");
      if (signal?.aborted) throw signal.reason;
      return { productId: descriptor.productId.slice(), revision: descriptor.revision, pageId, decodedHash128: descriptor.pageRecords.slice(0, 16), bytes: page.slice().buffer };
    },
    release() { released++; },
    get released() { return released; }
  };
}

test("admission controller activates Web-style provider revisions at the shared GPU boundary", async () => {
  const first = makeFixture(), device = fakeDevice(), source = sourceFor(first.descriptor, first.page);
  async function* provider() { yield source; }
  const controller = new GeometryProductAdmissionController(device);
  await controller.consume({ revisions: provider });
  assert.equal(controller.evidence().state, "complete");
  assert.equal(controller.evidence().activated, 1);
  assert.equal(controller.active?.state, "active");
  assert.equal(controller.active?.residency.pageLocation(0)?.flags & 1, 1);
  controller.retireActive();
  assert.equal(source.released, 0);
  controller.retireReplaced();
  assert.equal(source.released, 1);
});

test("failed richer revision leaves the previous active revision published", async () => {
  const first = makeFixture(), richer = makeFixture();
  richer.descriptor = { ...richer.descriptor, productId: first.descriptor.productId.slice(), revision: 1, replaces: { productId: first.descriptor.productId.slice(), revision: first.descriptor.revision } };
  const device = fakeDevice(), oldSource = sourceFor(first.descriptor, first.page), failedSource = sourceFor(richer.descriptor, richer.page, { fail: true });
  async function* provider() { yield oldSource; yield failedSource; }
  const controller = new GeometryProductAdmissionController(device);
  await controller.consume({ revisions: provider });
  assert.equal(controller.evidence().activated, 1);
  assert.equal(controller.evidence().rejected, 1);
  assert.equal(controller.active?.descriptor.revision, 0);
  controller.retireActive();
  assert.equal(oldSource.released, 0);
  controller.retireReplaced();
  assert.equal(oldSource.released, 1);
  assert.equal(failedSource.released, 1);
});

test("successful replacement switches active generation before retiring the old one", async () => {
  const first = makeFixture(), richer = makeFixture();
  richer.descriptor = { ...richer.descriptor, productId: first.descriptor.productId.slice(), revision: 1, replaces: { productId: first.descriptor.productId.slice(), revision: first.descriptor.revision } };
  const device = fakeDevice(), oldSource = sourceFor(first.descriptor, first.page), nextSource = sourceFor(richer.descriptor, richer.page);
  async function* provider() { yield oldSource; yield nextSource; }
  const controller = new GeometryProductAdmissionController(device);
  await controller.consume({ revisions: provider });
  assert.equal(controller.evidence().activated, 2);
  assert.equal(controller.evidence().replacements, 1);
  assert.equal(controller.evidence().retiring, 1);
  assert.equal(controller.active?.descriptor.revision, 1);
  assert.equal(oldSource.released, 0);
  controller.retireReplaced();
  assert.equal(oldSource.released, 1);
  controller.retireActive();
  controller.retireReplaced();
  assert.equal(nextSource.released, 1);
});

test("scheduler registration can borrow an active Product source without releasing Residency ownership", async () => {
  const value = makeFixture(), device = fakeDevice(), source = sourceFor(value.descriptor, value.page);
  async function* provider() { yield source; }
  const controller = new GeometryProductAdmissionController(device);
  await controller.consume({ revisions: provider });
  const scheduler = new GeometryPageSchedulerV1({ maxConcurrentReads: 1, maxInFlightBytes: 262144 });
  controller.registerActiveProduct(scheduler);
  scheduler.unregisterProduct(controller.active.generation);
  assert.equal(source.released, 0);
  controller.retireActive();
  controller.retireReplaced();
  assert.equal(source.released, 1);
});

test("controller cancellation aborts the in-flight activation and releases its source", async () => {
  const fixture = makeFixture(), device = fakeDevice();
  let releaseCount = 0, resolveRead, markStarted;
  const pending = new Promise(resolve => { resolveRead = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  const source = {
    descriptor: fixture.descriptor,
    async readPage(pageId, signal) { markStarted(); await pending; if (signal?.aborted) throw signal.reason; return { productId: fixture.descriptor.productId, revision: 0, pageId, decodedHash128: fixture.descriptor.pageRecords.slice(0, 16), bytes: fixture.page.slice().buffer }; },
    release() { releaseCount++; }
  };
  async function* provider() { yield source; }
  const controller = new GeometryProductAdmissionController(device), consuming = controller.consume({ revisions: provider });
  await started;
  controller.cancel();
  resolveRead();
  await consuming;
  assert.equal(controller.evidence().state, "cancelled");
  assert.equal(controller.evidence().activated, 0);
  assert.equal(releaseCount, 1);
});

test("active Product recovery rebuilds GPU residency without releasing the CPU source", async () => {
  const fixture = makeFixture(), deviceA = fakeDevice(), deviceB = fakeDevice();
  let reads = 0;
  const source = {
    descriptor: fixture.descriptor,
    async readPage(pageId) { reads++; return { productId: fixture.descriptor.productId.slice(), revision: 0, pageId, decodedHash128: fixture.descriptor.pageRecords.slice(0, 16), bytes: fixture.page.slice().buffer }; },
    release() { this.released = (this.released ?? 0) + 1; }
  };
  async function* provider() { yield source; }
  const controller = new GeometryProductAdmissionController(deviceA);
  await controller.consume({ revisions: provider });
  const generation = controller.active.generation;
  await controller.recoverDevice(deviceB);
  assert.equal(controller.active.generation, generation);
  assert.equal(reads, 2);
  assert.equal(source.released ?? 0, 0);
  assert.equal(controller.active.residency.device, deviceB);
  controller.retireActive();
  controller.retireReplaced();
  assert.equal(source.released, 1);
});

test("Product recovery disposes superseded GPU revisions before rebuilding the active one", async () => {
  const first = makeFixture(), richer = makeFixture();
  richer.descriptor = { ...richer.descriptor, productId: first.descriptor.productId.slice(), revision: 1, replaces: { productId: first.descriptor.productId.slice(), revision: 0 } };
  const oldSource = sourceFor(first.descriptor, first.page), nextSource = sourceFor(richer.descriptor, richer.page);
  async function* provider() { yield oldSource; yield nextSource; }
  const controller = new GeometryProductAdmissionController(fakeDevice());
  await controller.consume({ revisions: provider });
  await controller.recoverDevice(fakeDevice());
  assert.equal(oldSource.released, 1);
  assert.equal(nextSource.released, 0);
  controller.retireActive();
  controller.retireReplaced();
  assert.equal(nextSource.released, 1);
});

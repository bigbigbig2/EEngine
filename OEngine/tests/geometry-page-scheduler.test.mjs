import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const { GeometryPageSchedulerV1 } = await import("../.test-dist/gpu/GeometryPageScheduler.js");
const { GeometryDemandReadbackRingV1 } = await import("../.test-dist/gpu/GeometryDemandReadbackRing.js");
const { createGeometryPageDemandQueueV1, packGeometryPageDemandHeaderV1, packGeometryPageDemandV1, reserveGeometryPageDemandV1 } = await import("../.test-dist/gpu/GeometryPageDemandAbiV1.js");

function fixture() {
  const page = new Uint8Array(262144);
  const digest = createHash("sha256").update(page).digest();
  const asset = new Uint8Array(128); const av = new DataView(asset.buffer); asset.fill(1, 0, 32);
  for (const [at, value] of [[72, 0], [76, 1], [80, 0], [84, 1], [88, 0], [92, 1], [96, 0], [100, 1], [104, 1], [108, 1], [112, 1], [116, 0]]) av.setUint32(at, value, true);
  for (const [at, value] of [[32, 0], [36, 0], [37, 0], [38, 1]]) av.setFloat32(at, value, true);
  const hierarchy = new Uint8Array(48); const hv = new DataView(hierarchy.buffer); hv.setFloat32(12, 1, true); hv.setUint32(44, 1, true);
  const groups = new Uint8Array(16); const gv = new DataView(groups.buffer); gv.setUint32(8, 64, true); gv.setUint32(12, 1, true);
  const records = new Uint8Array(32); records.set(digest.subarray(0, 16)); const rv = new DataView(records.buffer); rv.setUint32(20, 1, true);
  const formats = new Uint8Array(16); const fv = new DataView(formats.buffer); fv.setUint16(0, 16, true); fv.setUint16(2, 3, true); fv.setUint8(5, 6);
  const descriptor = { schemaVersion: 1, productId: new Uint8Array(32).fill(2), revision: 0, producerKind: "offline-native", producerId: "fixture", producerVersion: "1", sourceIdentityKind: "session", sourceIdentityHash: new Uint8Array(32).fill(3), recipeHash: new Uint8Array(32).fill(4), runtimeProfile: "oengine-vg-v1-v3-decoded", decodedPageBytes: 262144, assetRecords: asset, rootNodeIds: new Uint32Array([0]), hierarchyNodes: hierarchy, groupDirectory: groups, pageRecords: records, bootstrapPageIds: new Uint32Array([0]), vertexFormats: formats, activationPageIds: new Uint32Array([0]) };
  return { descriptor, page, hash: digest.subarray(0, 16) };
}

function demand(flags = {}) { return { productTableSlot: 3, productGeneration: 9, pageId: 0, priority: 10, currentViewMissing: false, shadow: false, predictive: false, ...flags }; }

test("page scheduler rejects unbounded retry and upload budgets", () => {
  assert.throws(() => new GeometryPageSchedulerV1({ maxConcurrentReads: 1, maxInFlightBytes: 1, maxUploadBytesPerFrame: 0 }), /budgets\/retry/);
  assert.throws(() => new GeometryPageSchedulerV1({ maxConcurrentReads: 1, maxInFlightBytes: 1, maxRetries: -1 }), /budgets\/retry/);
  assert.throws(() => new GeometryPageSchedulerV1({ maxConcurrentReads: 1, maxInFlightBytes: 1, retryBaseDelayMs: Number.NaN }), /budgets\/retry/);
});

test("page scheduler rejects a Product whose page cannot fit the configured budgets", () => {
  const { descriptor } = fixture();
  const source = { descriptor, async readPage() { throw new Error("unreachable"); }, release() {} };
  const scheduler = new GeometryPageSchedulerV1({ maxConcurrentReads: 1, maxInFlightBytes: 262144, maxUploadBytesPerFrame: 131072 });
  assert.throws(() => scheduler.registerProduct(3, 9, source), /page budget/);
});

test("page scheduler verifies identity/hash, retries transient source errors, and batches uploads", async () => {
  const { descriptor, page, hash } = fixture(); let calls = 0;
  const source = { descriptor, async readPage(pageId) { calls++; if (calls === 1) throw new Error("temporary network failure"); return { productId: descriptor.productId.slice(), revision: 0, pageId, decodedHash128: hash.slice(), bytes: page.slice().buffer }; }, release() {} };
  const scheduler = new GeometryPageSchedulerV1({ maxConcurrentReads: 1, maxInFlightBytes: 262144, retryBaseDelayMs: 5 });
  scheduler.registerProduct(3, 9, source); scheduler.ingestDemands([demand(), demand({ priority: 2 })], 0);
  await scheduler.drainReads(); assert.equal(scheduler.state(9, 0), "queued");
  scheduler.tick(5); await scheduler.drainReads(); assert.equal(scheduler.state(9, 0), "upload-queued");
  const uploaded = []; assert.equal(scheduler.drainUploadBudget({ uploadPage(value) { uploaded.push(value); } }), 262144); assert.equal(uploaded.length, 1); assert.equal(scheduler.state(9, 0), "resident");
  const evidence = scheduler.evidence(); assert.equal(evidence.deduplicated, 1); assert.equal(evidence.retries, 1); assert.equal(evidence.uploadedBytes, 262144); assert.equal(calls, 2);
});

test("page scheduler rejects deterministic hash corruption and stale generations", async () => {
  const { descriptor, page, hash } = fixture();
  const source = { descriptor, async readPage(pageId) { return { productId: descriptor.productId.slice(), revision: 0, pageId, decodedHash128: hash.slice(), bytes: page.slice().fill(7).buffer }; }, release() {} };
  const scheduler = new GeometryPageSchedulerV1({ maxConcurrentReads: 1, maxInFlightBytes: 262144, maxRetries: 4 }); scheduler.registerProduct(3, 9, source);
  scheduler.ingestDemands([demand(), demand({ productGeneration: 10 }), demand({ pageId: 99 })]); await scheduler.drainReads();
  assert.equal(scheduler.state(9, 0), "failed"); assert.equal(scheduler.evidence().retries, 0); assert.equal(scheduler.evidence().stale, 2);
});

test("page scheduler aborts an in-flight source on generation cancellation", async () => {
  const { descriptor } = fixture(); let observedSignal;
  let resolveRead; const source = { descriptor, readPage(pageId, signal) { observedSignal = signal; return new Promise(resolve => { resolveRead = () => resolve({ productId: descriptor.productId.slice(), revision: 0, pageId, decodedHash128: descriptor.pageRecords.slice(0, 16), bytes: new Uint8Array(262144).buffer }); }); }, release() {} };
  const scheduler = new GeometryPageSchedulerV1({ maxConcurrentReads: 1, maxInFlightBytes: 262144 }); scheduler.registerProduct(3, 9, source); scheduler.ingestDemands([demand()]); scheduler.cancelGeneration(9); assert.equal(observedSignal.aborted, true); resolveRead(); await scheduler.drainReads(); assert.equal(scheduler.state(9, 0), "absent"); assert.equal(scheduler.evidence().cancelled, 1);
});

test("readback ring delays mapping until a completed later frame and enforces bounded slots", async () => {
  const mapped = []; const ring = new GeometryDemandReadbackRingV1({ slotCount: 2, bytesPerSlot: 64, async mapCompletedSlot(slot) { mapped.push(slot.index); return slot.storage.slice(0, 16); } });
  assert.equal(ring.submit(10, slot => new Uint8Array(slot.storage).fill(1)), 0); assert.equal(ring.submit(11, () => {}), 1); assert.equal(ring.submit(11, () => {}), undefined);
  assert.deepEqual(await ring.poll(10), []); assert.deepEqual(mapped, []);
  const results = await ring.poll(12); assert.equal(results.length, 2); assert.deepEqual(mapped.sort(), [0, 1]); assert.equal(ring.evidence().ready, 2);
  ring.release(results[0].slotIndex); ring.release(results[1].slotIndex); assert.equal(ring.evidence().inUse, 0);
});

test("scheduler consumes bounded demand readback records and preserves overflow accounting", async () => {
  const { descriptor, page, hash } = fixture();
  const source = { descriptor, async readPage(pageId) { return { productId: descriptor.productId.slice(), revision: 0, pageId, decodedHash128: hash.slice(), bytes: page.slice().buffer }; }, release() {} };
  const queue = createGeometryPageDemandQueueV1(2, 17);
  reserveGeometryPageDemandV1(queue, demand({ productTableSlot: 3, productGeneration: 9, pageId: 0 }));
  reserveGeometryPageDemandV1(queue, demand({ productTableSlot: 99, productGeneration: 9, pageId: 0 }));
  reserveGeometryPageDemandV1(queue, demand({ productTableSlot: 3, productGeneration: 9, pageId: 0, priority: 50 }));
  const bytes = new Uint8Array(16 + queue.records.length * 16);
  bytes.set(packGeometryPageDemandHeaderV1(queue), 0);
  queue.records.forEach((record, index) => bytes.set(packGeometryPageDemandV1(record), 16 + index * 16));
  const scheduler = new GeometryPageSchedulerV1({ maxConcurrentReads: 1, maxInFlightBytes: 262144 });
  scheduler.registerProduct(3, 9, source);
  scheduler.ingestDemandReadback(bytes);
  await scheduler.drainReads();
  assert.equal(scheduler.evidence().demandOverflow, 1);
  assert.equal(scheduler.evidence().requested, 2);
  assert.equal(scheduler.evidence().stale, 1);
  assert.equal(scheduler.state(9, 0), "upload-queued");
});

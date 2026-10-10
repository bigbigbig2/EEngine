import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const { GeometryPageSchedulerV1 } = await import("../../.test-dist/gpu/GeometryPageScheduler.js");
const abi = await import("../../.test-dist/gpu/GeometryPageDemandAbiV1.js");

function source(reads, generation, overrides = {}) {
  const bytes = new Uint8Array(16).fill(7);
  const hash = new Uint8Array(createHash("sha256").update(bytes).digest().subarray(0, 16));
  const pageRecords = new Uint8Array(4 * 32);
  for (let page = 0; page < 4; page++) pageRecords.set(hash, page * 32);
  const descriptor = {
    decodedPageBytes: 16, pageRecords, productId: new Uint8Array(32).fill(3), revision: 0,
  };
  const result = (pageId) => ({
    productId: descriptor.productId, revision: 0, pageId,
    decodedHash128: hash, decodedPageHash128: hash, bytes: bytes.slice().buffer,
  });
  return {
    descriptor, result,
    async readPage(pageId) { reads.push([generation, pageId]); return result(pageId); },
    release() {}, ...overrides,
  };
}

function demand(generation, slot, pageId, priority = 10) {
  return {
    productGeneration: generation, productTableSlot: slot, pageId, priority,
    currentViewMissing: false, shadow: false, predictive: false,
  };
}

function packet(records) {
  const bytes = new Uint8Array(16 + records.length * 16);
  bytes.set(abi.packGeometryPageDemandHeaderV1({
    attempted: records.length, capacity: records.length, overflow: 0, frameRevisionLow: 1,
  }));
  records.forEach((record, i) => bytes.set(abi.packGeometryPageDemandV1(record), 16 + i * 16));
  return bytes;
}

async function settle(scheduler) {
  for (let i = 0; i < 30 && scheduler.evidence().inFlightBytes > 0; i++) {
    await scheduler.drainReads();
  }
  assert.equal(scheduler.evidence().inFlightBytes, 0);
}

test("numeric operations preserve global insertion ties and dynamic Product read/upload fairness", async () => {
  const reads = [], uploaded = [];
  const scheduler = new GeometryPageSchedulerV1({
    maxConcurrentReads: 1, maxInFlightBytes: 160, maxUploadBytesPerFrame: 160, adaptive: false,
  });
  for (const generation of [0xfffffffe, 0x80000001, 2]) {
    scheduler.registerProduct(generation, generation, source(reads, generation));
  }
  const first = 0xfffffffe, second = 0x80000001;
  const pump = scheduler.pump;
  scheduler.pump = () => {}; // Arrange interleaved packets before read admission.
  for (const record of [
    demand(first, first, 0), demand(second, second, 0),
    demand(first, first, 1, 20), demand(second, second, 1, 20), demand(2, 2, 0),
  ]) scheduler.ingestDemandReadback(packet([record]));
  scheduler.pump = pump;
  scheduler.pump();
  await settle(scheduler);
  const expected = [[first, 1], [second, 1], [2, 0], [first, 0], [second, 0]];
  assert.deepEqual(reads, expected);
  scheduler.drainUploadBudget({
    uploadPage(_page, identity) { uploaded.push([identity.productGeneration, identity.pageId]); },
  });
  // After the first upload, the stable fairness re-sort moves first/0 behind
  // second/0. That relative order survives when their served counts tie again.
  assert.deepEqual(uploaded, [[first, 1], [second, 1], [2, 0], [second, 0], [first, 0]]);
  assert.equal(scheduler.evidence().pending, 0);
  scheduler.markRetiring(first, 0);
  scheduler.markRetired(first, 0);
  assert.equal(scheduler.state(first, 0), "absent");
  assert.equal(scheduler.state(second, 0), "resident", "same pageId belongs to a different full generation");
  scheduler.ingestDemandReadback(packet([demand(first, first, 0)]));
  await settle(scheduler);
  assert.equal(scheduler.state(first, 0), "upload-queued");
  assert.equal(reads.length, 6, "retired page can reload");
  for (const generation of [first, second, 2]) scheduler.unregisterProduct(generation);
  assert.equal(scheduler.evidence().verifiedBytes, 0);
});

test("generation cancellation drops verified/retiring operations but retains residents; unregister releases source", async () => {
  let released = 0;
  const scheduler = new GeometryPageSchedulerV1({
    maxConcurrentReads: 1, maxInFlightBytes: 64, maxUploadBytesPerFrame: 64, adaptive: false,
  });
  scheduler.registerProduct(3, 9, source([], 9, { release() { released++; } }));
  scheduler.ingestDemands([demand(9, 3, 0), demand(9, 3, 1), demand(9, 3, 2)]);
  await settle(scheduler);
  scheduler.drainUploadBudget({ uploadPage() {} }, 32);
  assert.equal(scheduler.state(9, 2), "upload-queued");
  scheduler.markRetiring(9, 0);
  scheduler.cancelGeneration(9);
  assert.equal(scheduler.state(9, 0), "absent");
  assert.equal(scheduler.state(9, 1), "resident");
  assert.equal(scheduler.state(9, 2), "absent");
  assert.equal(scheduler.evidence().verifiedBytes, 0);
  assert.equal(scheduler.evidence().cancelled, 2);
  scheduler.unregisterProduct(9);
  assert.equal(scheduler.state(9, 1), "absent");
  assert.equal(released, 1);
  assert.equal(scheduler.evidence().cancelled, 3);
});

test("late cancelled IO cannot overwrite an operation with the same generation/page after re-registration", async () => {
  let resolveRead, signal;
  const old = source([], 9, {
    readPage(_pageId, readSignal) {
      signal = readSignal;
      return new Promise((resolve) => { resolveRead = resolve; });
    },
  });
  const scheduler = new GeometryPageSchedulerV1({
    maxConcurrentReads: 1, maxInFlightBytes: 32, maxUploadBytesPerFrame: 32, adaptive: false,
  });
  scheduler.registerProduct(3, 9, old);
  scheduler.ingestDemands([demand(9, 3, 0)]);
  scheduler.unregisterProduct(9);
  assert.equal(signal.aborted, true);
  scheduler.registerProduct(4, 9, source([], 9));
  scheduler.ingestDemands([demand(9, 4, 0)]);
  resolveRead(old.result(0));
  await settle(scheduler);
  assert.equal(scheduler.state(9, 0), "upload-queued");
  assert.equal(scheduler.evidence().verifiedBytes, 16);
  assert.equal(scheduler.evidence().lateResults, 1);
  const uploaded = [];
  scheduler.drainUploadBudget({ uploadPage(_page, identity) { uploaded.push(identity.productTableSlot); } });
  assert.deepEqual(uploaded, [4]);
  scheduler.unregisterProduct(9);
});

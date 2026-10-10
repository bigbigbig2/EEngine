import assert from "node:assert/strict";
import test from "node:test";

const abi = await import("../../.test-dist/gpu/GeometryPageDemandAbiV1.js");
const { GeometryPageSchedulerV1 } = await import("../../.test-dist/gpu/GeometryPageScheduler.js");

// Test-only reference of the retired dedup algorithm. It never enters production.
function referenceUnique(records) {
  const score = (d) =>
    d.residentUsage
      ? -1
      : d.priority +
        (d.currentViewMissing ? 0x1000000 : 0) +
        (d.shadow ? 0x800000 : 0) +
        (d.predictive ? 0x400000 : 0);
  const map = new Map();
  for (const d of records) {
    const key = `${d.productTableSlot}:${d.productGeneration}:${d.pageId}`;
    const old = map.get(key);
    if (!old || score(d) > score(old)) map.set(key, d);
  }
  return [...map.values()].sort(
    (a, b) => score(b) - score(a) || a.productTableSlot - b.productTableSlot || a.pageId - b.pageId
  );
}

function packet(records, header = {}) {
  const bytes = new Uint8Array(16 + records.length * 16);
  bytes.set(
    abi.packGeometryPageDemandHeaderV1({
      attempted: records.length,
      capacity: records.length,
      overflow: 0,
      frameRevisionLow: 7,
      ...header
    })
  );
  records.forEach((record, index) => bytes.set(abi.packGeometryPageDemandV1(record), 16 + index * 16));
  return bytes;
}

const demand = (extra = {}) => ({
  productTableSlot: 3,
  productGeneration: 9,
  pageId: 0,
  priority: 10,
  currentViewMissing: false,
  shadow: false,
  predictive: false,
  ...extra
});

test("canonical packet replay preserves raw records, all u32 identities and stable dedup ordering", () => {
  const batch = new abi.GeometryPageDemandBatchV1();
  let seed = 0x781213;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let iteration = 0; iteration < 200; iteration++) {
    const records = [
      demand({ productGeneration: 0xfffffffe }),
      demand({ productGeneration: 0x80000001 }),
      demand({ productGeneration: 0xfffffffe, priority: 20 }),
      demand({ productGeneration: 0x80000001, priority: 20 }),
      demand({ productTableSlot: 0xfffffffe, productGeneration: 0xdeadbeef, pageId: 0xfffffffe }),
      demand({ productTableSlot: 0x80000001, productGeneration: 0x80000002, pageId: 0xfffffffd })
    ];
    for (let index = 0; index < iteration; index++) {
      records.push(
        demand({
          productTableSlot: random() % 5,
          productGeneration: (random() % 7) + 1,
          pageId: random() % 11,
          priority: random() & 0xffff,
          currentViewMissing: (random() & 1) !== 0,
          shadow: (random() & 2) !== 0,
          predictive: (random() & 4) !== 0,
          ...((random() & 8) !== 0 ? { residentUsage: true } : {})
        })
      );
      if (index % 3 === 0) records.push({ ...records.at(-1), priority: 0 });
    }
    const bytes = packet(records);
    // An unaligned packet view must retain little-endian decoding semantics.
    const padded = new Uint8Array(bytes.length + 3);
    padded.set(bytes, 3);
    const input = padded.subarray(3);
    batch.decodeRecords(input, abi.unpackGeometryPageDemandHeaderV1(input));
    assert.deepEqual(
      Array.from({ length: batch.count }, (_, i) => batch.materialize(i)),
      records
    );
    assert.deepEqual(
      Array.from(batch.uniqueIndices, (i) => batch.materialize(i)),
      referenceUnique(records)
    );
    assert.equal(batch.requested, records.filter((d) => !d.residentUsage).length);
  }
  const words = batch.words;
  batch.decodeRecords(packet([demand()]), abi.unpackGeometryPageDemandHeaderV1(packet([demand()])));
  assert.equal(batch.words, words, "smaller packets reuse storage");
});

test("canonical ingestion replays ordering, stale, overflow, retry and abort decisions", async () => {
  const records = [
    demand({ residentUsage: true }),
    demand({ priority: 200 }),
    demand({ priority: 2 }),
    demand({ pageId: 1, residentUsage: true }),
    demand({ productTableSlot: 99 }),
    demand({ productGeneration: 10 }),
    demand({ pageId: 5 })
  ];
  const bytes = packet(records, { attempted: records.length + 1, overflow: 1 });
  const decoded = records.map((_, i) => abi.unpackGeometryPageDemandV1(bytes, 16 + i * 16));
  const runs = [];
  for (const fromPacket of [false, true]) {
    const reads = [];
    const scheduler = new GeometryPageSchedulerV1({
      maxConcurrentReads: 1,
      maxInFlightBytes: 16,
      maxUploadBytesPerFrame: 16,
      retryBaseDelayMs: 5,
      adaptive: false
    });
    scheduler.registerProduct(3, 9, {
      descriptor: { decodedPageBytes: 16, pageRecords: new Uint8Array(64) },
      readPage(pageId, signal) {
        reads.push({ pageId, aborted: false });
        const read = reads.at(-1);
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            read.aborted = true;
            reject(new Error("aborted"));
          });
          if (reads.length === 1) reject(new Error("temporary network failure"));
        });
      },
      release() {}
    });
    if (fromPacket) {
      const batch = scheduler.ingestDemandReadback(bytes, 0);
      assert.deepEqual(
        Array.from(batch.uniqueIndices, (i) => batch.materialize(i)),
        referenceUnique(decoded)
      );
    } else scheduler.ingestDemands(decoded, 0);
    await scheduler.drainReads();
    assert.equal(scheduler.state(9, 0), "queued");
    scheduler.tick(5);
    assert.equal(scheduler.state(9, 0), "producing-or-reading");
    scheduler.unregisterProduct(9);
    await scheduler.drainReads();
    const evidence = scheduler.evidence();
    assert.equal(evidence.demandOverflow, fromPacket ? 1 : 0);
    runs.push({
      reads,
      requested: evidence.requested,
      deduplicated: evidence.deduplicated,
      stale: evidence.stale,
      retries: evidence.retries,
      cancelled: evidence.cancelled,
      lateResults: evidence.lateResults,
      pending: evidence.pending
    });
  }
  assert.deepEqual(runs[1], runs[0]);
  assert.equal(runs[1].stale, 3);
  assert.equal(runs[1].retries, 1);
  assert.ok(runs[1].reads.at(-1).aborted);
});

test("malformed and overflow packets retain counters without scheduling partial records", () => {
  const scheduler = new GeometryPageSchedulerV1({ maxConcurrentReads: 1, maxInFlightBytes: 16 });
  const bytes = packet([demand(), demand()], { overflow: 1 });
  new DataView(bytes.buffer).setUint32(16 + 16 + 4, 0, true);
  assert.throws(() => scheduler.ingestDemandReadback(bytes), /identity/);
  assert.equal(scheduler.evidence().demandOverflow, 1);
  assert.equal(scheduler.evidence().malformedReadbacks, 1);
  assert.equal(scheduler.evidence().requested, 0);
  assert.throws(() => scheduler.ingestDemandReadback(bytes.subarray(0, 20)), /truncated/);
  const huge = packet([], { attempted: 0xffffffff, capacity: 0xffffffff });
  assert.throws(() => scheduler.ingestDemandReadback(huge), /truncated/);
  const reserved = packet([demand()]);
  new DataView(reserved.buffer).setUint32(28, 0x80000000, true);
  assert.throws(() => scheduler.ingestDemandReadback(reserved), /reserved/);
  const invalidHeader = packet([]);
  new DataView(invalidHeader.buffer).setUint32(8, 2, true);
  assert.throws(() => scheduler.ingestDemandReadback(invalidHeader), /overflow/);
});

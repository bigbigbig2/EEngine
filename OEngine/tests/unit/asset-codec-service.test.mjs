import assert from "node:assert/strict";
import test from "node:test";
import { AssetWorkerPool } from "../../.test-dist/assets/codec/AssetWorkerPool.js";
class FakeWorker {
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  posted = [];
  terminated = false;

  postMessage(message, transfer = []) {
    this.posted.push({ message, transfer });
  }

  terminate() {
    this.terminated = true;
  }

  result(value) {
    this.onmessage?.({ data: value });
  }

  fail(message = "worker failed") {
    this.onerror?.({ message, preventDefault() {} });
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("bounded pool preserves priority, FIFO, concurrency, memory, and transfer lists", async () => {
  const workers = [];
  const pool = new AssetWorkerPool({
    maxWorkers: 2,
    maxInFlightEstimatedBytes: 100,
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  const buffer0 = new ArrayBuffer(1);
  const first = pool.submit({ request: { id: 0 }, transfer: [buffer0], estimatedPeakBytes: 60, priority: 0 });
  const low = pool.submit({ request: { id: 1 }, transfer: [], estimatedPeakBytes: 60, priority: 1 });
  const high = pool.submit({ request: { id: 2 }, transfer: [], estimatedPeakBytes: 40, priority: 0 });
  await tick();
  assert.equal(workers.length, 2);
  assert.deepEqual(
    workers.map((worker) => worker.posted[0].message.id),
    [0, 2],
  );
  assert.strictEqual(workers[0].posted[0].transfer[0], buffer0);
  assert.equal(pool.evidence().activeWorkers, 2);
  assert.equal(pool.evidence().peakInFlightEstimatedBytes, 100);
  workers[1].result("high");
  assert.equal(await high, "high");
  assert.equal(workers[1].posted.length, 1, "60-byte FIFO head stays queued while 60 bytes remain active");
  workers[0].result("first");
  assert.equal(await first, "first");
  assert.equal(workers[0].posted[1].message.id, 1);
  workers[0].result("low");
  assert.equal(await low, "low");
  assert.equal(pool.evidence().inFlightEstimatedBytes, 0);
  pool.dispose();
  assert.ok(workers.every((worker) => worker.terminated));
});

test("pool releases reservations after errors, replaces a failed worker, and cancels work", async () => {
  const workers = [];
  const pool = new AssetWorkerPool({
    maxWorkers: 1,
    maxInFlightEstimatedBytes: 100,
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  const failed = pool.submit({ request: { id: 1 }, transfer: [], estimatedPeakBytes: 80, priority: 0 });
  await tick();
  workers[0].fail();
  await assert.rejects(failed, /worker failed/);
  assert.equal(pool.evidence().inFlightEstimatedBytes, 0);
  const controller = new AbortController();
  const cancelled = pool.submit({
    request: { id: 2 },
    transfer: [],
    estimatedPeakBytes: 80,
    priority: 0,
    signal: controller.signal,
  });
  await tick();
  assert.equal(workers.length, 2);
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.equal(pool.evidence().inFlightEstimatedBytes, 0);
  pool.dispose();
});

test("pool dispose rejects queued and active tasks idempotently", async () => {
  const worker = new FakeWorker();
  const pool = new AssetWorkerPool({
    maxWorkers: 1,
    maxInFlightEstimatedBytes: 64,
    createWorker: () => worker,
  });
  const active = pool.submit({ request: 1, transfer: [], estimatedPeakBytes: 64, priority: 0 });
  const queued = pool.submit({ request: 2, transfer: [], estimatedPeakBytes: 64, priority: 0 });
  await tick();
  pool.dispose();
  pool.dispose();
  await assert.rejects(active, /disposed/);
  await assert.rejects(queued, /disposed/);
  assert.equal(worker.terminated, true);
});

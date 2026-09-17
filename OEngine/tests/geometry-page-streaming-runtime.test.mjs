import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

globalThis.GPUBufferUsage ??= Object.freeze({ MAP_READ: 1, COPY_DST: 2 });
globalThis.GPUMapMode ??= Object.freeze({ READ: 1 });

const { GpuGeometryDemandReadbackRingV1 } = await import(
  "../.test-dist/gpu/GeometryDemandReadbackRing.js"
);
const { GeometryPageStreamingRuntimeV1 } = await import(
  "../.test-dist/gpu/GeometryPageStreamingRuntime.js"
);
const {
  packGeometryPageDemandHeaderV1,
  packGeometryPageDemandV1
} = await import("../.test-dist/gpu/GeometryPageDemandAbiV1.js");

class FakeBuffer {
  constructor(descriptor) {
    this.size = descriptor.size;
    this.usage = descriptor.usage;
    this.bytes = new Uint8Array(this.size);
    this.destroyed = false;
    this.mapped = false;
  }
  async mapAsync() { this.mapped = true; }
  getMappedRange(offset, size) {
    if (!this.mapped) throw new Error("buffer is not mapped");
    return this.bytes.slice(offset, offset + size).buffer;
  }
  unmap() { this.mapped = false; }
  destroy() { this.destroyed = true; }
}

function device() {
  return {
    createBuffer(descriptor) { return new FakeBuffer(descriptor); }
  };
}

function encoder() {
  return {
    copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size) {
      destination.bytes.set(source.bytes.slice(sourceOffset, sourceOffset + size), destinationOffset);
    }
  };
}

test("GPU demand ring copies in-frame and maps only after a later completion", async () => {
  const ring = new GpuGeometryDemandReadbackRingV1({
    device: device(), slotCount: 2, bytesPerSlot: 64
  });
  const source = new FakeBuffer({ size: 32, usage: 0 });
  source.bytes.set([1, 2, 3, 4]);
  assert.equal(ring.encode(encoder(), source, 4), 0);
  assert.deepEqual(await ring.poll(4), []);
  const results = await ring.poll(5);
  assert.equal(results.length, 1);
  assert.deepEqual([...new Uint8Array(results[0].bytes).slice(0, 4)], [1, 2, 3, 4]);
  ring.release(results[0].slotIndex);
  ring.destroy();
});

test("streaming runtime consumes delayed demand and uploads through residency", async () => {
  const page = new Uint8Array(262144).fill(7);
  const hash = createHash("sha256").update(page).digest();
  const productId = new Uint8Array(32).fill(2);
  const pageRecords = new Uint8Array(32);
  pageRecords.set(hash.subarray(0, 16));
  new DataView(pageRecords.buffer).setUint32(20, 1, true);
  const descriptor = { pageRecords, decodedPageBytes: page.byteLength, productId, revision: 0 };
  const source = {
    descriptor,
    async readPage(pageId) {
      return { productId: productId.slice(), revision: 0, pageId,
        decodedHash128: hash.subarray(0, 16), bytes: page.slice().buffer };
    },
    release() {}
  };
  const uploaded = [];
  const residency = {
    productGeneration: 9,
    productTableSlot: 3,
    descriptor,
    uploadPage(value) { uploaded.push(value); },
    evidence() { return { productGeneration: 9, residentPages: uploaded.length }; }
  };
  const runtime = new GeometryPageStreamingRuntimeV1(device(), residency, {
    schedulerOptions: { maxConcurrentReads: 1, maxInFlightBytes: 262144 },
    readback: { slotCount: 2, bytesPerSlot: 64 }
  });
  runtime.registerProduct(source);
  const demand = new Uint8Array(32);
  demand.set(packGeometryPageDemandHeaderV1({ attempted: 1, capacity: 1, overflow: 0, frameRevisionLow: 4 }));
  demand.set(packGeometryPageDemandV1({ productTableSlot: 3, productGeneration: 9, pageId: 0, priority: 10, currentViewMissing: true, shadow: false, predictive: false }), 16);
  const gpuDemand = new FakeBuffer({ size: 32, usage: 0 });
  gpuDemand.bytes.set(demand);
  runtime.encodeDemandReadback(encoder(), gpuDemand, 10);
  const first = await runtime.consumeCompleted(10);
  assert.equal(first.mappedSlots, 0);
  const second = await runtime.consumeCompleted(11);
  assert.equal(second.mappedSlots, 1);
  await runtime.scheduler.drainReads();
  await runtime.consumeCompleted(12);
  assert.equal(uploaded.length, 1);
  assert.equal(runtime.evidence().scheduler.resident, 1);
  runtime.destroy();
});

test("streaming runtime revokes pages before the settled submission boundary", async () => {
  const descriptor = { pageRecords: new Uint8Array(160), decodedPageBytes: 262144, productId: new Uint8Array(32).fill(4), revision: 0 };
  const page = { productId: descriptor.productId.slice(), revision: 0, pageId: 4, decodedHash128: new Uint8Array(16), bytes: new ArrayBuffer(262144) };
  const source = { descriptor, async readPage() { return page; }, release() {} };
  const events = [];
  const residency = {
    productGeneration: 12,
    productTableSlot: 1,
    descriptor,
    uploadPage() {},
    pageLocation(pageId) { return pageId === 4 ? { flags: 1 } : undefined; },
    beginRetirePage(pageId) { events.push(`begin:${pageId}`); },
    completeRetirePage(pageId) { events.push(`complete:${pageId}`); },
    selectEvictionCandidates() { return []; },
    evidence() { return { productGeneration: 12, residentPages: 0 }; }
  };
  const runtime = new GeometryPageStreamingRuntimeV1(device(), residency, {
    schedulerOptions: { maxConcurrentReads: 1, maxInFlightBytes: 262144 },
    readback: { slotCount: 2, bytesPerSlot: 64 }
  });
  runtime.registerProduct(source);
  let settled = false;
  const completion = new Promise((resolve) => setTimeout(() => { settled = true; resolve(); }, 0));
  const retirement = runtime.retirePages([4], completion);
  assert.deepEqual(events, ["begin:4"]);
  await retirement;
  assert.equal(settled, true);
  assert.deepEqual(events, ["begin:4", "complete:4"]);
  runtime.destroy();
});

test("runtime destruction unregisters the Product and aborts pending page reads", async () => {
  const page = new Uint8Array(262144).fill(3);
  const hash = createHash("sha256").update(page).digest();
  const descriptor = {
    pageRecords: new Uint8Array(32),
    decodedPageBytes: page.byteLength,
    productId: new Uint8Array(32).fill(8),
    revision: 0
  };
  descriptor.pageRecords.set(hash.subarray(0, 16));
  new DataView(descriptor.pageRecords.buffer).setUint32(20, 1, true);
  let aborted = false;
  let resolveRead;
  const source = {
    descriptor,
    readPage(_pageId, signal) {
      signal.addEventListener("abort", () => { aborted = true; resolveRead?.(); }, { once: true });
      return new Promise((resolve) => { resolveRead = () => resolve({ productId: descriptor.productId.slice(), revision: 0, pageId: 0, decodedHash128: hash.subarray(0, 16), bytes: page.slice().buffer }); });
    },
    release() {}
  };
  const scheduler = new (await import("../.test-dist/gpu/GeometryPageScheduler.js")).GeometryPageSchedulerV1({
    maxConcurrentReads: 1,
    maxInFlightBytes: page.byteLength
  });
  const residency = {
    productGeneration: 21,
    productTableSlot: 5,
    descriptor,
    uploadPage() {},
    evidence() { return { productGeneration: 21, residentPages: 0 }; }
  };
  const runtime = new GeometryPageStreamingRuntimeV1(device(), residency, {
    scheduler,
    readback: { slotCount: 2, bytesPerSlot: 64 }
  });
  runtime.registerProduct(source);
  scheduler.ingestDemands([{ productTableSlot: 5, productGeneration: 21, pageId: 0, priority: 10, currentViewMissing: true, shadow: false, predictive: false }]);
  assert.equal(scheduler.state(21, 0), "producing-or-reading");
  runtime.destroy();
  assert.equal(aborted, true);
  assert.equal(scheduler.state(21, 0), "absent");
  assert.equal(scheduler.evidence().cancelled, 1);
  await scheduler.drainReads();
});

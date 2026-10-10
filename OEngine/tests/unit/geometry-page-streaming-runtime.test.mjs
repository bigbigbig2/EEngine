import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Signal } from "../../.test-dist/core/Signal.js";

globalThis.GPUBufferUsage ??= Object.freeze({ MAP_READ: 1, COPY_DST: 2 });
globalThis.GPUMapMode ??= Object.freeze({ READ: 1 });

const { GpuGeometryDemandReadbackRingV1 } = await import(
  "../../.test-dist/gpu/GeometryDemandReadbackRing.js"
);
const { GeometryPageStreamingRuntimeV1 } = await import(
  "../../.test-dist/gpu/GeometryPageStreamingRuntime.js"
);
const { packGeometryPageDemandHeaderV1, packGeometryPageDemandV1 } = await import(
  "../../.test-dist/gpu/GeometryPageDemandAbiV1.js"
);

class FakeBuffer {
  constructor(descriptor) {
    this.size = descriptor.size;
    this.usage = descriptor.usage;
    this.bytes = new Uint8Array(this.size);
    this.destroyed = false;
    this.mapped = false;
  }
  async mapAsync() {
    this.mapped = true;
  }
  getMappedRange(offset, size) {
    if (!this.mapped) throw new Error("buffer is not mapped");
    return this.bytes.slice(offset, offset + size).buffer;
  }
  unmap() {
    this.mapped = false;
  }
  destroy() {
    this.destroyed = true;
  }
}

function device() {
  return {
    lost: new Promise(() => {}),
    queue: { onSubmittedWorkDone: async () => {} },
    createBuffer(descriptor) {
      return new FakeBuffer(descriptor);
    }
  };
}

function command() {
  return {
    gpu_encoder: encoder(),
    onFinished: {
      addOne(callback) {
        callback();
      }
    },
    onAborted: { addOne() {} }
  };
}

function encoder() {
  return {
    copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size) {
      destination.bytes.set(source.bytes.slice(sourceOffset, sourceOffset + size), destinationOffset);
    }
  };
}

test("shadow content identity observes every resident owner and explicit retirement without demand readback", async () => {
  const makeResidency = (generation) => ({
    contentRevision: 0,
    productGeneration: generation,
    productTableSlot: generation - 1,
    publicationActive: true,
    publicationChanged: new Signal(),
    descriptor: { productId: new Uint8Array(32), revision: 0, decodedPageBytes: 262144, pageRecords: new Uint8Array(64) },
    pageLocation: () => ({ flags: 0 }),
    beginRetirePage() { this.contentRevision++; },
    completeRetirePage() {},
    evidence() { return {}; },
  });
  const first = makeResidency(1), second = makeResidency(2);
  const runtime = new GeometryPageStreamingRuntimeV1(device(), first, {
    readback: { slotCount: 2, bytesPerSlot: 64 }
  });
  const register = (residency) => runtime.registerProduct({
    descriptor: residency.descriptor,
    readPage() { throw new Error("Content observation must not read a page"); },
    release() {}
  }, residency);
  register(first);
  const initial = runtime.contentRevision;
  assert.equal(runtime.contentRevision, initial);
  register(second);
  const appended = runtime.contentRevision;
  assert.ok(appended > initial);
  second.contentRevision++; // Direct public-owner upload, bypassing streaming's upload sink.
  const uploaded = runtime.contentRevision;
  assert.ok(uploaded > appended);
  const fence = deferred();
  const retirement = runtime.retirePages([1], fence.promise, second);
  const revoked = runtime.contentRevision;
  assert.ok(revoked > uploaded, "revoked cut must invalidate before physical retirement completes");
  fence.resolve();
  await retirement;
  assert.equal(runtime.contentRevision, revoked, "slot release does not change already-revoked content");
  assert.equal(runtime.evidence().readback.submitted, 0);
  runtime.destroy();
});

test("resident feedback protects hot pages without IO and bounds shared-pool eviction", async () => {
  const events = [];
  const { GeometryPageSchedulerV1 } = await import("../../.test-dist/gpu/GeometryPageScheduler.js");
  const scheduler = new GeometryPageSchedulerV1({
    maxConcurrentReads: 1, maxInFlightBytes: 262144, maxUploadBytesPerFrame: 262144,
  });
  // Exercise feedback/retirement under pressure independently of page decoding.
  scheduler.drainUploadBudget = () => 0;
  // The runtime consumes the live pressure getter, not the diagnostic snapshot.
  Object.defineProperty(scheduler, "blockedUploads", { get: () => 1 });
  const makeResidency = (generation) => {
    const used = new Map();
    return {
      publicationActive: true, publicationChanged: new Signal(),
      productGeneration: generation, productTableSlot: generation - 1,
      descriptor: { productId: new Uint8Array(32), revision: 0, decodedPageBytes: 262144, pageRecords: new Uint8Array(64) },
      touchPage(page, frame) { used.set(page, frame); },
      recordDemand() { throw new Error("Usage must not be recorded as a miss"); },
      selectEvictionCandidates(frame, bytes, age) {
        events.push({ generation, frame, bytes });
        return bytes >= 262144 && frame - (used.get(0) ?? -100) >= age ? [0] : [];
      },
      residentPagePhysicalBytes() { return 262144; },
      beginRetirePage(page) { events.push(`begin:${generation}:${page}`); },
      completeRetirePage(page) { events.push(`end:${generation}:${page}`); },
      evidence() { return {}; },
    };
  };
  const first = makeResidency(1), second = makeResidency(2), third = makeResidency(3);
  const runtime = new GeometryPageStreamingRuntimeV1(device(), first, {
    scheduler, readback: { slotCount: 2, bytesPerSlot: 64 },
  });
  for (const residency of [first, second, third]) {
    runtime.registerProduct({
      descriptor: residency.descriptor,
      readPage() { throw new Error("Resident usage must never read a page"); }, release() {},
    }, residency);
  }
  const buffer = new FakeBuffer({ size: 32, usage: 0 });
  buffer.bytes.set(packGeometryPageDemandHeaderV1({ attempted: 1, capacity: 1, overflow: 0, frameRevisionLow: 10 }));
  buffer.bytes.set(packGeometryPageDemandV1({
    productTableSlot: 0, productGeneration: 1, pageId: 0, priority: 0,
    currentViewMissing: false, shadow: false, predictive: false, residentUsage: true,
  }), 16);
  runtime.encodeDemandReadback(command(), buffer, 10);
  await runtime.consumeCompleted(100); // completion clock must not age the hot page
  assert.deepEqual(events, [
    { generation: 1, frame: 10, bytes: 262144 },
    { generation: 2, frame: 10, bytes: 262144 }, "begin:2:0", "end:2:0",
  ]);
  assert.equal(scheduler.evidence().requested, 0);
  assert.equal(scheduler.evidence().inFlightBytes, 0);
  assert.equal(scheduler.evidence().verifiedBytes, 0);
  events.length = 0;
  buffer.bytes.set(packGeometryPageDemandHeaderV1({ attempted: 2, capacity: 1, overflow: 1, frameRevisionLow: 101 }));
  runtime.encodeDemandReadback(command(), buffer, 101);
  await runtime.consumeCompleted(102);
  assert.deepEqual(events, []); // incomplete usage cannot authorize eviction
  // A complete main snapshot cannot override incomplete active-shadow usage.
  buffer.bytes.set(packGeometryPageDemandHeaderV1({ attempted: 1, capacity: 1, overflow: 0, frameRevisionLow: 103 }));
  runtime.encodeDemandReadback(command(), buffer, 103);
  buffer.bytes.set(packGeometryPageDemandHeaderV1({ attempted: 2, capacity: 1, overflow: 1, frameRevisionLow: 103 }));
  runtime.encodeShadowDemandReadback(command(), buffer, 103);
  await runtime.consumeCompleted(104);
  assert.deepEqual(events, []);
  // Fill the shadow ring without consuming it. A dropped shadow copy must
  // still prevent the incomplete snapshot from aging pages by a newer main clock.
  for (const frame of [104, 105, 106, 107]) {
    runtime.encodeShadowDemandReadback(command(), buffer, frame);
  }
  buffer.bytes.set(packGeometryPageDemandHeaderV1({ attempted: 1, capacity: 1, overflow: 0, frameRevisionLow: 107 }));
  runtime.encodeDemandReadback(command(), buffer, 107);
  await runtime.consumeCompleted(108);
  assert.deepEqual(events, []);
  assert.ok(runtime.evidence().shadowReadback.overflow > 0);
  runtime.destroy();
});

test("GPU demand ring copies in-frame and maps only after a later completion", async () => {
  const ring = new GpuGeometryDemandReadbackRingV1({
    device: device(),
    slotCount: 2,
    bytesPerSlot: 64
  });
  const source = new FakeBuffer({ size: 32, usage: 0 });
  source.bytes.set([1, 2, 3, 4]);
  assert.equal(ring.encode(encoder(), source, 4), 0);
  ring.commit(0);
  assert.deepEqual(await ring.poll(4), []);
  const results = await ring.poll(5);
  assert.equal(results.length, 1);
  assert.deepEqual([...new Uint8Array(results[0].bytes).slice(0, 4)], [1, 2, 3, 4]);
  ring.release(results[0].slotIndex);
  ring.destroy();
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const shadow of [false, true]) {
  test(`loss cancels pending ${shadow ? "shadow" : "main"} mapping and queued pumps`, async () => {
    const lost = deferred();
    const started = deferred();
    const mapping = deferred();
    const buffers = [];
    const gpu = {
      lost: lost.promise,
      createBuffer(descriptor) {
        const buffer = new FakeBuffer(descriptor);
        buffer.mapAsync = () => { started.resolve(); return mapping.promise; };
        buffers.push(buffer);
        return buffer;
      }
    };
    const residency = { evidence: () => ({}) };
    const runtime = new GeometryPageStreamingRuntimeV1(gpu, residency, {
      readback: { slotCount: 2, bytesPerSlot: 64 }
    });
    const source = new FakeBuffer({ size: 32, usage: 0 });
    if (shadow) runtime.encodeShadowDemandReadback(command(), source, 1);
    else runtime.encodeDemandReadback(command(), source, 1);
    const active = runtime.consumeAfterCompletion(1, Promise.resolve());
    await started.promise;
    const queued = runtime.consumeAfterCompletion(2, Promise.resolve());
    lost.resolve({ reason: "destroyed" });
    await Promise.resolve();
    mapping.reject(new Error("map canceled by device loss"));
    for (const result of await Promise.all([active, queued])) {
      assert.equal(result.cancelled, true);
      assert.equal(result.uploadedBytes, 0);
    }
    assert.equal(runtime.evidence().lastError, null);
    assert.equal(runtime.evidence().readback.inUse, 0);
    if (shadow) assert.equal(runtime.evidence().shadowReadback.inUse, 0);
    assert.ok(buffers.every((buffer) => buffer.destroyed));
    runtime.destroy();
  });
}

test("live-device mapping failures remain observable", async () => {
  const gpu = device();
  gpu.createBuffer = (descriptor) => {
    const buffer = new FakeBuffer(descriptor);
    buffer.mapAsync = async () => { throw new Error("real live mapping failure"); };
    return buffer;
  };
  const runtime = new GeometryPageStreamingRuntimeV1(gpu, { evidence: () => ({}) }, {
    readback: { slotCount: 2, bytesPerSlot: 64 }
  });
  runtime.encodeDemandReadback(command(), new FakeBuffer({ size: 32, usage: 0 }), 1);
  await assert.rejects(runtime.consumeAfterCompletion(1, Promise.resolve()), (error) => {
    assert.match(error.message, /Geometry demand mapping failed/);
    assert.match(error.errors[0].message, /real live mapping failure/);
    return true;
  });
  assert.match(runtime.evidence().lastError, /mapping failed/);
  runtime.destroy();
});

for (const [shadow, rangeInvalidated] of [[false, false], [true, false], [false, true], [true, true]]) {
  test(`${rangeInvalidated ? "mapped range invalidation" : "map abort"} before loss notification cancels ${shadow ? "shadow" : "main"} pump`, async () => {
    const lost = deferred();
    const started = deferred();
    const mapping = deferred();
    const buffers = [];
    const gpu = {
      lost: lost.promise,
      queue: { onSubmittedWorkDone: async () => {} },
      createBuffer(descriptor) {
        const buffer = new FakeBuffer(descriptor);
        buffer.mapAsync = () => { started.resolve(); return mapping.promise; };
        if (rangeInvalidated) {
          buffer.getMappedRange = () => { throw new DOMException("Lost mapped range", "OperationError"); };
        }
        buffers.push(buffer);
        return buffer;
      }
    };
    const runtime = new GeometryPageStreamingRuntimeV1(gpu, { evidence: () => ({}) }, {
      readback: { slotCount: 2, bytesPerSlot: 64 }
    });
    const source = new FakeBuffer({ size: 32, usage: 0 });
    if (shadow) runtime.encodeShadowDemandReadback(command(), source, 1);
    else runtime.encodeDemandReadback(command(), source, 1);
    const active = runtime.consumeAfterCompletion(1, Promise.resolve());
    await started.promise;
    if (rangeInvalidated) mapping.resolve();
    else mapping.reject(new DOMException("Buffer unmapped before mapping resolved", "AbortError"));
    // Real Chrome delivers this cancellation before the device-loss task.
    await new Promise((resolve) => setTimeout(resolve, 0));
    lost.resolve({ reason: "destroyed" });
    assert.equal((await active).cancelled, true);
    assert.equal(runtime.evidence().lastError, null);
    assert.equal(runtime.evidence().readback.inUse, 0);
    if (shadow) assert.equal(runtime.evidence().shadowReadback.inUse, 0);
    assert.ok(buffers.every((buffer) => buffer.destroyed));
    runtime.destroy();
  });
}

test("live-device AbortError is not classified as loss", async () => {
  const gpu = device();
  gpu.queue = { onSubmittedWorkDone: async () => {} };
  gpu.createBuffer = (descriptor) => {
    const buffer = new FakeBuffer(descriptor);
    buffer.mapAsync = async () => { throw new DOMException("live map abort", "AbortError"); };
    return buffer;
  };
  const runtime = new GeometryPageStreamingRuntimeV1(gpu, { evidence: () => ({}) }, {
    readback: { slotCount: 2, bytesPerSlot: 64 }
  });
  runtime.encodeDemandReadback(command(), new FakeBuffer({ size: 32, usage: 0 }), 1);
  await assert.rejects(runtime.consumeAfterCompletion(1, Promise.resolve()), (error) => {
    assert.match(error.message, /Geometry demand mapping failed/);
    assert.equal(error.errors[0].name, "AbortError");
    return true;
  });
  assert.match(runtime.evidence().lastError, /mapping failed/);
  runtime.destroy();
});

test("destroyed runtime cancels rejected completion; live rejection remains an error", async () => {
  const runtime = new GeometryPageStreamingRuntimeV1(device(), { evidence: () => ({}) });
  await assert.rejects(runtime.consumeAfterCompletion(1, Promise.reject(new Error("live fence"))), /live fence/);
  const completion = deferred();
  const pump = runtime.consumeAfterCompletion(2, completion.promise);
  runtime.destroy();
  completion.reject(new Error("lost fence"));
  assert.equal((await pump).cancelled, true);
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
      return {
        productId: productId.slice(),
        revision: 0,
        pageId,
        decodedHash128: hash.subarray(0, 16),
        decodedPageHash128: hash.subarray(0, 16),
        bytes: page.slice().buffer
      };
    },
    release() {}
  };
  const uploaded = [];
  const residency = {
    publicationActive: true,
    publicationChanged: new Signal(),
    productGeneration: 9,
    productTableSlot: 3,
    descriptor,
    uploadCost(value) {
      return value.bytes.byteLength;
    },
    recordDemand() {},
    tryUploadPage(value) {
      uploaded.push(value);
    },
    evidence() {
      return { productGeneration: 9, residentPages: uploaded.length };
    }
  };
  const runtime = new GeometryPageStreamingRuntimeV1(device(), residency, {
    schedulerOptions: { maxConcurrentReads: 1, maxInFlightBytes: 262144 },
    readback: { slotCount: 2, bytesPerSlot: 64 }
  });
  runtime.registerProduct(source);
  const demand = new Uint8Array(32);
  demand.set(packGeometryPageDemandHeaderV1({ attempted: 1, capacity: 1, overflow: 0, frameRevisionLow: 4 }));
  demand.set(
    packGeometryPageDemandV1({
      productTableSlot: 3,
      productGeneration: 9,
      pageId: 0,
      priority: 10,
      currentViewMissing: true,
      shadow: false,
      predictive: false
    }),
    16
  );
  const gpuDemand = new FakeBuffer({ size: 32, usage: 0 });
  gpuDemand.bytes.set(demand);
  runtime.encodeDemandReadback(command(), gpuDemand, 10);
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

test("one streaming runtime routes Product-local pages to multiple shard residencies", async () => {
  const makeProduct = (fill, slot, generation) => {
    const page = new Uint8Array(262144).fill(fill);
    const hash = createHash("sha256").update(page).digest();
    const productId = new Uint8Array(32).fill(fill);
    const pageRecords = new Uint8Array(32);
    pageRecords.set(hash.subarray(0, 16));
    new DataView(pageRecords.buffer).setUint32(20, 1, true);
    const descriptor = { pageRecords, decodedPageBytes: page.byteLength, productId, revision: 0 };
    const source = {
      descriptor,
      async readPage(pageId) {
        return {
          productId: productId.slice(),
          revision: 0,
          pageId,
          decodedHash128: hash.subarray(0, 16),
          decodedPageHash128: hash.subarray(0, 16),
          bytes: page.slice().buffer
        };
      },
      release() {}
    };
    const uploaded = [];
    const residency = {
      publicationActive: true,
      publicationChanged: new Signal(),
      productGeneration: generation,
      productTableSlot: slot,
      descriptor,
      uploadCost(value) {
        return value.bytes.byteLength;
      },
      recordDemand() {},
      tryUploadPage(value) {
        uploaded.push(value);
      },
      recordDemand() {},
      evidence() {
        return { productGeneration: generation, residentPages: uploaded.length };
      }
    };
    return { source, residency, uploaded };
  };
  const first = makeProduct(5, 3, 9);
  const second = makeProduct(5, 4, 10); // same revision, separate slot/generation
  const runtime = new GeometryPageStreamingRuntimeV1(device(), first.residency, {
    schedulerOptions: { maxConcurrentReads: 2, maxInFlightBytes: 2 * 262144 },
    readback: { slotCount: 2, bytesPerSlot: 64 }
  });
  runtime.registerProduct(first.source, first.residency);
  runtime.registerProduct(second.source, second.residency);
  const demand = new Uint8Array(48);
  demand.set(packGeometryPageDemandHeaderV1({ attempted: 2, capacity: 2, overflow: 0, frameRevisionLow: 4 }));
  demand.set(
    packGeometryPageDemandV1({
      productTableSlot: 3,
      productGeneration: 9,
      pageId: 0,
      priority: 10,
      currentViewMissing: true,
      shadow: false,
      predictive: false
    }),
    16
  );
  demand.set(
    packGeometryPageDemandV1({
      productTableSlot: 4,
      productGeneration: 10,
      pageId: 0,
      priority: 9,
      currentViewMissing: true,
      shadow: false,
      predictive: false
    }),
    32
  );
  const gpuDemand = new FakeBuffer({ size: 48, usage: 0 });
  gpuDemand.bytes.set(demand);
  runtime.encodeDemandReadback(command(), gpuDemand, 20);
  await runtime.consumeCompleted(20);
  await runtime.consumeCompleted(21);
  await runtime.scheduler.drainReads();
  await runtime.consumeCompleted(22);
  assert.equal(first.uploaded.length, 1);
  assert.equal(second.uploaded.length, 1);
  assert.equal(runtime.evidence().scheduler.resident, 2);
  runtime.destroy();
});

test("streaming runtime revokes pages before the settled submission boundary", async () => {
  const descriptor = {
    pageRecords: new Uint8Array(160),
    decodedPageBytes: 262144,
    productId: new Uint8Array(32).fill(4),
    revision: 0
  };
  const page = {
    productId: descriptor.productId.slice(),
    revision: 0,
    pageId: 4,
    decodedHash128: new Uint8Array(16),
    decodedPageHash128: new Uint8Array(16),
    bytes: new ArrayBuffer(262144)
  };
  const source = {
    descriptor,
    async readPage() {
      return page;
    },
    release() {}
  };
  const events = [];
  const residency = {
    publicationActive: true,
    publicationChanged: new Signal(),
    productGeneration: 12,
    productTableSlot: 1,
    descriptor,
    uploadPage() {},
    pageLocation(pageId) {
      return pageId === 4 ? { flags: 1 } : undefined;
    },
    beginRetirePage(pageId) {
      events.push(`begin:${pageId}`);
    },
    completeRetirePage(pageId) {
      events.push(`complete:${pageId}`);
    },
    selectEvictionCandidates() {
      return [];
    },
    evidence() {
      return { productGeneration: 12, residentPages: 0 };
    }
  };
  const runtime = new GeometryPageStreamingRuntimeV1(device(), residency, {
    schedulerOptions: { maxConcurrentReads: 1, maxInFlightBytes: 262144 },
    readback: { slotCount: 2, bytesPerSlot: 64 }
  });
  runtime.registerProduct(source);
  let settled = false;
  const completion = new Promise((resolve) =>
    setTimeout(() => {
      settled = true;
      resolve();
    }, 0)
  );
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
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          resolveRead?.();
        },
        { once: true }
      );
      return new Promise((resolve) => {
        resolveRead = () =>
          resolve({
            productId: descriptor.productId.slice(),
            revision: 0,
            pageId: 0,
            decodedHash128: hash.subarray(0, 16),
            decodedPageHash128: hash.subarray(0, 16),
            bytes: page.slice().buffer
          });
      });
    },
    release() {}
  };
  const scheduler = new (
    await import("../../.test-dist/gpu/GeometryPageScheduler.js")
  ).GeometryPageSchedulerV1({
    maxConcurrentReads: 1,
    maxInFlightBytes: page.byteLength
  });
  const residency = {
    publicationActive: true,
    publicationChanged: new Signal(),
    productGeneration: 21,
    productTableSlot: 5,
    descriptor,
    uploadPage() {},
    evidence() {
      return { productGeneration: 21, residentPages: 0 };
    }
  };
  const runtime = new GeometryPageStreamingRuntimeV1(device(), residency, {
    scheduler,
    readback: { slotCount: 2, bytesPerSlot: 64 }
  });
  runtime.registerProduct(source);
  scheduler.ingestDemands([
    {
      productTableSlot: 5,
      productGeneration: 21,
      pageId: 0,
      priority: 10,
      currentViewMissing: true,
      shadow: false,
      predictive: false
    }
  ]);
  assert.equal(scheduler.state(21, 0), "producing-or-reading");
  runtime.destroy();
  assert.equal(aborted, true);
  assert.equal(scheduler.state(21, 0), "absent");
  assert.equal(scheduler.evidence().cancelled, 1);
  await scheduler.drainReads();
});

test("canonical residency feedback preserves raw multiplicity, order and full generation/slot rejection", async () => {
  const { GeometryPageStreamingRuntimeV1 } = await import(
    "../../.test-dist/gpu/GeometryPageStreamingRuntime.js"
  );
  const abi = await import("../../.test-dist/gpu/GeometryPageDemandAbiV1.js");
  const { GeometryPageSchedulerV1 } = await import("../../.test-dist/gpu/GeometryPageScheduler.js");
  const events = [];
  const residency = {
    productGeneration: 0x80000001,
    productTableSlot: 0xfffffffe,
    publicationActive: true,
    publicationChanged: new Signal(),
    descriptor: {
      productId: new Uint8Array(32),
      revision: 0,
      decodedPageBytes: 16,
      pageRecords: new Uint8Array(64)
    },
    touchPage: (page, frame) => events.push(["touch", page, frame]),
    recordDemand: (page, frame, missing, predictive) =>
      events.push(["demand", page, frame, missing, predictive]),
    evidence: () => ({})
  };
  const scheduler = new GeometryPageSchedulerV1({ maxConcurrentReads: 1, maxInFlightBytes: 16 });
  const runtime = new GeometryPageStreamingRuntimeV1(device(), residency, { scheduler });
  runtime.registerProduct({
    descriptor: residency.descriptor,
    readPage: () => new Promise(() => {}),
    release() {}
  });
  const record = {
    productGeneration: residency.productGeneration,
    productTableSlot: residency.productTableSlot,
    pageId: 0,
    priority: 2,
    currentViewMissing: false,
    shadow: false,
    predictive: false
  };
  const records = [
    { ...record, residentUsage: true },
    { ...record, shadow: true },
    { ...record, predictive: true },
    { ...record, residentUsage: true },
    { ...record, productGeneration: 1 },
    { ...record, productTableSlot: 1 },
    { ...record, pageId: 5 }
  ];
  const bytes = new Uint8Array(16 + records.length * 16);
  bytes.set(
    abi.packGeometryPageDemandHeaderV1({
      attempted: records.length,
      capacity: records.length,
      overflow: 0,
      frameRevisionLow: 12
    })
  );
  records.forEach((d, i) => bytes.set(abi.packGeometryPageDemandV1(d), 16 + i * 16));
  const expected = [];
  for (let i = 0; i < records.length; i++) {
    const d = abi.unpackGeometryPageDemandV1(bytes, 16 + i * 16);
    if (
      d.productGeneration !== residency.productGeneration ||
      d.productTableSlot !== residency.productTableSlot ||
      d.pageId >= 2
    )
      continue;
    expected.push(
      d.residentUsage
        ? ["touch", d.pageId, 12]
        : ["demand", d.pageId, 12, d.currentViewMissing || d.shadow, d.predictive]
    );
  }
  const batch = scheduler.ingestDemandReadback(bytes);
  assert.equal(runtime.recordResidencyFeedback(batch, 12), true);
  assert.deepEqual(events, expected);
  events.length = 0;
  residency.publicationActive = false;
  runtime.recordResidencyFeedback(batch, 12);
  assert.deepEqual(events, []);
  runtime.destroy();
});

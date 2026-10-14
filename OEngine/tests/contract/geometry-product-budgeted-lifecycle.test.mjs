import assert from "node:assert/strict";
import test from "node:test";
import { streamingProductFixture } from "../helpers/geometry-product-fixture.mjs";
import { GeometryProductMultiRuntimeV1 } from "../../.test-dist/gpu/GeometryProductMultiRuntime.js";
import {
  geometryProductGpuBudgetEvidence,
  reserveGeometryProductGpuBytes,
  reserveGeometryProductMetadataBytes,
} from "../../.test-dist/gpu/GeometryProductGpuBudget.js";
import { selectGeometryProductResidencyProfileV1 } from "../../.test-dist/gpu/GeometryProductResidencyProfile.js";
import {
  encodeGeometryProductGpuLocationV1,
  validateGeometryProductGpuLocationV1,
} from "../../.test-dist/gpu/GeometryProductGpuAbiV1.js";
import { GeometryDemandReadbackRingV1 } from "../../.test-dist/gpu/GeometryDemandReadbackRing.js";
import { GeometryPageSchedulerV1 } from "../../.test-dist/gpu/GeometryPageScheduler.js";
import { GeometryPageStreamingRuntimeV1 } from "../../.test-dist/gpu/GeometryPageStreamingRuntime.js";

globalThis.GPUBufferUsage ??= { STORAGE: 128, COPY_DST: 8, MAP_READ: 1 };
const MiB = 1024 * 1024;
function device() {
  const buffers = [];
  let fences = 0;
  return {
    lost: new Promise(() => {}),
    buffers,
    get fences() {
      return fences;
    },
    limits: {
      maxBufferSize: 256 * MiB,
      maxStorageBufferBindingSize: 256 * MiB,
      maxStorageBuffersPerShaderStage: 16,
    },
    createBuffer(descriptor) {
      const buffer = {
        ...descriptor,
        destroy() {
          this.destroyed = true;
        },
      };
      buffers.push(buffer);
      return buffer;
    },
    queue: {
      writeBuffer() {},
      async onSubmittedWorkDone() {
        fences++;
      },
    },
  };
}
const demand = (slot, generation, pageId, priority = 0) => ({
  productTableSlot: slot,
  productGeneration: generation,
  pageId,
  priority,
  currentViewMissing: true,
  predictive: false,
  shadow: false,
});

test("page content stamps cover all referencing assets without dirtying unrelated asset ranges", async () => {
  for (const shared of [false, true]) {
    const fixture = await streamingProductFixture(3);
    const records = new Uint8Array(256);
    records.set(fixture.descriptor.assetRecords, 0);
    records.set(fixture.descriptor.assetRecords, 128);
    if (!shared) {
      const view = new DataView(records.buffer);
      // The second asset owns only the bootstrap group on page 0.
      for (const offset of [76, 84, 92, 104, 108, 112]) view.setUint32(128 + offset, 1, true);
    }
    fixture.descriptor.assetRecords = records;
    const runtime = new GeometryProductMultiRuntimeV1(device(), {
      metadataBytes: 64 * 1024,
      residency: { configuredCapacityBytes: 2 * MiB },
    });
    try {
      const { residency } = await runtime.load(fixture.source);
      const initial = [...residency.assetContentRevisions];
      assert.equal(residency.tryUploadPage(await fixture.source.readPage(1)), true);
      assert.ok(residency.assetContentRevisions[0] > initial[0]);
      assert.equal(residency.assetContentRevisions[1] > initial[1], shared);
      const uploaded = [...residency.assetContentRevisions];
      residency.beginRetirePage(1);
      assert.ok(residency.assetContentRevisions[0] > uploaded[0]);
      assert.equal(residency.assetContentRevisions[1] > uploaded[1], shared);
    } finally {
      runtime.destroy();
    }
  }
});

test("payload accounting follows publication, retirement, reload and release rather than cumulative uploads", async () => {
  const gpu = device();
  const writes = [];
  gpu.queue.writeBuffer = (buffer, _offset, data) => {
    if (buffer.label.includes(" bank ")) writes.push(data.byteLength);
  };
  const runtime = new GeometryProductMultiRuntimeV1(gpu, {
    metadataBytes: 64 * 1024,
    residency: { configuredCapacityBytes: 2 * MiB },
  });
  const fixture = await streamingProductFixture(3);
  const { residency } = await runtime.load(fixture.source);
  const initial = residency.evidence();
  assert.equal(initial.totalPages, 3);
  assert.equal(
    initial.residentPayloadBytes,
    writes.reduce((a, b) => a + b, 0),
  );
  const page = await fixture.source.readPage(1);
  const stampBefore = residency.assetContentRevisions[0];
  assert.equal(residency.tryUploadPage(page), true);
  assert.ok(residency.assetContentRevisions[0] > stampBefore);
  assert.equal(residency.assetContentRevisions[0], residency.contentRevision);
  const uploadedStamp = residency.assetContentRevisions[0];
  assert.equal(residency.tryUploadPage(page), true);
  assert.equal(
    residency.assetContentRevisions[0],
    uploadedStamp,
    "duplicate upload cannot create caster churn",
  );
  const uploaded = residency.evidence();
  const payload = uploaded.residentPayloadBytes - initial.residentPayloadBytes;
  assert.equal(
    uploaded.residentPayloadBytes,
    writes.reduce((a, b) => a + b, 0),
  );
  assert.equal(uploaded.residentInternalSlackBytes, uploaded.residentBytes - uploaded.residentPayloadBytes);
  residency.beginRetirePage(1);
  assert.ok(residency.assetContentRevisions[0] > uploadedStamp);
  const retiredStamp = residency.assetContentRevisions[0];
  const pending = residency.evidence();
  assert.equal(pending.residentPayloadBytes, initial.residentPayloadBytes);
  assert.equal(pending.retiringPayloadBytes, payload);
  assert.ok(pending.retiringBytes >= payload);
  residency.completeRetirePage(1);
  assert.equal(residency.assetContentRevisions[0], retiredStamp, "fence only frees already-revoked bytes");
  assert.equal(residency.evidence().retiringPayloadBytes, 0);
  assert.equal(residency.tryUploadPage(page), true);
  assert.ok(residency.assetContentRevisions[0] > retiredStamp);
  const streamer = new GeometryPageStreamingRuntimeV1(gpu, residency);
  const activeRevision = streamer.contentRevision;
  residency.deactivatePublication();
  assert.ok(streamer.contentRevision > activeRevision, "withdrawal must wake source invalidation");
  const inactiveRevision = streamer.contentRevision;
  residency.activatePublication();
  assert.ok(streamer.contentRevision > inactiveRevision, "restoration must wake source invalidation");
  streamer.destroy();
  assert.equal(residency.evidence().residentPayloadBytes, uploaded.residentPayloadBytes);
  assert.ok(residency.evidence().uploadedBytes > residency.evidence().residentPayloadBytes);
  const sections = runtime.evidence().metadataSections;
  assert.equal(sections.page.usedRecords, 3);
  assert.equal(sections.page.usedBytes, 48);
  await runtime.release(0, residency.productGeneration);
  assert.ok(Object.values(runtime.evidence().metadataSections).every((s) => s.usedRecords === 0));
  assert.equal(residency.evidence().residentPayloadBytes, 0);
  assert.equal(residency.evidence().retiringPayloadBytes, 0);
  runtime.destroy();
  assert.equal(geometryProductGpuBudgetEvidence(gpu).totalBytes, 0);
});

test("geometry peak is simultaneous bank plus metadata capacity, not a sum of independent peaks", () => {
  const gpu = device();
  const releaseMetadata = reserveGeometryProductMetadataBytes(gpu, 128 * MiB);
  releaseMetadata();
  const releaseBank = reserveGeometryProductGpuBytes(gpu, 512 * MiB);
  const releaseSmallMetadata = reserveGeometryProductMetadataBytes(gpu, 64 * MiB);
  const evidence = geometryProductGpuBudgetEvidence(gpu);
  assert.equal(evidence.totalPeakBytes, 576 * MiB);
  assert.equal(evidence.peakBytes + evidence.metadataPeakBytes, 640 * MiB);
  releaseSmallMetadata();
  releaseBank();
  assert.equal(geometryProductGpuBudgetEvidence(gpu).totalBytes, 0);
});

test("page tail directory and decoded attributes never overwrite authored geometry", async () => {
  const gpu = device();
  const createBuffer = gpu.createBuffer.bind(gpu);
  gpu.createBuffer = (descriptor) => {
    const buffer = createBuffer(descriptor);
    buffer.bytes = new Uint8Array(descriptor.size);
    return buffer;
  };
  gpu.queue.writeBuffer = (buffer, offset, data) => {
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    buffer.bytes.set(bytes, offset);
  };
  const runtime = new GeometryProductMultiRuntimeV1(gpu, {
    metadataBytes: 64 * 1024,
    residency: { configuredCapacityBytes: 2 * MiB },
  });
  const fixture = await streamingProductFixture(2);
  const handle = await runtime.load(fixture.source);
  try {
    const residency = handle.residency;
    assert.equal(residency.tryUploadPage(await fixture.source.readPage(1)), true);
    assert.equal(residency.evidence().residentBytes, 2 * 262144);
    for (const pageId of [0, 1]) {
      const original = await fixture.source.readPage(pageId);
      const location = residency.pageLocation(pageId);
      assert.equal(location.residentBankIndex, location.bankIndex);
      assert.equal(location.residentSlotIndex, location.slotIndex);
      assert.equal(location.residentByteOffset, 0);
      const buffer = residency.bank(location.bankIndex);
      const base = location.slotIndex * 262144;
      assert.deepEqual(buffer.bytes.slice(base, base + 176), new Uint8Array(original.bytes, 0, 176));
      assert.deepEqual(buffer.bytes.slice(base + 176, base + 262144), new Uint8Array(262144 - 176));
      const view = new DataView(buffer.bytes.buffer, base, 176);
      const vertexDataOffset = view.getUint32(56, true);
      assert.deepEqual(
        [0, 1, 2].map((axis) => view.getFloat32(vertexDataOffset + axis * 4, true)),
        [-0.5, -0.5, 0],
      );
    }
  } finally {
    runtime.destroy();
  }
  assert.equal(geometryProductGpuBudgetEvidence(gpu).totalBytes, 0);
});

test("budget/profile final slots round trip with an explicit physical capacity", () => {
  const limits = device().limits;
  for (const [profile, bytes, last] of [
    ["auto", 128 * MiB, 127],
    ["Portable", 512 * MiB, 511],
    ["Balanced", 768 * MiB, 767],
    ["HighEnd", 1024 * MiB, 1023],
  ]) {
    const plan = selectGeometryProductResidencyProfileV1(limits, { requestedProfile: profile });
    assert.equal(plan.capacityBytes, bytes);
    for (const slot of new Set([0, Math.min(511, last), Math.min(512, last), Math.min(767, last), last])) {
      const encoded = encodeGeometryProductGpuLocationV1({
        bankIndex: 3,
        slotIndex: slot,
        residentBankIndex: 2,
        residentSlotIndex: slot,
        productGeneration: 19,
        flags: 1,
      });
      assert.equal(validateGeometryProductGpuLocationV1(encoded, 19, plan.slotsPerBank).valid, true);
      assert.equal(new DataView(encoded.buffer).getUint32(4, true) >>> 16, 2 * 2048 + slot + 1);
      assert.equal(validateGeometryProductGpuLocationV1(encoded, 20, plan.slotsPerBank).valid, false);
    }
  }
  const aboveSmallPool = encodeGeometryProductGpuLocationV1({
    bankIndex: 0,
    slotIndex: 128,
    residentBankIndex: 1,
    residentSlotIndex: 128,
    productGeneration: 1,
    flags: 1,
  });
  assert.equal(validateGeometryProductGpuLocationV1(aboveSmallPool, 1, 128).valid, false);
});

test("metadata reuse exceeds cumulative capacity; one GPU directory and fenced slot retirement", async () => {
  const gpu = device();
  const runtime = new GeometryProductMultiRuntimeV1(gpu, {
    metadataBytes: 64 * 1024,
    residency: { configuredCapacityBytes: 4 * MiB },
  });
  const fixture = await streamingProductFixture(3);
  let handle = await runtime.load(fixture.source);
  assert.equal(gpu.buffers.length, 5); // scene directory + four banks, no shard heap/table
  assert.equal(handle.residency.evidence().metadataBytes, 0);
  let finish;
  const fence = new Promise((resolve) => {
    finish = resolve;
  });
  const retiring = runtime.release(handle.productTableSlot, handle.productGeneration, fence);
  await assert.rejects(
    runtime.load(fixture.source, { productTableSlot: handle.productTableSlot }),
    /occupied/,
  );
  finish();
  await retiring;
  for (let cycle = 0; cycle < 100; cycle++) {
    const next = await runtime.load((await streamingProductFixture(3, cycle)).source, {
      productTableSlot: 0,
    });
    assert.equal(next.assetReferenceBegin, 0);
    const replacement = await runtime.replace(0, (await streamingProductFixture(3, cycle + 1)).source);
    assert.notEqual(replacement.assetReferenceBegin, next.assetReferenceBegin);
    await runtime.retire(0, next.productGeneration);
    // A revoke from the old generation cannot reach replacement metadata.
    runtime.publishPageLocation(0, next.productGeneration, 0, undefined);
    assert.ok(replacement.residency.pageLocation(0));
    await runtime.release(0, replacement.productGeneration);
  }
  assert.equal(runtime.evidence().retiring, 0);
  assert.equal(geometryProductGpuBudgetEvidence(gpu).metadataBytes, 64 * 1024);
  assert.ok(gpu.fences >= 200);
  runtime.destroy();
  assert.equal(geometryProductGpuBudgetEvidence(gpu).totalBytes, 0);
});

test("1/8/64/66 Products replay every source, slot, generation and published asset range", async () => {
  for (const count of [1, 8, 64, 66]) {
    const gpu = device();
    const runtime = new GeometryProductMultiRuntimeV1(gpu, {
      slotCapacity: 66,
      residency: { configuredCapacityBytes: 64 * MiB },
    });
    const fixtures = [];
    const originals = [];
    for (let index = 0; index < count; index++) {
      const fixture = await streamingProductFixture(2);
      fixtures.push(fixture);
      originals.push(await runtime.load(fixture.source)); // deliberately same revision
    }
    const checkpoint = runtime.checkpointForDeviceLoss();
    assert.equal(checkpoint.products.length, count);
    assert.ok(fixtures.every((fixture) => fixture.releases === 0));
    const recovered = new GeometryProductMultiRuntimeV1(device(), checkpoint.options);
    for (const [index, product] of checkpoint.products.entries()) {
      const shard = await recovered.load(product.source, product);
      assert.equal(shard.productGeneration, originals[index].productGeneration);
      assert.equal(shard.assetReferenceBegin, originals[index].assetReferenceBegin);
    }
    assert.equal(recovered.evidence().active, count);
    recovered.destroy();
    assert.ok(fixtures.every((fixture) => fixture.releases === 1));
    assert.equal(geometryProductGpuBudgetEvidence(gpu).totalBytes, 0);
  }
});

test("demand encode abort/retry, mapping failure siblings and device-loss reset", async () => {
  let fail = false;
  const ring = new GeometryDemandReadbackRingV1({
    bytesPerSlot: 16,
    slotCount: 3,
    async mapCompletedSlot(slot) {
      if (fail && slot.index === 1) throw new Error("map failure");
      return slot.storage;
    },
  });
  const first = ring.reserve(1, () => {});
  assert.deepEqual(await ring.poll(2), []);
  ring.cancel(first);
  const retry = ring.reserve(1, () => {});
  ring.commit(retry);
  ring.submit(2, () => {});
  fail = true;
  await assert.rejects(ring.poll(3), /mapping failed/);
  assert.equal(ring.evidence().inUse, 0);
  ring.reset();
  fail = false;
  ring.submit(1, () => {});
  const results = await ring.poll(2);
  assert.equal(results.length, 1);
  ring.release(results[0].slotIndex);
});

test("reset after mapping settlement cannot release or report the replacement epoch", async () => {
  let fail = true;
  const ring = new GeometryDemandReadbackRingV1({
    bytesPerSlot: 16,
    slotCount: 2,
    async mapCompletedSlot(slot) {
      if (fail && slot.index === 1) throw new Error("revoked mapping");
      return slot.storage;
    },
  });
  ring.submit(1, () => {});
  ring.submit(2, () => {});
  const old = ring.poll(3);
  queueMicrotask(() => {
    ring.reset();
    fail = false;
    ring.submit(1, () => {});
  });
  assert.deepEqual(await old, []);
  assert.equal(ring.evidence().inUse, 1);
  const next = await ring.poll(2);
  assert.equal(next.length, 1);
  ring.release(next[0].slotIndex);
});

test("verified bytes remain bounded and both IO/upload service make progress across 66 Products", async () => {
  const scheduler = new GeometryPageSchedulerV1({
    maxConcurrentReads: 4,
    maxInFlightBytes: 8 * 262144,
    maxUploadBytesPerFrame: 262144,
    adaptive: false,
  });
  const fixtures = [];
  for (let slot = 0; slot < 66; slot++) {
    const fixture = await streamingProductFixture(3);
    fixtures.push(fixture);
    scheduler.registerProduct(slot, slot + 1, fixture.source);
  }
  const demands = [];
  for (let slot = 0; slot < 66; slot++) {
    demands.push(demand(slot, slot + 1, 1, slot === 0 ? 65535 : 0));
    demands.push(demand(slot, slot + 1, 2, slot === 0 ? 65535 : 0));
  }
  scheduler.ingestDemands(demands);
  const uploaded = [];
  const sink = {
    uploadPage(_page, identity) {
      uploaded.push(identity);
    },
  };
  for (let tick = 0; tick < 180 && uploaded.length < demands.length; tick++) {
    await scheduler.drainReads();
    assert.ok(scheduler.evidence().inFlightBytes + scheduler.evidence().verifiedBytes <= 8 * 262144);
    scheduler.drainUploadBudget(sink);
    scheduler.tick(tick);
  }
  assert.equal(uploaded.length, demands.length);
  assert.equal(new Set(uploaded.slice(0, 66).map((identity) => identity.productTableSlot)).size, 66);
  assert.equal(scheduler.evidence().verifiedBytes, 0);
  for (let generation = 1; generation <= 66; generation++) scheduler.unregisterProduct(generation);
  assert.ok(fixtures.every((fixture) => fixture.releases === 1));
});

test("rejected consumer fence retains slots/ranges until a successful retirement", async () => {
  const runtime = new GeometryProductMultiRuntimeV1(device(), {
    metadataBytes: 64 * 1024,
    residency: { configuredCapacityBytes: 2 * MiB },
  });
  const fixture = await streamingProductFixture(2);
  const handle = await runtime.load(fixture.source);
  await assert.rejects(
    runtime.release(0, handle.productGeneration, Promise.reject(new Error("consumer failed"))),
    /consumer failed/,
  );
  assert.equal(runtime.evidence().retiring, 1);
  assert.equal(fixture.releases, 0);
  await assert.rejects(
    runtime.load((await streamingProductFixture(2)).source, { productTableSlot: 0 }),
    /occupied/,
  );
  await runtime.retire(0, handle.productGeneration);
  assert.equal(fixture.releases, 1);
  runtime.destroy();
});

test("Product withdrawal cancels verified/late IO before fenced retirement and dormancy can resume", async () => {
  const gpu = device();
  const runtime = new GeometryProductMultiRuntimeV1(gpu, {
    residency: { configuredCapacityBytes: 4 * MiB },
  });
  const fixture = await streamingProductFixture(3);
  let lateRead;
  let readSignal;
  const source = {
    ...fixture.source,
    readPage(pageId, signal) {
      if (pageId !== 2) return fixture.source.readPage(pageId, signal);
      readSignal = signal;
      return new Promise((resolve) => {
        lateRead = async () => resolve(await fixture.source.readPage(pageId));
      });
    },
  };
  const first = await runtime.load(source);
  const streaming = new GeometryPageStreamingRuntimeV1(gpu, first.residency, {
    schedulerOptions: { maxConcurrentReads: 1, maxInFlightBytes: 262144 },
    readback: { bytesPerSlot: 64 },
  });
  streaming.registerProduct(source);
  streaming.scheduler.ingestDemands([demand(0, first.productGeneration, 1)]);
  await streaming.scheduler.drainReads();
  assert.equal(streaming.scheduler.evidence().verifiedBytes, 262144);
  runtime.setDormant(0, first.productGeneration);
  assert.equal(streaming.scheduler.evidence().verifiedBytes, 0);
  assert.equal(streaming.scheduler.state(first.productGeneration, 1), "absent");
  runtime.setDormant(0, first.productGeneration, false);
  streaming.scheduler.ingestDemands([demand(0, first.productGeneration, 2)]);
  assert.equal(readSignal.aborted, false);
  const nextFixture = await streamingProductFixture(3, 1);
  const next = await runtime.replace(0, nextFixture.source);
  assert.equal(readSignal.aborted, true);
  streaming.registerProduct(nextFixture.source, next.residency);
  await runtime.retire(0, first.productGeneration);
  await lateRead();
  await streaming.scheduler.drainReads();
  assert.equal(streaming.scheduler.evidence().verifiedBytes, 0);
  assert.equal(streaming.scheduler.state(first.productGeneration, 2), "absent");
  assert.equal(streaming.evidence().products.length, 1);
  assert.equal(fixture.releases, 1);
  await runtime.release(0, next.productGeneration);
  assert.equal(streaming.evidence().products.length, 0);
  assert.equal(nextFixture.releases, 1);
  streaming.destroy();
  runtime.destroy();
});

test("late cancelled activation and failed replacement cannot republish into a reused slot", async () => {
  const runtime = new GeometryProductMultiRuntimeV1(device(), {
    metadataBytes: 64 * 1024,
    residency: { configuredCapacityBytes: 4 * MiB },
  });
  const fixture = await streamingProductFixture(2);
  let finishRead;
  const source = {
    ...fixture.source,
    readPage: (pageId) =>
      new Promise((resolve) => {
        finishRead = async () => resolve(await fixture.source.readPage(pageId));
      }),
  };
  const pending = runtime.load(source, { productTableSlot: 0 });
  const failure = assert.rejects(pending, /released|cancelled|destroyed/);
  const generation = 1;
  const retirement = runtime.release(0, generation);
  await finishRead();
  await failure;
  await retirement;
  assert.equal(fixture.releases, 1);
  const active = await runtime.load((await streamingProductFixture(2)).source, { productTableSlot: 0 });
  const failed = await streamingProductFixture(2, 1);
  await assert.rejects(
    runtime.replace(0, {
      ...failed.source,
      readPage: async () => {
        throw new Error("IO failed");
      },
    }),
    /IO failed/,
  );
  assert.equal(runtime.shard(0).productGeneration, active.productGeneration);
  assert.equal(failed.releases, 1);
  assert.ok(active.residency.pageLocation(0));
  runtime.destroy();
});

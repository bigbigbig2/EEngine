import assert from "node:assert/strict";
import test from "node:test";
import { streamingProductFixture } from "../helpers/geometry-product-fixture.mjs";
import { GeometryProductMultiRuntimeV1 } from "../../.test-dist/gpu/GeometryProductMultiRuntime.js";
import { geometryProductGpuBudgetEvidence } from "../../.test-dist/gpu/GeometryProductGpuBudget.js";
import { selectGeometryProductResidencyProfileV1 } from "../../.test-dist/gpu/GeometryProductResidencyProfile.js";
import {
  encodeGeometryProductGpuLocationV1,
  validateGeometryProductGpuLocationV1
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
      maxStorageBuffersPerShaderStage: 16
    },
    createBuffer(descriptor) {
      const buffer = {
        ...descriptor,
        destroy() {
          this.destroyed = true;
        }
      };
      buffers.push(buffer);
      return buffer;
    },
    queue: {
      writeBuffer() {},
      async onSubmittedWorkDone() {
        fences++;
      }
    }
  };
}
const demand = (slot, generation, pageId, priority = 0) => ({
  productTableSlot: slot,
  productGeneration: generation,
  pageId,
  priority,
  currentViewMissing: true,
  predictive: false,
  shadow: false
});

test("budget/profile final slots round trip with an explicit physical capacity", () => {
  const limits = device().limits;
  for (const [profile, bytes, last] of [
    ["auto", 128 * MiB, 127],
    ["Portable", 512 * MiB, 511],
    ["Balanced", 768 * MiB, 767],
    ["HighEnd", 1024 * MiB, 1023]
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
        flags: 1
      });
      assert.equal(validateGeometryProductGpuLocationV1(encoded, 19, plan.slotsPerBank).valid, true);
      assert.equal(new DataView(encoded.buffer).getUint32(4, true) >>> 16, 2 * 1024 + slot + 1);
      assert.equal(validateGeometryProductGpuLocationV1(encoded, 20, plan.slotsPerBank).valid, false);
    }
  }
  const aboveSmallPool = encodeGeometryProductGpuLocationV1({
    bankIndex: 0,
    slotIndex: 128,
    residentBankIndex: 1,
    residentSlotIndex: 128,
    productGeneration: 1,
    flags: 1
  });
  assert.equal(validateGeometryProductGpuLocationV1(aboveSmallPool, 1, 128).valid, false);
});

test("metadata reuse exceeds cumulative capacity; one GPU directory and fenced slot retirement", async () => {
  const gpu = device();
  const runtime = new GeometryProductMultiRuntimeV1(gpu, {
    metadataBytes: 64 * 1024,
    residency: { configuredCapacityBytes: 4 * MiB }
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
    /occupied/
  );
  finish();
  await retiring;
  for (let cycle = 0; cycle < 100; cycle++) {
    const next = await runtime.load((await streamingProductFixture(3, cycle)).source, {
      productTableSlot: 0
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
      residency: { configuredCapacityBytes: 64 * MiB }
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
    }
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
    }
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
    adaptive: false
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
    }
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
    residency: { configuredCapacityBytes: 2 * MiB }
  });
  const fixture = await streamingProductFixture(2);
  const handle = await runtime.load(fixture.source);
  await assert.rejects(
    runtime.release(0, handle.productGeneration, Promise.reject(new Error("consumer failed"))),
    /consumer failed/
  );
  assert.equal(runtime.evidence().retiring, 1);
  assert.equal(fixture.releases, 0);
  await assert.rejects(
    runtime.load((await streamingProductFixture(2)).source, { productTableSlot: 0 }),
    /occupied/
  );
  await runtime.retire(0, handle.productGeneration);
  assert.equal(fixture.releases, 1);
  runtime.destroy();
});

test("Product withdrawal cancels verified/late IO before fenced retirement and dormancy can resume", async () => {
  const gpu = device();
  const runtime = new GeometryProductMultiRuntimeV1(gpu, {
    residency: { configuredCapacityBytes: 4 * MiB }
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
    }
  };
  const first = await runtime.load(source);
  const streaming = new GeometryPageStreamingRuntimeV1(gpu, first.residency, {
    schedulerOptions: { maxConcurrentReads: 1, maxInFlightBytes: 262144 },
    readback: { bytesPerSlot: 64 }
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
    residency: { configuredCapacityBytes: 4 * MiB }
  });
  const fixture = await streamingProductFixture(2);
  let finishRead;
  const source = {
    ...fixture.source,
    readPage: (pageId) =>
      new Promise((resolve) => {
        finishRead = async () => resolve(await fixture.source.readPage(pageId));
      })
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
      }
    }),
    /IO failed/
  );
  assert.equal(runtime.shard(0).productGeneration, active.productGeneration);
  assert.equal(failed.releases, 1);
  assert.ok(active.residency.pageLocation(0));
  runtime.destroy();
});

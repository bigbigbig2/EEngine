import assert from "node:assert/strict";
import test from "node:test";
import { GeometryProductBytePool } from "../../.test-dist/gpu/GeometryProductBytePool.js";
import { GeometryProductMultiRuntimeV1 } from "../../.test-dist/gpu/GeometryProductMultiRuntime.js";
import { geometryProductGpuBudgetEvidence } from "../../.test-dist/gpu/GeometryProductGpuBudget.js";
import { selectGeometryProductResidencyProfileV1 } from "../../.test-dist/gpu/GeometryProductResidencyProfile.js";
import { streamingProductFixture } from "../helpers/geometry-product-fixture.mjs";
import { geometryPublicationCommand } from "../helpers/geometry-publication.mjs";

globalThis.GPUBufferUsage ??= { STORAGE: 128, COPY_DST: 8, COPY_SRC: 4 };
function device() {
  const buffers = [];
  return {
    buffers,
    limits: {
      maxBufferSize: 16 * 1024 * 1024,
      maxStorageBufferBindingSize: 16 * 1024 * 1024,
      maxStorageBuffersPerShaderStage: 16,
    },
    queue: {
      writeBuffer(buffer, offset, bytes) {
        buffer.bytes.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset);
      },
      onSubmittedWorkDone: () => Promise.resolve(),
    },
    createBuffer(descriptor) {
      const buffer = {
        ...descriptor,
        bytes: new Uint8Array(descriptor.size),
        destroyed: false,
        getMappedRange() {
          return this.bytes.buffer;
        },
        unmap() {},
        destroy() {
          this.destroyed = true;
        },
      };
      buffers.push(buffer);
      return buffer;
    },
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function waitForCapacityRequest(runtime) {
  const deadline = performance.now() + 5000;
  while (!runtime.evidence().capacityPending) {
    assert.ok(performance.now() < deadline, "Admission did not reach metadata capacity preparation");
    await tick();
  }
}

test("query geometry snapshots require complete offscreen coverage and own immutable directories", async () => {
  const gpu = device();
  const fixture = await streamingProductFixture(3);
  const runtime = new GeometryProductMultiRuntimeV1(gpu, { descriptors: [fixture.descriptor] });
  const { residency } = await runtime.load(fixture.source);
  assert.throws(() => residency.retainQueryGeometry(), /not available/);
  assert.equal(residency.evidence().querySnapshots, 0);
  residency.stagePage(await fixture.source.readPage(2));
  const aborted = geometryPublicationCommand();
  residency.preparePublication(aborted, [2]);
  const discarded = residency.retainQueryGeometry(aborted);
  assert.deepEqual(discarded.pages.map((page) => page.pageId), [2]);
  const directoryBefore = discarded.segments[0].metadata.bytes.slice();
  aborted.abort(new Error("discard immutable candidate"));
  assert.equal(discarded.valid, false);
  assert.equal(discarded.segments[0].metadata.destroyed, true);
  const command = geometryPublicationCommand();
  residency.preparePublication(command, [2]);
  const snapshot = residency.retainQueryGeometry(command);
  command.submit();
  assert.equal(snapshot.valid, true);
  assert.deepEqual(snapshot.segments[0].metadata.bytes, directoryBefore);
  const header = new DataView(snapshot.segments[0].metadata.bytes.buffer);
  assert.equal(header.getUint32(0, true), 0x31445147);
  assert.equal(header.getUint32(16, true), snapshot.productGeneration);
  assert.equal(header.getUint32(32, true), 2, "only exact offscreen query cut is indexed");
  assert.equal(header.getUint32(32 + 80 + 4, true), snapshot.pages[0].location.byteOffset);
  residency.beginRetirePage(2);
  const retire = geometryPublicationCommand();
  residency.preparePublication(retire, []);
  retire.submit();
  await tick();
  assert.deepEqual(snapshot.segments[0].metadata.bytes, directoryBefore);
  await assert.rejects(snapshot.releaseAfter(Promise.reject(new Error("query fence failed"))), /query fence failed/);
  assert.equal(snapshot.valid, false);
  assert.equal(snapshot.segments[0].metadata.destroyed, false, "failed fence cannot reclaim resources");
  assert.equal(residency.evidence().retiringPages, 1);
  await snapshot.releaseAfter(Promise.resolve());
  assert.equal(snapshot.segments[0].metadata.destroyed, false, "an unrelated successful fence cannot clear poison");
  assert.equal(residency.evidence().retiringPages, 1);
  residency.abandonForDeviceLoss();
  assert.equal(snapshot.segments[0].metadata.destroyed, true);
  assert.equal(residency.evidence().retiringPages, 0);
  runtime.destroy();
  assert.equal(geometryProductGpuBudgetEvidence(gpu).totalBytes, 0);
});

test("query snapshots retain exact addresses through revoke, bank growth and Product destruction", async () => {
  const gpu = device();
  const fixture = await streamingProductFixture(3);
  const options = {
    configuredCapacityBytes: 4 * 1024 * 1024,
    initialBankBytes: 1024,
    maxPageLeases: 32,
  };
  const runtime = new GeometryProductMultiRuntimeV1(gpu, {
    descriptors: [fixture.descriptor],
    residency: options,
  });
  const { residency } = await runtime.load(fixture.source);
  residency.stagePage(await fixture.source.readPage(1));
  const publish = geometryPublicationCommand();
  residency.preparePublication(publish, [1]);
  assert.throws(() => residency.retainQueryPages([0]), /committed/);
  publish.submit();
  assert.throws(() => residency.retainQueryPages([0, 0]), /duplicate/);
  assert.throws(() => residency.retainQueryPages([0, 2]), /not available/);
  assert.throws(() => residency.retainQueryPages([0], publish), /exact open command/);
  assert.equal(residency.evidence().querySnapshots, 0, "failed acquisition is atomic");
  const snapshot = residency.retainQueryPages([0, 1]);
  const sibling = residency.retainQueryPages([1]);
  const oldBanks = snapshot.banks;
  const location = snapshot.pages[1].location;
  const oldBytes = oldBanks[location.bankIndex].bytes.slice(
    location.byteOffset,
    location.byteOffset + location.payloadBytes,
  );
  residency.beginRetirePage(1);
  assert.throws(() => residency.retainQueryPages([1]), /not available/);
  const revoke = geometryPublicationCommand();
  residency.preparePublication(revoke, []);
  revoke.submit();
  await tick();
  assert.equal(residency.pageLocation(1), undefined);
  assert.equal(residency.evidence().retiringPages, 1, "frame fence alone cannot release a query page");
  assert.equal(residency.tryStagePage(await fixture.source.readPage(1)), false);
  const pool = GeometryProductBytePool.retain(
    gpu,
    selectGeometryProductResidencyProfileV1(gpu.limits, options),
  );
  pool.requestGrowth(2048);
  const growth = geometryPublicationCommand();
  growth.onFinished.addOne(() => {
    throw new Error("growth observer failed");
  });
  GeometryProductBytePool.prepareDeviceFrame(gpu, growth);
  assert.throws(() => residency.retainQueryPages([0]), /committed/);
  assert.throws(() => pool.retainBanks(), /committed/);
  assert.throws(() => growth.submit(), /growth observer failed/);
  await tick();
  assert.equal(new Uint32Array(runtime.bindings().metadata.bytes.buffer)[12], 2048);
  assert.notEqual(pool.banks, oldBanks);
  assert.ok(
    oldBanks.every((bank) => !bank.destroyed),
    "BLAS snapshot retains its exact generation",
  );
  assert.deepEqual(
    oldBanks[location.bankIndex].bytes.subarray(
      location.byteOffset,
      location.byteOffset + location.payloadBytes,
    ),
    oldBytes,
  );
  snapshot.release();
  snapshot.release();
  assert.equal(residency.evidence().retiringPages, 1, "second AS still owns the page");
  sibling.release();
  assert.equal(residency.evidence().retiringPages, 0);
  assert.ok(oldBanks.every((bank) => bank.destroyed));
  assert.equal(residency.tryStagePage(await fixture.source.readPage(1)), true);
  const last = residency.retainQueryPages([0]);
  runtime.destroy();
  pool.releaseOwner();
  assert.ok(last.banks.every((bank) => !bank.destroyed));
  assert.ok(geometryProductGpuBudgetEvidence(gpu).totalBytes > 0);
  last.release();
  assert.ok(last.banks.every((bank) => bank.destroyed));
  assert.equal(geometryProductGpuBudgetEvidence(gpu).totalBytes, 0);
});

test("query pages survive failed retirement fences and device loss invalidates leases once", async () => {
  const gpu = device();
  const fixture = await streamingProductFixture(2);
  const runtime = new GeometryProductMultiRuntimeV1(gpu, { descriptors: [fixture.descriptor] });
  const { residency } = await runtime.load(fixture.source);
  residency.stagePage(await fixture.source.readPage(1));
  const publish = geometryPublicationCommand();
  residency.preparePublication(publish, [1]);
  publish.submit();
  const snapshot = residency.retainQueryPages([1]);
  residency.beginRetirePage(1);
  let reject;
  const fence = new Promise((_resolve, fail) => {
    reject = fail;
  });
  const revoke = geometryPublicationCommand(fence);
  residency.preparePublication(revoke, []);
  revoke.onFinished.addOne(() => {
    throw new Error("external observer failed");
  });
  assert.throws(() => revoke.submit(), /external observer failed/);
  assert.equal(
    residency.pageLocation(1),
    undefined,
    "resource transaction settles before external callbacks",
  );
  reject(new Error("query retirement failed"));
  await tick();
  snapshot.release();
  assert.equal(residency.evidence().retiringPages, 1);
  assert.match(residency.evidence().retirementError, /query retirement failed/);
  const lost = residency.retainQueryPages([0]);
  residency.abandonForDeviceLoss();
  lost.release();
  snapshot.release();
  assert.equal(residency.evidence().querySnapshots, 0);
  runtime.destroy();
  assert.equal(geometryProductGpuBudgetEvidence(gpu).totalBytes, 0);
});

test("failed query fences stay quarantined; destruction aborts growth-only snapshots", async () => {
  const gpu = device();
  const fixture = await streamingProductFixture(2);
  const options = { configuredCapacityBytes: 2 * 1024 * 1024, initialBankBytes: 1024, maxPageLeases: 8 };
  const runtime = new GeometryProductMultiRuntimeV1(gpu, {
    descriptors: [fixture.descriptor],
    residency: options,
  });
  const { residency } = await runtime.load(fixture.source);
  const snapshot = residency.retainQueryPages([0]);
  await assert.rejects(
    snapshot.releaseAfter(Promise.reject(new Error("last consumer failed"))),
    /last consumer failed/,
  );
  assert.equal(snapshot.valid, false);
  assert.equal(residency.evidence().queryPages, 1);
  await snapshot.releaseAfter(Promise.resolve());
  assert.equal(residency.evidence().queryPages, 1, "successful later fence cannot prove the failed query completed");
  const pool = GeometryProductBytePool.retain(
    gpu,
    selectGeometryProductResidencyProfileV1(gpu.limits, options),
  );
  pool.requestGrowth(2048);
  const growth = geometryPublicationCommand();
  GeometryProductBytePool.prepareDeviceFrame(gpu, growth);
  const candidate = residency.retainQueryPages([0], growth);
  residency.destroy();
  assert.equal(candidate.valid, false);
  assert.throws(() => growth.submit(), /already closed/);
  candidate.release();
  runtime.destroy();
  pool.releaseOwner();
  assert.ok(geometryProductGpuBudgetEvidence(gpu).totalBytes > 0);
  residency.abandonForDeviceLoss();
  assert.equal(geometryProductGpuBudgetEvidence(gpu).totalBytes, 0);
});

test("late device loss releases snapshots of a Product already removed from the directory", async () => {
  const gpu = device();
  let lose;
  gpu.lost = new Promise((resolve) => { lose = resolve; });
  const fixture = await streamingProductFixture(2);
  const runtime = new GeometryProductMultiRuntimeV1(gpu, { descriptors: [fixture.descriptor] });
  const { residency } = await runtime.load(fixture.source);
  const snapshot = residency.retainQueryPages([0]);
  runtime.destroy();
  assert.ok(geometryProductGpuBudgetEvidence(gpu).totalBytes > 0);
  lose({ reason: "destroyed" });
  await tick();
  assert.equal(snapshot.valid, false);
  snapshot.release();
  assert.equal(geometryProductGpuBudgetEvidence(gpu).totalBytes, 0);
});

test("query snapshots consume only their exact frame candidate and abort releases staged addresses", async () => {
  const gpu = device();
  const fixture = await streamingProductFixture(2);
  const options = { configuredCapacityBytes: 2 * 1024 * 1024, initialBankBytes: 1024, maxPageLeases: 8 };
  const runtime = new GeometryProductMultiRuntimeV1(gpu, {
    descriptors: [fixture.descriptor],
    residency: options,
  });
  const { residency } = await runtime.load(fixture.source);
  const pool = GeometryProductBytePool.retain(
    gpu,
    selectGeometryProductResidencyProfileV1(gpu.limits, options),
  );
  const page = await fixture.source.readPage(1);
  residency.stagePage(page);
  const abort = geometryPublicationCommand();
  residency.preparePublication(abort, [1]);
  assert.throws(
    () => residency.retainQueryPages([1], geometryPublicationCommand()),
    /exact open command/,
  );
  const snapshot = residency.retainQueryPages([1], abort);
  assert.equal(snapshot.valid, true);
  residency.releaseStagedPages([1]); // Aborts the encoding command before reuse.
  assert.equal(snapshot.valid, false);
  snapshot.release();
  assert.equal(residency.evidence().queryPages, 0);
  assert.equal(residency.evidence().stagedPages, 0);
  assert.equal(residency.tryStagePage(page), true);
  pool.requestGrowth(2048);
  const retry = geometryPublicationCommand();
  GeometryProductBytePool.prepareDeviceFrame(gpu, retry);
  residency.preparePublication(retry, [1]);
  const next = residency.retainQueryPages([1], retry);
  assert.equal(next.banks, pool.banks);
  retry.submit();
  assert.equal(next.valid, true);
  assert.equal(next.pages[0].location, residency.pageLocation(1));
  next.release();
  let reject;
  const failed = geometryPublicationCommand(
    new Promise((_resolve, fail) => {
      reject = fail;
    }),
  );
  const failedSnapshot = residency.retainQueryPages([0], failed);
  failed.submit();
  reject(new Error("snapshot submit failed"));
  await tick();
  assert.equal(failedSnapshot.valid, false);
  assert.equal(residency.evidence().queryPages, 1, "poison does not authorize address reuse");
  failedSnapshot.release();
  const callbackFailure = geometryPublicationCommand();
  const poisoned = residency.retainQueryPages([0], callbackFailure);
  callbackFailure.onFinished.addOne(() => {
    throw new Error("snapshot observer failed");
  });
  assert.throws(() => callbackFailure.submit(), /snapshot observer failed/);
  assert.equal(poisoned.valid, false);
  poisoned.release();
  runtime.destroy();
  pool.releaseOwner();
  assert.ok(geometryProductGpuBudgetEvidence(gpu).totalBytes > 0, "failed consumers survive ordinary teardown");
  residency.abandonForDeviceLoss();
  assert.equal(geometryProductGpuBudgetEvidence(gpu).totalBytes, 0);
});

test("two runtimes share compact banks and independent metadata without serializing page IO", async () => {
  const gpu = device();
  const fixtures = [await streamingProductFixture(2), await streamingProductFixture(2, 1)];
  const options = {
    descriptors: fixtures.map((fixture) => fixture.descriptor),
    residency: { configuredCapacityBytes: 4 * 1024 * 1024, maxPageLeases: 32 },
  };
  const runtime = new GeometryProductMultiRuntimeV1(gpu, options);
  const sibling = new GeometryProductMultiRuntimeV1(gpu, options);
  let startFirst;
  let releaseFirst;
  const started = new Promise((resolve) => {
    startFirst = resolve;
  });
  const paused = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const slowSource = {
    ...fixtures[0].source,
    async readPage(page, signal) {
      startFirst();
      await paused;
      return fixtures[0].source.readPage(page, signal);
    },
  };
  const pending = runtime.load(slowSource);
  await started;
  const second = await runtime.load(fixtures[1].source);
  assert.equal(second.productTableSlot, 1);
  releaseFirst();
  await pending;
  await sibling.load((await streamingProductFixture(2)).source);
  const a = runtime.bindings(),
    b = sibling.bindings();
  assert.equal(a.banks, b.banks);
  assert.notEqual(a.metadata, b.metadata);
  assert.ok(a.banks.reduce((bytes, bank) => bytes + bank.size, 0) < 4096);
  runtime.destroy();
  assert.ok(b.banks.every((bank) => !bank.destroyed));
  sibling.destroy();
  assert.equal(geometryProductGpuBudgetEvidence(gpu).totalBytes, 0);
});

test("growth peak failure is explicit and leaves the committed allocation usable", async () => {
  const gpu = device();
  const profile = selectGeometryProductResidencyProfileV1(gpu.limits, {
    configuredCapacityBytes: 1024 * 1024,
    initialBankBytes: 128 * 1024,
    maxPageLeases: 8,
  });
  const pool = GeometryProductBytePool.retain(gpu, profile);
  const leases = Array.from({ length: 4 }, () => pool.allocate(128 * 1024));
  const old = pool.banks;
  assert.equal(pool.allocate(16), undefined);
  const waiting = assert.rejects(pool.waitForGrowth(), /peak exceeds/);
  const command = geometryPublicationCommand();
  pool.prepareFrame(command);
  command.submit();
  await waiting;
  assert.equal(pool.banks, old);
  assert.equal(pool.evidence().lastFailure, "growth-budget");
  assert.equal(pool.allocate(16), undefined);
  assert.equal(pool.evidence().lastFailure, "growth-budget");
  for (const lease of leases) pool.release(lease);
  const last = pool.allocate(16);
  assert.ok(last);
  pool.release(last);
  pool.releaseOwner();
  assert.equal(geometryProductGpuBudgetEvidence(gpu).totalBytes, 0);
});

test("destroy returns activation reservations while source IO is still pending", async () => {
  const gpu = device();
  const fixture = await streamingProductFixture(2);
  const runtime = new GeometryProductMultiRuntimeV1(gpu, { descriptors: [fixture.descriptor] });
  let start;
  let finish;
  const started = new Promise((resolve) => {
    start = resolve;
  });
  const paused = new Promise((resolve) => {
    finish = resolve;
  });
  const source = {
    ...fixture.source,
    async readPage(page, signal) {
      start();
      await paused;
      return fixture.source.readPage(page, signal);
    },
  };
  const pending = runtime.load(source);
  const rejected = assert.rejects(pending, /destroyed|released|abort/i);
  await started;
  runtime.destroy();
  assert.equal(geometryProductGpuBudgetEvidence(gpu).totalBytes, 0);
  finish();
  await rejected;
  assert.equal(fixture.releases, 1);
});

test("one bank-growth frame publishes both runtime headers and withdrawal cancels that frame", async () => {
  const gpu = device();
  const fixture = await streamingProductFixture(2);
  const options = {
    descriptors: [fixture.descriptor],
    residency: { configuredCapacityBytes: 4 * 1024 * 1024, initialBankBytes: 1024, maxPageLeases: 32 },
  };
  const a = new GeometryProductMultiRuntimeV1(gpu, options);
  const b = new GeometryProductMultiRuntimeV1(gpu, options);
  const first = await a.load(fixture.source);
  await b.load((await streamingProductFixture(2, 1)).source);
  const left = a.bindings(),
    right = b.bindings();
  const old = left.banks;
  const pool = GeometryProductBytePool.retain(
    gpu,
    selectGeometryProductResidencyProfileV1(gpu.limits, options.residency),
  );
  pool.requestGrowth(2048);
  const aborted = geometryPublicationCommand();
  GeometryProductBytePool.prepareDeviceFrame(gpu, aborted);
  assert.equal(left.banks, right.banks);
  assert.notEqual(left.banks, old);
  a.setDormant(0, first.productGeneration);
  assert.equal(left.banks, old);
  assert.equal(right.banks, old);
  assert.equal(new Uint32Array(left.metadata.bytes.buffer)[12], 1024);
  a.setDormant(0, first.productGeneration, false);
  const command = geometryPublicationCommand();
  GeometryProductBytePool.prepareDeviceFrame(gpu, command);
  command.submit();
  assert.equal(new Uint32Array(left.metadata.bytes.buffer)[12], 2048);
  assert.equal(new Uint32Array(right.metadata.bytes.buffer)[12], 2048);
  await tick();
  assert.ok(old.every((bank) => bank.destroyed));
  a.destroy();
  b.destroy();
  pool.releaseOwner();
  assert.equal(geometryProductGpuBudgetEvidence(gpu).totalBytes, 0);
});

test("compact banks copy stable offsets, abort/retry unique epochs and retain old banks through fence", async () => {
  const gpu = device();
  const profile = selectGeometryProductResidencyProfileV1(gpu.limits, {
    configuredCapacityBytes: 4 * 1024 * 1024,
    initialBankBytes: 256,
    maxPageLeases: 32,
  });
  const pool = GeometryProductBytePool.retain(gpu, profile);
  const leases = Array.from({ length: 4 }, () => pool.allocate(176));
  for (const [index, lease] of leases.entries())
    gpu.queue.writeBuffer(pool.banks[lease.bankIndex], lease.byteOffset, new Uint32Array([100 + index]));
  const old = pool.banks;
  pool.exposeBindings();
  assert.equal(pool.allocate(176), undefined);
  const aborted = geometryPublicationCommand();
  pool.prepareFrame(aborted);
  const failedEpoch = pool.bindingEpoch;
  const discarded = pool.banks;
  assert.equal(pool.allocate(16), undefined);
  aborted.abort();
  assert.equal(pool.banks, old);
  assert.ok(discarded.every((buffer) => buffer.destroyed));
  let finish;
  const command = geometryPublicationCommand(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  pool.prepareFrame(command);
  assert.ok(pool.bindingEpoch > failedEpoch);
  assert.equal(command.copies.length, 4);
  command.submit();
  assert.ok(old.every((buffer) => !buffer.destroyed));
  for (const [index, lease] of leases.entries())
    assert.equal(
      new DataView(pool.banks[lease.bankIndex].bytes.buffer).getUint32(lease.byteOffset, true),
      100 + index,
    );
  const extra = pool.allocate(176);
  assert.ok(extra);
  finish();
  await tick();
  assert.ok(old.every((buffer) => buffer.destroyed));
  for (const lease of [...leases, extra]) pool.release(lease);
  pool.releaseOwner();
  assert.equal(geometryProductGpuBudgetEvidence(gpu).totalBytes, 0);
});

test("metadata growth preserves record indices and payload, retries in ordinary frame, retires after successful fence", async () => {
  const gpu = device();
  const fixture = await streamingProductFixture(3);
  const runtime = new GeometryProductMultiRuntimeV1(gpu, {
    slotCapacity: 1,
    metadataCapacities: { asset: 1, root: 1, hierarchy: 3, group: 3, page: 3, vertexFormat: 1 },
    residency: { configuredCapacityBytes: 4 * 1024 * 1024, initialBankBytes: 1024, maxPageLeases: 32 },
  });
  const first = await runtime.load(fixture.source);
  const bindings = runtime.bindings();
  const old = bindings.metadata;
  const firstRecord = runtime.tableRecord(0);
  const initialLocation = first.residency.pageLocation(0);
  const pending = runtime.load((await streamingProductFixture(3, 1)).source);
  await waitForCapacityRequest(runtime);
  const aborted = geometryPublicationCommand();
  GeometryProductBytePool.prepareDeviceFrame(gpu, aborted);
  const failed = bindings.metadata;
  const failedEpoch = bindings.bindingEpoch;
  assert.notEqual(failed, old);
  aborted.abort();
  assert.equal(bindings.metadata, old);
  assert.ok(failed.destroyed);
  await tick();
  let finish;
  const command = geometryPublicationCommand(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  GeometryProductBytePool.prepareDeviceFrame(gpu, command);
  assert.notEqual(bindings.bindingEpoch, failedEpoch);
  assert.equal(command.copies.length, 8);
  command.submit();
  const second = await pending;
  assert.equal(first.assetReferenceBegin, 0);
  assert.equal(second.assetReferenceBegin, 1);
  assert.deepEqual(runtime.tableRecord(0), firstRecord);
  assert.deepEqual(first.residency.pageLocation(0), initialLocation);
  const header = new Uint32Array(bindings.metadata.bytes.buffer, 0, 16);
  assert.equal(header[0], 6);
  assert.equal(
    new DataView(bindings.metadata.bytes.buffer).getUint32(header[4] * 4, true),
    first.productGeneration,
  );
  assert.ok(!old.destroyed);
  finish();
  await tick();
  assert.ok(old.destroyed);
  runtime.destroy();
  assert.equal(geometryProductGpuBudgetEvidence(gpu).totalBytes, 0);
});

test("pinned admission rejects the complete catalog before allocating GPU resources", async () => {
  const gpu = device();
  const fixture = await streamingProductFixture(2);
  fixture.descriptor.activationPageIds = new Uint32Array([0, 1]);
  assert.throws(() => new GeometryProductMultiRuntimeV1(gpu, {
    descriptors: [fixture.descriptor],
    residency: { maxPageLeases: 1 },
  }), /pinned activation exceeds/);
  assert.equal(gpu.buffers.length, 0);
  assert.equal(geometryProductGpuBudgetEvidence(gpu).totalBytes, 0);
});

test("fragmented banks reject a request even when aggregate free bytes suffice", () => {
  const gpu = device();
  const pool = GeometryProductBytePool.retain(gpu,
    selectGeometryProductResidencyProfileV1(gpu.limits, {
      configuredCapacityBytes: 1024 * 1024, initialBankBytes: 256, maxPageLeases: 32,
    }));
  const leases = Array.from({ length: 16 }, () => pool.allocate(64));
  assert.ok(leases.every(Boolean));
  const live = new Set(leases);
  for (const index of [4, 5, 6, 7, 12, 13, 14, 15]) {
    pool.release(leases[index]);
    live.delete(leases[index]);
  }
  assert.equal(pool.evidence().freeBytes, 512);
  assert.equal(pool.allocate(80), undefined);
  assert.equal(pool.evidence().lastFailure, "bytes-or-fragmentation");
  for (const index of [8, 9, 10, 11]) {
    pool.release(leases[index]);
    live.delete(leases[index]);
  }
  const coalesced = pool.allocate(176);
  assert.ok(coalesced);
  pool.release(coalesced);
  for (const lease of live) pool.release(lease);
  pool.releaseOwner();
  assert.equal(geometryProductGpuBudgetEvidence(gpu).totalBytes, 0);
});

test("one metadata section grows without increasing other record capacities", async () => {
  const gpu = device();
  const fixture = await streamingProductFixture(3);
  const runtime = new GeometryProductMultiRuntimeV1(gpu, {
    slotCapacity: 8,
    metadataCapacities: { asset: 16, root: 16, hierarchy: 16, group: 16, page: 3, vertexFormat: 16 },
  });
  try {
    const first = await runtime.load(fixture.source);
    const bindings = runtime.bindings();
    const before = runtime.evidence();
    const location = first.residency.pageLocation(0);
    const pending = runtime.load((await streamingProductFixture(3, 1)).source);
    await waitForCapacityRequest(runtime);
    const command = geometryPublicationCommand();
    GeometryProductBytePool.prepareDeviceFrame(gpu, command);
    command.submit();
    await pending;
    const after = runtime.evidence();
    for (const name of Object.keys(before.metadataSections)) {
      if (name === "page") {
        assert.ok(after.metadataSections[name].capacityRecords > before.metadataSections[name].capacityRecords);
      } else {
        assert.equal(after.metadataSections[name].capacityRecords, before.metadataSections[name].capacityRecords);
      }
    }
    assert.deepEqual(first.residency.pageLocation(0), location);
    const header = new Uint32Array(bindings.metadata.bytes.buffer);
    assert.equal(header[0], 6);
    assert.equal(header[12], bindings.banks[0].size);
  } finally {
    runtime.destroy();
  }
  assert.equal(geometryProductGpuBudgetEvidence(gpu).totalBytes, 0);
});

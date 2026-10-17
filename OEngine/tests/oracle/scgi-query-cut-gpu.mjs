import assert from "node:assert/strict";
import { GpuScene } from "../../.test-dist/gpu/GpuScene.js";
import { VirtualGeometryResidency } from "../../.test-dist/gpu/VirtualGeometryResidency.js";
import { GeometryQueryInstanceSnapshot } from "../../.test-dist/gpu/GeometryQueryInstanceSnapshot.js";
import { GeometryQueryWorkingSet } from "../../.test-dist/gpu/GeometryQueryWorkingSet.js";
import { GeometryQueryCoverage } from "../../.test-dist/gpu/GeometryQueryCoverage.js";
import { GeometryPageStreamingRuntimeV1 } from "../../.test-dist/gpu/GeometryPageStreamingRuntime.js";
import { ScgiQueryBatch } from "../../.test-dist/render/gi/ScgiQueryBatch.js";
import { geometryQueryCut } from "../../.test-dist/gpu/GeometryQueryCut.js";
import { streamingProductFixture } from "../helpers/geometry-product-fixture.mjs";
import { attachTriangleQuerySection } from "../helpers/geometry-query-fixture.mjs";
import { scgiGraphics, scgiCommand } from "./scgi-fixture.mjs";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const domain = { min: [-2, -2, -2], max: [2, 2, 2] };

async function spatialProduct() {
  const fixture = await streamingProductFixture(2);
  const pages = [];
  const descriptor = fixture.descriptor;
  for (let index = 0; index < 2; index++) {
    const source = await fixture.source.readPage(index);
    const page = new Uint8Array(source.bytes);
    const view = new DataView(page.buffer);
    view.setUint8(46, 0);
    view.setUint32(76, 0xffffffff, true);
    view.setFloat32(40, 0, true);
    if (index === 1) {
      for (const at of [16, 28, 88, 100, 116, 132, 148]) {
        view.setFloat32(at, view.getFloat32(at, true) + 100, true);
      }
      view.setFloat32(0, 100, true);
    }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", page));
    descriptor.pageRecords.set(digest.subarray(0, 16), index * 32);
    pages.push({ page, digest });
  }
  const asset = new DataView(descriptor.assetRecords.buffer);
  asset.setFloat32(60, 100.5, true);
  asset.setUint32(104, 2, true);
  asset.setUint32(108, 2, true);
  attachTriangleQuerySection(descriptor, pages);
  return { descriptor, async readPage(index) {
    return { productId: descriptor.productId.slice(), revision: descriptor.revision, pageId: index,
      bytes: pages[index].page.slice().buffer, decodedHash128: pages[index].digest.slice(0, 16),
      decodedPageHash128: pages[index].digest.slice(0, 16) };
  }, release() {} };
}

async function readStatus(device, graphics, coverage) {
  const read = device.createBuffer({ size: 48, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  try {
    const command = scgiCommand(graphics);
    coverage.encode(command);
    command.copyBufferToBuffer(coverage.status, 0, read, 0, 48);
    command.finish();
    await command.gpuDone;
    await read.mapAsync(GPUMapMode.READ);
    const result = new Uint32Array(read.getMappedRange().slice(0));
    read.unmap();
    return result;
  } finally {
    read.destroy();
  }
}

async function emptyDomainBatch(device, graphics, certificate) {
  const batch = device.createBuffer({ size: 160, usage: GPUBufferUsage.STORAGE |
    GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, mappedAtCreation: true });
  const rays = new Float32Array(batch.getMappedRange());
  rays.set([0, 0, 10, 0, 0, 0, 1, 1], 0);
  rays.set([0, 0, 10, 0, 0, 0, 1, 100], 12);
  batch.unmap();
  const output = device.createBuffer({ size: 128, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const read = device.createBuffer({ size: 64, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  let query;
  try {
    // Isolate the zero-shard consumer with the real GPU certificate above.
    // Complete Renderer composition remains the SCGI-8 integration boundary.
    query = await ScgiQueryBatch.create(device, { prepared: true, valid: true, shards: [],
      coverageStatus: certificate.status, observeUse() {} }, {
      batch, output, rayCount: 2, resultByteOffset: 96, view: identity, camera: [0, 0, 0],
      coneWidth: 0, coneSpread: 0, wavefrontRounds: 0,
    });
    const command = scgiCommand(graphics);
    query.encode(command);
    command.copyBufferToBuffer(batch, 96, read, 0, 64);
    command.finish();
    await command.gpuDone;
    await read.mapAsync(GPUMapMode.READ);
    const words = new Uint32Array(read.getMappedRange().slice(0));
    read.unmap();
    assert.equal(words[3], 1, "covered empty finite segment is a physical miss");
    assert.equal(words[11], 2, "out-of-domain empty segment is unknown");
  } finally {
    await device.queue.onSubmittedWorkDone();
    query?.destroy();
    batch.destroy();
    output.destroy();
    read.destroy();
  }
}

export async function runScgiQueryCutGpuOracle(device) {
  const graphics = scgiGraphics(device);
  const source = await spatialProduct();
  const product = await VirtualGeometryResidency.create(device, source, 29, 3, undefined, {
    configuredBankBytes: 512 * 1024, configuredCapacityBytes: 2 * 1024 * 1024,
    initialBankBytes: 512 * 1024,
  });
  product.activatePublication();
  const scene = new GpuScene(device, {});
  const transforms = new Float32Array([...identity, ...identity]);
  transforms[0] = -2;
  transforms[5] = 3;
  transforms[10] = 0.5;
  transforms[16 + 12] = 1000;
  const upload = scgiCommand(graphics);
  scene.instantiate({ count: 2, geometryHandles: [], virtualGeometry: {
    productTableSlot: product.productTableSlot, productGeneration: product.productGeneration, assetCount: 1,
  }, geometryIndices: new Uint32Array(2), materialHandles: new Uint32Array(2),
  currentTransforms: transforms, boundsSpheres: new Float32Array([50, 0, 0, 51, 50, 0, 0, 51]),
  boundsMin: new Float32Array([-0.5, -0.5, 0, -0.5, -0.5, 0]),
  boundsMax: new Float32Array([100.5, 0.5, 0, 100.5, 0.5, 0]),
  }, upload);
  upload.finish();
  await upload.gpuDone;
  const snapshot = new GeometryQueryInstanceSnapshot(device, scene);
  const streaming = new GeometryPageStreamingRuntimeV1(device, product);
  streaming.registerProduct(source, product);
  const materials = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE, mappedAtCreation: true });
  new Uint32Array(materials.getMappedRange()).set([0, 0, 0, 1]);
  materials.unmap();
  let demand, lease, coverage, stale;
  try {
    demand = await GeometryQueryWorkingSet.create(device, snapshot, product, {
      domain, voxelSize: 1, errorFraction: 0.1, receiver: [0, 0, 0], angularFootprint: 0.01,
      maximumBytes: 4096,
    });
    const command = scgiCommand(graphics);
    demand.encode(command, 7);
    command.finish();
    await command.gpuDone;
    assert.equal(await demand.consumeCompleted(7, streaming), undefined, "same frame is never mapped for work control");
    const cut = await demand.consumeCompleted(8, streaming);
    assert.ok(cut);
    assert.deepEqual(cut.clusters, [0]);
    assert.deepEqual(cut.pages, [0]);
    assert.equal(product.pageLocation(1), undefined, "far leaf was not pulled into the query working set");
    lease = product.retainQueryGeometry(undefined, 160, cut);
    assert.equal(lease.pages.length, 1);
    assert.equal(lease.queryPrimitiveCount, 1);
    coverage = await GeometryQueryCoverage.create(device, snapshot, [lease], materials, undefined, domain);
    assert.equal((await readStatus(device, graphics, coverage))[0], 0, "near cut covers the complete finite domain");
    stale = await GeometryQueryCoverage.create(device, snapshot, [lease], materials, undefined,
      { min: [-202, -2, -2], max: [-198, 2, 2] });
    assert.ok((await readStatus(device, graphics, stale))[0] & 16, "teleport cannot certify the old spatial cut");
    const full = geometryQueryCut(product.descriptor);
    let unavailable;
    try {
      const unexpected = product.retainQueryGeometry(undefined, 160, full);
      unexpected.release();
    } catch (error) {
      unavailable = error;
    }
    assert.ok(/not available/.test(String(unavailable)),
      "missing far coverage does not partially publish a full-world cut");
    assert.equal(lease.valid, true, "failed replacement keeps previous page leases");
    assert.equal(streaming.requestQueryCut(product, full), 1, "only the missing query page enters normal streaming");
    let overBudget;
    try {
      const unexpected = await GeometryQueryWorkingSet.create(device, snapshot, product, {
        domain, voxelSize: 1, errorFraction: 0.1, receiver: [0, 0, 0], angularFootprint: 0,
        maximumBytes: 1,
      });
      unexpected.destroy();
    } catch (error) {
      overBudget = error;
    }
    assert.ok(/resource budget/.test(String(overBudget)), "capacity failure must precede GPU allocation");
    await streaming.scheduler.drainReads();
    await streaming.consumeCompleted(9, performance.now());
    assert.deepEqual([...product.stagedPageIds], [1], "query IO stages through the existing scheduler");
    const cancel = scgiCommand(graphics);
    assert.equal(streaming.preparePublication(cancel), 1);
    const canceledCut = product.retainQueryGeometry(cancel, 160, full);
    assert.equal(canceledCut.pages.length, 2);
    cancel.abort(new Error("query cut candidate abort"));
    assert.equal(canceledCut.valid, false);
    assert.equal(lease.valid, true);
    assert.equal(product.pageLocation(1), undefined, "abort keeps the candidate page unpublished");
    const retry = scgiCommand(graphics);
    assert.equal(streaming.preparePublication(retry), 1);
    const completeCut = product.retainQueryGeometry(retry, 160, full);
    retry.finish();
    await retry.gpuDone;
    assert.equal(completeCut.valid, true);
    assert.equal(completeCut.pages.length, 2);
    product.beginRetirePage(1);
    const retire = scgiCommand(graphics);
    streaming.preparePublication(retire);
    retire.finish();
    await retire.gpuDone;
    assert.equal(product.pageLocation(1), undefined);
    assert.equal(completeCut.valid, true, "retained old cut survives page-directory revocation");
    completeCut.release();
    const emptyCut = geometryQueryCut(product.descriptor, [{ active: false, domain: null, maximumError: 0 }]);
    const emptyLease = product.retainQueryGeometry(undefined, 160, emptyCut);
    const emptyScene = new GpuScene(device, {});
    const emptySnapshot = new GeometryQueryInstanceSnapshot(device, emptyScene);
    const emptyCertificate = await GeometryQueryCoverage.create(device, emptySnapshot, [emptyLease], materials, undefined,
      { min: [-2, -2, 8], max: [2, 2, 12] });
    try {
      await readStatus(device, graphics, emptyCertificate);
      await emptyDomainBatch(device, graphics, emptyCertificate);
    } finally {
      emptyCertificate.destroy();
      emptyLease.release();
      emptySnapshot.destroy();
      emptyScene.destroy();
    }
    return { gpuDomainDemand: true, exactSpatialCut: cut.clusters, retainedPages: lease.pages.length,
      farPageAbsent: true, delayedFeedback: true, teleportUnknown: true, failedReplacementKeepsActive: true,
      negativeNonuniformTransform: true, emptyDomainMissAndUnknown: true,
      normalStreamingAbortRetry: true, oldCutSurvivesPageRevocation: true,
      demandBytes: demand.byteLength, queryDirectoryBytes: lease.metadataByteLength };
  } finally {
    await device.queue.onSubmittedWorkDone();
    demand?.destroy();
    coverage?.destroy();
    stale?.destroy();
    lease?.release();
    streaming.destroy();
    snapshot.destroy();
    scene.destroy();
    product.destroy();
    materials.destroy();
    graphics.buffer_allocator_main.destroy();
    graphics.buffer_allocator_staging.destroy();
  }
}

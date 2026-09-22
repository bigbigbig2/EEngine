import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

globalThis.GPUBufferUsage ??= Object.freeze({ COPY_DST: 8, STORAGE: 128 });

const { GeometryProductMultiRuntimeV1 } = await import("../../.test-dist/gpu/GeometryProductMultiRuntime.js");
const { unpackGeometryProductTableRecordV1 } = await import("../../.test-dist/gpu/GeometryProductGpuAbiV1.js");
const { HIERARCHICAL_VIRTUAL_WORK_GENERATION_WGSL } = await import("../../.test-dist/shaders/hierarchical_work_generation.js");
const { VIRTUAL_GEOMETRY_MESHLET_WORK_WGSL } = await import("../../.test-dist/shaders/virtual_geometry_work.js");
const {
  GPU_INSTANCE_RECORD_OFFSETS,
  GPU_INSTANCE_RECORD_STRIDE,
  GPU_INSTANCE_RECORD_WGSL,
  packGpuInstanceRecord
} = await import("../../.test-dist/gpu/GpuInstanceAbi.js");

function fakeDevice() {
  const writes = [];
  return {
    writes,
    limits: {
      maxBufferSize: 256 * 1024 * 1024,
      maxStorageBufferBindingSize: 128 * 1024 * 1024
    },
    createBuffer(descriptor) {
      return {
        ...descriptor,
        size: descriptor.size,
        destroy() { this.destroyed = true; }
      };
    },
    queue: {
      writeBuffer(buffer, offset, data) {
        const bytes = new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.byteLength).slice();
        writes.push({ buffer, offset, bytes });
      }
    }
  };
}

function makeFixture(revision = 0) {
  const payloads = [
    new Uint8Array(262144),
    new Uint8Array(262144).fill((revision + 1) & 0xff)
  ];
  const pageRecords = new Uint8Array(64);
  const pageView = new DataView(pageRecords.buffer);
  for (let pageId = 0; pageId < payloads.length; pageId++) {
    const hash = createHash("sha256").update(payloads[pageId]).digest();
    pageRecords.set(hash.subarray(0, 16), pageId * 32);
    pageView.setUint32(pageId * 32 + 16, pageId === 0 ? 0 : 1, true);
    pageView.setUint32(pageId * 32 + 20, pageId === 0 ? 1 : 0, true);
  }
  const assetRecords = new Uint8Array(128);
  const assetView = new DataView(assetRecords.buffer);
  assetRecords.fill(1, 0, 32);
  for (const [at, value] of [[72, 0], [76, 1], [80, 0], [84, 1], [88, 0], [92, 1], [96, 0], [100, 1], [104, 1], [108, 1], [112, 1], [116, 0]]) assetView.setUint32(at, value, true);
  for (const [at, value] of [[32, 0], [36, 0], [37, 0], [38, 1]]) assetView.setFloat32(at, value, true);
  const hierarchyNodes = new Uint8Array(48);
  const hierarchyView = new DataView(hierarchyNodes.buffer);
  hierarchyView.setFloat32(12, 1, true);
  hierarchyView.setUint32(44, 1, true);
  const groupDirectory = new Uint8Array(16);
  const groupView = new DataView(groupDirectory.buffer);
  groupView.setUint32(8, 64, true);
  groupView.setUint32(12, 1, true);
  const vertexFormats = new Uint8Array(16);
  const formatView = new DataView(vertexFormats.buffer);
  formatView.setUint16(0, 16, true);
  formatView.setUint16(2, 3, true);
  formatView.setUint8(5, 6);
  const descriptor = {
    schemaVersion: 1,
    productId: new Uint8Array(32).fill((2 + revision) & 0xff),
    revision,
    producerKind: "web-runtime",
    producerId: "phase-e-contract",
    producerVersion: "1",
    sourceIdentityKind: "session",
    sourceIdentityHash: new Uint8Array(32).fill(3),
    recipeHash: new Uint8Array(32).fill(4),
    runtimeProfile: "oengine-vg-v1-v3-decoded",
    decodedPageBytes: 262144,
    assetRecords,
    rootNodeIds: new Uint32Array([0]),
    hierarchyNodes,
    groupDirectory,
    pageRecords,
    bootstrapPageIds: new Uint32Array([0]),
    vertexFormats,
    activationPageIds: new Uint32Array([0])
  };
  const source = {
    descriptor,
    async readPage(pageId, signal) {
      if (signal?.aborted) throw signal.reason;
      const bytes = payloads[pageId];
      if (bytes === undefined) throw new Error(`unknown page ${pageId}`);
      const hash = createHash("sha256").update(bytes).digest();
      return {
        productId: descriptor.productId,
        revision,
        pageId,
        decodedHash128: descriptor.pageRecords.slice(pageId * 32, pageId * 32 + 16),
        decodedPageHash128: hash.subarray(0, 16),
        bytes: bytes.slice().buffer
      };
    },
    released: 0,
    release() { this.released++; }
  };
  return { descriptor, source, payloads };
}

function tableWrite(device, buffer, offset) {
  const writes = device.writes.filter((write) => write.buffer === buffer && write.offset === offset);
  return writes.at(-1)?.bytes;
}

test("Phase E multi-Product runtime keeps 64 independent shards and rejects stale identity", async () => {
  const device = fakeDevice();
  const runtime = new GeometryProductMultiRuntimeV1(device);
  const handles = [];
  const fixtures = [];
  for (let index = 0; index < 64; index++) {
    const fixture = makeFixture(index);
    fixtures.push(fixture);
    handles.push(await runtime.load(fixture.source));
  }
  const evidence = runtime.evidence();
  assert.equal(evidence.active, 64);
  assert.equal(evidence.peakActive, 64);
  assert.equal(evidence.slotCapacity, 64);
  assert.equal(new Set(handles.map((handle) => handle.productTableSlot)).size, 64);
  assert.equal(new Set(handles.map((handle) => handle.productGeneration)).size, 64);

  const first = handles[0];
  const firstPage = { productTableSlot: first.productTableSlot, productGeneration: first.productGeneration, pageId: 1 };
  assert.equal(runtime.acceptDemand(firstPage), true);
  assert.equal(runtime.acceptDemand({ ...firstPage, productGeneration: first.productGeneration + 100000 }), false);
  assert.equal(runtime.acceptDemand({ ...firstPage, pageId: 99 }), false);
  assert.equal(runtime.completePage(firstPage, await fixtures[0].source.readPage(1)), "uploaded");
  const corruptPage = await fixtures[0].source.readPage(1);
  corruptPage.decodedHash128 = new Uint8Array(16);
  assert.equal(runtime.completePage(firstPage, corruptPage), "rejected");
  assert.equal(await runtime.evictPage({ ...firstPage, pageId: 0 }), false);
  assert.equal(await runtime.evictPage(firstPage), true);
  assert.equal(first.residency.pageLocation(1), undefined);

  runtime.setDormant(first.productTableSlot, first.productGeneration, true);
  assert.equal(runtime.tableRecord(first.productTableSlot), undefined);
  assert.equal(runtime.acceptDemand(firstPage), false);
  runtime.setDormant(first.productTableSlot, first.productGeneration, false);
  assert.equal(runtime.tableRecord(first.productTableSlot)?.flags, 1);

  const replacementFixture = makeFixture(1000);
  const replacement = await runtime.replace(first.productTableSlot, replacementFixture.source);
  assert.notEqual(replacement.productGeneration, first.productGeneration);
  assert.equal(runtime.acceptDemand(firstPage), false);
  assert.equal(runtime.completePage(firstPage, await fixtures[0].source.readPage(1)), "stale");
  assert.equal(await runtime.retire(first.productTableSlot, first.productGeneration), true);
  assert.deepEqual(runtime.instanceIdentity(replacement.productTableSlot, replacement.productGeneration, 0), {
    productTableSlot: replacement.productTableSlot,
    productGeneration: replacement.productGeneration,
    assetRecordIndex: 0
  });
  assert.equal(runtime.instanceIdentity(replacement.productTableSlot, replacement.productGeneration, 99), undefined);

  const released = handles[1];
  assert.equal(await runtime.release(released.productTableSlot, released.productGeneration), true);
  const reusedFixture = makeFixture(2000);
  const reused = await runtime.load(reusedFixture.source, { productTableSlot: released.productTableSlot });
  assert.notEqual(reused.productGeneration, released.productGeneration);
  assert.equal(runtime.acceptDemand({ productTableSlot: released.productTableSlot, productGeneration: released.productGeneration, pageId: 0 }), false);

  const recordBytes = tableWrite(device, runtime.table, replacement.productTableSlot * 64);
  assert.ok(recordBytes);
  const record = unpackGeometryProductTableRecordV1(recordBytes);
  assert.equal(record.productGeneration, replacement.productGeneration);
  assert.equal(record.flags, 1);
  assert.equal(record.pageCount, 2);

  for (let slot = 0; slot < 64; slot++) {
    const handle = runtime.shard(slot);
    if (handle !== undefined) await runtime.release(handle.productTableSlot, handle.productGeneration);
  }
  const finalEvidence = runtime.evidence();
  assert.equal(finalEvidence.active, 0);
  assert.ok(finalEvidence.replacements >= 1);
  assert.ok(finalEvidence.evictions >= 1);
  assert.ok(finalEvidence.releases >= 64);
  runtime.destroy();
  assert.ok(fixtures.every((fixture) => fixture.source.released === 1));
  assert.equal(replacementFixture.source.released, 1);
  assert.equal(reusedFixture.source.released, 1);
});

test("ProductTableSlot is an explicit instance ABI lane without changing record stride", () => {
  const bytes = packGpuInstanceRecord({
    geometryRecordIndex: 3,
    geometryGeneration: 9,
    productTableSlot: 17,
    materialHandle: 4,
    flags: 1,
    debugId: 5,
    boundsSphere: [0, 0, 0, 1],
    boundsMin: [-1, -1, -1],
    boundsMax: [1, 1, 1],
    currentObjectToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    previousObjectToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  });
  const view = new DataView(bytes.buffer);
  assert.equal(bytes.byteLength, GPU_INSTANCE_RECORD_STRIDE);
  assert.equal(GPU_INSTANCE_RECORD_OFFSETS.product_table_slot, 168);
  assert.equal(view.getUint32(GPU_INSTANCE_RECORD_OFFSETS.product_table_slot, true), 17);
  assert.match(GPU_INSTANCE_RECORD_WGSL, /product_table_slot: u32/u);
  assert.match(GPU_INSTANCE_RECORD_WGSL, /oengine_instance_product_table_slot/u);
});

test("scene metadata relocates every second-Product range into one authoritative heap", async () => {
  const device = fakeDevice();
  const runtime = new GeometryProductMultiRuntimeV1(device, { metadataBytes: 2 * 1024 * 1024 });
  const firstFixture = makeFixture(3000);
  const secondFixture = makeFixture(3001);
  const first = await runtime.load(firstFixture.source);
  const second = await runtime.load(secondFixture.source);
  assert.deepEqual(runtime.tableRecord(first.productTableSlot), {
    productGeneration: first.productGeneration,
    flags: 1,
    assetBegin: 0, assetCount: 1,
    rootBegin: 0, rootCount: 1,
    hierarchyBegin: 0, hierarchyCount: 1,
    groupBegin: 0, groupCount: 1,
    pageBegin: 0, pageCount: 2,
    vertexFormatBegin: 0, vertexFormatCount: 1
  });
  assert.deepEqual(runtime.tableRecord(second.productTableSlot), {
    productGeneration: second.productGeneration,
    flags: 1,
    assetBegin: 1, assetCount: 1,
    rootBegin: 1, rootCount: 1,
    hierarchyBegin: 1, hierarchyCount: 1,
    groupBegin: 1, groupCount: 1,
    pageBegin: 2, pageCount: 2,
    vertexFormatBegin: 1, vertexFormatCount: 1
  });
  assert.equal(second.assetReferenceBegin, 1);
  const metadata = runtime.bindings().metadata;
  const header = device.writes.find((write) => write.buffer === metadata && write.offset === 0 && write.bytes.byteLength === 64);
  assert.ok(header);
  const headerWords = new Uint32Array(header.bytes.buffer, header.bytes.byteOffset, 16);
  const assetRecordsOffset = headerWords[6] * 4;
  const rootsOffset = headerWords[7] * 4;
  const hierarchyOffset = headerWords[8] * 4;
  const pageLocationsOffset = headerWords[10] * 4;
  const secondAsset = tableWrite(device, metadata, assetRecordsOffset + 128);
  assert.ok(secondAsset);
  const assetView = new DataView(secondAsset.buffer, secondAsset.byteOffset, secondAsset.byteLength);
  assert.equal(assetView.getUint32(72, true), 1);
  assert.equal(assetView.getUint32(80, true), 1);
  assert.equal(assetView.getUint32(88, true), 1);
  assert.equal(new DataView(tableWrite(device, metadata, rootsOffset + 4).buffer).getUint32(0, true), 1);
  assert.equal(new DataView(tableWrite(device, metadata, hierarchyOffset + 48).buffer).getUint32(44, true), 3);
  assert.ok(tableWrite(device, metadata, pageLocationsOffset + 2 * 16));
  assert.ok(tableWrite(device, metadata, pageLocationsOffset + 3 * 16));
  runtime.destroy();
});

test("multi-Product GPU work uses global demand-mask pages and per-instance generation", () => {
  assert.match(HIERARCHICAL_VIRTUAL_WORK_GENERATION_WGSL,
    /mask,\s*asset\.page_begin \+ page_id,\s*mask_word_count/u);
  assert.match(VIRTUAL_GEOMETRY_MESHLET_WORK_WGSL,
    /product_instances\[visible\.instance_record_index\]/u);
  assert.match(VIRTUAL_GEOMETRY_MESHLET_WORK_WGSL,
    /visible\.geometry_record_index,\s*oengine_instance_geometry_generation\(instance\)/u);
});

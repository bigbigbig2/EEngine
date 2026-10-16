import assert from "node:assert/strict";
import test from "node:test";

const abi = await import("../../.test-dist/gpu/GeometryProductGpuAbiV1.js");
const meshletAbi = await import("../../.test-dist/gpu/GpuMeshletRasterWorkAbi.js");
const { encodeGeometryProductGpuLocationV1, validateGeometryProductGpuLocationV1 } = abi;

test("Geometry ABI6 exact byte ranges retain full generation and all banks", () => {
  for (const bankIndex of [0, 1, 2, 3]) {
    for (const byteOffset of [0, 16, 176, 0x1fffff00, 0x3ffffff0]) {
      const location = { bankIndex, byteOffset, payloadBytes: 16, productGeneration: 11, flags: 3 };
      const bytes = encodeGeometryProductGpuLocationV1(location);
      assert.deepEqual(validateGeometryProductGpuLocationV1(bytes, 11), { ...location, valid: true, resident: true });
      assert.equal(validateGeometryProductGpuLocationV1(bytes, 12).valid, false);
      assert.equal(validateGeometryProductGpuLocationV1(bytes, 11, byteOffset + 16).valid, true);
      if (byteOffset > 0) assert.equal(validateGeometryProductGpuLocationV1(bytes, 11, byteOffset).valid, false);
    }
  }
  assert.equal(validateGeometryProductGpuLocationV1(encodeGeometryProductGpuLocationV1(undefined), 11).valid, false);
});

test("Geometry ABI6 rejects reserved bits, misalignment, overflow and stale generations", () => {
  const location = { bankIndex: 0, byteOffset: 16, payloadBytes: 176, productGeneration: 11, flags: 1 };
  for (const change of [{bankIndex: 4}, {byteOffset: 4}, {byteOffset: 0x3ffffff0},
    {payloadBytes: 0}, {payloadBytes: 262148}, {payloadBytes: 175}, {flags: 2}, {flags: 5},
    {productGeneration: 0}, {productGeneration: 0xffffffff}]) {
    assert.throws(() => encodeGeometryProductGpuLocationV1({...location, ...change}));
  }
  for (const [word, value] of [[0, 17], [1, 4], [2, 0], [3, 0], [3, 262148], [3, 175]]) {
    const bytes = encodeGeometryProductGpuLocationV1(location);
    new DataView(bytes.buffer).setUint32(word * 4, value, true);
    assert.equal(validateGeometryProductGpuLocationV1(bytes, 11).valid, false);
  }
});

test("virtual MeshletWork preserves 24-bit GroupID and 7-bit local MeshletID", () => {
  const slot = meshletAbi.encodeVirtualGeometryMeshletSlot(0x00fedcba, 127);
  assert.deepEqual(meshletAbi.decodeVirtualGeometryMeshletSlot(slot), {groupId: 0x00fedcba, localMeshlet: 127});
  assert.throws(() => meshletAbi.encodeVirtualGeometryMeshletSlot(0x01000000, 0), /invalid/);
});

test("Geometry Product GPU metadata records freeze product ranges and asset references", () => {
  const heap = {
    bankByteCapacity: 1024,
    productCount: 1,
    productCapacity: 2,
    totalWords: 144,
    productTableWordOffset: 16,
    assetReferenceWordOffset: 48,
    assetRecordWordOffset: 52,
    rootNodeIdWordOffset: 84,
    hierarchyWordOffset: 88,
    groupDirectoryWordOffset: 100,
    pageLocationWordOffset: 104,
    vertexFormatWordOffset: 108,
  };
  assert.deepEqual(
    abi.unpackGeometryProductMetadataHeapHeaderV1(abi.packGeometryProductMetadataHeapHeaderV1(heap)),
    heap,
  );
  assert.throws(
    () => abi.packGeometryProductMetadataHeapHeaderV1({ ...heap, assetReferenceWordOffset: 32 }),
    /offsets/,
  );
  const product = {
    productGeneration: 9,
    flags: 1,
    assetBegin: 4,
    assetCount: 2,
    rootBegin: 8,
    rootCount: 3,
    hierarchyBegin: 12,
    hierarchyCount: 7,
    groupBegin: 20,
    groupCount: 6,
    pageBegin: 30,
    pageCount: 5,
    vertexFormatBegin: 2,
    vertexFormatCount: 1,
  };
  const productBytes = abi.packGeometryProductTableRecordV1(product);
  assert.equal(productBytes.byteLength, 64);
  assert.deepEqual(abi.unpackGeometryProductTableRecordV1(productBytes), product);
  const reference = { productTableSlot: 5, productGeneration: 9, assetRecordIndex: 1, flags: 0 };
  assert.deepEqual(
    abi.unpackGeometryProductAssetReferenceV1(abi.packGeometryProductAssetReferenceV1(reference)),
    reference,
  );
  const bad = productBytes.slice();
  new DataView(bad.buffer).setUint32(60, 1, true);
  assert.throws(() => abi.unpackGeometryProductTableRecordV1(bad), /reserved/);
});

test("Geometry Product metadata heap CPU oracle fail-closes generation and resolves table word ranges", () => {
  const heap = {
    bankByteCapacity: 1024,
    productCount: 1,
    productCapacity: 1,
    totalWords: 128,
    productTableWordOffset: 16,
    assetReferenceWordOffset: 32,
    assetRecordWordOffset: 36,
    rootNodeIdWordOffset: 68,
    hierarchyWordOffset: 72,
    groupDirectoryWordOffset: 84,
    pageLocationWordOffset: 88,
    vertexFormatWordOffset: 92,
  };
  const bytes = new Uint8Array(heap.totalWords * 4);
  bytes.set(abi.packGeometryProductMetadataHeapHeaderV1(heap));
  bytes.set(
    abi.packGeometryProductTableRecordV1({
      productGeneration: 9,
      flags: 1,
      assetBegin: 0,
      assetCount: 1,
      rootBegin: 0,
      rootCount: 1,
      hierarchyBegin: 0,
      hierarchyCount: 1,
      groupBegin: 0,
      groupCount: 1,
      pageBegin: 0,
      pageCount: 1,
      vertexFormatBegin: 0,
      vertexFormatCount: 1,
    }),
    64,
  );
  bytes.set(
    abi.packGeometryProductAssetReferenceV1({
      productTableSlot: 0,
      productGeneration: 9,
      assetRecordIndex: 0,
      flags: 0,
    }),
    128,
  );
  const view = new DataView(bytes.buffer);
  for (const [offset, value] of [
    [72, 0],
    [76, 1],
    [80, 0],
    [84, 1],
    [88, 0],
    [92, 1],
  ])
    view.setUint32(144 + offset, value, true);
  assert.deepEqual(abi.resolveGeometryProductAssetFromHeapV1(bytes, 0, 9), {
    productTableSlot: 0,
    productGeneration: 9,
    assetWordOffset: 36,
    rootWordOffset: 68,
    rootCount: 1,
    hierarchyWordOffset: 72,
    hierarchyCount: 1,
    groupWordOffset: 84,
    groupCount: 1,
    pageBegin: 0,
    pageLocationWordOffset: 88,
    pageCount: 1,
    vertexFormatWordOffset: 92,
    vertexFormatCount: 1,
  });
  assert.equal(abi.resolveGeometryProductAssetFromHeapV1(bytes, 0, 10), undefined);
});

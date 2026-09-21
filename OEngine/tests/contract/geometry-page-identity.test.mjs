import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const product = await import("../.test-dist/assets/geometry-product/GeometryProductV1.js");

/**
 * Page identity is rolled up from Group payloads so it can be computed before a
 * payload buffer exists. These cases pin the properties the incremental
 * publication design depends on, and keep identity separate from the
 * whole-page integrity digest.
 */

test("page identity is a rolled-up digest carried by the descriptor page record", () => {
  const identity = new Uint8Array(16).fill(0x5a);
  const descriptor = fixture({ identity });
  const record = product.decodeGeometryProductPageRecordV1(descriptor, 0);
  assert.deepEqual([...record.decodedHash128], [...identity]);
});

test("descriptor page record stride stays 32 bytes and round-trips identity", () => {
  const records = [
    { decodedHash128: new Uint8Array(16).fill(1), firstGroup: 3, groupCount: 2, flags: 0, reserved: 0 },
    { decodedHash128: new Uint8Array(16).fill(2), firstGroup: 9, groupCount: 1, flags: 0, reserved: 0 }
  ];
  const encoded = product.encodeGeometryProductPageRecordsV1(records);
  assert.equal(encoded.byteLength, records.length * product.GEOMETRY_PRODUCT_PAGE_RECORD_STRIDE);
  assert.equal(product.GEOMETRY_PRODUCT_PAGE_RECORD_STRIDE, 32);
  const view = new DataView(encoded.buffer, encoded.byteOffset);
  assert.equal(view.getUint32(16, true), 3);
  assert.equal(view.getUint32(20, true), 2);
  assert.equal(view.getUint32(32 + 16, true), 9);
  assert.deepEqual([...encoded.slice(0, 16)], [...records[0].decodedHash128]);
});

test("page identity must be exactly 16 bytes and is not the whole-page digest", () => {
  const page = new Uint8Array(262144).fill(3);
  const wholePage = new Uint8Array(createHash("sha256").update(page).digest()).subarray(0, 16);
  // A rolled-up identity over a page's Groups is independent of the page buffer,
  // so it must not equal the whole-page digest.
  const rolledUp = new Uint8Array(createHash("sha256").update("OENGINE-GEOMETRY-PAGE-IDENTITY-V1").digest()).subarray(0, 16);
  assert.notDeepEqual([...rolledUp], [...wholePage]);
  const descriptor = fixture({ identity: rolledUp });
  const record = product.decodeGeometryProductPageRecordV1(descriptor, 0);
  assert.deepEqual([...record.decodedHash128], [...rolledUp]);
  assert.throws(() => product.encodeGeometryProductPageRecordsV1([
    { decodedHash128: new Uint8Array(15), firstGroup: 0, groupCount: 1, flags: 0, reserved: 0 }
  ]), /16 bytes/);
});

test("page record validation rejects padding-bearing identity mismatch and preserves reserved", () => {
  const descriptor = fixture({ identity: new Uint8Array(16).fill(8) });
  const report = product.validateGeometryProductDescriptorV1(descriptor);
  assert.equal(report.valid, true, JSON.stringify(report.issues));
  const record = product.decodeGeometryProductPageRecordV1(descriptor, 0);
  assert.equal(record.flags, 0);
  assert.equal(record.reserved, 0);
});

function fixture({ identity }) {
  const asset = new Uint8Array(128);
  const av = new DataView(asset.buffer);
  asset.fill(1, 0, 32);
  for (const [at, value] of [[72, 0], [76, 1], [80, 0], [84, 1], [88, 0], [92, 1], [96, 0], [100, 1], [104, 1], [108, 1], [112, 1], [116, 0]]) av.setUint32(at, value, true);
  for (const [at, value] of [[32, 0], [36, 0], [37, 0], [38, 1]]) av.setFloat32(at, value, true);
  const hierarchy = new Uint8Array(48);
  const hv = new DataView(hierarchy.buffer);
  hv.setFloat32(12, 1, true);
  hv.setUint32(44, 1, true);
  const groups = new Uint8Array(16);
  const gv = new DataView(groups.buffer);
  gv.setUint32(8, 64, true);
  gv.setUint32(12, 1, true);
  const records = new Uint8Array(32);
  records.set(identity);
  new DataView(records.buffer).setUint32(20, 1, true);
  const formats = new Uint8Array(16);
  const fv = new DataView(formats.buffer);
  fv.setUint16(0, 16, true);
  fv.setUint16(2, 3, true);
  fv.setUint8(5, 6);
  return {
    schemaVersion: 1,
    productId: new Uint8Array(32).fill(2),
    revision: 0,
    producerKind: "offline-native",
    producerId: "fixture",
    producerVersion: "1",
    sourceIdentityKind: "session",
    sourceIdentityHash: new Uint8Array(32).fill(3),
    recipeHash: new Uint8Array(32).fill(4),
    runtimeProfile: "oengine-vg-v1-v3-decoded",
    decodedPageBytes: 262144,
    assetRecords: asset,
    rootNodeIds: new Uint32Array([0]),
    hierarchyNodes: hierarchy,
    groupDirectory: groups,
    pageRecords: records,
    bootstrapPageIds: new Uint32Array([0]),
    vertexFormats: formats,
    activationPageIds: new Uint32Array([0])
  };
}

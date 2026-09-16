import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const binary = await import("../.test-dist/assets/geometry-product/GeometryProductBinaryV1.js");

function fixture() {
  const page = new Uint8Array(262144), hash = createHash("sha256").update(page).digest();
  const asset = new Uint8Array(128), av = new DataView(asset.buffer); asset.fill(1, 0, 32);
  for (const [at, value] of [[72, 0], [76, 1], [80, 0], [84, 1], [88, 0], [92, 1], [96, 0], [100, 1], [104, 1], [108, 1], [112, 1], [116, 0]]) av.setUint32(at, value, true);
  for (const [at, value] of [[32, 0], [36, 0], [37, 0], [38, 1]]) av.setFloat32(at, value, true);
  const hierarchy = new Uint8Array(48), hv = new DataView(hierarchy.buffer); hv.setFloat32(12, 1, true); hv.setUint32(44, 1, true);
  const groups = new Uint8Array(16), gv = new DataView(groups.buffer); gv.setUint32(8, 64, true); gv.setUint32(12, 1, true);
  const pages = new Uint8Array(32); pages.set(hash.subarray(0, 16)); new DataView(pages.buffer).setUint32(20, 1, true);
  const formats = new Uint8Array(16), fv = new DataView(formats.buffer); fv.setUint16(0, 16, true); fv.setUint16(2, 3, true); fv.setUint8(5, 6);
  return { schemaVersion: 1, productId: new Uint8Array(32).fill(2), revision: 4, replaces: { productId: new Uint8Array(32).fill(7), revision: 3 }, producerKind: "web-runtime", producerId: "oengine-web-nyx", producerVersion: "1.0-test", sourceIdentityKind: "session", sourceIdentityHash: new Uint8Array(32).fill(3), recipeHash: new Uint8Array(32).fill(4), runtimeProfile: "oengine-vg-v1-v3-decoded", decodedPageBytes: 262144, assetRecords: asset, rootNodeIds: new Uint32Array([0]), hierarchyNodes: hierarchy, groupDirectory: groups, pageRecords: pages, bootstrapPageIds: new Uint32Array([0]), vertexFormats: formats, activationPageIds: new Uint32Array([0]) };
}

test("Geometry Product descriptor binary V1 has canonical deterministic bytes and round-trips", () => {
  const descriptor = fixture(), encoded = binary.encodeGeometryProductDescriptorBinaryV1(descriptor), decoded = binary.decodeGeometryProductDescriptorBinaryV1(encoded);
  assert.equal(encoded.byteLength % 16, 0); assert.equal(new DataView(encoded).getUint32(0, true), binary.GEOMETRY_PRODUCT_BINARY_MAGIC_V1);
  assert.equal(decoded.producerId, descriptor.producerId); assert.equal(decoded.producerVersion, descriptor.producerVersion); assert.deepEqual([...decoded.productId], [...descriptor.productId]); assert.deepEqual([...decoded.rootNodeIds], [0]); assert.deepEqual(decoded.replaces, descriptor.replaces);
  assert.deepEqual(new Uint8Array(binary.encodeGeometryProductDescriptorBinaryV1(decoded)), new Uint8Array(encoded));
  assert.equal(createHash("sha256").update(new Uint8Array(encoded)).digest("hex"), "20e439c5cd9a9f580e41edde5f803123618ca28f854170b20298a743acbb1c0a");
});

test("Geometry Product descriptor binary V1 rejects reserved, alias, padding and trailing corruption", () => {
  const encoded = binary.encodeGeometryProductDescriptorBinaryV1(fixture());
  const corrupt = (mutate) => { const copy = encoded.slice(0); mutate(new Uint8Array(copy), new DataView(copy)); return copy; };
  assert.throws(() => binary.decodeGeometryProductDescriptorBinaryV1(corrupt((_b, v) => v.setUint32(124, 1, true))), /reserved/);
  assert.throws(() => binary.decodeGeometryProductDescriptorBinaryV1(corrupt((_b, v) => v.setUint32(84, v.getUint32(80, true), true))), /canonical/);
  assert.throws(() => binary.decodeGeometryProductDescriptorBinaryV1(corrupt((b, v) => { const rootEnd = v.getUint32(84, true) + 4; b[rootEnd] = 1; })), /padding/);
  const trailing = new Uint8Array(encoded.byteLength + 16); trailing.set(new Uint8Array(encoded)); new DataView(trailing.buffer).setUint32(12, trailing.byteLength, true); assert.throws(() => binary.decodeGeometryProductDescriptorBinaryV1(trailing.buffer), /trailing|missing/);
});

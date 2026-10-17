import assert from "node:assert/strict";
import test from "node:test";
import { geometryQueryDirectorySegments } from "../../.test-dist/gpu/GeometryQueryDirectory.js";
import { deepProductFixture } from "../helpers/geometry-product-fixture.mjs";

test("query directory segments preserve complete exact cuts and global primitive addresses", () => {
  const { descriptor } = deepProductFixture(7);
  new DataView(descriptor.assetRecords.buffer).setUint32(104, 8, true);
  const location = { bankIndex: 3, byteOffset: 1024, payloadBytes: 8 * 176,
    productGeneration: 19, flags: 1 };
  const pages = [{ pageId: 0, location }];
  const segments = geometryQueryDirectorySegments(descriptor, pages, 19, 288);
  assert.equal(segments.length, 4);
  const observed = [];
  for (const segment of segments) {
    assert.ok(segment.bytes.byteLength <= 288);
    const view = new DataView(segment.bytes.buffer);
    assert.equal(view.getUint32(0, true), 0x31445147);
    assert.equal(view.getUint32(16, true), 19);
    assert.equal(segment.primitiveCount, 2);
    assert.equal(segment.assets[0].cutCount, 2);
    for (let local = 0; local < 2; local++) {
      const at = 32 + local * 112;
      const primitive = view.getUint32(at + 64, true);
      observed.push(primitive);
      assert.equal(view.getUint32(at + 60, true), primitive);
      assert.equal(view.getUint32(at + 80, true), 3);
      assert.equal(view.getUint32(at + 84, true), 1024 + primitive * 176);
      assert.equal(view.getUint32(at + 88, true), 176);
      assert.equal(view.getUint32(at + 92, true), 19);
      assert.deepEqual(segment.bytes.subarray(at + 96, at + 112), descriptor.vertexFormats);
      assert.equal(view.getUint32(segment.prefixWordOffset * 4 + local * 4, true), primitive);
    }
    assert.equal(view.getUint32(segment.prefixWordOffset * 4 + 8, true), observed.length);
    assert.equal(segment.assets[0].primitiveBegin, observed.length - 2);
  }
  assert.deepEqual(observed, [0, 1, 2, 3, 4, 5, 6, 7]);
  const whole = geometryQueryDirectorySegments(descriptor, pages, 19, 65536);
  assert.equal(whole.length, 1);
  assert.equal(whole[0].primitiveCount, 8);
  assert.throws(() => geometryQueryDirectorySegments(descriptor, pages, 19, 159), /one complete cluster/);
  assert.throws(() => geometryQueryDirectorySegments(descriptor, [], 19, 288), /retained page/);
  assert.throws(() => geometryQueryDirectorySegments(descriptor, pages, 20, 288), /generation/);
  assert.throws(() => geometryQueryDirectorySegments(descriptor,
    [{ pageId: 0, location: { ...location, payloadBytes: 100 } }], 19, 288), /escapes/);
});

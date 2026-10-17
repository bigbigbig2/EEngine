import assert from "node:assert/strict";
import test from "node:test";
import { geometryQueryCut } from "../../.test-dist/gpu/GeometryQueryCut.js";
import { geometryQueryDirectorySegments } from "../../.test-dist/gpu/GeometryQueryDirectory.js";
import { validateGeometryProductQuerySection } from "../../.test-dist/assets/geometry-product/GeometryProductQuerySection.js";
import { cloneGeometryProductDescriptorV1 } from "../../.test-dist/assets/geometry-product/GeometryProductV1.js";
import { deepProductFixture, streamingProductFixture } from "../helpers/geometry-product-fixture.mjs";

test("a finite query cut omits unrelated clusters and retains source identity across cut changes", () => {
  const { descriptor: source } = deepProductFixture(5);
  const descriptor = cloneGeometryProductDescriptorV1(source);
  const section = validateGeometryProductQuerySection(descriptor);
  for (let cluster = 0; cluster < section.clusterCount; cluster++) {
    const at = section.clusters + cluster * 80;
    section.view.setFloat32(at + 32, cluster * 10, true);
    section.view.setFloat32(at + 44, cluster * 10 + 1, true);
  }
  const full = geometryQueryCut(descriptor);
  const finite = geometryQueryCut(descriptor, [{ active: true, maximumError: 100,
    domain: { min: [19, -1, -1], max: [31, 1, 1] } }]);
  assert.deepEqual(full.clusters, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(finite.clusters, [2, 3]);
  assert.equal(finite.primitiveCount, 2);
  const pages = [{ pageId: 0, location: { bankIndex: 0, byteOffset: 0,
    payloadBytes: 6 * 176, productGeneration: 17 } }];
  for (const cut of [finite, full]) {
    const segments = geometryQueryDirectorySegments(descriptor, pages, 17, 288, cut);
    const identities = [];
    for (const segment of segments) {
      const view = new DataView(segment.bytes.buffer);
      assert.equal(view.getUint32(4, true), 2);
      for (let cluster = 0; cluster < view.getUint32(8, true); cluster++) {
        const at = 32 + cluster * 112;
        const remapWord = view.getUint32(at + 72, true);
        identities.push(view.getUint32(remapWord * 4, true));
      }
    }
    assert.deepEqual(identities, cut.clusters);
  }
  assert.throws(() => geometryQueryCut(descriptor, []), /complete Product asset domain/);
  assert.throws(() => geometryQueryDirectorySegments(source, pages, 17, 288, finite), /different immutable Product/);
});

test("unproven coarse geometry cannot replace thin or alpha coverage even at a huge error budget", async () => {
  const { descriptor } = await streamingProductFixture(6);
  const cut = geometryQueryCut(descriptor, [{ active: true, domain: null, maximumError: 1e30 }]);
  assert.deepEqual(cut.clusters, [5]);
  assert.deepEqual(cut.pages, [5]);
  assert.equal(cut.primitiveCount, 1);
});

test("empty query demand produces a complete empty directory and no page pins", () => {
  const { descriptor } = deepProductFixture(1);
  const cut = geometryQueryCut(descriptor, [{ active: false, domain: null, maximumError: 0 }]);
  assert.deepEqual(cut.clusters, []);
  assert.deepEqual(cut.pages, []);
  const [segment] = geometryQueryDirectorySegments(descriptor, [], 17, 160, cut);
  assert.equal(segment.primitiveCount, 0);
  assert.equal(segment.assets[0].cutCount, 0);
  assert.equal(segment.bytes.byteLength, 48);
  assert.equal(new DataView(segment.bytes.buffer).getUint32(segment.prefixWordOffset * 4, true), 0);
});

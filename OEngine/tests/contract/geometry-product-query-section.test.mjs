import assert from "node:assert/strict";
import test from "node:test";
import { triangleProductFixture, streamingProductFixture } from "../helpers/geometry-product-fixture.mjs";
import { validateGeometryProductQuerySection } from "../../.test-dist/assets/geometry-product/GeometryProductQuerySection.js";
import { prepareProductResidentAttributes } from "../../.test-dist/assets/geometry-product/GeometryProductResidentAttributes.js";
import { cloneGeometryProductDescriptorV1 } from "../../.test-dist/assets/geometry-product/GeometryProductV1.js";

test("query section retains the exact terminal cut independently of raster bootstrap pages", async () => {
  const fixture = await streamingProductFixture(4);
  const section = validateGeometryProductQuerySection(fixture.descriptor);
  assert.equal(section.clusterCount, 4);
  const u32 = (at) => section.view.getUint32(at, true);
  assert.deepEqual([...fixture.descriptor.bootstrapPageIds], [0]);
  assert.equal(u32(section.assets + 12), 1);
  assert.equal(u32(section.minimumCut), 3);
  assert.equal(u32(section.minimumPages), 3);
  for (let cluster = 0; cluster < 4; cluster++) {
    const at = section.clusters + cluster * 80;
    assert.equal(u32(at), cluster);
    assert.equal(u32(at + 24), cluster === 3 ? 5 : 6);
    assert.equal(u32(at + 64), cluster === 3 ? 0 : 1);
    const page = await fixture.source.readPage(cluster);
    prepareProductResidentAttributes(fixture.descriptor, cluster, page.bytes);
  }
});

test("query validation rejects malformed extents, coverage, cycles and duplicate references", async () => {
  const { descriptor } = await streamingProductFixture(3);
  const original = validateGeometryProductQuerySection(descriptor);
  const mutations = [
    (view) => view.setUint32(76, original.clusters + 4, true),
    (view) => view.setUint32(original.minimumCut, 0, true),
    (view) => view.setUint32(original.minimumPages, 0, true),
    (view) => view.setUint32(original.children, 0, true),
    (view) => view.setUint32(original.clusters + 80 + 4, 0, true),
    (view) => view.setUint32(original.clusters + 76, 1, true),
    (view) => view.setUint32(original.assets + 24, 1, true),
    (view) => view.setUint32(16, 0, true),
  ];
  for (const mutate of mutations) {
    const candidate = cloneGeometryProductDescriptorV1(descriptor);
    mutate(new DataView(candidate.querySection.buffer));
    assert.throws(() => validateGeometryProductQuerySection(candidate), RangeError);
  }
});

test("query metadata cannot substitute different material or refinement for shared page bytes", () => {
  const { descriptor, page } = triangleProductFixture();
  const candidate = cloneGeometryProductDescriptorV1(descriptor);
  const section = validateGeometryProductQuerySection(candidate);
  const query = new DataView(candidate.querySection.buffer);
  query.setUint32(section.clusters + 16, 7, true);
  assert.throws(() => prepareProductResidentAttributes(candidate, 0, page.buffer), /disagrees/);
  query.setUint32(section.clusters + 16, 0, true);
  new DataView(page.buffer).setUint32(76, 0, true);
  assert.throws(() => prepareProductResidentAttributes(candidate, 0, page.buffer), /refinement/);
});

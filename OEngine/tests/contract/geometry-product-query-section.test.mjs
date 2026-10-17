import assert from "node:assert/strict";
import test from "node:test";
import { triangleProductFixture, streamingProductFixture } from "../helpers/geometry-product-fixture.mjs";
import { validateGeometryProductQuerySection, verifyGeometryProductQueryContent,
  geometryProductQueryPrimitiveIdentity } from "../../.test-dist/assets/geometry-product/GeometryProductQuerySection.js";
import { prepareProductResidentAttributes } from "../../.test-dist/assets/geometry-product/GeometryProductResidentAttributes.js";
import { cloneGeometryProductDescriptorV1, snapshotGeometryProductSourceV1 } from "../../.test-dist/assets/geometry-product/GeometryProductV1.js";

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

test("query content digest authenticates source remaps as well as cluster tables", async () => {
  const { descriptor } = triangleProductFixture();
  const captured = cloneGeometryProductDescriptorV1(descriptor);
  const section = validateGeometryProductQuerySection(captured);
  await verifyGeometryProductQueryContent(section);
  assert.equal(section.primitiveCount, 1);
  assert.equal(section.vertexCount, 3);
  assert.equal(geometryProductQueryPrimitiveIdentity(section, 0, 0), 0);
  assert.throws(() => geometryProductQueryPrimitiveIdentity(section, 0, 1), /outside its cluster/);
  assert.deepEqual([...new Uint32Array(captured.querySection.buffer, section.vertices, 3)], [0, 1, 2]);
  section.view.setUint32(section.vertices, 2, true);
  await assert.rejects(verifyGeometryProductQueryContent(section), /content hash mismatch/);
});

test("exact minimum cut has a bijection to original triangles and rejects unsupported query ABI", async () => {
  const fixture = await streamingProductFixture(4);
  const captured = cloneGeometryProductDescriptorV1(fixture.descriptor);
  const section = validateGeometryProductQuerySection(captured);
  const leaf = section.view.getUint32(section.minimumCut, true);
  assert.equal(geometryProductQueryPrimitiveIdentity(section, leaf, 0), 0);
  const remap = section.view.getUint32(section.clusters + leaf * 80 + 72, true);
  section.view.setUint32(section.primitives + remap * 4, 1, true);
  assert.throws(() => validateGeometryProductQuerySection(captured), /escapes source primitives/);
  section.view.setUint32(4, 2, true);
  assert.throws(() => validateGeometryProductQuerySection(captured), /unsupported.*recook/);
});

test("source capture isolates all metadata before IO and forwards receiver, priority and release", async () => {
  const fixture = await streamingProductFixture(3);
  const provider = {
    descriptor: fixture.descriptor,
    sceneAssetIndices: [7],
    calls: [],
    readPage(page, signal) { this.calls.push([page, signal]); return fixture.source.readPage(page, signal); },
    readPages(pages, signal, priority) {
      this.calls.push([[...pages], signal, priority]);
      return Promise.all([...pages].map((page) => fixture.source.readPage(page, signal)));
    },
    release() { this.calls.push("release"); },
  };
  const source = snapshotGeometryProductSourceV1(provider);
  assert.equal(snapshotGeometryProductSourceV1(source), source);
  const original = source.descriptor.querySection.slice();
  provider.descriptor.recipeHash.fill(0);
  provider.descriptor.activationPageIds.fill(2);
  provider.sceneAssetIndices[0] = 99;
  assert.deepEqual(source.descriptor.querySection, original);
  assert.equal(source.descriptor.recipeHash[0], 4);
  assert.deepEqual([...source.descriptor.activationPageIds], [0]);
  assert.deepEqual(source.sceneAssetIndices, [7]);
  await verifyGeometryProductQueryContent(validateGeometryProductQuerySection(source.descriptor));
  await source.readPage(0);
  await source.readPages([1, 2], undefined, 2);
  source.release();
  assert.deepEqual(provider.calls, [[0, undefined], [[1, 2], undefined, 2], "release"]);
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

test("finite decoded vertices cannot escape advertised query or raster bounds", () => {
  const { descriptor, page } = triangleProductFixture();
  // The descriptor and meshlet header still advertise the original bounds.
  // This is finite payload corruption, not a NaN or an invalid byte offset.
  new DataView(page.buffer).setFloat32(116, -2, true);
  assert.throws(() => prepareProductResidentAttributes(descriptor, 0, page.buffer),
    /bounds do not contain decoded vertex/);
});

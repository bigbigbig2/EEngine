import assert from "node:assert/strict";
import test from "node:test";
import { triangleProductFixture, deepProductFixture } from "../helpers/geometry-product-fixture.mjs";
import {
  geometryProductWorkload,
  geometryProductSceneWorkload,
  geometryProductMeshletWorkCapacity,
  validateGeometryProductSceneWorkLimits,
} from "../../.test-dist/assets/geometry-product/GeometryProductWorkload.js";
import {
  buildVirtualGeometrySceneSourceV1,
  mergeVirtualGeometryProductSceneSourcesV1,
} from "../../.test-dist/assets/geometry-product/VirtualGeometrySceneSourceV1.js";
import { prepareProductResidentAttributes } from "../../.test-dist/gpu/GeometryProductResidentAttributes.js";

const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const limits = {
  maxBufferSize: 268435456,
  maxStorageBufferBindingSize: 134217728,
  maxComputeWorkgroupsPerDimension: 65535,
};

test("Product workload bounds actual forest depth, widest frontier and accumulated groups", () => {
  for (const depth of [0, 1, 7, 40]) {
    const { descriptor } = deepProductFixture(depth);
    const work = geometryProductSceneWorkload(descriptor, [{ assetIndex: 0 }, { assetIndex: 0 }]);
    assert.equal(work.hierarchyMaxDepth, depth);
    assert.equal(work.hierarchyTraversalCapacity, depth === 0 ? 2 : 4);
    assert.equal(work.hierarchyVisibleClusterCapacity, 2 * (depth + 1));
    assert.equal(work.hierarchyRasterWorkCapacity, 2 * (depth + 1));
  }
});

test("one asset with many instances has per-instance capacity, not assetCount times 16", () => {
  const { descriptor } = triangleProductFixture();
  const instances = Array.from({ length: 10000 }, () => ({
    assetIndex: 0,
    materialIndex: 0,
    transform: identity,
  }));
  const { source } = buildVirtualGeometrySceneSourceV1(descriptor, [{}], instances, [{}]);
  assert.equal(source.hierarchyMaxDepth, 0);
  assert.equal(source.hierarchyTraversalCapacity, 10000);
  assert.equal(source.hierarchyVisibleClusterCapacity, 10000);
  assert.equal(source.hierarchyRasterWorkCapacity, 10000);
  validateGeometryProductSceneWorkLimits(source, source.count, limits);
  assert.throws(() => buildVirtualGeometrySceneSourceV1(descriptor, [{}], [], [{}]), /at least one instance/);
});

test("each Product keeps its own depth and merged capacities never clamp overflow", () => {
  const one = (descriptor) =>
    buildVirtualGeometrySceneSourceV1(
      descriptor,
      [{}],
      [{ assetIndex: 0, materialIndex: 0, transform: identity }],
      [{}],
    ).source;
  const parts = [one(triangleProductFixture().descriptor), one(deepProductFixture(7).descriptor)].map(
    (source, index) => ({
      source,
      productTableSlot: index,
      productGeneration: index + 1,
      assetReferenceBegin: index,
    }),
  );
  const merged = mergeVirtualGeometryProductSceneSourcesV1(parts);
  assert.equal(merged.hierarchyMaxDepth, 7);
  assert.equal(merged.hierarchyTraversalCapacity, 3);
  assert.equal(merged.hierarchyVisibleClusterCapacity, 9);
  assert.equal(merged.hierarchyRasterWorkCapacity, 9);
  parts[0].source = { ...parts[0].source, hierarchyTraversalCapacity: 0xffffffff };
  assert.throws(() => mergeVirtualGeometryProductSceneSourcesV1(parts), /u32 work namespace/);
});

test("negotiated binding and dispatch limits reject unsupported scenes without truncation", () => {
  const base = geometryProductSceneWorkload(triangleProductFixture().descriptor, [{ assetIndex: 0 }]);
  validateGeometryProductSceneWorkLimits({ ...base, hierarchyVisibleClusterCapacity: 65535 }, 1, limits);
  validateGeometryProductSceneWorkLimits({ ...base, hierarchyVisibleClusterCapacity: 65536 }, 1, limits);
  assert.throws(
    () =>
      validateGeometryProductSceneWorkLimits({ ...base, hierarchyVisibleClusterCapacity: 5 }, 1, {
        ...limits,
        maxComputeWorkgroupsPerDimension: 2,
      }),
    /dispatch grid/,
  );
  validateGeometryProductSceneWorkLimits(
    { ...base, hierarchyRasterWorkCapacity: 444_363_334 },
    19144,
    limits,
  );
  assert.throws(
    () =>
      validateGeometryProductSceneWorkLimits({ ...base, hierarchyRasterWorkCapacity: 444_363_334 }, 19144, {
        ...limits,
        maxStorageBufferBindingSize: 64 * 1024 ** 2,
      }),
    /storage-buffer limits/,
  );
});

test("resident page validates the hierarchy count before trusting its exact work bound", () => {
  const { descriptor, page } = triangleProductFixture();
  const result = prepareProductResidentAttributes(descriptor, 0, page.buffer);
  assert.equal(result.slotCount, 1);
  assert.equal(result.rawPayloadBytes, 176);
  assert.equal(result.uploadBytes, 176);
  const invalid = page.slice();
  new DataView(invalid.buffer).setFloat32(116, NaN, true);
  assert.throws(() => prepareProductResidentAttributes(descriptor, 0, invalid.buffer), /nonfinite position/);
  const uvDescriptor = { ...descriptor, vertexFormats: descriptor.vertexFormats.slice() };
  const format = new DataView(uvDescriptor.vertexFormats.buffer);
  format.setUint16(0, 20, true);
  format.setUint16(2, 11, true);
  format.setUint8(7, 16);
  const uvPage = page.slice();
  const uvView = new DataView(uvPage.buffer);
  for (let vertex = 0; vertex < 3; vertex++) {
    for (let axis = 0; axis < 3; axis++) uvView.setFloat32(116 + vertex * 20 + axis * 4, 0, true);
    uvView.setUint16(116 + vertex * 20 + 16, 0x3c00, true);
    uvView.setUint16(116 + vertex * 20 + 18, 0x3c00, true);
  }
  assert.equal(prepareProductResidentAttributes(uvDescriptor, 0, uvPage.buffer).slotCount, 1);
  uvView.setUint16(132, 0x7c00, true);
  assert.throws(() => prepareProductResidentAttributes(uvDescriptor, 0, uvPage.buffer), /nonfinite UV/);
  const bad = { ...descriptor, hierarchyNodes: descriptor.hierarchyNodes.slice() };
  new DataView(bad.hierarchyNodes.buffer).setUint32(44, (1 << 25) | 1, true);
  assert.throws(() => prepareProductResidentAttributes(bad, 0, page.buffer), /hierarchy work bound/);
  const cycle = { ...descriptor, hierarchyNodes: descriptor.hierarchyNodes.slice() };
  new DataView(cycle.hierarchyNodes.buffer).setUint32(44, 1 << 28, true);
  assert.throws(() => geometryProductWorkload(cycle), /cycle/);
});

test("logical complete scene bounds remain exact beyond the frame-local key namespace", () => {
  const descriptor = deepProductFixture(64).descriptor;
  const instances = new Array(260000).fill({ assetIndex: 0 });
  const work = geometryProductSceneWorkload(descriptor, instances);
  assert.equal(work.hierarchyRasterWorkCapacity, 16_900_000);
  assert.equal(work.hierarchyVisibleClusterCapacity, 16_900_000);
  assert.equal(geometryProductMeshletWorkCapacity(work.hierarchyRasterWorkCapacity), 4_194_304);
  assert.equal(geometryProductMeshletWorkCapacity(work.hierarchyRasterWorkCapacity, 8_388_608), 8_388_608);
  assert.equal(geometryProductMeshletWorkCapacity(2), 2);
  assert.throws(() => geometryProductMeshletWorkCapacity(0), /namespace/);
  assert.throws(() => geometryProductMeshletWorkCapacity(100, 16_777_217), /namespace/);
});

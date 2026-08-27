import test from "node:test";
import assert from "node:assert/strict";

import { createGeometryCookRecipe } from "../.test-dist/assets/GeometryCookRecipe.js";
import {
  GEOMETRY_MATERIAL_RANGE_STRIDE,
  GEOMETRY_MESHLET_RECORD_STRIDE,
  GEOMETRY_SECTION_TYPES,
  GEOMETRY_VERTEX_STREAM_DESCRIPTOR_STRIDE,
  GeometryAssetPackageError,
  openGeometryAssetPackage
} from "../.test-dist/assets/GeometryAssetPackage.js";
import {
  openRuntimeAssetPackage,
  writeRuntimeAssetPackage
} from "../.test-dist/assets/RuntimeAssetPackage.js";
import { createSourceGeometry } from "../.test-dist/assets/SourceGeometry.js";
import { buildBoxSourceGeometry } from "../.test-dist/geometry/BoxGeometry.js";
import { cookGeometryAssetPackage } from "../.test-dist/geometry/GeometryCooker.js";

test("R2-B-04 preserves uncompressed streams, indices and material boundaries", async () => {
  const source = buildAttributedGrid(16, 16);
  const cooked = await cookGeometryAssetPackage(source, createGeometryCookRecipe());
  const asset = cooked.asset;

  assert.ok(Number.isFinite(cooked.timing.cookTimeMs));
  assert.ok(cooked.timing.cookTimeMs >= 0);
  assert.match(cooked.evidence.sourceHash, /^[0-9a-f]{64}$/);
  assert.match(cooked.evidence.recipeHash, /^[0-9a-f]{64}$/);
  assert.match(cooked.evidence.packageHash, /^[0-9a-f]{64}$/);
  assert.ok(cooked.evidence.geometricError.maximum >= cooked.evidence.geometricError.minimum);

  assert.equal(asset.vertexStreamDescriptors.length, 4);
  assert.equal(cooked.evidence.vertexStreamCount, 4);
  assert.deepEqual([...asset.indices], [...source.indices]);
  assert.deepEqual(
    asset.vertexStreamDescriptors.map((descriptor) => descriptor.semantic),
    ["position", "normal", "tangent", "uv0"]
  );
  const position = asset.vertexStreamDescriptors[0];
  assert.equal(position.dataType, "float32");
  assert.equal(position.componentCount, 3);
  assert.equal(position.elementStride, 12);
  assert.deepEqual([...position.componentMinimum.subarray(0, 3)], [0, 0, 0]);
  assert.deepEqual([...position.componentMaximum.subarray(0, 3)], [16, 16, 0]);

  const uv = asset.vertexStreamDescriptors[3];
  assert.equal(uv.dataType, "uint16");
  assert.equal(uv.componentCount, 2);
  assert.equal(uv.normalized, true);
  const uvView = new DataView(
    asset.vertexStreamData.buffer,
    asset.vertexStreamData.byteOffset + uv.dataByteOffset,
    uv.dataByteLength
  );
  assert.equal(uvView.getUint16(0, true), 0);
  assert.equal(uvView.getUint16(2, true), 0);
  assert.equal(uvView.getUint16(uv.dataByteLength - 4, true), 65535);
  assert.equal(uvView.getUint16(uv.dataByteLength - 2, true), 65535);

  assert.equal(asset.materialRanges.length, 2);
  assert.equal(cooked.evidence.materialRangeCount, 2);
  assert.deepEqual(asset.materialRanges.map((range) => ({
    firstTriangle: range.firstTriangle,
    triangleCount: range.triangleCount,
    materialId: range.materialId,
    alphaMode: range.alphaMode,
    doubleSided: range.doubleSided
  })), [
    { firstTriangle: 0, triangleCount: 256, materialId: 7, alphaMode: "opaque", doubleSided: false },
    { firstTriangle: 256, triangleCount: 256, materialId: 11, alphaMode: "mask", doubleSided: true }
  ]);
  for (const meshlet of asset.meshlets) {
    const material = asset.materialRanges[meshlet.materialRangeIndex];
    assert.equal(meshlet.materialId, material.materialId);
    assert.equal(meshlet.alphaMode, material.alphaMode);
    assert.equal(meshlet.doubleSided, material.doubleSided);
  }
});

test("R2-B-04 required sections are byte-identical for the same source and recipe", async () => {
  const source = buildAttributedGrid(16, 16);
  const recipe = createGeometryCookRecipe();
  const first = await cookGeometryAssetPackage(source, recipe);
  const second = await cookGeometryAssetPackage(source, recipe);
  const reordered = await cookGeometryAssetPackage(
    buildAttributedGrid(16, 16, true),
    recipe
  );
  assert.deepEqual(new Uint8Array(first.bytes), new Uint8Array(second.bytes));
  assert.deepEqual(new Uint8Array(first.bytes), new Uint8Array(reordered.bytes));
  assert.equal(first.evidence.contentHash, second.evidence.contentHash);
});

test("R2-B-04 default recipe keeps full payload when a tiny asset naturally stays single-level", async () => {
  const cooked = await cookGeometryAssetPackage(
    buildBoxSourceGeometry(),
    createGeometryCookRecipe()
  );
  assert.equal(cooked.asset.clusters.length, 0);
  assert.equal(cooked.asset.bvh8Nodes.length, 0);
  assert.ok(cooked.asset.vertexStreamDescriptors.length > 0);
  assert.equal(cooked.asset.indices.length, 36);
  assert.equal(cooked.asset.materialRanges.length, 1);
});

test("R2-B-04 validator rejects rehashed stream, index, material and bounds corruption", async () => {
  const cooked = await cookGeometryAssetPackage(
    buildAttributedGrid(16, 16),
    createGeometryCookRecipe()
  );
  const corruptions = [
    {
      type: GEOMETRY_SECTION_TYPES.VertexStreamDescriptors,
      code: "vertex-stream-range-noncanonical",
      mutate(bytes) {
        new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          .setUint32(32, 16, true);
      }
    },
    {
      type: GEOMETRY_SECTION_TYPES.IndexData,
      code: "geometry-index-range",
      mutate(bytes) {
        new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          .setUint32(0, 0xffffffff, true);
      }
    },
    {
      type: GEOMETRY_SECTION_TYPES.MaterialRanges,
      code: "meshlet-material-mismatch",
      mutate(bytes) {
        new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          .setUint32(8, 99, true);
      }
    },
    {
      type: GEOMETRY_SECTION_TYPES.MeshletRecords,
      code: "meshlet-position-bounds-containment",
      mutate(bytes) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        view.setFloat32(32 + 12, view.getFloat32(32, true), true);
        view.setFloat32(32 + 16, view.getFloat32(36, true), true);
        view.setFloat32(32 + 20, view.getFloat32(40, true), true);
      }
    }
  ];
  for (const corruption of corruptions) {
    const bytes = await rewriteGeometrySection(
      cooked.bytes,
      corruption.type,
      corruption.mutate
    );
    await assert.rejects(
      () => openGeometryAssetPackage(bytes),
      (error) => error instanceof GeometryAssetPackageError &&
        error.report.issues.some((issue) => issue.code === corruption.code),
      corruption.code
    );
  }
});

function buildAttributedGrid(widthSegments, heightSegments, reverseAttributes = false) {
  const row = widthSegments + 1;
  const vertexCount = row * (heightSegments + 1);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const tangents = new Float32Array(vertexCount * 4);
  const uv0 = new Uint16Array(vertexCount * 2);
  let vertex = 0;
  for (let y = 0; y <= heightSegments; y++) {
    for (let x = 0; x <= widthSegments; x++, vertex++) {
      positions.set([x, y, 0], vertex * 3);
      normals.set([0, 0, 1], vertex * 3);
      tangents.set([1, 0, 0, 1], vertex * 4);
      uv0[vertex * 2] = Math.round(x / widthSegments * 65535);
      uv0[vertex * 2 + 1] = Math.round(y / heightSegments * 65535);
    }
  }
  const indices = new Uint32Array(widthSegments * heightSegments * 6);
  let indexOffset = 0;
  for (let y = 0; y < heightSegments; y++) {
    for (let x = 0; x < widthSegments; x++) {
      const a = y * row + x;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      indices.set([a, b, c, c, b, d], indexOffset);
      indexOffset += 6;
    }
  }
  const triangleCount = indices.length / 3;
  const attributes = [
    { semantic: "position", componentCount: 3, data: positions },
    { semantic: "normal", componentCount: 3, data: normals },
    { semantic: "tangent", componentCount: 4, data: tangents },
    { semantic: "uv0", componentCount: 2, normalized: true, data: uv0 }
  ];
  return createSourceGeometry({
    sourceId: "r2-b-04-attributed-grid",
    indices,
    attributes: reverseAttributes ? attributes.reverse() : attributes,
    materialRanges: [
      { firstTriangle: 0, triangleCount: triangleCount / 2, materialId: 7, alphaMode: "opaque", doubleSided: false },
      { firstTriangle: triangleCount / 2, triangleCount: triangleCount / 2, materialId: 11, alphaMode: "mask", doubleSided: true }
    ]
  });
}

async function rewriteGeometrySection(packageBytes, type, mutate) {
  const generic = await openRuntimeAssetPackage(packageBytes, {
    supportedSectionTypes: new Set(Object.values(GEOMETRY_SECTION_TYPES))
  });
  const sections = generic.sections.map((section) => {
    const data = section.bytes.slice();
    if (section.type === type) mutate(data);
    return {
      type: section.type,
      required: section.required,
      data,
      elementStride: section.elementStride,
      elementCount: section.elementCount,
      alignment: section.alignment
    };
  });
  return writeRuntimeAssetPackage({ sections });
}

import test from "node:test";
import assert from "node:assert/strict";

import {
  SOURCE_DEFAULT_MATERIAL_ID,
  createSourceGeometry
} from "../.test-dist/assets/SourceGeometry.js";
import {
  geometryToSourceGeometry,
  sourceGeometryToGeometry
} from "../.test-dist/geometry/SourceGeometryAdapter.js";
import { buildBoxMesh } from "../.test-dist/geometry/BoxGeometry.js";
import {
  createGltfGeometryBuildContext,
  primitiveToSourceGeometry
} from "../.test-dist/loaders/gltf/gltfGeometry.js";

test("SourceGeometry owns canonical triangle-list data and complete material coverage", () => {
  const positions = new Float32Array([
    0, 0, 0,
    2, 0, 0,
    0, 4, 0
  ]);
  const source = createSourceGeometry({
    sourceId: "triangle",
    indices: new Uint16Array([0, 1, 2]),
    attributes: [{
      semantic: "position",
      componentCount: 3,
      normalized: false,
      data: positions
    }]
  });

  positions[0] = 99;
  assert.deepEqual([...source.indices], [0, 1, 2]);
  assert.deepEqual([...source.attributes.get("position").data], [
    0, 0, 0,
    2, 0, 0,
    0, 4, 0
  ]);
  assert.deepEqual(source.materialRanges, [{
    firstTriangle: 0,
    triangleCount: 1,
    materialId: SOURCE_DEFAULT_MATERIAL_ID,
    alphaMode: "opaque",
    doubleSided: false
  }]);
  assert.deepEqual([...source.bounds.box], [0, 0, 0, 2, 4, 0]);
  assert.deepEqual([...source.bounds.sphere.subarray(0, 3)], [1, 2, 0]);
  assert.ok(Math.abs(source.bounds.sphere[3] - Math.sqrt(5)) < 1e-6);
});

test("SourceGeometry rejects corrupt indices, non-finite attributes and material gaps", () => {
  const valid = {
    sourceId: "invalid",
    indices: new Uint32Array([0, 1, 2]),
    attributes: [{
      semantic: "position",
      componentCount: 3,
      normalized: false,
      data: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
    }]
  };

  assert.throws(
    () => createSourceGeometry({ ...valid, indices: new Uint32Array([0, 1, 3]) }),
    /indices\[2\].*vertex count/
  );
  assert.throws(
    () => createSourceGeometry({
      ...valid,
      attributes: [{
        ...valid.attributes[0],
        data: new Float32Array([0, 0, 0, 1, Number.NaN, 0, 0, 1, 0])
      }]
    }),
    /finite/
  );
  assert.throws(
    () => createSourceGeometry({
      ...valid,
      indices: new Uint32Array([0, 1, 2, 0, 2, 1]),
      materialRanges: [{
        firstTriangle: 1,
        triangleCount: 1,
        materialId: 0,
        alphaMode: "opaque",
        doubleSided: false
      }]
    }),
    /materialRanges.*cover/
  );
});

test("SourceGeometry preserves explicit multi-material and degenerate input for Cooker policy", () => {
  const source = createSourceGeometry({
    sourceId: "multi-material-degenerate",
    indices: new Uint32Array([0, 1, 2, 0, 0, 0]),
    attributes: [{
      semantic: "position",
      componentCount: 3,
      data: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
    }],
    materialRanges: [
      {
        firstTriangle: 0,
        triangleCount: 1,
        materialId: 2,
        alphaMode: "opaque",
        doubleSided: false
      },
      {
        firstTriangle: 1,
        triangleCount: 1,
        materialId: 3,
        alphaMode: "mask",
        doubleSided: true
      }
    ]
  });

  assert.equal(source.triangleCount, 2);
  assert.deepEqual(source.materialRanges.map((range) => range.materialId), [2, 3]);
});

test("legacy Geometry adapter round-trips the public SourceGeometry seam", () => {
  const source = geometryToSourceGeometry(buildBoxMesh(2, 4, 6), {
    sourceId: "box"
  });
  const roundTrip = sourceGeometryToGeometry(source);

  assert.equal(source.sourceId, "box");
  assert.equal(source.indices.length, 36);
  assert.equal(source.attributes.get("position").componentCount, 3);
  assert.equal(roundTrip.getIndexCount(), 36);
  assert.equal(roundTrip.getVertexCount(), 24);
  assert.deepEqual([...roundTrip.bounding_box], [-1, -2, -3, 1, 2, 3]);
});

test("glTF primitive normalization produces SourceGeometry before legacy Meshlet conversion", () => {
  const positions = new Float32Array([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0
  ]);
  const indices = new Uint16Array([0, 1, 2]);
  const doc = {
    buffers: [positions.buffer, indices.buffer],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 1, byteOffset: 0, byteLength: indices.byteLength }
    ],
    accessors: [
      {
        bufferView: 0,
        byteOffset: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3"
      },
      {
        bufferView: 1,
        byteOffset: 0,
        componentType: 5123,
        count: 3,
        type: "SCALAR"
      }
    ],
    materials: [{ alphaMode: "MASK", doubleSided: true }]
  };
  const primitive = {
    attributes: { POSITION: 0 },
    indices: 1,
    material: 0
  };
  const source = primitiveToSourceGeometry(
    doc,
    primitive,
    "gltf-triangle",
    createGltfGeometryBuildContext()
  );

  assert.equal(source.sourceId, "gltf-triangle");
  assert.deepEqual([...source.indices], [0, 1, 2]);
  assert.deepEqual(source.materialRanges, [{
    firstTriangle: 0,
    triangleCount: 1,
    materialId: 0,
    alphaMode: "mask",
    doubleSided: true
  }]);
});

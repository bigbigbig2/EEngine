import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mat4 } from "gl-matrix";

import { load_gltf_packed } from "../.test-dist/loaders/load_gltf.js";

test("R2-D static glTF import produces typed Packed input without runtime scene objects", async () => {
  const bytes = new Uint8Array(44);
  new Float32Array(bytes.buffer, 0, 9).set([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0
  ]);
  new Uint16Array(bytes.buffer, 36, 3).set([0, 1, 2]);
  const bufferUri = `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`;
  const gltf = {
    asset: { version: "2.0" },
    buffers: [{ uri: bufferUri, byteLength: bytes.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 }
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [0, 0, 0],
        max: [1, 1, 0]
      },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }
    ],
    materials: [{ name: "packed-test", doubleSided: true }],
    meshes: [{
      name: "triangle",
      primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }]
    }],
    nodes: [
      { mesh: 0, translation: [3, 4, 5] },
      { mesh: 0, translation: [-3, -4, -5] }
    ],
    scenes: [{ nodes: [0, 1] }],
    scene: 0
  };
  const url = `data:model/gltf+json,${encodeURIComponent(JSON.stringify(gltf))}`;

  const packed = await load_gltf_packed(url);

  assert.equal(packed.geometries.length, 1);
  assert.equal(packed.materials.length, 1);
  assert.deepEqual([...packed.geometryIndices], [0, 0]);
  assert.deepEqual([...packed.materialIndices], [0, 0]);
  assert.equal(packed.transforms.length, 32);
  assert.deepEqual([...packed.transforms.subarray(12, 15)], [3, 4, 5]);
  assert.deepEqual([...packed.transforms.subarray(28, 31)], [-3, -4, -5]);
  assert.equal(packed.flags[0], (1 << 1) | (1 << 4));
  assert.equal(packed.flags[1], (1 << 1) | (1 << 4));
  assert.equal(packed.geometries[0].triangleCount, 1);
});

test("R2-D Packed glTF seam is public and does not build Mesh or Node3D", () => {
  const entry = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const loader = readFileSync(
    new URL("../src/loaders/load_gltf.ts", import.meta.url),
    "utf8"
  );
  const packedBody = loader.slice(loader.indexOf("function buildPackedGltfSource"));

  assert.match(entry, /export \{ load_gltf, load_gltf_packed \}/);
  assert.match(entry, /export type \{ PackedGltfSource \}/);
  assert.doesNotMatch(packedBody, /new Mesh\s*\(|new Node3D\s*\(|new SkinnedMesh\s*\(/);
});

test("R2-D-10 Packed glTF preserves multi-primitive materials and nested world transforms", async () => {
  const bytes = new Uint8Array(84);
  new Float32Array(bytes.buffer, 0, 9).set([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0
  ]);
  new Float32Array(bytes.buffer, 36, 9).set([
    0, 0, 0,
    0, 1, 0,
    0, 0, 1
  ]);
  new Uint16Array(bytes.buffer, 72, 3).set([0, 1, 2]);
  new Uint16Array(bytes.buffer, 78, 3).set([0, 1, 2]);
  const bufferUri = `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`;
  const halfSqrt = Math.sqrt(0.5);
  const gltf = {
    asset: { version: "2.0" },
    buffers: [{ uri: bufferUri, byteLength: bytes.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 36 },
      { buffer: 0, byteOffset: 72, byteLength: 6 },
      { buffer: 0, byteOffset: 78, byteLength: 6 }
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 2, componentType: 5123, count: 3, type: "SCALAR" },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [0, 1, 1] },
      { bufferView: 3, componentType: 5123, count: 3, type: "SCALAR" }
    ],
    materials: [
      { name: "opaque" },
      {
        name: "masked-double-sided",
        alphaMode: "MASK",
        doubleSided: true,
        pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0.5] }
      }
    ],
    meshes: [{
      name: "two-primitive-mesh",
      primitives: [
        { attributes: { POSITION: 0 }, indices: 1, material: 0 },
        { attributes: { POSITION: 2 }, indices: 3, material: 1 }
      ]
    }],
    nodes: [
      { children: [1], translation: [10, 20, 30], rotation: [0, 0, halfSqrt, halfSqrt] },
      { mesh: 0, translation: [2, 0, 0], scale: [2, 3, 4] }
    ],
    scenes: [{ nodes: [0] }],
    scene: 0
  };

  const packed = await load_gltf_packed(
    `data:model/gltf+json,${encodeURIComponent(JSON.stringify(gltf))}`
  );

  assert.equal(packed.geometries.length, 2);
  assert.equal(packed.materials.length, 2);
  assert.deepEqual([...packed.geometryIndices], [0, 1]);
  assert.deepEqual([...packed.materialIndices], [0, 1]);
  assert.deepEqual([...packed.flags], [1 << 1, (1 << 1) | (1 << 3) | (1 << 4)]);
  assert.equal(packed.geometries[0].materialRanges[0].materialId, 0);
  assert.equal(packed.geometries[1].materialRanges[0].materialId, 1);
  assert.equal(packed.transforms.length, 32);

  const parent = mat4.fromRotationTranslationScale(
    mat4.create(),
    [0, 0, halfSqrt, halfSqrt],
    [10, 20, 30],
    [1, 1, 1]
  );
  const local = mat4.fromRotationTranslationScale(
    mat4.create(),
    [0, 0, 0, 1],
    [2, 0, 0],
    [2, 3, 4]
  );
  const expectedWorld = mat4.multiply(mat4.create(), parent, local);
  assertMatrixClose(packed.transforms.subarray(0, 16), expectedWorld, 1e-6);
  assertMatrixClose(packed.transforms.subarray(16, 32), expectedWorld, 1e-6);
});

function assertMatrixClose(actual, expected, epsilon) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < actual.length; index++) {
    assert.ok(
      Math.abs(actual[index] - expected[index]) <= epsilon,
      `matrix[${index}] ${actual[index]} != ${expected[index]} ± ${epsilon}`
    );
  }
}

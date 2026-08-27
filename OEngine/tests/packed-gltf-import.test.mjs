import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
    nodes: [{ mesh: 0, translation: [3, 4, 5] }],
    scenes: [{ nodes: [0] }],
    scene: 0
  };
  const url = `data:model/gltf+json,${encodeURIComponent(JSON.stringify(gltf))}`;

  const packed = await load_gltf_packed(url);

  assert.equal(packed.geometries.length, 1);
  assert.equal(packed.materials.length, 1);
  assert.deepEqual([...packed.geometryIndices], [0]);
  assert.deepEqual([...packed.materialIndices], [0]);
  assert.equal(packed.transforms.length, 16);
  assert.deepEqual([...packed.transforms.subarray(12, 15)], [3, 4, 5]);
  assert.equal(packed.flags[0], 1 << 4);
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

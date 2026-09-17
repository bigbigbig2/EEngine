import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const abi = await import("../.test-dist/assets/web-cook/wasm/WebGeometryCookerAbi.js");

function cubeDomain() {
  const positions = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]
  ];
  const vertices = new Float32Array(positions.length * abi.WEB_GEOMETRY_CANONICAL_VERTEX_FLOATS);
  positions.forEach((position, index) => {
    const at = index * abi.WEB_GEOMETRY_CANONICAL_VERTEX_FLOATS;
    vertices.set(position, at);
    vertices[at + 6] = 1;
    vertices[at + 9] = 1;
    vertices.set([1, 1, 1, 1], at + 14);
  });
  return {
    materialId: 7,
    meshletFlags: 17,
    attributeMask: 1,
    generateNormals: true,
    vertices,
    indices: new Uint32Array([
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
      1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7
    ])
  };
}

test("Web geometry canonical and recipe ABIs are deterministic and canonical", () => {
  const canonical = abi.encodeWebCanonicalGeometryV1([cubeDomain()]);
  const view = new DataView(canonical), bytes = new Uint8Array(canonical);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 7)), "OEWGCAN");
  assert.equal(view.getUint32(8, true), 1);
  assert.equal(view.getUint32(12, true), 128);
  assert.equal(view.getUint32(16, true), canonical.byteLength);
  assert.equal(view.getUint32(20, true), 1);
  assert.equal(view.getUint32(24, true), 8);
  assert.equal(view.getUint32(28, true), 36);
  assert.equal(view.getUint32(32, true), 128);
  assert.equal(view.getUint32(36, true), 160);
  assert.equal(view.getUint32(40, true), 736);
  assert.equal(view.getUint32(44, true), 72);
  assert.equal(view.getUint32(48, true), 32);
  assert.equal(canonical.byteLength, 880);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "ef3d47d2ca6e355184bc540928ca0663910c27d3bbdac0d43187ed998e4df822");

  const recipe = abi.encodeWebGeometryCookRecipeV1(), recipeView = new DataView(recipe);
  assert.equal(new TextDecoder().decode(new Uint8Array(recipe, 0, 7)), "OEWGRCP");
  assert.equal(recipeView.getUint32(8, true), 1);
  assert.equal(recipeView.getUint32(12, true), 96);
  assert.equal(recipeView.getUint32(16, true), 64);
  assert.equal(recipeView.getUint32(52, true), 3);
  assert.equal(recipeView.getUint32(68, true), 8);
  assert.equal(recipeView.getUint32(72, true), 18);
  assert.equal(createHash("sha256").update(new Uint8Array(recipe)).digest("hex"), "43d244b5d0453b36e076d340ee8cc8ef69550fbc9265eb6959b70cdbda85e44c");
});

test("Web geometry canonical ABI rejects alias-prone and invalid input", () => {
  const valid = cubeDomain();
  assert.throws(() => abi.encodeWebCanonicalGeometryV1([{ ...valid, generateNormals: false }]), /normal/);
  assert.throws(() => abi.encodeWebCanonicalGeometryV1([{ ...valid, indices: new Uint32Array([0, 1, 99]) }]), /index/);
  const nonFinite = valid.vertices.slice(); nonFinite[0] = Number.NaN;
  assert.throws(() => abi.encodeWebCanonicalGeometryV1([{ ...valid, vertices: nonFinite }]), /finite/);
});

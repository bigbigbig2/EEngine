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
  assert.equal(abi.WEB_GEOMETRY_COOKER_ABI_VERSION, 2);
  assert.equal(view.getUint32(8, true), 2);
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
  // Golden freeze of the fixture encoding itself: pins the exact byte layout
  // (including the ABI version word) so an accidental fixture edit cannot mask
  // a real cooker regression.
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "bf445f9207ee9a3a76a7656bbc1a31aaac36efab1c64dea489423d84f28e6a29");

  const recipe = abi.encodeWebGeometryCookRecipeV1(), recipeView = new DataView(recipe);
  assert.equal(new TextDecoder().decode(new Uint8Array(recipe, 0, 7)), "OEWGRCP");
  assert.equal(recipeView.getUint32(8, true), 2);
  assert.equal(recipeView.getUint32(12, true), 96);
  assert.equal(recipeView.getUint32(16, true), 64);
  assert.equal(recipeView.getUint32(52, true), 3);
  assert.equal(recipeView.getUint32(68, true), 8);
  assert.equal(recipeView.getUint32(72, true), 18);
  assert.equal(createHash("sha256").update(new Uint8Array(recipe)).digest("hex"), "4c7311b0954eb9592036cb3e135464e1001e11949876dfe4de9460179c5db01b");
});

test("Two-phase ABI exposes the descriptor stage before any payload exists", () => {
  // The payload-stage result codes are part of the frozen ABI surface.
  assert.equal(abi.WEB_GEOMETRY_COOK_PAGE_READY, 1);
  assert.equal(abi.WEB_GEOMETRY_COOK_PAGE_PENDING, 2);
  assert.equal(abi.WEB_GEOMETRY_COOK_PAGE_UNDECLARED, 3);
  // The plan entry point must exist alongside the monolithic one so a caller
  // can freeze the ID graph without paying for payload production.
  assert.equal(typeof abi.planWebGeometryWasmV1, "function");
  assert.equal(typeof abi.cookWebGeometryWasmV1, "function");
  assert.equal(typeof abi.WebGeometryCookWasmPlanV1, "function");
  assert.equal(typeof abi.WebGeometryCookWasmResultV1, "function");
});

test("Web geometry canonical ABI rejects alias-prone and invalid input", () => {
  const valid = cubeDomain();
  assert.throws(() => abi.encodeWebCanonicalGeometryV1([{ ...valid, generateNormals: false }]), /normal/);
  assert.throws(() => abi.encodeWebCanonicalGeometryV1([{ ...valid, indices: new Uint32Array([0, 1, 99]) }]), /index/);
  const nonFinite = valid.vertices.slice(); nonFinite[0] = Number.NaN;
  assert.throws(() => abi.encodeWebCanonicalGeometryV1([{ ...valid, vertices: nonFinite }]), /finite/);
});

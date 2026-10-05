import test from "node:test";
import assert from "node:assert/strict";
import { buildSurfaceContinuity } from "../../src/geometry/SurfaceContinuity.ts";

// A seam duplicates endpoint vertex records, but position edges still connect.
function fixture({ uvSeam = false, normalSeam = false, colorSeam = false } = {}) {
  const p = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
  ];
  const v = new Float32Array(6 * 24);
  for (let i = 0; i < 6; i++) {
    const at = i * 24;
    v.set(normalSeam && i >= 3 ? [0, 1, 0] : [0, 0, 1], at);
    v.set([1, 0, 0, 1], at + 4);
    v.set([p[i][0] + (uvSeam && i >= 3 ? 2 : 0), p[i][1]], at + 8);
    v.set([p[i][0], p[i][1]], at + 10);
    v.set(colorSeam && i >= 3 ? [0, 0, 0, 1] : [1, 1, 1, 1], at + 12);
    v.set(p[i], at + 20);
  }
  return {
    vertices: v,
    indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
    stride: 24,
    normal: 0,
    tangent: 4,
    uv0: 8,
    uv1: 10,
    color: 12,
    position: 20,
  };
}
test("oriented manifold edge joins separate primitive vertices in all continuous fields", () => {
  const result = buildSurfaceContinuity(fixture());
  for (let field = 0; field < 6; field++) assert.equal(result.domains[field], result.domains[6 + field]);
  assert.deepEqual([...result.identityRisk], [0, 0]);
});
test("UV0 seam splits only UV0; geometry, UV1 and unrelated fields stay connected", () => {
  const result = buildSurfaceContinuity(fixture({ uvSeam: true }));
  assert.notEqual(result.domains[1], result.domains[7]);
  for (const field of [0, 2, 3, 4, 5]) assert.equal(result.domains[field], result.domains[6 + field]);
});
test("normal and color seams do not erase geometry/UV domains", () => {
  const result = buildSurfaceContinuity(fixture({ normalSeam: true, colorSeam: true }));
  assert.notEqual(result.domains[3], result.domains[9]);
  assert.notEqual(result.domains[5], result.domains[11]);
  for (const field of [0, 1, 2, 4]) assert.equal(result.domains[field], result.domains[6 + field]);
});
test("material seam retains geometry connectivity but separates field chart scopes", () => {
  const result = buildSurfaceContinuity({ ...fixture(), materialIds: new Uint32Array([1, 2]) });
  assert.equal(result.domains[0], result.domains[6]);
  for (let field = 1; field < 6; field++) assert.notEqual(result.domains[field], result.domains[6 + field]);
});
test("disconnected identical-material triangles and duplicate facing sheets do not share", () => {
  const disconnected = fixture();
  for (const vertex of [3, 4, 5]) disconnected.vertices[vertex * 24 + 20] += 10;
  const result = buildSurfaceContinuity(disconnected);
  assert.notEqual(result.domains[0], result.domains[6]);
  const duplicate = fixture();
  duplicate.indices = new Uint32Array([0, 1, 2, 0, 1, 2]);
  const sheets = buildSurfaceContinuity(duplicate);
  assert.notEqual(sheets.domains[0], sheets.domains[6]);
  assert.ok(sheets.identityRisk[0] & 2);
});
test("mirrored UV orientation does not split geometry or unaffected UV channel", () => {
  const input = fixture();
  input.vertices[4 * 24 + 8] = -1;
  const result = buildSurfaceContinuity(input);
  assert.equal(result.domains[0], result.domains[6]);
  assert.notEqual(result.domains[1], result.domains[7]);
  assert.equal(result.domains[2], result.domains[8]);
});
test("invalid shape/index/attributes are rejected instead of publishing corrupt domains", () => {
  const input = fixture();
  assert.throws(() => buildSurfaceContinuity({ ...input, indices: new Uint32Array([0, 1, 9]) }), RangeError);
  assert.throws(() => buildSurfaceContinuity({ ...input, color: 23 }), RangeError);
  input.vertices[20] = NaN;
  assert.throws(() => buildSurfaceContinuity(input), RangeError);
});

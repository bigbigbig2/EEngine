import test from "node:test";
import assert from "node:assert/strict";
import { nativeSurfaceMotion, nativeSurfaceTemporalMask, nativeSurfaceTemporalMaterialSignature } from "../../.test-dist/render/temporal/NativeTemporalMath.js";

test("motion uses jittered clip coordinates and rejects out-of-domain reprojection and camera cuts", () => {
  const result = nativeSurfaceMotion([0.2, -0.2, 0.5, 1], [0.1, 0.2, 0.5, 1], true);
  assert.equal(result.valid, true);
  assert.ok(Math.abs(result.motion[0] - 0.05) < 1e-7);
  assert.ok(Math.abs(result.motion[1] - 0.2) < 1e-7);
  for (const prior of [
    [2, 0, 0.5, 1],
    [0, 0, -0.1, 1],
    [0, 0, 0, 0],
    [NaN, 0, 0, 1]
  ]) {
    assert.deepEqual(nativeSurfaceMotion([0, 0, 0.5, 1], prior, true), { motion: [0, 0], valid: false });
  }
  assert.deepEqual(nativeSurfaceMotion([0, 0, 0.5, 1], [0, 0, 0.5, 1], false), {
    motion: [0, 0],
    valid: false
  });
});

test("Temporal mask separates winner changes, same-slot replacement and invalid motion from reactive", () => {
  assert.deepEqual(nativeSurfaceTemporalMask([1, 2, 3, 4], [1, 2, 3, 5], true, true, 0, 0), [
    0,
    1,
    0,
    8 / 255
  ]);
  assert.deepEqual(nativeSurfaceTemporalMask([1, 2, 3, 4], [1, 2, 9, 4], true, true, 0.25, 64), [
    0.25,
    1,
    1,
    68 / 255
  ]);
  assert.deepEqual(nativeSurfaceTemporalMask([1, 2, 3, 4], [1, 2, 3, 4], false, false, 0, 0), [
    0,
    0,
    0,
    16 / 255
  ]);
  assert.deepEqual(nativeSurfaceTemporalMask([1, 2, 3, 4], [1, 2, 3, 4], false, true, 0, 0), [
    0,
    0,
    0,
    16 / 255
  ]);
});

test("native Temporal signatures change for material versions and conservatively distinguish equal-content slots", () => {
  const input = { materialHandle: 7, instanceFlags: 0, materialSlot: 1, signature: 23, valueRevision: 1 };
  const first = nativeSurfaceTemporalMaterialSignature(input);
  assert.equal(nativeSurfaceTemporalMaterialSignature(input), first);
  assert.notEqual(nativeSurfaceTemporalMaterialSignature({ ...input, materialSlot: 2 }), first);
  assert.notEqual(nativeSurfaceTemporalMaterialSignature({ ...input, valueRevision: 2 }), first);
  assert.notEqual(nativeSurfaceTemporalMaterialSignature({ ...input, signature: 24 }), first);
  assert.throws(() => nativeSurfaceTemporalMaterialSignature({ ...input, signature: -1 }), /u32/);
});

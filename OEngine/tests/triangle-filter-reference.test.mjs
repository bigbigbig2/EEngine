import assert from "node:assert/strict";
import test from "node:test";

const { filterTriangleClipReference } = await import(
  "../.test-dist/render/TriangleFilterReference.js"
);

const defaults = Object.freeze({
  viewportWidth: 1280,
  viewportHeight: 720,
  doubleSided: false,
  mirrored: false,
  frontFace: "ccw",
  sampleCount: 1,
  cullSmallPrimitives: true
});

test("exact triangle filter preserves front-facing work and rejects opposite winding", () => {
  const front = [[-0.5, -0.5, 0.5, 1], [0.5, -0.5, 0.5, 1], [0, 0.5, 0.5, 1]];
  assert.deepEqual(filterTriangleClipReference(front, defaults), {
    keep: true,
    reason: null,
    crossesNearPlane: false
  });
  assert.equal(
    filterTriangleClipReference([front[0], front[2], front[1]], defaults).reason,
    "backface"
  );
  assert.equal(
    filterTriangleClipReference([front[0], front[2], front[1]], {
      ...defaults,
      doubleSided: true
    }).keep,
    true
  );
  assert.equal(
    filterTriangleClipReference([front[0], front[2], front[1]], {
      ...defaults,
      mirrored: true
    }).keep,
    true
  );
});

test("exact triangle filter rejects degenerate and wholly clipped work", () => {
  assert.equal(filterTriangleClipReference([
    [0, 0, 0.5, 1], [0.25, 0.25, 0.5, 1], [0.5, 0.5, 0.5, 1]
  ], defaults).reason, "degenerate");
  assert.equal(filterTriangleClipReference([
    [2, 0, 0.5, 1], [3, 0, 0.5, 1], [2, 1, 0.5, 1]
  ], defaults).reason, "frustum");
});

test("near-plane crossings fail open and 23.8 small-primitive filtering follows sample count", () => {
  const crossing = [[-0.2, -0.2, -0.1, 1], [0.2, -0.2, 0.2, 1], [0, 0.2, 0.2, 1]];
  const result = filterTriangleClipReference(crossing, defaults);
  assert.equal(result.keep, true);
  assert.equal(result.crossesNearPlane, true);

  const centerX = 2 * (640.75 / defaults.viewportWidth - 0.5);
  const centerY = 2 * (0.5 - 360.75 / defaults.viewportHeight);
  const tiny = [
    [centerX, centerY, 0.5, 1],
    [centerX, centerY - 0.00001, 0.5, 1],
    [centerX + 0.00001, centerY, 0.5, 1]
  ];
  assert.equal(filterTriangleClipReference(tiny, defaults).reason, "small-primitive");
  assert.equal(filterTriangleClipReference(tiny, { ...defaults, sampleCount: 4 }).keep, true);
  assert.throws(
    () => filterTriangleClipReference(tiny, { ...defaults, sampleCount: 8 }),
    /4x precision contract/
  );
});

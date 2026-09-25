import assert from "node:assert/strict";
import test from "node:test";

import "../webgpu-test-globals.mjs";

import { projectedSurfaceBarycentricReference } from "../../.test-dist/shaders/SurfaceReconstructionOracle.js";
import { geometryWgsl } from "../../.test-dist/shaders/surface_material_kernel.js";

function closeVector(actual, expected, tolerance = 1e-6) {
  for (let i = 0; i < actual.length; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance,
      `${i}: ${actual[i]} differs from ${expected[i]}`);
  }
}

test("new Surface kernel retains the projected one-pixel gradient used by The Forge CalcFullBary", () => {
  const source = geometryWgsl(false);
  assert.match(source, /result\.ddx=\(w\+wx\)\/\(sum\+ix\)-result\.weights/u);
  assert.match(source, /result\.ddy=\(w\+wy\)\/\(sum\+iy\)-result\.weights/u);
  assert.match(source, /if any\(abs\(vec3f\(c0\.w, c1\.w, c2\.w\)\)/u);
  assert.doesNotMatch(source, /\(wx\*sum-w\*ix\)/u);
});

test("projected Surface gradients equal adjacent-pixel perspective interpolation", () => {
  const clips = [
    [-0.7, -0.7, 0, 1],
    [0.7, -0.7, 0, 1],
    [0, 0.35, 0, 0.5]
  ];
  const center = projectedSurfaceBarycentricReference([55, 50], clips, [100, 100]);
  const right = projectedSurfaceBarycentricReference([56, 50], clips, [100, 100]);
  const below = projectedSurfaceBarycentricReference([55, 51], clips, [100, 100]);
  assert.equal(center.valid, true);
  closeVector(center.weights.map((v, i) => v + center.ddx[i]), right.weights);
  closeVector(center.weights.map((v, i) => v + center.ddy[i]), below.weights);
  closeVector([center.weights.reduce((sum, value) => sum + value, 0)], [1]);
  closeVector([center.ddx.reduce((sum, value) => sum + value, 0)], [0]);
  closeVector([center.ddy.reduce((sum, value) => sum + value, 0)], [0]);
  const degenerate = projectedSurfaceBarycentricReference([50, 50],
    [[0, 0, 0, 1], [0.2, 0.2, 0, 1], [0.4, 0.4, 0, 1]], [100, 100]);
  assert.equal(degenerate.valid, false);
  const clipped = projectedSurfaceBarycentricReference([50, 50],
    [[0, 0, 0, 0], clips[1], clips[2]], [100, 100]);
  assert.equal(clipped.valid, false);
});

import assert from "node:assert/strict";
import test from "node:test";
globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
const { packScgiIrradiance, unpackScgiIrradiance } = await import("../../.test-dist/render/gi/ScgiAbi.js");

test("normalized irradiance preserves L0, signed directional ratios, rotations and RGB mixing", () => {
  for (const magnitude of [0, 1e-30, 1e-12, 1, 65504, 1e30]) {
    for (const normal of [
      [0, 0, 1],
      [0.6, 0, 0.8],
      [-0.577350269, -0.577350269, -0.577350269]
    ]) {
      const coefficients = [magnitude, magnitude * 0.5, magnitude * 0.25];
      for (let axis = 0; axis < 3; axis++)
        for (let c = 0; c < 3; c++) coefficients.push((coefficients[c] * normal[axis] * 2) / Math.sqrt(3));
      const scale = magnitude === 0 ? 1 : 2 ** Math.ceil(Math.log2(magnitude) - 14);
      const decoded = unpackScgiIrradiance(packScgiIrradiance(coefficients, scale), scale);
      for (let i = 0; i < 12; i++) {
        // Half L0 relative rounding <=2^-11; normalized ratio absolute
        // rounding <=2^-11, propagated via 4/sqrt3 times L0 plus L0 error.
        const bound = coefficients[i % 3] * 0.0025 + 1e-44;
        assert.ok(Math.abs(decoded[i] - coefficients[i]) <= bound, `${magnitude}/${i}`);
      }
    }
  }
  assert.throws(() => packScgiIrradiance([-1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 1), RangeError);
  assert.throws(() => packScgiIrradiance([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0], 1), RangeError);
  assert.throws(() => packScgiIrradiance([1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0], 1), RangeError);
});

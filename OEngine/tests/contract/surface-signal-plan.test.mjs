import assert from "node:assert/strict";
import test from "node:test";
import { packSurfaceSignalRates, unpackSurfaceSignalRates,
  surfaceSignalEffectiveRate, surfaceSignalRatesReference,
  surfaceResolveReference } from "../../.test-dist/render/surface/SurfaceSignalPlan.js";

test("Surface signal layout keeps directional coverage and forces unsafe closure signals full-rate", () => {
  const packed = packSurfaceSignalRates({ lighting: 1, material: 3, emissive: 2, normal: 0 });
  assert.deepEqual(unpackSurfaceSignalRates(packed), { lighting: 1, material: 3, emissive: 2, normal: 0 });
  assert.equal(surfaceSignalEffectiveRate(unpackSurfaceSignalRates(packed)), 0);
  assert.deepEqual(surfaceSignalRatesReference({ candidate: 3, normalTexture: true,
    ormTexture: false, emissiveTexture: false, materialVariation: 0, normalVariation: 0,
    budget: 0 }), { lighting: 3, material: 0, emissive: 3, normal: 0 });
  assert.deepEqual(surfaceSignalRatesReference({ candidate: 3, coated: true, shadow: true,
    materialVariation: 0, emissiveVariation: 0, normalVariation: 0, budget: 0 }),
    { lighting: 0, material: 0, emissive: 3, normal: 0 });
});

test("Surface Resolve oracle rejects cross-domain, depth and normal neighbors", () => {
  const owner = { value: [1, 2, 3, 1], domain: 7, depth: 0.5, normal: [0, 0, 1], valid: true };
  const accepted = { value: [3, 4, 5, 1], domain: 7, depth: 0.501, normal: [0, 0.001, 1], valid: true };
  const rejected = { value: [9, 9, 9, 1], domain: 8, depth: 0.5, normal: [0, 0, 1], valid: true };
  assert.deepEqual(surfaceResolveReference(owner, [accepted, rejected], 0.01, 0.01), [2, 3, 4, 1]);
  assert.deepEqual(surfaceResolveReference(owner, [rejected], 0.01, 0.01), owner.value);
});

import assert from "node:assert/strict";
import test from "node:test";
import { packSurfaceSignalRates, unpackSurfaceSignalRates,
  surfaceSignalEffectiveRate, surfaceSignalRatesReference,
  surfaceResolveReference } from "../../.test-dist/render/surface/SurfaceSignalPlan.js";
import { surfaceMaterialPackedRate } from "../../.test-dist/render/surface/SurfaceSampleAbi.js";
import { surfaceProbePairReference } from "../../.test-dist/render/surface/SurfaceProbe.js";

test("target geometry normal and depth do not cancel certified material closure reuse", () => {
  const fact = { valid: true, risk: 0, residencyValid: true, instance: 1, material: 2,
    geometry: 3, representation: 4, domain: 5, normal: [0,0,1], color: [1,1,1], uv: [0,0],
    depth: 0.4, normalVariation: 0.1, colorVariation: 0, variation: 0, parameterVariation: 0 };
  const neighbor = { ...fact, depth: 0.5, normal: [0,0.1,0.99] };
  const exact = { color: 0, parameter: 0, normal: 0, depth: 0, uv: 0 };
  assert.equal(surfaceProbePairReference(fact, neighbor, exact, false), true);
  assert.equal(surfaceProbePairReference(fact, neighbor, exact, true), false);
  assert.equal(surfaceProbePairReference(fact, { ...neighbor, domain: 6 }, exact, false), false);
  assert.equal(surfaceMaterialPackedRate(packSurfaceSignalRates({ material: 3, emissive: 3, normal: 0, lighting: 0 })), 3);
  assert.equal(surfaceMaterialPackedRate(packSurfaceSignalRates({ material: 3, emissive: 3, normal: 0, lighting: 1 })), 0);
});

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
  assert.deepEqual(surfaceSignalRatesReference({ candidate: 3, shadow: true, aoVariation: 1,
    materialVariation: 0, normalVariation: 0, budget: 0 }),
    { lighting: 0, material: 3, emissive: 3, normal: 3 });
});

test("Surface Resolve oracle rejects cross-domain, depth and normal neighbors", () => {
  const owner = { value: [1, 2, 3, 1], domain: 7, depth: 0.5, normal: [0, 0, 1], valid: true,
    identity: [2,3,4], representation: 9, layout: 3, position: [0,0], stride: [2,2], kind: 1 };
  const accepted = { ...owner, value: [3, 4, 5, 1], depth: 0.501, normal: [0, 0.001, 1], position: [2,0] };
  const rejected = { ...owner, value: [9, 9, 9, 1], domain: 8, position: [0,2] };
  assert.deepEqual(surfaceResolveReference(owner, [accepted, rejected], 0.01, 0.01, [1,0]), [2, 3, 4, 1]);
  assert.deepEqual(surfaceResolveReference(owner, [rejected], 0.01, 0.01, [1,1]), owner.value);
  for (const invalid of [{ identity: [2,3,5] }, { representation: 10 }, { layout: 1 }, { kind: 2 },
    { position: [1,0] }, { depth: 0.8 }, { normal: [1,0,0] }, { value: [NaN,1,1,1] }]) {
    assert.deepEqual(surfaceResolveReference(owner, [{ ...accepted, ...invalid }], 0.01, 0.01, [1,0]), owner.value);
  }
  assert.deepEqual(surfaceResolveReference(owner, [accepted], 0.01, 0.01, [0,0]), owner.value);
});

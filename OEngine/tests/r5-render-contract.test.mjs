import assert from "node:assert/strict";
import test from "node:test";

import {
  RenderSettings,
  metersToWorldUnits,
  qualityProfilePatch
} from "../.test-dist/render/pipeline/RenderSettings.js";
import {
  requireDomain,
  textureDomain
} from "../.test-dist/render/pipeline/FrameProducts.js";

test("Q01 physical scale is the single meters-to-world conversion", () => {
  assert.equal(metersToWorldUnits(2, { metersPerWorldUnit: 0.1 }), 20);
  assert.throws(() => metersToWorldUnits(1, { metersPerWorldUnit: 0 }), /greater than zero/);
});

test("Q01 rejects implicit resolution-domain conversions", () => {
  const half = textureDomain("internal-half", 960, 540, 0.5);
  assert.throws(() => requireDomain(half, "internal-full"), /declare a conversion owner/);
  assert.doesNotThrow(() => requireDomain(half, "internal-full", "JointBilateralUpsample"));
});

test("Q01 runtime uniforms do not rebuild topology", () => {
  const settings = new RenderSettings();
  const runtime = settings.update({ ao: { intensity: 1.25, radiusMeters: 1.5 } });
  assert.equal(runtime.changed, true);
  assert.equal(runtime.topologyChanged, false);
  assert.equal(runtime.resourcesChanged, false);
  assert.equal(runtime.resolutionChanged, false);
  assert.deepEqual(runtime.historiesInvalidated, ["ssao"]);

  const topology = settings.update({ ao: { resolutionScale: 1 } });
  assert.equal(topology.topologyChanged, true);
  assert.equal(topology.resourcesChanged, true);
  assert.equal(topology.resolutionChanged, false);
});

test("Q01 quality profiles only configure the unified pipeline", () => {
  assert.deepEqual(qualityProfilePatch("medium").ao?.resolutionScale, 0.5);
  const settings = new RenderSettings();
  settings.update({ qualityProfile: "ultra" });
  assert.equal(settings.values.ao.resolutionScale, 1);
  assert.equal(settings.values.qualityProfile, "ultra");
});

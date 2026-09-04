import assert from "node:assert/strict";
import test from "node:test";

import {
  RenderSettings,
  metersToWorldUnits,
  qualityProfilePatch
} from "../.test-dist/render/pipeline/RenderSettings.js";
import {
  opaqueLightingFrame,
  lightClusterFrame,
  shadowVisibilityFrame,
  requireDomain,
  surfaceFrameWithVelocity,
  surfaceFrame,
  textureDomain
} from "../.test-dist/render/pipeline/FrameProducts.js";
import {
  evaluateDirectLighting,
  schlickFresnel
} from "../.test-dist/render/DirectLightingReference.js";

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

test("Q01 Surface product freezes attachment semantics and allows missing velocity", () => {
  const frame = surfaceFrame({
    depth: null,
    pbr: 1,
    normal: 2,
    albedoAo: 3,
    emissive: 4,
    velocity: null,
    metadata: 5,
    domain: textureDomain("internal-full", 1920, 1080, 1)
  });
  assert.equal(frame.velocity, null);
  assert.equal(Object.isFrozen(frame), true);
  assert.throws(() => surfaceFrame({ ...frame, pbr: -1 }), /resource id/);
});

test("Q01 legacy Surface producer joins the same immutable product seam", () => {
  const base = surfaceFrame({
    depth: null,
    pbr: 1,
    normal: 2,
    albedoAo: 3,
    emissive: 4,
    velocity: null,
    metadata: null,
    domain: textureDomain("internal-full", 1920, 1080, 1)
  });
  const withVelocity = surfaceFrameWithVelocity(base, 5);
  assert.equal(withVelocity.velocity, 5);
  assert.equal(withVelocity.pbr, base.pbr);
  assert.equal(Object.isFrozen(withVelocity), true);
  assert.equal(base.velocity, null);
});

test("Q01 opaque lighting product rejects non-internal output domains", () => {
  const valid = opaqueLightingFrame({
    hdr: 1,
    iblSpecular: 2,
    indirectDiffuse: 3,
    domain: textureDomain("internal-full", 1920, 1080, 1)
  });
  assert.equal(valid.domain.domain, "internal-full");
  assert.equal(Object.isFrozen(valid), true);
  assert.throws(() => opaqueLightingFrame({
    ...valid,
    domain: textureDomain("output-full", 1920, 1080, 1)
  }), /internal-full/);
});

test("S2A clustered-light product freezes GPU producer/consumer ABI", () => {
  const frame = lightClusterFrame({
    parameters: 1,
    lookup: 2,
    data: 3,
    candidateLightList: 4,
    activeLightList: 5,
    counters: null,
    width: 1920,
    height: 1080,
    tileSize: 32,
    depthSlices: 24
  });
  assert.equal(Object.isFrozen(frame), true);
  assert.equal(frame.depthSlices, 24);
  assert.throws(() => lightClusterFrame({ ...frame, activeLightList: -1 }), /resource id/);
  assert.throws(() => lightClusterFrame({ ...frame, tileSize: 0 }), /layout/);
});

test("S2A CPU direct-lighting oracle freezes Schlick, GGX and metallic energy", () => {
  assert.deepEqual(schlickFresnel([0.04, 0.04, 0.04], 1, 1), [0.04, 0.04, 0.04]);
  assert.deepEqual(schlickFresnel([0.04, 0.04, 0.04], 1, 0), [1, 1, 1]);
  const dielectric = evaluateDirectLighting({
    albedo: [0.8, 0.2, 0.1], metallic: 0, roughness: 0.5,
    noL: 1, noV: 1, noH: 1, voH: 1, radiance: [1, 1, 1]
  });
  assert.ok(dielectric.contribution.every((value) => Number.isFinite(value) && value >= 0));
  const metal = evaluateDirectLighting({
    albedo: [0.8, 0.2, 0.1], metallic: 1, roughness: 0.5,
    noL: 1, noV: 1, noH: 1, voH: 1, radiance: [1, 1, 1]
  });
  assert.deepEqual(metal.diffuse, [0, 0, 0]);
  const invalid = evaluateDirectLighting({
    albedo: [0.8, 0.2, 0.1], metallic: 0, roughness: 0.5,
    noL: 1, noV: 1, noH: 1, voH: 1, radiance: [Infinity, 1, 1]
  });
  assert.deepEqual(invalid.contribution, [0, 0, 0]);
});

test("S2B shadow product exposes visibility-only resources and frozen filter parameters", () => {
  const frame = shadowVisibilityFrame({
    atlas: 7,
    contactVisibility: null,
    cascadeCount: 3,
    pcfTapCount: 5,
    normalOffsetScale: 0.5,
    depthBias: 2,
    slopeScale: 1.5,
    atlasWidth: 4096,
    atlasHeight: 4096
  });
  assert.equal(Object.isFrozen(frame), true);
  assert.equal(frame.contactVisibility, null);
  assert.equal(frame.cascadeCount, 3);
  assert.throws(() => shadowVisibilityFrame({ ...frame, depthBias: -1 }), /non-negative/);
  assert.throws(() => shadowVisibilityFrame({ ...frame, atlasWidth: 0 }), /dimensions/);
});

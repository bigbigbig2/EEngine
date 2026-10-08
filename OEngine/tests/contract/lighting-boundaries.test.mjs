import test from "node:test";
import assert from "node:assert/strict";
import { PointLight } from "../../.test-dist/light/PointLight.js";
import { SpotLight } from "../../.test-dist/light/SpotLight.js";
import { DirectionalLight } from "../../.test-dist/light/DirectionalLight.js";
import "../webgpu-test-globals.mjs";
import {
  GPULightCollection,
  packPointLightRecord,
  packSpotLightRecord,
  packDirectionalLightRecord,
} from "../../.test-dist/gpu/LightDatabase.js";
import {
  lightSphereDistanceAttenuation,
  spotLightAttenuation,
  assertLightListCapacity,
  clusterDepthToSlice,
} from "../../.test-dist/render/ClusteredLightingReference.js";

test("finite spherical support is cutoff plus emitter radius; zero cutoff is unbounded", () => {
  assert.equal(lightSphereDistanceAttenuation(2.5, 2, 1), 0.140625);
  assert.equal(lightSphereDistanceAttenuation(3, 2, 1), 0);
  assert.equal(lightSphereDistanceAttenuation(10, 0, 0), 0.01);
  assert.equal(spotLightAttenuation(0.5, 0.5, 0.5), 1);
  assert.equal(spotLightAttenuation(0.5, 0.5, 0.49), 0);
});

test("default casts_shadow with no published provider ID is not a shadow request", () => {
  for (const [Type, pack] of [
    [PointLight, packPointLightRecord],
    [SpotLight, packSpotLightRecord],
    [DirectionalLight, packDirectionalLightRecord],
  ]) {
    const light = new Type();
    assert.equal(light.casts_shadow, true);
    assert.equal(light._gpu_shadowmap_id, -1);
    assert.equal(pack(light).flags, 0);
  }
});

test("unsupported authored shadow publication fails before mutating the LightDatabase owner", () => {
  for (const Type of [PointLight, SpotLight, DirectionalLight]) {
    const light = new Type();
    light._gpu_shadowmap_id = 0;
    const owner = Object.create(GPULightCollection.prototype);
    owner.source = { elements: [light] };
    owner.lightingRevision = 7;
    assert.throws(() => owner.build({}), /unsupported.*shadow/i);
    assert.equal(owner.lightingRevision, 7);
  }
});

test("admission rejects loss rather than truncating a complete light list", () => {
  assert.doesNotThrow(() => assertLightListCapacity(16380, 16380));
  assert.throws(() => assertLightListCapacity(16381, 16380), RangeError);
});

test("log cluster boundary convention clamps near/far and assigns every boundary", () => {
  const parameters = { x: 1, y: 0, z: 1 };
  assert.equal(clusterDepthToSlice(0, parameters, 24), 0);
  assert.equal(clusterDepthToSlice(1, parameters, 24), 0);
  for (let slice = 1; slice < 24; slice++) {
    assert.equal(clusterDepthToSlice(2 ** slice, parameters, 24), slice);
    assert.ok(clusterDepthToSlice(2 ** slice * (1 - 1e-6), parameters, 24) < slice);
    assert.ok(clusterDepthToSlice(2 ** slice * (1 + 1e-6), parameters, 24) > slice);
  }
  assert.equal(clusterDepthToSlice(2 ** 30, parameters, 24), 24);
});

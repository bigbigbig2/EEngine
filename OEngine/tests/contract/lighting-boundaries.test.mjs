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
  packDirectionalLightRecord
} from "../../.test-dist/gpu/LightDatabase.js";
import {
  lightSphereDistanceAttenuation,
  spotLightAttenuation
} from "../../.test-dist/render/DirectLightingReference.js";

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
    [DirectionalLight, packDirectionalLightRecord]
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

test("local-light identity rejects unrepresentable slots without truncation", async () => {
  const { localLightId } = await import("../../.test-dist/gpu/GpuLocalLightWorkAbi.js");
  assert.equal(localLightId(0xffffff, 1), 0x1ffffff);
  assert.throws(() => localLightId(0x1000000, 0), RangeError);
});

test("log slices assign near/far and beyond-far to bounded cells", async () => {
  const { localLightDepthSlice } = await import("../../.test-dist/gpu/GpuLocalLightWorkAbi.js");
  assert.equal(localLightDepthSlice(0, 1, 2 ** 23), 0);
  for (let slice = 1; slice < 23; slice++) {
    assert.equal(localLightDepthSlice(2 ** slice, 1, 2 ** 23), slice);
    assert.equal(localLightDepthSlice(2 ** slice * (1 - 1e-6), 1, 2 ** 23), slice - 1);
    assert.equal(localLightDepthSlice(2 ** slice * (1 + 1e-6), 1, 2 ** 23), slice);
  }
  assert.equal(localLightDepthSlice(2 ** 30, 1, 2 ** 23), 23);
});

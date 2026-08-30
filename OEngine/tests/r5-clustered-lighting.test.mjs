import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  appendBoundedLightList,
  assertLightListCapacity,
  clusterDepthToSlice,
  clusterGridIndex,
  lightSphereDistanceAttenuation,
  resolveClusterLightIndices,
  sphereIntersectsFrustum,
  spotLightAttenuation
} from "../.test-dist/render/ClusteredLightingReference.js";
import {
  assertDirectionalLightCapacity,
  MAX_DIRECTIONAL_LIGHTS
} from "../.test-dist/gpu/LightCapacity.js";

test("FX-02 inverse-square attenuation respects emitter radius and cutoff", () => {
  assert.equal(lightSphereDistanceAttenuation(0, 0.5, 0), 4);
  assert.equal(lightSphereDistanceAttenuation(0.25, 0.5, 0), 4);
  assert.equal(lightSphereDistanceAttenuation(2, 0, 0), 0.25);
  assert.equal(lightSphereDistanceAttenuation(2, 0.5, 1), 0);
  assert.ok(lightSphereDistanceAttenuation(1, 0.25, 2) > 0);
});

test("FX-02 spot attenuation covers cone, penumbra, and outside", () => {
  const cone = Math.cos(Math.PI / 4);
  const penumbra = Math.cos(Math.PI / 8);
  assert.equal(spotLightAttenuation(cone, penumbra, cone - 0.01), 0);
  assert.equal(spotLightAttenuation(cone, penumbra, penumbra + 0.01), 1);
  const transition = spotLightAttenuation(cone, penumbra, (cone + penumbra) * 0.5);
  assert.ok(transition > 0 && transition < 1);
});

test("FX-02 cluster depth slice and grid index match the production layout", () => {
  const parameters = { x: 0.8, y: 0.2, z: 4.06 };
  assert.equal(clusterDepthToSlice(0, parameters, 23), 0);
  assert.ok(clusterDepthToSlice(10, parameters, 23) > 0);
  assert.equal(clusterDepthToSlice(1e9, parameters, 23), 23);
  assert.equal(clusterGridIndex([2, 3, 4], [40, 23]), 2 + (3 + 4 * 23) * 40);
});

test("FX-02 light sphere intersection rejects only fully separated clusters", () => {
  const unitCubeFrustum = [
    [1, 0, 0, 1],
    [-1, 0, 0, 1],
    [0, 1, 0, 1],
    [0, -1, 0, 1],
    [0, 0, 1, 1],
    [0, 0, -1, 1]
  ];
  assert.equal(sphereIntersectsFrustum([0, 0, 0, 0.25], unitCubeFrustum), true);
  assert.equal(sphereIntersectsFrustum([1.25, 0, 0, 0.25], unitCubeFrustum), true);
  assert.equal(sphereIntersectsFrustum([1.26, 0, 0, 0.25], unitCubeFrustum), false);
});

test("FX-02 directional capacity rejects overflow instead of truncating", () => {
  assert.doesNotThrow(() => assertDirectionalLightCapacity(MAX_DIRECTIONAL_LIGHTS));
  assert.throws(
    () => assertDirectionalLightCapacity(MAX_DIRECTIONAL_LIGHTS + 1),
    /exceeds the explicit capacity/
  );
});

test("FX-02 bounded LightList separates attempted, written, capacity, and overflow", () => {
  assert.deepEqual(appendBoundedLightList([4, 5, 6], 3), {
    attempted: 3,
    written: 3,
    capacity: 3,
    overflow: 0,
    data: [4, 5, 6]
  });
  assert.deepEqual(appendBoundedLightList([4, 5, 6], 2), {
    attempted: 3,
    written: 2,
    capacity: 2,
    overflow: 1,
    data: [4, 5]
  });
});

test("FX-02 production LightList rejects counts that cannot preserve every light", () => {
  assert.doesNotThrow(() => assertLightListCapacity(16_380, 16_380));
  assert.throws(
    () => assertLightListCapacity(16_381, 16_380),
    /exceeds the explicit LightList capacity/
  );
});

test("FX-02 fallback consumes the bounded active list and cannot omit lights", () => {
  const active = appendBoundedLightList([11, 22, 33], 3);
  assert.deepEqual(
    resolveClusterLightIndices(
      { offset: 1, pointCount: 1, spotCount: 1, flags: 0 },
      [99, 11, 22],
      active
    ),
    [11, 22]
  );
  assert.deepEqual(
    resolveClusterLightIndices(
      { offset: 0, pointCount: 0, spotCount: 0, flags: 8 },
      [],
      active
    ),
    [11, 22, 33]
  );
});

test("FX-02 production shader uses bounded headers and explicit cluster fallback", async () => {
  const source = await readFile(new URL("../src/shaders/light_cluster.ts", import.meta.url), "utf8");
  const pass = await readFile(new URL("../src/render/passes/LightClusterPass.ts", import.meta.url), "utf8");
  assert.match(source, /attempted:\s*atomic<u32>/);
  assert.match(source, /written:\s*atomic<u32>/);
  assert.match(source, /capacity:\s*atomic<u32>/);
  assert.match(source, /overflow:\s*atomic<u32>/);
  assert.match(source, /atomicCompareExchangeWeak/);
  assert.match(source, /CLUSTER_METADATA_FLAG_FALLBACK/);
  assert.doesNotMatch(source, /point_count\s*>=\s*128u\)\s*\{\s*continue/);
  assert.doesNotMatch(source, /spot_count\s*>=\s*128u\)\s*\{\s*continue/);
  assert.match(pass, /if \(activeLocalLightCount === 0\) return;/);
  assert.match(pass, /active_list\.written == 0u/);
  assert.match(pass, /if \(localLightCount === 0\)/);
  assert.match(pass, /LightCluster\/zero-light-stats/);
});

test("FX-02 authored direct shader owns runtime and consumes Surface metadata", async () => {
  const pass = await readFile(new URL("../src/render/passes/LightingPass.ts", import.meta.url), "utf8");
  const shader = await readFile(new URL("../src/shaders/lighting_direct.ts", import.meta.url), "utf8");
  assert.match(pass, /shaders\/lighting_direct\.js/);
  assert.doesNotMatch(pass, /lighting_ch_oracle/);
  assert.match(pass, /gMetadata:\s*ResourceId/);
  assert.match(pass, /activeLightList:\s*ResourceId/);
  assert.match(shader, /OENGINE_SURFACE_FLAG_UNLIT/);
  assert.match(shader, /active_light_list\.written/);
  assert.match(shader, /if \(active_light_list\.written == 0u\)/);
  assert.match(shader, /CLUSTER_METADATA_FLAG_FALLBACK/);
});

test("FX-02 legacy direct-lighting oracle source is removed", async () => {
  await assert.rejects(
    readFile(new URL("../src/shaders/lighting_ch_oracle.ts", import.meta.url), "utf8"),
    (error) => error?.code === "ENOENT"
  );
});

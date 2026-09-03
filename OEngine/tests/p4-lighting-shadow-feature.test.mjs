import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("P4 LightingFeature owns clustered producer, direct HDR consumer and background composition", async () => {
  const feature = await readFile(
    new URL("../src/render/features/LightingFeature.ts", import.meta.url),
    "utf8"
  );
  const renderer = await readFile(
    new URL("../src/render/Renderer.ts", import.meta.url),
    "utf8"
  );
  assert.match(feature, /GPU producer 链为 Light Buffer/);
  assert.match(feature, /new LightClusterPass/);
  assert.match(feature, /new LightingPass/);
  assert.match(feature, /new EnvironmentBackgroundPass/);
  assert.match(feature, /clusterParameters: clusters\.parameters/);
  assert.match(feature, /activeLightList: clusters\.activeLightList/);
  assert.match(feature, /return Object\.freeze\(\{ hdr: direct\.hdr, clusters \}\)/);
  assert.match(renderer, /new LightingFeature\(this\._graphics\)/);
  assert.doesNotMatch(renderer, /new LightClusterPass\(/);
  assert.doesNotMatch(renderer, /new LightingPass\(/);
  assert.doesNotMatch(renderer, /new EnvironmentBackgroundPass\(/);
});

test("P4 ShadowService is the GPU light collection shadow owner boundary", async () => {
  const service = await readFile(
    new URL("../src/gpu/ShadowService.ts", import.meta.url),
    "utf8"
  );
  const lights = await readFile(
    new URL("../src/gpu/LightDatabase.ts", import.meta.url),
    "utf8"
  );
  const renderer = await readFile(
    new URL("../src/render/Renderer.ts", import.meta.url),
    "utf8"
  );
  assert.match(service, /new ShadowContext/);
  assert.match(service, /setEnabled\(enabled: boolean/);
  assert.match(service, /select_for_draw\(/);
  assert.match(service, /draw\(/);
  assert.match(service, /releasePackedScene\(/);
  assert.match(lights, /readonly shadow_service: ShadowService/);
  assert.match(lights, /this\.shadow_service = new ShadowService/);
  assert.doesNotMatch(lights, /readonly shadow_context/);
  assert.match(renderer, /lights\.shadow_service/);
  assert.doesNotMatch(renderer, /lights\.shadow_context/);
});

test("P4 keeps default shadow caster semantics and bounded lighting evidence", async () => {
  const light = await readFile(
    new URL("../src/light/Light.ts", import.meta.url),
    "utf8"
  );
  const cluster = await readFile(
    new URL("../src/render/passes/LightClusterPass.ts", import.meta.url),
    "utf8"
  );
  const shadow = await readFile(
    new URL("../src/render/passes/PackedCsmShadowPass.ts", import.meta.url),
    "utf8"
  );
  assert.match(light, /casts_shadow = true/);
  assert.match(cluster, /assertLightListCapacity\(/);
  assert.match(cluster, /clusterOverflowClusters/);
  assert.match(shadow, /pass\.drawIndirect\(generated\.drawIndirect, 0\)/);
  assert.match(shadow, /shadowQueueOverflowMask/);
});

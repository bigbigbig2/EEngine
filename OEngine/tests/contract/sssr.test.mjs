import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  SCREEN_SPACE_REFLECTIONS_DEFAULT_SETTINGS as defaults,
  resolveScreenSpaceReflectionsSettings as resolve,
  screenSpaceReflectionsHistoryKey as key
} from "../../.test-dist/render/reflections/ScreenSpaceReflectionsSettings.js";
import {
  planSssrCapacity,
  packSssrReceiver,
  resolveSssrMemorySettings
} from "../../.test-dist/render/reflections/SssrAbi.js";

const limits = {
  maxTextureDimension2D: 16384,
  maxTextureArrayLayers: 256,
  maxBufferSize: 1024 ** 3,
  maxStorageBufferBindingSize: 128 * 1024 ** 2,
  maxComputeWorkgroupsPerDimension: 65535,
  maxStorageTexturesPerShaderStage: 4,
  maxStorageBuffersPerShaderStage: 8,
  maxSampledTexturesPerShaderStage: 16,
  maxUniformBufferBindingSize: 65536,
  maxComputeWorkgroupStorageSize: 16384,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupSizeX: 256,
  maxComputeWorkgroupSizeY: 256
};

test("SSSR settings are atomic, f32 safe and do not mix strength with signal history", () => {
  assert.equal(defaults.enabled, false);
  assert.equal(resolve(defaults, {}), defaults);
  for (const patch of [
    { strength: NaN },
    { maxRoughness: 0 },
    { quality: "low" },
    { enabled: 1 },
    { unknown: 0 },
    { thicknessMeters: 1e-40 },
    { metersPerWorldUnit: 1e-40 },
    { maxRoughness: 1e-30 },
    { thicknessMeters: 1e30, metersPerWorldUnit: 1e-30 }
  ]) {
    assert.throws(() => resolve(defaults, patch), RangeError);
  }
  assert.equal(key(defaults), key(resolve(defaults, { strength: 0.5 })));
  assert.notEqual(key(defaults), key(resolve(defaults, { quality: "high" })));
  assert.notEqual(key(defaults), key(resolve(defaults, { thicknessMeters: 0.03, metersPerWorldUnit: 2 })));
});

test("SSSR complete viewport capacities include both lobes and skinny mip chains", () => {
  const p = planSssrCapacity(1920, 1080, limits);
  assert.equal(p.receiverBytes, 66355200);
  assert.equal(p.rayBytes, 16588800);
  assert.equal(p.tiles, 32400);
  assert.equal(p.mipCount, 7);
  assert.ok(p.activeBytes <= 143 * p.pixels + 40 * p.tiles + 1048576);
  const narrow = planSssrCapacity(1, 2048, limits);
  assert.equal(narrow.depthBytes, 4 * (2048 + 1024 + 512 + 256 + 128 + 64 + 32));
  assert.ok(narrow.activeBytes <= 143 * narrow.pixels + 40 * narrow.tiles + 1048576);
  assert.equal(planSssrCapacity(1, 1, limits).mipCount, 1);
  assert.equal(
    planSssrCapacity(17, 19, limits, {}, true).activeBytes - planSssrCapacity(17, 19, limits).activeBytes,
    17 * 19 * 4
  );
  assert.throws(() => planSssrCapacity(3840, 2160, limits), /binding capacity/);
  const large = planSssrCapacity(
    3840,
    2160,
    { ...limits, maxStorageBufferBindingSize: 256 * 1024 ** 2 },
    { maxBytes: 2 * 1024 ** 3, ownerMaxBytes: 3 * 1024 ** 3 }
  );
  assert.equal(large.receiverBytes, 265420800);
  assert.throws(() => planSssrCapacity(1920, 1080, limits, { maxBytes: 1024 ** 2 }), /memory ceiling/);
  assert.throws(
    () => planSssrCapacity(16, 16, { ...limits, maxStorageTexturesPerShaderStage: 3 }),
    /complete profile/
  );
  assert.throws(() => resolveSssrMemorySettings({ maxBytes: 1024, ownerMaxBytes: 512 }), /owner/);
});

test("SSSR record preserves all normals, responses, baseline and flags; failure does not partially write", () => {
  const values = [1, 0, 0, 0.0016, 0, 1, 0, 0.0625, 0.25, 0.5, 0.75, 0.04, 1, 2, 3, 7];
  const words = new Uint32Array(10).fill(0xdeadbeef);
  packSssrReceiver(values, words, 1);
  // IEEE binary16 independently decoded, not the production half codec.
  const half = (value) => {
    const e = (value >>> 10) & 31,
      f = value & 1023;
    return (value & 0x8000 ? -1 : 1) * (e ? (1 + f / 1024) * 2 ** (e - 15) : f * 2 ** -24);
  };
  const decoded = [];
  for (const word of words.subarray(1, 9)) decoded.push(half(word & 65535), half(word >>> 16));
  decoded.forEach((value, index) =>
    assert.ok(Math.abs(value - values[index]) <= Math.max(2 ** -24, Math.abs(values[index]) / 1024))
  );
  assert.equal(decoded[15], 7);
  assert.equal(words[0], 0xdeadbeef);
  assert.equal(words[9], 0xdeadbeef);
  const before = words.slice();
  assert.throws(() => packSssrReceiver([...values.slice(0, 15), Infinity], words, 1));
  assert.deepEqual(words, before);
  assert.throws(() => packSssrReceiver(values, words, 0.5));
  assert.throws(() => packSssrReceiver([...values.slice(0, 15), 8], words, 1));
  assert.deepEqual(words, before);
});

test("SSSR consumes exactly the pinned 1spp Sobol/scrambling data", async () => {
  const bytes = await readFile(new URL("../../src/render/assets/sssr/blue-noise.bin", import.meta.url));
  assert.equal(bytes.length, 786432);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "11b613c467f85e4ad558dc7d3e5b046f0fc3207c607dbb289623fdff922cf612"
  );
  assert.equal(bytes.readUInt32LE(0), 32);
  assert.equal(bytes.readUInt32LE(65536 * 4), 162);
});

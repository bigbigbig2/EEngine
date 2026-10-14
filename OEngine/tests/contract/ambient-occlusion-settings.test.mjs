import test from "node:test";
import assert from "node:assert/strict";
import "../webgpu-test-globals.mjs";
import {
  AMBIENT_OCCLUSION_DEFAULT_SETTINGS as defaults,
  resolveAmbientOcclusionSettings as resolve,
  ambientOcclusionContentKey as key
} from "../../.test-dist/render/ao/AmbientOcclusionSettings.js";
import { mergeRendererConfig, validateRendererConfig } from "../../.test-dist/render/RendererConfig.js";
import {
  packXeGtaoPreparation,
  XE_GTAO_PREP_BYTES
} from "../../.test-dist/render/ao/XeGtaoPreparationAbi.js";

globalThis.GPUBufferUsage ??= {
  MAP_READ: 1,
  COPY_SRC: 4,
  COPY_DST: 8,
  UNIFORM: 64,
  STORAGE: 128,
  INDIRECT: 256
};
const { Renderer } = await import("../../.test-dist/render/pipeline/RendererCore.js");

test("AO defaults, immutable snapshots and atomic pre-initialization edits", () => {
  assert.deepEqual(defaults, {
    enabled: true,
    radiusMeters: 1,
    metersPerWorldUnit: 1,
    strength: 1,
    finalValuePower: 2.2,
    quality: "high",
    denoisePasses: 1
  });
  const renderer = new Renderer({ ambientOcclusion: { quality: "medium" } });
  renderer.setAmbientOcclusionSettings({ strength: 0.5, denoisePasses: 3 });
  const snapshot = renderer.ambientOcclusionSettings;
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(snapshot.quality, "medium");
  renderer.setAmbientOcclusionSettings({ strength: 0.5 });
  assert.equal(renderer.ambientOcclusionSettings, snapshot);
  for (const invalid of [
    { enabled: 1 },
    { radiusMeters: 0 },
    { radiusMeters: Infinity },
    { metersPerWorldUnit: -1 },
    { radiusMeters: 1e-300 },
    { radiusMeters: 1e-40 },
    { radiusMeters: 3e38 },
    { strength: NaN },
    { strength: 1.01 },
    { finalValuePower: 0.49 },
    { finalValuePower: 5.1 },
    { quality: "low" },
    { denoisePasses: 4 },
    { denoisePasses: 0.5 },
    { typo: true },
    { radiusMeters: undefined }
  ]) {
    assert.throws(() => renderer.setAmbientOcclusionSettings({ strength: 0.7, ...invalid }), RangeError);
    assert.equal(renderer.ambientOcclusionSettings, snapshot, JSON.stringify(invalid));
  }
  assert.equal(Object.hasOwn(renderer, "xe_gtao_enabled"), false);
  assert.equal(renderer._temporalResetPending, false);
});

test("AO physical content identity ignores inactive edits and equivalent unit conversions", () => {
  assert.equal(key(resolve(defaults, { radiusMeters: 10, metersPerWorldUnit: 10 })), key(defaults));
  assert.notEqual(key(resolve(defaults, { strength: 0.5 })), key(defaults));
  assert.notEqual(key(resolve(defaults, { finalValuePower: 1 })), key(defaults));
  assert.equal(key(resolve(defaults, { enabled: false, quality: "medium" })), null);
  assert.equal(key(resolve(defaults, { strength: 0, denoisePasses: 3 })), null);
  const config = mergeRendererConfig(
    { ambientOcclusion: { strength: 0.4, quality: "medium" } },
    { ambientOcclusion: { radiusMeters: 2 } }
  );
  validateRendererConfig(config);
  assert.deepEqual(config.ambientOcclusion, { strength: 0.4, quality: "medium", radiusMeters: 2 });
  assert.throws(() => validateRendererConfig({ ambientOcclusion: { strength: -1 } }), RangeError);
});

test("96-byte AO constants retain the donor prefix and append output strength", () => {
  const projection = new Float32Array(16);
  projection[0] = 1.5;
  projection[5] = 2;
  projection[14] = 0.1;
  const input = { width: 193, height: 129, projection, radiusMeters: 1, metersPerWorldUnit: 1 };
  const base = packXeGtaoPreparation(input);
  const mixed = packXeGtaoPreparation({ ...input, strength: 0.375 });
  assert.equal(XE_GTAO_PREP_BYTES, 96);
  assert.equal(mixed.byteLength, 96);
  assert.deepEqual(new Uint8Array(mixed, 0, 80), new Uint8Array(base, 0, 80));
  assert.deepEqual([...new Float32Array(mixed, 80)], [0.375, 0, 0, 0]);
  assert.equal(new Float32Array(base)[20], 1);
});

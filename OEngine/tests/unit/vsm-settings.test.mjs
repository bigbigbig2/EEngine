import { VSM_PARAMETERS_WORD, VSM_CONTROL_WORD, VSM_IDENTITY_BYTE_OFFSET, VSM_DEPTH_RANGE_BYTE_OFFSET,
  VSM_PROJECTION_CONSTANT_BYTES, VSM_SELECTOR_WORD } from "../../.test-dist/gpu/GpuVsmProjectionAbi.js";
import test from "node:test";
import assert from "node:assert/strict";
import { VSM_DEFAULT_SETTINGS, resolveVsmSettings } from "../../.test-dist/render/vsm/VsmSettings.js";
import { buildVsmDirectionalFrameConstants } from "../../.test-dist/render/vsm/VsmProjection.js";
import { packVsmSamplingConstants } from "../../.test-dist/render/vsm/VsmReceiverDemandPass.js";
import { VsmGeneration } from "../../.test-dist/render/vsm/VsmGeneration.js";

const resources = {
  profile: "vsm-directional-high",
  namespace: 19,
  capabilities: {
    clipLevels: 10,
    virtualPagesPerAxis: 64,
    pageSize: 64,
    border: 4,
    atlasPagesPerAxis: 56,
    atlasDimension: 4096,
  },
};
function frame(settings = VSM_DEFAULT_SETTINGS) {
  return buildVsmDirectionalFrameConstants([0, 1, 0], [0, 0, 0], 256, resources, 7, 43, settings);
}
function packed(settings, profile = resources) {
  return packVsmSamplingConstants({
    width: 16,
    height: 16,
    frame: frame(settings),
    resources: profile,
    generation: 7,
    filterNoiseWordOffset: 2048,
    filterPhase: 63,
  });
}

test("default disk4 has four total samples, a bounded level transition and merged angular depth bias", () => {
  const bytes = packed(VSM_DEFAULT_SETTINGS);
  const floats = new Float32Array(bytes),
    words = new Uint32Array(bytes);
  assert.deepEqual(Array.from(floats.subarray(VSM_PARAMETERS_WORD, VSM_PARAMETERS_WORD + 4)), [1, 1, Math.fround(0.16), 1.5]);
  assert.equal(words[VSM_CONTROL_WORD + 2], 2);
  assert.equal(words[VSM_CONTROL_WORD + 3], 63);
  assert.deepEqual(Array.from(words.subarray(VSM_IDENTITY_BYTE_OFFSET / 4, VSM_IDENTITY_BYTE_OFFSET / 4 + 4)), [43, 19, 0, 2048]);
  assert.equal(bytes.byteLength, VSM_PROJECTION_CONSTANT_BYTES);
  assert.equal(frame().clipOriginExtent[0][2], 4);
});

test("distance profile is camera-centered and preserves effective finest texel", () => {
  const value = frame();
  assert.deepEqual(value.clipOriginExtent[0], [-2, -2, 4, 1/1024]);
  assert.equal(value.clipOriginExtent[1][3], 32/16384);
  assert.ok(value.clipOriginExtent.at(-1)[2] >= 32*32);
  assert.deepEqual(Array.from(new Float32Array(packed(VSM_DEFAULT_SETTINGS)).subarray(VSM_SELECTOR_WORD,VSM_SELECTOR_WORD+4)),[0,0,0,1]);
});

test("all kernels retain projection/depth identity and disk offsets stay within rasterized gutter", () => {
  for (const [filterMode, code] of [
    ["point", 0],
    ["gather2x2", 1],
    ["disk4", 2],
  ]) {
    const settings = resolveVsmSettings(VSM_DEFAULT_SETTINGS, {
      angularBiasTexels: 0.75,
      depthBiasTexels: 4,
      filterRadiusTexels: 3,
      filterMode,
      debugView: "page-state",
    });
    const bytes = packed(settings);
    assert.deepEqual(Array.from(new Float32Array(bytes).subarray(VSM_PARAMETERS_WORD, VSM_PARAMETERS_WORD + 4)), [0.75, 4, Math.fround(0.16), 3]);
    assert.equal(new Uint32Array(bytes)[VSM_CONTROL_WORD + 2], code);
    assert.deepEqual(Array.from(new Uint32Array(bytes).subarray(VSM_IDENTITY_BYTE_OFFSET / 4, VSM_IDENTITY_BYTE_OFFSET / 4 + 4)), [43, 19, 3, 2048]);
    assert.deepEqual(Array.from(new Float32Array(bytes).subarray(VSM_DEPTH_RANGE_BYTE_OFFSET / 4, VSM_DEPTH_RANGE_BYTE_OFFSET / 4 + 4)), [0, 0, 0, 0]);
  }
  for (const radius of [0, 0.75, 1.5, 3])
    for (let angle = 0; angle < 360; angle++)
      for (const uv of [0, 1 - 1e-7]) {
        const texel = Math.floor(uv * 64 + Math.cos((angle * Math.PI) / 180) * radius + 0.5);
        assert.ok(texel >= -4 && texel < 68);
      }
  assert.throws(
    () => packVsmSamplingConstants({ resources, frame: frame(), width: 16, height: 16, generation: 7 }),
    /noise publication/,
  );
});

test("zero-radius disk folds to one point without requiring a noise publication", () => {
  const settings = resolveVsmSettings(VSM_DEFAULT_SETTINGS, { filterRadiusTexels: 0 });
  const bytes = packVsmSamplingConstants({
    resources,
    frame: frame(settings),
    width: 16,
    height: 16,
    generation: 7,
  });
  assert.equal(new Uint32Array(bytes)[VSM_CONTROL_WORD + 2], 0);
  assert.equal(new Uint32Array(bytes)[VSM_IDENTITY_BYTE_OFFSET / 4 + 3], 0);
});

test("coverage changes rebuild transactionally while sampling changes do not redraw depth", () => {
  const owner = new VsmGeneration();
  const input = {
    deviceEpoch: 1,
    scene: {},
    sceneRevision: 1,
    casterRevision: 0,
    sourceRevision: 0,
    sunDirection: [0, 1, 0],
    cameraCut: false,
    width: 16,
    height: 16,
    clipOriginExtent: frame().clipOriginExtent,
  };
  const initial = owner.prepare(input);
  owner.commit(initial);
  const filtered = frame(
    resolveVsmSettings(VSM_DEFAULT_SETTINGS, { depthBiasTexels: 8, debugView: "visibility" }),
  );
  const sampling = owner.prepare({ ...input, clipOriginExtent: filtered.clipOriginExtent });
  assert.equal(sampling.fullInvalidate, false);
  assert.equal(sampling.rebuildDepth, false);
  owner.commit(sampling);
  const enlarged = frame(resolveVsmSettings(VSM_DEFAULT_SETTINGS, { clipExtentScale: 2 }));
  assert.equal(enlarged.clipOriginExtent[0][2], 8);
  const changed = owner.prepare({ ...input, clipOriginExtent: enlarged.clipOriginExtent });
  assert.equal(changed.fullInvalidate, true);
  assert.equal(changed.rebuildDepth, true);
  owner.abort();
  assert.equal(owner.currentProjectionEpoch, initial.projectionEpoch);
  const retry = owner.prepare({ ...input, clipOriginExtent: enlarged.clipOriginExtent });
  assert.deepEqual(retry, changed);
  owner.commit(retry);
  owner.invalidate();
  const rebuild = owner.prepare({ ...input, clipOriginExtent: enlarged.clipOriginExtent });
  assert.equal(rebuild.fullInvalidate, true);
  owner.abort();
});

test("invalid or nonfinite tuning cannot mutate the frozen live settings", () => {
  for (const patch of [
    { depthBiasTexels: -1 },
    { angularBiasTexels: NaN },
    { angularBiasTexels: 17 },
    { filterMode: "grid16" },
    { normalBiasTexels: 0.5 },
    { filterRadiusTexels: 3.01 },
    { clipSelectionBias: 0.5 },
    { clipSelectionBias: Infinity },
    { clipExtentScale: 0 },
    { clipExtentScale: Infinity },
    { clipTransitionRatio: -0.01 },
    { clipTransitionRatio: 0.36 },
    { debugView: "atlas" },
  ]) {
    assert.throws(() => resolveVsmSettings(VSM_DEFAULT_SETTINGS, patch), RangeError);
  }
  assert.ok(Object.isFrozen(VSM_DEFAULT_SETTINGS));
  assert.equal(VSM_DEFAULT_SETTINGS.depthBiasTexels, 1);
  assert.equal(VSM_DEFAULT_SETTINGS.clipTransitionRatio, 0.16);
});

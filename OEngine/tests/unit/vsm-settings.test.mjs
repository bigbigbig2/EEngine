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
    clipLevels: 6,
    virtualPagesPerAxis: 128,
    pageSize: 128,
    border: 4,
    atlasPagesPerAxis: 30,
    pcfTapCount: 4,
    atlasDimension: 4096
  }
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
    generation: 7
  });
}

test("default constants preserve the production biases, 16 samples and 1.5 texel kernel width", () => {
  const bytes = packed(VSM_DEFAULT_SETTINGS);
  const floats = new Float32Array(bytes),
    words = new Uint32Array(bytes);
  assert.deepEqual(Array.from(floats.subarray(48, 52)), [0.5, 2, 1.5, 1.5]);
  assert.equal(words[46], 4);
  assert.deepEqual(Array.from(words.subarray(56, 60)), [43, 19, 0, 0]);
  assert.equal(bytes.byteLength, 256);
  assert.equal(frame().clipOriginExtent[0][2], 32);
});

test("sampling controls retain depth/identity ABI and respect the negotiated tap ceiling", () => {
  const settings = resolveVsmSettings(VSM_DEFAULT_SETTINGS, {
    normalBiasTexels: 0,
    depthBiasTexels: 4,
    slopeBiasTexels: 0.75,
    filterRadiusTexels: 3,
    pcfTapsPerAxis: 3,
    debugView: "page-state"
  });
  const bytes = packed(settings, {
    ...resources,
    capabilities: { ...resources.capabilities, pcfTapCount: 2 }
  });
  assert.deepEqual(Array.from(new Float32Array(bytes).subarray(48, 52)), [0, 4, 0.75, 6]);
  assert.equal(new Uint32Array(bytes)[46], 2);
  assert.deepEqual(Array.from(new Uint32Array(bytes).subarray(56, 60)), [43, 19, 3, 0]);
  assert.deepEqual(
    Array.from(new Float32Array(bytes).subarray(52, 56)),
    [0, 0, 0, 0],
    "GPU depth range remains the existing copied product"
  );
  for (let taps = 1; taps <= 4; taps++)
    for (const radius of [0, 0.75, 3])
      for (let tap = 0; tap < taps; tap++)
        for (const uv of [0, 1 - 1e-7]) {
          const offset = ((tap + 0.5) / taps - 0.5) * radius * 2;
          const texel = Math.floor(uv * 128 + offset + 0.5);
          assert.ok(texel >= -4 && texel < 132, "PCF reads only the rasterized slot gutter");
        }
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
    clipOriginExtent: frame().clipOriginExtent
  };
  const initial = owner.prepare(input);
  owner.commit(initial);
  const filtered = frame(
    resolveVsmSettings(VSM_DEFAULT_SETTINGS, { depthBiasTexels: 8, debugView: "visibility" })
  );
  const sampling = owner.prepare({ ...input, clipOriginExtent: filtered.clipOriginExtent });
  assert.equal(sampling.fullInvalidate, false);
  assert.equal(sampling.rebuildDepth, false);
  owner.commit(sampling);
  const enlarged = frame(resolveVsmSettings(VSM_DEFAULT_SETTINGS, { clipExtentScale: 2 }));
  assert.equal(enlarged.clipOriginExtent[0][2], 64);
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
    { normalBiasTexels: NaN },
    { slopeBiasTexels: 17 },
    { pcfTapsPerAxis: 1.5 },
    { pcfTapsPerAxis: 5 },
    { filterRadiusTexels: 3.01 },
    { clipExtentScale: 0 },
    { clipExtentScale: Infinity },
    { debugView: "atlas" }
  ]) {
    assert.throws(() => resolveVsmSettings(VSM_DEFAULT_SETTINGS, patch), RangeError);
  }
  assert.ok(Object.isFrozen(VSM_DEFAULT_SETTINGS));
  assert.equal(VSM_DEFAULT_SETTINGS.depthBiasTexels, 2);
});

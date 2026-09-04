import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DynamicResolutionScaling } from
  "../.test-dist/render/DynamicResolutionScaling.js";
import { resolveMainFrameFeatureTopology } from
  "../.test-dist/render/MainFrameFeatureTopology.js";
import {
  RenderSettings,
  qualityProfilePatch
} from "../.test-dist/render/pipeline/RenderSettings.js";
import { RenderDebugView } from "../.test-dist/debug/RenderDebugView.js";

const source = (relative) => readFileSync(
  new URL(`../src/${relative}`, import.meta.url),
  "utf8"
);

test("Q04 SSR defaults to a half-resolution configurable reconstruction chain", () => {
  const settings = new RenderSettings();
  assert.equal(settings.values.ssr.resolutionScale, 0.5);
  assert.equal(settings.values.ssr.temporalEnabled, true);
  assert.equal(qualityProfilePatch("medium").ssr.resolutionScale, 0.5);
  assert.equal(qualityProfilePatch("high").ssr.resolutionScale, 0.5);
  assert.equal(qualityProfilePatch("ultra").ssr.resolutionScale, 1);

  const pass = source("render/passes/ScreenSpaceReflectionsPass.ts");
  assert.match(pass, /SSR joint bilateral upscale/);
  assert.match(pass, /for \(const step of \[1\]\)/);
  assert.match(pass, /lastSpatialPasses\+\+/);
  assert.match(pass, /traceWidth/);
  assert.match(pass, /traceHeight/);

  const trace = source("shaders/ssr_trace.ts");
  assert.match(trace, /length\(current_view - origin_view\) > max_distance/);
  assert.match(trace, /settings\.base_thickness/);
  assert.match(trace, /settings\.distance_thickness_scale/);
  assert.match(trace, /find_strip_next\(hit\.xy/);
  assert.match(trace, /roughness\s*>\s*settings\.max_roughness/);
  assert.match(trace, /distance_confidence\s*=\s*1\.0\s*-\s*smoothstep/);
  assert.match(trace, /roughness_confidence\s*=\s*1\.0\s*-\s*smoothstep/);
  assert.match(trace, /edge_confidence \* distance_confidence \* roughness_confidence/);
});

test("Q04 SSR temporal and half-resolution modes are topology keys", () => {
  const base = {
    shadows: false, ssr: true, ssao: false, temporal: true,
    bloom: false, automaticExposure: false, motionBlur: false,
    sharpening: false, fusedIndirect: false, upscaleType: 0,
    debugView: RenderDebugView.None, indirectLightingMode: 0
  };
  const fullSpatial = resolveMainFrameFeatureTopology({
    ...base, ssrTemporal: false, ssrHalfResolution: false
  });
  const halfTemporal = resolveMainFrameFeatureTopology({
    ...base, ssrTemporal: true, ssrHalfResolution: true
  });
  assert.equal(fullSpatial.histories.includes("ssr-history"), false);
  assert.equal(halfTemporal.histories.includes("ssr-history"), true);
  assert.notEqual(fullSpatial.enabledFeatureBits, halfTemporal.enabledFeatureBits);
});

test("Q05 owns separate opaque/final validity and closest-surface TAA inputs", () => {
  const renderer = source("render/Renderer.ts");
  assert.match(renderer, /"opaque"/);
  assert.match(renderer, /"final"/);
  assert.match(renderer, /opaqueTemporalValidityRes/);
  assert.match(renderer, /transparentReactiveRes/);

  const taa = source("shaders/taa.ts");
  assert.match(taa, /fn closest_depth_pixel/);
  assert.match(taa, /fn reconstruct_current/);
  assert.match(taa, /catmull_rom_weight/);
  assert.match(taa, /output_reactive/);
  assert.match(taa, /max\(surface_classification\.r, output_reactive\)/);
  assert.doesNotMatch(taa, /current_jitter\s*-\s*previous_jitter/);
});

test("Q05 DRS decisions snap to stable resource/history buckets", () => {
  const drs = new DynamicResolutionScaling();
  let scale = 0.8;
  drs.enabled = true;
  drs.get_scale = () => scale;
  drs.set_scale = (next) => { scale = next; };
  drs.warmup_frames = 0;
  drs.settle_frames = 1;
  drs.probe_step = 0.05;
  drs.notify_frame(0.03);
  drs.notify_frame(0.03);
  assert.equal(scale, 0.75);
  assert.deepEqual(drs.scale_buckets, [0.5, 0.67, 0.75, 0.8, 1]);
});

test("Q05 motion Gate requires sustained settling, not one lucky keyframe", () => {
  const runner = readFileSync(
    new URL("../../examples/scripts/run-r5-fx06b-gate.mjs", import.meta.url),
    "utf8"
  );
  assert.match(runner, /samples\.slice\(candidateIndex\)\.every/);
  assert.match(runner, /maxGhostTrailAt32FramesPixels:\s*18/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { RenderDebugView, getRenderDebugViewStatus } from "../.test-dist/debug/RenderDebugView.js";
import { resolveMainFrameFeatureTopology } from "../.test-dist/render/MainFrameFeatureTopology.js";
import { TemporalHistoryRegistry } from "../.test-dist/render/TemporalHistoryRegistry.js";

const base = {
  shadows: false,
  ssr: false,
  ssao: false,
  temporal: false,
  bloom: false,
  automaticExposure: false,
  motionBlur: false,
  sharpening: false,
  fusedIndirect: false,
  upscaleType: 0,
  debugView: RenderDebugView.None,
  indirectLightingMode: 0
};

const revision = (feature = 0) => ({
  outputWidth: 1280,
  outputHeight: 720,
  internalWidth: 1280,
  internalHeight: 720,
  camera: 0,
  renderScale: 0,
  feature,
  format: 2,
  light: 0,
  view: "camera-0/scene-0"
});

test("FX-07 topology prunes AO temporal history independently", () => {
  const off = resolveMainFrameFeatureTopology(base);
  assert.equal(off.persistentOwners.includes("ssao"), false);
  assert.equal(off.histories.includes("ssao-history"), false);

  const spatialOnly = resolveMainFrameFeatureTopology({
    ...base,
    ssao: true,
    ssaoTemporal: false
  });
  assert.equal(spatialOnly.ssao, true);
  assert.equal(spatialOnly.ssaoTemporal, false);
  assert.equal(spatialOnly.persistentOwners.includes("ssao"), true);
  assert.equal(spatialOnly.histories.includes("ssao-history"), false);

  const temporal = resolveMainFrameFeatureTopology({
    ...base,
    ssao: true,
    ssaoTemporal: true
  });
  assert.equal(temporal.ssaoTemporal, true);
  assert.equal(temporal.histories.includes("ssao-history"), true);
  assert.notEqual(temporal.enabledFeatureBits, spatialOnly.enabledFeatureBits);

  const half = resolveMainFrameFeatureTopology({
    ...base,
    ssao: true,
    ssaoTemporal: true,
    ssaoHalfResolution: true
  });
  assert.equal(half.ssaoHalfResolution, true);
  assert.notEqual(half.enabledFeatureBits, temporal.enabledFeatureBits);
});

test("FX-07 AO history uses the shared submission-aware registry", () => {
  const histories = new TemporalHistoryRegistry(["color", "ssao"]);
  histories.beginFrame(0, revision(), ["ssao"]);
  assert.equal(histories.state("ssao").valid, false);
  histories.markProduced("ssao");
  histories.commitFrame(0);
  assert.equal(histories.state("ssao").valid, true);
  assert.equal(histories.state("color").valid, false);

  histories.beginFrame(1, revision(), ["ssao"]);
  histories.abortFrame(1);
  assert.equal(histories.state("ssao").valid, false);
  assert.equal(histories.state("ssao").lastInvalidationReason, "abort");
});

test("FX-07 shader keeps visibility/depth filter arguments in ABI order", () => {
  const shader = readFileSync(new URL("../src/shaders/ssao.ts", import.meta.url), "utf8");
  assert.match(shader, /sample_weight\(\s*center\.r,\s*sample_value\.r,\s*max\(visibility_phi, epsilon\)/s);
  assert.match(shader, /center_depth,\s*sample_depth,\s*sigma_depth/s);
  assert.match(shader, /settings\.history_valid != 0u/);
  assert.match(shader, /velocity_full \* vec2f\(dimensions\) \/ vec2f\(full_dimensions\)/);
  assert.match(shader, /SSAO_JOINT_BILATERAL_RESOLVE_WGSL/);
  assert.match(shader, /history_blend, 0\.0, 0\.99\) \* history_weight/);
  assert.match(shader, /radius_world/);
  assert.match(shader, /linear_depth_source/);
  assert.match(shader, /hzb_sample_depth/);
  assert.match(shader, /textureNumLevels\(hzb\)/);
  assert.match(shader, /floor\(log2\(max\(footprint, 1\.0\)\)\)/);
  assert.doesNotMatch(shader, /const falloff_(?:mul|add)\s*=/);
});

test("FX-07 pass has no frame-parity history owner and prunes temporal work", () => {
  const source = readFileSync(
    new URL("../src/render/passes/ScreenSpaceAmbientOcclusionPass.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /frameIndex\s*\+\s*\(output/);
  assert.match(source, /if \(this\.temporalEnabled\)/);
  assert.match(source, /SSAO temporal history bindings are required/);
  assert.match(source, /historyTexture\(index: 0 \| 1\)/);
  assert.match(source, /historyTextureCount/);
  assert.match(source, /historyBytes/);
  assert.match(source, /GTAO linear\/view-depth mip/);
  assert.match(source, /hzb: resolveTextureView\(resources\.get\(inputs\.hzb\)\)/);
  assert.match(source, /rawBuilder\.read\(inputs\.hzb\)/);
  assert.match(source, /GTAO joint bilateral AO\+bent-normal resolve/);
  assert.match(source, /frame: ambientOcclusionFrame\(/);
  assert.doesNotMatch(source, /inputs\.albedoAo/);
});

test("FX-07 raw, denoised and temporal AO debug views are production-supported", () => {
  for (const view of [
    RenderDebugView.AmbientOcclusionRaw,
    RenderDebugView.AmbientOcclusionDenoised,
    RenderDebugView.AmbientOcclusionTemporal
  ]) {
    assert.equal(getRenderDebugViewStatus(view).status, "supported");
  }
});

test("FX-07 reference record pins XeGTAO provenance and retained-current decision", () => {
  const ledger = readFileSync(
    new URL("../../docs/porting/shading.md", import.meta.url),
    "utf8"
  );
  assert.match(ledger, /0d177ce06bfa642f64d8af4de1197ad1bcb862d4/);
  assert.match(ledger, /SPDX-License-Identifier:\s*MIT/);
  assert.match(ledger, /保留并修复当前实现/);
  assert.match(ledger, /未直接复制/);
});

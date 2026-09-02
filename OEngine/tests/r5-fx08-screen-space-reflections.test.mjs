import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  RenderDebugView,
  getRenderDebugViewStatus
} from "../.test-dist/debug/RenderDebugView.js";
import { resolveMainFrameFeatureTopology } from "../.test-dist/render/MainFrameFeatureTopology.js";
import { TemporalHistoryRegistry } from "../.test-dist/render/TemporalHistoryRegistry.js";
import { iblRoughnessToLod } from "../.test-dist/render/IblAlignment.js";

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
  format: 3,
  view: "camera-0/scene-0"
});

test("FX-08 topology prunes the complete SSR owner and history", () => {
  const off = resolveMainFrameFeatureTopology(base);
  assert.equal(off.ssr, false);
  assert.equal(off.persistentOwners.includes("ssr"), false);
  assert.equal(off.histories.includes("ssr-history"), false);

  const on = resolveMainFrameFeatureTopology({ ...base, ssr: true });
  assert.equal(on.ssr, true);
  assert.equal(on.persistentOwners.includes("ssr"), true);
  assert.equal(on.histories.includes("ssr-history"), true);
  assert.notEqual(on.enabledFeatureBits, off.enabledFeatureBits);
});

test("FX-08 SSR history obeys the shared submission-aware registry", () => {
  const histories = new TemporalHistoryRegistry(["color", "ssao", "ssr"]);
  histories.beginFrame(0, revision(), ["ssr"]);
  assert.equal(histories.state("ssr").valid, false);
  assert.equal(histories.state("ssr").readIndex, 0);
  assert.equal(histories.state("ssr").writeIndex, 1);
  histories.markProduced("ssr");
  histories.commitFrame(0);
  assert.equal(histories.state("ssr").valid, true);
  assert.equal(histories.state("ssr").readIndex, 1);

  histories.beginFrame(1, revision(), ["ssr"]);
  histories.abortFrame(1);
  assert.equal(histories.state("ssr").valid, false);
  assert.equal(histories.state("ssr").lastInvalidationReason, "abort");

  const renderer = readFileSync(
    new URL("../src/render/Renderer.ts", import.meta.url),
    "utf8"
  );
  assert.match(renderer, /new TemporalHistoryRegistry\(\["color", "ssao", "ssr"\]\)/);
  assert.match(renderer, /featureTopology\.ssrTemporal \? \["ssr"\] : \[\]/);
  assert.match(renderer, /markProduced\("ssr"\)/);
  assert.match(renderer, /ssrHistoryValidity/);
  assert.match(renderer, /ssrHistoryInputIndex/);
  assert.match(renderer, /ssrHistoryOutputIndex/);
  assert.match(renderer, /_ssrOwnerGeneration/);
  assert.match(renderer, /ssr-owner\$\{this\._ssrOwnerGeneration\}/);
});

test("FX-08 SSR pass has no frame-index parity history policy", () => {
  const source = readFileSync(
    new URL("../src/render/passes/ScreenSpaceReflectionsPass.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /frameIndex\s*\+\s*\(output/);
  assert.match(source, /historyValid:\s*boolean/);
  assert.match(source, /historyInputIndex:\s*0 \| 1/);
  assert.match(source, /historyOutputIndex:\s*0 \| 1/);
  assert.match(source, /SSR temporal history bindings are required/);
  assert.match(source, /historyTexture\(index:\s*0 \| 1\)/);
  assert.match(source, /historyTextureCount/);
  assert.match(source, /historyBytes/);
});

test("FX-08 miss fallback uses the FX-03 environment mip contract", () => {
  assert.deepEqual(
    [0, 0.5, 1].map((roughness) => iblRoughnessToLod(roughness, 7)),
    [0, 3, 6]
  );
  const resolve = readFileSync(
    new URL("../src/shaders/ssr_resolve.ts", import.meta.url),
    "utf8"
  );
  assert.match(resolve, /textureNumLevels\(sec_radix_passes\)/);
  assert.doesNotMatch(resolve, /ratio\s*\*\s*4\.0/);
  assert.doesNotMatch(resolve, /min\(lower \+ 1u, 4u\)/);
  assert.match(resolve, /mix\(environment, radiance, maximum_confidence\)/);
});

test("FX-08 roughness sweep is not disabled by the legacy 0.3 trace cutoff", () => {
  const trace = readFileSync(
    new URL("../src/shaders/ssr_trace.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(trace, /roughness\s*>\s*0\.3/);
});

test("FX-08 temporal resolve rejects globally invalid history", () => {
  const shader = readFileSync(
    new URL("../src/shaders/ssr_denoise.ts", import.meta.url),
    "utf8"
  );
  assert.match(shader, /struct SsrTemporalSettings/);
  assert.match(shader, /settings\.history_valid == 0u/);
});

test("FX-08 keeps the unified indirect pass as the only final composite owner", () => {
  const source = readFileSync(
    new URL("../src/render/passes/ScreenSpaceReflectionsPass.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /SSR_COMPOSITE_WGSL/);
  assert.doesNotMatch(source, /SSR final material resolve/);
});

test("FX-08 hit-miss and history-confidence debug views are production-supported", () => {
  for (const view of [
    RenderDebugView.ScreenSpaceReflectionHitMiss,
    RenderDebugView.ScreenSpaceReflectionHistoryConfidence
  ]) {
    assert.equal(getRenderDebugViewStatus(view).status, "supported");
  }
});

test("FX-08 reference record retains current authored SSR before considering replacement", () => {
  const ledger = readFileSync(
    new URL("../../docs/references/porting/R5-06-screen-space-reflections.md", import.meta.url),
    "utf8"
  );
  assert.match(ledger, /FidelityFX SSSR/);
  assert.match(ledger, /MIT/);
  assert.match(ledger, /revalidate/i);
  assert.match(ledger, /retained-current-authored/i);
  assert.match(ledger, /not adopted/i);
});

test("FX-08 production Gate covers the documented fixture and evidence contract", () => {
  const fixture = readFileSync(
    new URL("../../examples/r5-screen-space-reflections/main.ts", import.meta.url),
    "utf8"
  );
  const runner = readFileSync(
    new URL("../../examples/scripts/run-r5-fx08-gate.mjs", import.meta.url),
    "utf8"
  );
  for (const requirement of [
    "hit-miss",
    "roughness-0-05-1",
    "screen-miss-fallback",
    "offscreen-target",
    "camera-pan",
    "disocclusion",
    "feature-off",
    "feature-restored"
  ]) {
    assert.match(fixture, new RegExp(requirement));
  }
  assert.match(fixture, /requestLinearHdrCapture/);
  assert.match(fixture, /screenSpaceReflectionsEvidence/);
  assert.match(runner, /minimumEventResponseRmsRgb8/);
  assert.match(runner, /maximumSettle32To64RmsRgb8/);
  assert.match(runner, /performance\.json/);
  assert.match(runner, /graph-counters\.json/);
  assert.match(runner, /screenshot-metrics\.json/);
});

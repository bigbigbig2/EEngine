import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  TemporalHistoryRegistry
} from "../.test-dist/render/TemporalHistoryRegistry.js";
import {
  classifyTemporalHistory,
  reprojectTemporalSample
} from "../.test-dist/render/TemporalResolveContract.js";
import { DynamicResolutionScaling } from "../.test-dist/render/DynamicResolutionScaling.js";
import { resolveMainFrameFeatureTopology } from "../.test-dist/render/MainFrameFeatureTopology.js";
import { RenderDebugView } from "../.test-dist/debug/RenderDebugView.js";
import {
  GPU_COUNTER_SCHEMA_VERSION,
  counterByteOffset
} from "../.test-dist/debug/GpuFrameCounters.js";

const revision = (overrides = {}) => ({
  outputWidth: 1920,
  outputHeight: 1080,
  internalWidth: 1920,
  internalHeight: 1080,
  camera: 0,
  renderScale: 0,
  feature: 0,
  format: 1,
  light: 0,
  view: "camera-0/scene-0",
  ...overrides
});

test("FX-06 shared history commits only submitted production and ping-pongs", () => {
  const histories = new TemporalHistoryRegistry(["color"]);
  histories.beginFrame(0, revision(), ["color"]);
  assert.equal(histories.state("color").valid, false);
  assert.equal(histories.state("color").readIndex, 0);
  assert.equal(histories.state("color").writeIndex, 1);

  histories.markProduced("color");
  assert.equal(histories.commitFrame(0), true);
  assert.equal(histories.state("color").valid, true);
  assert.equal(histories.state("color").readIndex, 1);
  assert.equal(histories.state("color").writeIndex, 0);

  histories.beginFrame(1, revision(), ["color"]);
  histories.abortFrame(1);
  assert.equal(histories.state("color").valid, false);
  assert.equal(histories.state("color").lastInvalidationReason, "abort");
});

test("FX-06 shared history invalidates cut, output resize, scale and feature transitions", () => {
  const cases = [
    [revision({ camera: 1 }), "camera-cut"],
    [revision({ outputWidth: 1280 }), "output-resize"],
    [revision({ internalWidth: 1280 }), "internal-resize"],
    [revision({ renderScale: 1 }), "render-scale"],
    [revision({ format: 2 }), "format-change"],
    [revision({ light: 1 }), "lighting-change"],
    [revision({ view: "camera-1/scene-0" }), "view-switch"]
  ];
  for (const [next, reason] of cases) {
    const histories = committedHistory();
    histories.beginFrame(1, next, ["color"]);
    assert.equal(histories.state("color").valid, false, reason);
    assert.equal(histories.state("color").lastInvalidationReason, reason);
  }

  const toggled = committedHistory();
  toggled.beginFrame(1, revision({ feature: 1 }), []);
  assert.equal(toggled.state("color").valid, false);
  assert.equal(toggled.state("color").lastInvalidationReason, "feature-toggle");
  assert.equal(toggled.commitFrame(1), false);
  toggled.beginFrame(2, revision({ feature: 2 }), ["color"]);
  assert.equal(toggled.state("color").valid, false);
  assert.equal(toggled.state("color").lastInvalidationReason, "feature-toggle");
});

test("FX-06 reprojection uses current-minus-previous internal-pixel velocity", () => {
  const sample = reprojectTemporalSample({
    currentInternalPixel: [320.5, 180.5],
    velocityInternalPixels: [16, -8],
    internalResolution: [640, 360]
  });
  assert.deepEqual(sample.previousInternalPixel, [304.5, 188.5]);
  assert.deepEqual(
    sample.historyUv.map((value) => Number(value.toFixed(6))),
    [0.475781, 0.523611]
  );
  assert.equal(sample.inside, true);

  const outside = reprojectTemporalSample({
    currentInternalPixel: [2, 2],
    velocityInternalPixels: [8, 0],
    internalResolution: [640, 360]
  });
  assert.equal(outside.inside, false);
});

test("FX-06 reactive, invalid motion and disocclusion reject history", () => {
  const stable = classifyTemporalHistory({
    historyValid: true,
    motionValid: true,
    reactive: 0,
    disocclusionConfidence: 1,
    velocityMagnitudePixels: 0,
    currentLuminance: 0.5,
    historyLuminance: 0.5,
    reprojectedInside: true
  });
  assert.equal(stable.rejected, false);
  assert.ok(stable.historyWeight > 0 && stable.historyWeight <= 0.95);

  for (const [change, reason] of [
    [{ reactive: 1 }, "reactive"],
    [{ motionValid: false }, "motion-invalid"],
    [{ disocclusionConfidence: 0 }, "disoccluded"],
    [{ reprojectedInside: false }, "outside"]
  ]) {
    const result = classifyTemporalHistory({
      historyValid: true,
      motionValid: true,
      reactive: 0,
      disocclusionConfidence: 1,
      velocityMagnitudePixels: 0,
      currentLuminance: 0.5,
      historyLuminance: 0.5,
      reprojectedInside: true,
      ...change
    });
    assert.equal(result.historyWeight, 0, reason);
    assert.equal(result.rejectionReason, reason);
  }
});

test("FX-06 DRS accepts only delayed completed GPU samples and clamps scale", () => {
  let scale = 1;
  const drs = new DynamicResolutionScaling();
  drs.enabled = true;
  drs.get_scale = () => scale;
  drs.set_scale = (next) => { scale = next; };
  drs.target_frame_rate = 60;
  drs.min_scale = 0.5;
  drs.max_scale = 1;
  drs.warmup_frames = 1;
  drs.settle_frames = 1;
  drs.probe_step = 0.2;

  assert.equal(drs.notify_gpu_timing({
    sampleFrameIndex: 4,
    currentFrameIndex: 4,
    gpuFrameTimeMs: 25
  }), false);
  assert.equal(scale, 1);

  assert.equal(drs.consume_delayed_gpu_timing(5), true);
  assert.equal(drs.notify_gpu_timing({
    sampleFrameIndex: 4,
    currentFrameIndex: 6,
    gpuFrameTimeMs: 25
  }), false, "duplicate sample must not be consumed twice");
  assert.equal(drs.notify_gpu_timing({
    sampleFrameIndex: 8,
    currentFrameIndex: 10,
    gpuFrameTimeMs: 25
  }), true);
  assert.equal(scale, 0.8);
  assert.equal(drs.last_feedback_latency_frames, 2);
  assert.equal(drs.last_gpu_frame_time_ms, 25);

  for (let frame = 9; frame < 30; frame++) {
    drs.notify_gpu_timing({
      sampleFrameIndex: frame,
      currentFrameIndex: frame + 2,
      gpuFrameTimeMs: 100
    });
  }
  assert.ok(scale >= 0.5 && scale <= 1);
});

test("FX-06 current color is not sampled with projection jitter twice", () => {
  const source = readFileSync(
    new URL("../src/shaders/taa.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /output_uv\s*\+\s*settings\.jitter/);
  assert.match(source, /current_pixel_f\s*-\s*velocity/);
});

test("FX-06 sampled rejection evidence keeps history validity late-bound", () => {
  const source = readFileSync(
    new URL("../src/render/passes/TemporalClassificationPass.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /data\.job\.historyValid/);
  assert.doesNotMatch(source, /historyValid:\s*job\.historyValid/);
});

test("FX-06 feature-off topology owns no temporal pass or history", () => {
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
  const disabled = resolveMainFrameFeatureTopology(base);
  assert.equal(disabled.temporal, false);
  assert.equal(disabled.persistentOwners.includes("taa"), false);
  assert.equal(disabled.histories.includes("temporal-color-history"), false);

  const enabled = resolveMainFrameFeatureTopology({ ...base, temporal: true });
  assert.equal(enabled.taa, true);
  assert.equal(enabled.persistentOwners.includes("taa"), true);
  assert.equal(enabled.histories.includes("temporal-color-history"), true);
});

test("FX-06 temporal evidence extends the additive sampled counter ABI", () => {
  assert.equal(GPU_COUNTER_SCHEMA_VERSION, 12);
  assert.equal(counterByteOffset("temporalReactivePixels"), 276);
  assert.equal(counterByteOffset("temporalDisoccludedPixels"), 280);
  assert.equal(counterByteOffset("temporalHistoryRejectedPixels"), 284);
});

test("FX-06 porting ledger freezes exact licensed sources and A/B scope", () => {
  const ledger = readFileSync(
    new URL("../../docs/references/porting/R5-04-temporal-upscale.md", import.meta.url),
    "utf8"
  );
  assert.match(ledger, /4795aa0007d464371abe60b7b28a1cf893a4e349/);
  assert.match(ledger, /1680d1edd5c034f88ebbbb793d8b88f8842cf804/);
  assert.match(ledger, /Assets\/Shaders\/TemporalReprojection\.shader/);
  assert.match(ledger, /ffx_fsr2_reproject\.h/);
  assert.match(ledger, /license:\s*MIT/gi);
  assert.match(ledger, /FX-06B/);
  assert.match(ledger, /不能由本记录提前宣称完成/);
});

function committedHistory() {
  const histories = new TemporalHistoryRegistry(["color"]);
  histories.beginFrame(0, revision(), ["color"]);
  histories.markProduced("color");
  histories.commitFrame(0);
  return histories;
}

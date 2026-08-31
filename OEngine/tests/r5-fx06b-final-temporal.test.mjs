import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyTemporalHistory
} from "../.test-dist/render/TemporalResolveContract.js";
import { resolveMainFrameFeatureTopology } from "../.test-dist/render/MainFrameFeatureTopology.js";
import { RenderDebugView } from "../.test-dist/debug/RenderDebugView.js";

const temporalContract = await import(
  "../.test-dist/render/TemporalResolveContract.js"
);

test("FX-06B stable history lock grows gradually and reactive input clears it", () => {
  const stable = classifyTemporalHistory({
    historyValid: true,
    motionValid: true,
    reactive: 0,
    disocclusionConfidence: 1,
    velocityMagnitudePixels: 0,
    currentLuminance: 0.5,
    historyLuminance: 0.5,
    reprojectedInside: true,
    historyLock: 0
  });
  assert.equal(stable.rejected, false);
  assert.ok(stable.nextHistoryLock > 0 && stable.nextHistoryLock < 1);
  assert.ok(stable.historyWeight < 0.92);

  const locked = classifyTemporalHistory({
    historyValid: true,
    motionValid: true,
    reactive: 0,
    disocclusionConfidence: 1,
    velocityMagnitudePixels: 0,
    currentLuminance: 0.5,
    historyLuminance: 0.5,
    reprojectedInside: true,
    historyLock: 1
  });
  assert.equal(locked.nextHistoryLock, 1);
  assert.ok(locked.historyWeight > stable.historyWeight);

  const reactive = classifyTemporalHistory({
    historyValid: true,
    motionValid: true,
    reactive: 1,
    disocclusionConfidence: 1,
    velocityMagnitudePixels: 0,
    currentLuminance: 0.5,
    historyLuminance: 0.5,
    reprojectedInside: true,
    historyLock: 1
  });
  assert.equal(reactive.rejected, true);
  assert.equal(reactive.nextHistoryLock, 0);
});

test("FX-06B clips HDR history inside a YCoCg variance envelope", () => {
  assert.equal(typeof temporalContract.clipTemporalHistoryYCoCg, "function");
  const currentNeighborhood = [
    [4, 0.5, 0.25],
    [4.2, 0.55, 0.2],
    [3.8, 0.45, 0.3],
    [4.1, 0.52, 0.24],
    [3.9, 0.48, 0.26]
  ];
  const clipped = temporalContract.clipTemporalHistoryYCoCg(
    [32, 0, 16],
    currentNeighborhood,
    1.25
  );
  assert.equal(clipped.length, 3);
  assert.ok(clipped.every(Number.isFinite));
  assert.ok(clipped[0] < 8, "red-channel HDR outlier must be clipped");
  assert.ok(clipped[1] >= 0, "clipping must not invent negative green");

  const stable = temporalContract.clipTemporalHistoryYCoCg(
    [4, 0.5, 0.25],
    currentNeighborhood,
    1.25
  );
  assert.ok(Math.abs(stable[0] - 4) < 1e-6);
  assert.ok(Math.abs(stable[1] - 0.5) < 1e-6);
  assert.ok(Math.abs(stable[2] - 0.25) < 1e-6);
});

test("FX-06B output pixels map to centered internal TAAU samples", () => {
  assert.equal(typeof temporalContract.resolveTemporalUpscaleSample, "function");
  for (const scale of [1, 0.85, 0.67, 0.5]) {
    const output = [1920, 1080];
    const internal = [
      Math.floor(output[0] * scale),
      Math.floor(output[1] * scale)
    ];
    const sample = temporalContract.resolveTemporalUpscaleSample({
      outputPixel: [959, 539],
      internalResolution: internal,
      outputResolution: output
    });
    assert.deepEqual(sample.outputUv, [959.5 / 1920, 539.5 / 1080]);
    assert.ok(Math.abs(sample.internalPixel[0] - sample.outputUv[0] * internal[0]) < 1e-9);
    assert.ok(Math.abs(sample.internalPixel[1] - sample.outputUv[1] * internal[1]) < 1e-9);
    assert.equal(sample.upscaling, scale < 1);
  }
});

test("FX-06B core TAAU remains one TAA owner and never selects optional NSS", () => {
  const topology = resolveMainFrameFeatureTopology({
    shadows: false,
    ssr: true,
    ssao: true,
    temporal: true,
    bloom: false,
    automaticExposure: false,
    motionBlur: false,
    sharpening: false,
    fusedIndirect: false,
    upscaleType: 0,
    debugView: RenderDebugView.None,
    indirectLightingMode: 0,
    transparency: true
  });
  assert.equal(topology.taa, true);
  assert.equal(topology.nss, false);
  assert.deepEqual(
    topology.persistentOwners.filter((owner) => owner === "taa" || owner === "nss"),
    ["taa"]
  );
  assert.equal(topology.histories.filter((owner) => owner === "temporal-color-history").length, 1);
});

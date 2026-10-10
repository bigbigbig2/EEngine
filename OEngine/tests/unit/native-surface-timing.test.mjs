import assert from "node:assert/strict";
import test from "node:test";
import {
  classifySurfaceTimingPhase,
  surfaceTimingTotalsForFrame,
} from "../../.test-dist/debug/SurfacePhaseTiming.js";
import { classifyGpuFramePhase } from "../../.test-dist/debug/GpuFramePhase.js";
import { summarizeGpuTimingCost } from "../../.test-dist/debug/GpuTimingCost.js";

test("current winner shading and initialization labels keep GPU cost attribution complete", () => {
  const segments = [
    { label: "Renderer/visibility-frame/SurfaceV4/bins classify", durationMs: 0.5, scope: "pass" },
    { label: "Renderer/visibility-frame/SurfaceV4/native winner shading", durationMs: 10, scope: "pass" },
    {
      label: "Renderer/visibility-frame/SurfaceV4/HDR and Aux initialization",
      durationMs: 0.1,
      scope: "pass",
    },
  ];
  const cost = summarizeGpuTimingCost(segments);
  assert.equal(cost.surfaceEvaluationMs, 10);
  assert.equal(cost.surfaceManagementMs, 0.5);
  assert.equal(cost.surfaceAuxiliaryMs, 0.1);
  assert.equal(classifyGpuFramePhase(segments[1].label), "lighting-and-ibl");
  assert.equal(classifyGpuFramePhase("Renderer/visibility-frame/FSR3 Shading SPD"), "temporal");
  assert.equal(classifyGpuFramePhase("Renderer/visibility-frame/Visibility/current-HZB recover"), "hzb");
});

test("native timing groups physical passes and excludes nested scopes", () => {
  const segments = [
    { label: "SurfaceV4/bins count", durationMs: 0.3 },
    { label: "SurfaceV4/bins scatter", durationMs: 0.4 },
    { label: "SurfaceV4/native opaque + background", durationMs: 5 },
    { label: "SurfaceV4/resource-limited native sun", durationMs: 1 },
    { label: "SurfaceV4/empty background", durationMs: 0.1 },
    { label: "SurfaceV4/native opaque", durationMs: 99, scope: "stage" },
  ];
  assert.deepEqual(
    [...surfaceTimingTotalsForFrame(segments)],
    [
      ["executionBins", 0.7],
      ["nativeShading", 5],
      ["nativeSun", 1],
      ["background", 0.1],
    ],
  );
  assert.equal(classifySurfaceTimingPhase({ label: "unknown kernel" }), null);
});

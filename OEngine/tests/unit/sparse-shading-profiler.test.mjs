import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyGpuFramePhase
} from "../.test-dist/debug/GpuFramePhase.js";
import {
  SURFACE_TIMING_PHASES,
  classifySurfaceTimingPhase,
  surfaceTimingTotalsForFrame
} from "../.test-dist/debug/SurfacePhaseTiming.js";

test("ADR-0013 Step 7 profiler classifies the production sparse shading stages", () => {
  const segments = [
    { label: "SparseShading/clear + classify production Visibility MRT", durationMs: 0.2 },
    { label: "SparseShading/finalize production indirect arguments", durationMs: 0.1 },
    { label: "SparseShading/active-bin production indirect resolve", durationMs: 0.8 },
    { label: "Opaque lighting/IBL composition", durationMs: 0.4 }
  ];

  assert.deepEqual(SURFACE_TIMING_PHASES, ["classify", "finalize", "resolve", "lighting"]);
  assert.deepEqual(
    segments.map((segment) => classifySurfaceTimingPhase(segment)),
    ["classify", "finalize", "resolve", "lighting"]
  );
  assert.deepEqual(
    [...surfaceTimingTotalsForFrame(segments)],
    [["classify", 0.2], ["finalize", 0.1], ["resolve", 0.8], ["lighting", 0.4]]
  );
  assert.equal(classifyGpuFramePhase(segments[0].label), "material-resolve");
  assert.equal(classifyGpuFramePhase(segments[1].label), "material-resolve");
  assert.equal(classifyGpuFramePhase(segments[2].label), "material-resolve");
});

test("ADR-0013 diagnostics labels stay outside production surface timing", () => {
  const label = "SparseShading/diagnostics readback";
  assert.equal(classifyGpuFramePhase(label), "observability");
  assert.equal(classifySurfaceTimingPhase({ label }), null);
});

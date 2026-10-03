import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyGpuFramePhase
} from "../../.test-dist/debug/GpuFramePhase.js";
import {
  SURFACE_TIMING_PHASES,
  classifySurfaceTimingPhase,
  surfaceTimingTotalsForFrame
} from "../../.test-dist/debug/SurfacePhaseTiming.js";

test("ADR-0013 Step 7 profiler classifies the production sparse shading stages", () => {
  const segments = [
    { label: "SurfaceWork/classify implicit-uniform-mixed", durationMs: 0.2 },
    { label: "SurfaceWork/finalize counters", durationMs: 0.1 },
    { label: "Surface/material publication lookup", durationMs: 0.3 },
    { label: "Surface/GeometryRecord cache classify", durationMs: 0.2 },
    { label: "Surface/GeometryRecord miss finalize", durationMs: 0.1 },
    { label: "Surface/GeometryRecord miss resolve", durationMs: 0.8 },
    { label: "Surface/Material miss indirect finalize", durationMs: 0.1 },
    { label: "Surface/Material miss publication evaluation", durationMs: 0.2 },
    { label: "Surface/lighting packets", durationMs: 0.4 },
    { label: "Surface/reconstruct batch 0", durationMs: 0.4 }
  ];

  assert.deepEqual(SURFACE_TIMING_PHASES, ["classify", "workFinalize", "materialLookup",
    "geometryLookup", "geometryFinalize", "geometryResolve", "materialFinalize",
    "materialEvaluate", "lighting", "reconstruct"]);
  assert.deepEqual(
    segments.map((segment) => classifySurfaceTimingPhase(segment)),
    ["classify", "workFinalize", "materialLookup", "geometryLookup", "geometryFinalize",
      "geometryResolve", "materialFinalize", "materialEvaluate", "lighting", "reconstruct"]
  );
  assert.deepEqual(
    [...surfaceTimingTotalsForFrame(segments)],
    [["classify", 0.2], ["workFinalize", 0.1], ["materialLookup", 0.3], ["geometryLookup", 0.2],
      ["geometryFinalize", 0.1], ["geometryResolve", 0.8], ["materialFinalize", 0.1],
      ["materialEvaluate", 0.2], ["lighting", 0.4], ["reconstruct", 0.4]]
  );
  assert.equal(classifyGpuFramePhase(segments[0].label), "unclassified");
  assert.equal(classifyGpuFramePhase(segments[8].label), "lighting-and-ibl");
});

test("ADR-0013 diagnostics labels stay outside production surface timing", () => {
  const label = "SparseShading/diagnostics readback";
  assert.equal(classifyGpuFramePhase(label), "observability");
  assert.equal(classifySurfaceTimingPhase({ label }), null);
});

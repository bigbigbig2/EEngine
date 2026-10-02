import assert from "node:assert/strict";
import test from "node:test";
import { surfaceTimingTotalsForFrame } from "../../.test-dist/debug/SurfacePhaseTiming.js";

test("V3 totals include actual dispatch labels and every material program once", () => {
  const segments = [
    ["SurfaceWork/classify", 0.4],
    ["Surface/GeometryRecord cache classify", 0.3],
    ["Surface/GeometryRecord miss resolve", 4],
    ["Surface/material publication kernel 0", 2],
    ["Surface/material publication kernel 1", 0.5],
    ["Surface/reconstruct", 1],
    ["Surface/diagnostics snapshot", 99],
    ["FSR3 Accumulate", 7]
  ].map(([label, durationMs]) => ({ label: `Renderer/visibility-frame/${label}`, durationMs }));
  assert.deepEqual([...surfaceTimingTotalsForFrame(segments)], [
    ["classify", 0.4], ["geometryLookup", 0.3], ["geometryResolve", 4],
    ["materialEvaluate", 2.5], ["reconstruct", 1]
  ]);
});

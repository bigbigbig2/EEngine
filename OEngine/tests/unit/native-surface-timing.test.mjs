import assert from "node:assert/strict";
import test from "node:test";
import { classifySurfaceTimingPhase, surfaceTimingTotalsForFrame } from "../../.test-dist/debug/SurfacePhaseTiming.js";

test("native timing groups physical passes and excludes nested scopes", () => {
  const segments = [
    { label: "SurfaceV4/bins count", durationMs: 0.3 },
    { label: "SurfaceV4/bins scatter", durationMs: 0.4 },
    { label: "SurfaceV4/native opaque + background", durationMs: 5 },
    { label: "SurfaceV4/resource-limited native sun", durationMs: 1 },
    { label: "SurfaceV4/empty background", durationMs: 0.1 },
    { label: "SurfaceV4/native opaque", durationMs: 99, scope: "stage" },
  ];
  assert.deepEqual([...surfaceTimingTotalsForFrame(segments)], [
    ["executionBins", 0.7], ["nativeShading", 5], ["nativeSun", 1], ["background", 0.1],
  ]);
  assert.equal(classifySurfaceTimingPhase({ label: "unknown kernel" }), null);
});

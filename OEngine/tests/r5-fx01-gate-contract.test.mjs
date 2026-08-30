import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateBuildProvenance,
  evaluateDiagnosticSnapshots,
  velocityTilesAreZero
} from "../../examples/scripts/r5-fx01-gate-contract.mjs";

test("FX-01 Gate binds browser build metadata to the current worktree", () => {
  const current = {
    commit: "abc123",
    dirty: true,
    dirtyReasons: [" M file-a", "?? file-b"],
    contentHash: "current-content"
  };
  assert.deepEqual(
    evaluateBuildProvenance({ ...current }, current),
    { passed: true, issues: [] }
  );
  assert.equal(
    evaluateBuildProvenance({ ...current, commit: "old" }, current).passed,
    false
  );
  assert.equal(
    evaluateBuildProvenance({ ...current, dirty: false, dirtyReasons: [] }, current).passed,
    false
  );
  assert.equal(
    evaluateBuildProvenance(
      { ...current, dirtyReasons: [" M file-a"] },
      current
    ).passed,
    false
  );
  assert.equal(
    evaluateBuildProvenance(
      { commit: current.commit, dirty: current.dirty },
      current
    ).passed,
    false
  );
  assert.equal(
    evaluateBuildProvenance(
      { ...current, contentHash: "stale-build-content" },
      current
    ).passed,
    false
  );
});

test("FX-01 Gate rejects diagnostics raised by any captured debug view", () => {
  const clean = {
    validationErrorCount: 0,
    uncapturedErrorCount: 0,
    deviceLostCount: 0,
    failedGpuTimestampBatches: 0,
    droppedGpuCounterSamples: 0,
    failedGpuCounterSamples: 0
  };
  assert.deepEqual(
    evaluateDiagnosticSnapshots([
      { label: "initial", diagnostics: clean },
      { label: "Normal", diagnostics: clean }
    ]),
    { passed: true, issues: [] }
  );
  const result = evaluateDiagnosticSnapshots([
    { label: "initial", diagnostics: clean },
    {
      label: "Velocity",
      diagnostics: { ...clean, uncapturedErrorCount: 1 }
    }
  ]);
  assert.equal(result.passed, false);
  assert.match(result.issues.join("\n"), /Velocity.*uncapturedErrorCount=1/);
});

test("FX-01 zero-velocity screenshot requires every static and invalid tile to be neutral", () => {
  const neutral = (value) => ({ rgb: [value, value, value], luminance: value });
  assert.equal(
    velocityTilesAreZero(Array.from({ length: 6 }, () => neutral(84))),
    true
  );
  assert.equal(
    velocityTilesAreZero([
      { rgb: [90, 112, 81], luminance: 105 },
      ...Array.from({ length: 5 }, () => neutral(84))
    ]),
    false
  );
});

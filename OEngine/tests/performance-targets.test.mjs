import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const targets = JSON.parse(await readFile(new URL("../../performance-targets.json", import.meta.url), "utf8"));

test("G5-L target-machine contract freezes required product and regression fields", () => {
  assert.equal(targets.schemaVersion, 1);
  assert.equal(targets.status, "frozen");
  assert.equal(targets.owner, "G5-L");
  assert.equal(targets.targetMachine.adapter.vendor, "nvidia");
  assert.equal(targets.targetMachine.adapter.architecture, "turing");
  assert.ok(targets.targetMachine.evidence.length >= 4);
  assert.equal(targets.minimumCorrectAdapter.mode, "correctness-only");

  assert.equal(targets.productProfile.outputWidth, 1920);
  assert.equal(targets.productProfile.outputHeight, 1080);
  assert.equal(targets.productProfile.devicePixelRatio, 1);
  assert.equal(targets.productProfile.targetFramesPerSecond, 60);
  assert.ok(targets.productProfile.totalGpuBudgetMs > 0);
  assert.equal(targets.productProfile.attainment, "not-yet-demonstrated");

  for (const caseId of ["A", "B", "C"]) {
    const ceiling = targets.regressionProfile.absoluteCeilings[caseId];
    assert.ok(Number.isFinite(ceiling.p95Ms) && ceiling.p95Ms > 0, `${caseId} absolute ceiling must be real`);
    assert.ok(ceiling.basis.length > 40, `${caseId} ceiling must retain its evidence basis`);
  }
});

test("G5-L target contract cannot confuse an aspirational product budget with an achieved result", () => {
  assert.equal(targets.claims.g5LightingGateClosed, true);
  assert.equal(targets.claims.productPerformanceAchieved, false);
  assert.equal(targets.claims.threeJsParityClaimed, false);
  assert.equal(targets.claims.aaaLikePerformanceClaimed, false);
});

test("R5 target contract freezes feature, memory, upload and readback budgets", () => {
  for (const field of ["lightingMs", "shadowMs", "transparencyMs", "temporalAndUpscaleMs"]) {
    assert.ok(Number.isFinite(targets.featureOnIncrementBudgets[field]) && targets.featureOnIncrementBudgets[field] > 0);
  }
  for (const field of ["residentBytes", "transientBytes", "historyBytes", "shadowAtlasBytes"]) {
    assert.ok(Number.isInteger(targets.memoryCaps[field]) && targets.memoryCaps[field] > 0);
  }
  assert.ok(targets.perFrameIoCaps.uploadBytes > 0);
  assert.ok(targets.perFrameIoCaps.readbackBytes > 0);
  assert.equal(targets.perFrameIoCaps.steadyStatePrivateSubmits, 0);
});

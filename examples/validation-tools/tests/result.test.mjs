import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateStatus,
  exitCodeForStatus,
  validateScenarioResult
} from "../result.mjs";
import { validationCase } from "../cases.mjs";

test("validation status aggregation and exit codes preserve three-state semantics", () => {
  assert.equal(aggregateStatus([{ status: "passed" }]), "passed");
  assert.equal(aggregateStatus([{ status: "passed" }, { status: "inconclusive" }]), "inconclusive");
  assert.equal(aggregateStatus([{ status: "inconclusive" }, { status: "failed" }]), "failed");
  assert.equal(exitCodeForStatus("passed"), 0);
  assert.equal(exitCodeForStatus("failed"), 1);
  assert.equal(exitCodeForStatus("inconclusive"), 2);
});

test("scenario result rejects stale run and frame evidence", () => {
  const errors = validateScenarioResult({
    schemaVersion: 1,
    fixtureId: "smoke",
    runId: "old-run",
    scenarioId: "basic",
    status: "passed",
    startedFrame: 4,
    completedFrame: 4,
    evidence: {},
    assertions: [],
    diagnostics: {}
  }, validationCase("smoke.basic"), "new-run");
  assert.match(errors.join("\n"), /runId/);
  assert.match(errors.join("\n"), /newer than startedFrame/);
});

test("a malformed or failed assertion can never be reported as passed", () => {
  const base = {
    schemaVersion: 1,
    fixtureId: "smoke",
    runId: "run-1",
    scenarioId: "basic",
    status: "passed",
    startedFrame: 4,
    completedFrame: 5,
    evidence: {},
    diagnostics: {
      validationErrorCount: 0,
      uncapturedErrorCount: 0,
      deviceLostCount: 0,
      uncapturedErrors: [],
      deviceLostReasons: []
    }
  };
  const failed = validateScenarioResult({
    ...base,
    assertions: [{ id: "real-check", passed: false, message: "failed" }]
  }, validationCase("smoke.basic"), "run-1");
  const malformed = validateScenarioResult({
    ...base,
    assertions: [{ id: "real-check", passed: "false", message: "malformed" }]
  }, validationCase("smoke.basic"), "run-1");
  assert.match(failed.join("\n"), /passed result cannot contain/);
  assert.match(malformed.join("\n"), /assertions\[0\] is invalid/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { claimStatus, evidenceReplacementError, isVerificationComplete, loadModel, validateModel } from "../../tools/vibe-lib.mjs";

const head = "a".repeat(40);
const tree = "b".repeat(40);
const signature = "c".repeat(64);
const registrySha256 = "d".repeat(64);
const claim = {
  id: "test.claim",
  requiredChecks: ["registry"],
  evidencePolicy: { allOf: ["required-case"], anyOf: [], diagnosticCases: ["diagnostic-case"], checkOnly: false }
};

function acceptedRecord(caseId = "required-case") {
  return {
    caseId,
    claimIds: [claim.id],
    runId: `${caseId}-run`,
    completedAt: "2026-09-21T00:00:00.000Z",
    status: "passed",
    evidenceStatus: "accepted",
    commit: head,
    tree,
    dirty: false,
    registrySha256,
    caseSignatureSha256: signature,
    freshness: { clean: true, revisionMatches: true, accepted: true },
    checkReceipts: [{ id: "registry", status: "passed", revision: head, tree, dirty: false, scope: "full", registrySha256 }]
  };
}

test("claim promotion requires real matching check receipts", () => {
  const record = acceptedRecord();
  const index = { evidence: [record] };
  assert.equal(claimStatus(claim, index, head, { "required-case": signature }), "accepted");
  record.checkReceipts = [];
  assert.equal(claimStatus(claim, index, head, { "required-case": signature }), "stale");
});

test("diagnostic case history cannot block a promotion policy", () => {
  const required = acceptedRecord();
  const diagnostic = { ...acceptedRecord("diagnostic-case"), status: "failed", evidenceStatus: "diagnostic-only" };
  const index = { evidence: [required, diagnostic] };
  assert.equal(claimStatus(claim, index, head, { "required-case": signature, "diagnostic-case": signature }), "accepted");
});

test("model rejects a promotion case below the claim assurance", async () => {
  const model = await loadModel();
  const protocol = model.cases.find((item) => item.id === "protocol-self-test");
  protocol.level = "L0";
  const errors = validateModel(model, null);
  assert.ok(errors.some((error) => error.includes("frame.host-protocol requires L3 but protocol-self-test is L0")));
});

test("model rejects diagnostic cases in promotion policy", async () => {
  const model = await loadModel();
  model.cases.find((item) => item.id === "protocol-self-test").evidenceRole = "diagnostic";
  const errors = validateModel(model, null);
  assert.ok(errors.some((error) => error.includes("protocol-self-test must have evidenceRole promotion")));
});

test("diagnostic cases may omit durable claim coverage", async () => {
  const model = await loadModel();
  const diagnostic = model.cases.find((item) => item.id === "oegpack-v3-component");
  diagnostic.covers = [];
  diagnostic.errorAllowlist = [];
  for (const item of model.claims) {
    item.evidencePolicy.diagnosticCases = item.evidencePolicy.diagnosticCases.filter((id) => id !== diagnostic.id);
  }
  const errors = validateModel(model, null);
  assert.ok(!errors.some((error) => error.includes(diagnostic.id)));
});

test("check-only claims require current clean receipts", () => {
  const checkClaim = {
    requiredChecks: ["model", "registry"],
    evidencePolicy: { allOf: [], anyOf: [], diagnosticCases: [], checkOnly: true }
  };
  const receipts = ["model", "registry"].map((id) => ({ id, status: "passed", revision: head, dirty: false, scope: "full" }));
  assert.equal(claimStatus(checkClaim, { evidence: [], checkReceipts: receipts }, head, {}), "accepted");
  receipts[0].dirty = true;
  assert.equal(claimStatus(checkClaim, { evidence: [], checkReceipts: receipts }, head, {}), "unproven");
});

test("not-run required gates prevent verification completion", () => {
  assert.equal(isVerificationComplete(true, [], []), true);
  assert.equal(isVerificationComplete(true, [{ caseId: "gpu-case" }], []), false);
  assert.equal(isVerificationComplete(true, [], [{ id: "engine-suites" }]), false);
});

test("empty raw evidence cannot silently replace a non-empty compact index", () => {
  const existing = { evidence: [{ runId: "kept" }] };
  const empty = { evidence: [] };
  assert.match(evidenceReplacementError(empty, existing), /Refusing to replace/u);
  assert.equal(evidenceReplacementError(empty, existing, { forceEmpty: true }), null);
});

test("partial raw evidence cannot silently prune compact case history", () => {
  const existing = { evidence: [{ caseId: "case-a" }, { caseId: "case-b" }] };
  const partial = { evidence: [{ caseId: "case-a" }] };
  assert.match(evidenceReplacementError(partial, existing), /case-b/u);
  assert.equal(evidenceReplacementError(partial, existing, { forcePrune: true }), null);
});

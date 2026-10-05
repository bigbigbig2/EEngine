import assert from "node:assert/strict";
import test from "node:test";
import { validateArtifact } from "../src/shared/artifact.mjs";

const sha = "a".repeat(64);
const commit = "b".repeat(40);
const now = "2026-09-13T00:00:00.000Z";

function validArtifact() {
  return {
    schemaVersion: 3,
    runId: "2026-09-13T00-00-00-000Z-protocol-self-test-00000000-0000-4000-8000-000000000000",
    nonce: "c".repeat(48),
    caseId: "protocol-self-test",
    workloadId: "protocol-self-test-v1",
    registrySha256: sha,
    workloadSha256: sha,
    status: "passed",
    validationMode: "diagnostic",
    evidenceStatus: "diagnostic-only",
    provenance: {
      commit,
      tree: commit,
      dirty: false,
      engineSourceSha256: sha,
      hostBuildId: "host-build-v1",
      browserExecutable: "chrome.exe",
      browserExecutableSha256: sha,
      browserVersion: "153.0.0.0",
      userAgent: "Chrome",
      startedAt: now,
      completedAt: now
    },
    page: {
      schemaVersion: 1,
      runId: "2026-09-13T00-00-00-000Z-protocol-self-test-00000000-0000-4000-8000-000000000000",
      nonce: "c".repeat(48),
      caseId: "protocol-self-test",
      workloadId: "protocol-self-test-v1",
      registrySha256: sha,
      workloadSha256: sha,
      hostBuildId: "host-build-v1",
      documentId: "00000000-0000-4000-8000-000000000001",
      navigationCount: 1,
      state: "disposed",
      outcome: "passed",
      startedAt: now,
      completedAt: now,
      disposedAt: now,
      phases: [
        { state: "created", at: now },
        { state: "passed", at: now },
        { state: "disposed", at: now }
      ],
      evidence: {},
      errors: [],
      disposeEvidence: { listeners: 0 }
    },
    events: [{ at: now, source: "browser:launch", detail: {} }],
    artifactManifest: [{ kind: "events", path: "events.json", bytes: 2, sha256: sha }],
    gate: {
      freshness: true,
      identity: true,
      browserErrors: true,
      pageOutcome: true,
      disposed: true,
      artifacts: true
    }
  };
}

const selectedCase = {
  id: "protocol-self-test",
  workloadId: "protocol-self-test-v1",
  artifacts: ["result", "events"]
};

// Local protocol validation, not a browser/GPU execution assertion.
test("current diagnostic artifact satisfies identity, dispose and artifact ownership", () => {
  assert.deepEqual(validateArtifact(validArtifact(), selectedCase), []);
});
test("dirty diagnostic runs are allowed but identity drift and missing disposal fail", () => {
  const artifact = validArtifact();
  artifact.provenance.dirty = true;
  assert.deepEqual(validateArtifact(artifact, selectedCase), []);
  artifact.page.nonce = "d".repeat(48);
  artifact.gate.disposed = false;
  const errors = validateArtifact(artifact, selectedCase);
  assert.ok(errors.some((error) => error.includes("page nonce")));
  assert.ok(errors.some((error) => error.includes("every gate")));
});
test("retired acceptance and fabricated receipts cannot re-enter the diagnostic protocol", () => {
  const artifact = validArtifact();
  artifact.validationMode = "acceptance";
  artifact.evidenceStatus = "accepted";
  artifact.checkReceipts = [{ status: "passed" }];
  const errors = validateArtifact(artifact, selectedCase);
  assert.ok(errors.some((error) => error.includes("acceptance is retired")));
  assert.ok(errors.some((error) => error.includes("evidenceStatus")));
  assert.ok(errors.some((error) => error.includes("receipts are retired")));
});

test("manifest rejects undeclared, missing and unsafe artifacts", () => {
  const artifact = validArtifact();
  artifact.artifactManifest = [{ kind: "trace", path: "../trace.json", bytes: -1, sha256: "bad" }];
  const errors = validateArtifact(artifact, selectedCase);
  assert.ok(errors.some((error) => error.includes("unsafe")));
  assert.ok(errors.some((error) => error.includes("not owned")));
  assert.ok(errors.some((error) => error.includes("events is missing")));
});

test("only failed runner artifacts may omit a page snapshot", () => {
  const artifact = validArtifact();
  artifact.page = null;
  assert.ok(validateArtifact(artifact, selectedCase).some((error) => error.includes("failed run")));
  artifact.status = "failed";
  artifact.evidenceStatus = "diagnostic-only";
  artifact.gate = {
    freshness: false,
    identity: false,
    browserErrors: false,
    pageOutcome: false,
    disposed: false,
    artifacts: true
  };
  assert.deepEqual(validateArtifact(artifact, selectedCase), []);
});

test("unsupported runs may omit case-specific artifacts without claiming accepted evidence", () => {
  const artifact = validArtifact();
  artifact.status = "unsupported";
  artifact.evidenceStatus = "diagnostic-only";
  artifact.page.outcome = "unsupported";
  artifact.page.errors = [{ source: "case", message: "required capability unavailable" }];
  artifact.artifactManifest = [];
  artifact.gate.artifacts = true;
  assert.deepEqual(validateArtifact(artifact, selectedCase), []);
});

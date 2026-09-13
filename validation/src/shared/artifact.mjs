const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const NONCE_PATTERN = /^[0-9a-f]{48}$/u;
const CASE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const STATUS = new Set(["passed", "failed", "unsupported"]);
const EVIDENCE_STATUS = new Set(["accepted", "diagnostic-only"]);
const ARTIFACT_KINDS = new Set(["events", "screenshot", "readback", "trace", "samples"]);
const GATE_FIELDS = ["freshness", "identity", "browserErrors", "pageOutcome", "disposed", "artifacts"];

export function validateArtifact(artifact, selectedCase) {
  const errors = [];
  if (!isRecord(artifact)) return ["artifact must be an object"];
  if (artifact.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (typeof artifact.runId !== "string" || artifact.runId.length < 40) errors.push("runId is invalid");
  if (!NONCE_PATTERN.test(artifact.nonce ?? "")) errors.push("nonce must be 24 random bytes encoded as hex");
  if (!CASE_ID_PATTERN.test(artifact.caseId ?? "")) errors.push("caseId is invalid");
  if (typeof artifact.workloadId !== "string" || !/-v\d+$/u.test(artifact.workloadId)) errors.push("workloadId is invalid");
  if (!SHA256_PATTERN.test(artifact.registrySha256 ?? "")) errors.push("registrySha256 is invalid");
  if (!SHA256_PATTERN.test(artifact.workloadSha256 ?? "")) errors.push("workloadSha256 is invalid");
  if (!STATUS.has(artifact.status)) errors.push("status is invalid");
  if (!EVIDENCE_STATUS.has(artifact.evidenceStatus)) errors.push("evidenceStatus is invalid");

  validateProvenance(artifact.provenance, errors);
  validateEvents(artifact.events, errors);
  validateManifest(artifact.artifactManifest, errors);
  validateGate(artifact.gate, errors);
  validatePage(artifact.page, artifact, errors);

  if (selectedCase !== undefined) {
    if (artifact.caseId !== selectedCase.id) errors.push("artifact case does not match registry selection");
    if (artifact.workloadId !== selectedCase.workloadId) errors.push("artifact workload does not match registry selection");
    const declared = new Set(selectedCase.artifacts ?? []);
    for (const entry of artifact.artifactManifest ?? []) {
      if (!declared.has(entry.kind)) errors.push(`artifact kind ${entry.kind} is not owned by the case`);
    }
    if (artifact.status === "passed") {
      for (const required of [...declared].filter((kind) => kind !== "result")) {
        if (!(artifact.artifactManifest ?? []).some((entry) => entry.kind === required)) {
          errors.push(`declared artifact ${required} is missing from manifest`);
        }
      }
    }
  }

  if (artifact.evidenceStatus === "accepted" && artifact.provenance?.dirty !== false) {
    errors.push("accepted evidence requires a clean revision");
  }
  if (artifact.status === "passed") {
    if (artifact.page === null || artifact.page?.outcome !== "passed") errors.push("passed artifact requires a passed page");
    if (!GATE_FIELDS.every((field) => artifact.gate?.[field] === true)) errors.push("passed artifact requires every gate to pass");
    if ((artifact.page?.errors?.length ?? 0) !== 0) errors.push("passed artifact cannot contain page errors");
  }
  return errors;
}

export function requireValidArtifact(artifact, selectedCase) {
  const errors = validateArtifact(artifact, selectedCase);
  if (errors.length > 0) throw new Error(`Invalid validation artifact:\n${errors.join("\n")}`);
  return artifact;
}

function validateProvenance(value, errors) {
  if (!isRecord(value)) {
    errors.push("provenance must be an object");
    return;
  }
  if (!COMMIT_PATTERN.test(value.commit ?? "")) errors.push("provenance commit is invalid");
  if (!COMMIT_PATTERN.test(value.tree ?? "")) errors.push("provenance tree is invalid");
  if (typeof value.dirty !== "boolean") errors.push("provenance dirty must be boolean");
  for (const field of ["hostBuildId", "browserExecutable", "browserVersion", "userAgent"]) {
    if (typeof value[field] !== "string" || value[field].length === 0) errors.push(`provenance ${field} is invalid`);
  }
  if (!SHA256_PATTERN.test(value.browserExecutableSha256 ?? "")) errors.push("browser executable hash is invalid");
  const started = parseDate(value.startedAt, "provenance startedAt", errors);
  const completed = parseDate(value.completedAt, "provenance completedAt", errors);
  if (started !== null && completed !== null && completed < started) errors.push("provenance completedAt precedes startedAt");
}

function validatePage(page, artifact, errors) {
  if (page === null) {
    if (artifact.status !== "failed") errors.push("only a failed run may omit the page snapshot");
    return;
  }
  if (!isRecord(page)) {
    errors.push("page must be an object or null");
    return;
  }
  for (const field of ["schemaVersion", "caseId", "workloadId", "runId", "nonce", "registrySha256", "workloadSha256"]) {
    if (page[field] !== artifact[field] && !(field === "schemaVersion" && page[field] === 1)) {
      errors.push(`page ${field} does not match artifact`);
    }
  }
  if (page.hostBuildId !== artifact.provenance?.hostBuildId) errors.push("page hostBuildId does not match provenance");
  if (typeof page.documentId !== "string" || page.documentId.length < 32) errors.push("page documentId is invalid");
  if (page.navigationCount !== 1) errors.push("page navigationCount must be exactly one");
  if (page.state !== "disposed") errors.push("page was not disposed");
  if (!STATUS.has(page.outcome)) errors.push("page outcome is invalid");
  const started = parseDate(page.startedAt, "page startedAt", errors);
  const completed = parseDate(page.completedAt, "page completedAt", errors);
  const disposed = parseDate(page.disposedAt, "page disposedAt", errors);
  if (started !== null && completed !== null && completed < started) errors.push("page completedAt precedes startedAt");
  if (completed !== null && disposed !== null && disposed < completed) errors.push("page disposedAt precedes completedAt");
  if (!Array.isArray(page.phases) || page.phases.length < 3) errors.push("page phases are incomplete");
  if (!isRecord(page.evidence)) errors.push("page evidence must be an object");
  if (!Array.isArray(page.errors)) errors.push("page errors must be an array");
  if (!isRecord(page.disposeEvidence)) errors.push("page disposeEvidence must be an object");
}

function validateEvents(events, errors) {
  if (!Array.isArray(events)) {
    errors.push("events must be an array");
    return;
  }
  for (const [index, event] of events.entries()) {
    if (!isRecord(event) || typeof event.source !== "string" || event.source.length === 0) errors.push(`event ${index} source is invalid`);
    parseDate(event?.at, `event ${index} at`, errors);
    if (!("detail" in (event ?? {}))) errors.push(`event ${index} detail is missing`);
  }
}

function validateManifest(manifest, errors) {
  if (!Array.isArray(manifest)) {
    errors.push("artifactManifest must be an array");
    return;
  }
  const paths = new Set();
  for (const [index, entry] of manifest.entries()) {
    if (!isRecord(entry) || !ARTIFACT_KINDS.has(entry.kind)) errors.push(`artifact ${index} kind is invalid`);
    if (typeof entry?.path !== "string" || entry.path.length === 0 || entry.path.includes("..") || /^[A-Za-z]:|^[\\/]/u.test(entry.path)) {
      errors.push(`artifact ${index} path is unsafe`);
    } else if (paths.has(entry.path)) errors.push(`duplicate artifact path ${entry.path}`);
    else paths.add(entry.path);
    if (!Number.isSafeInteger(entry?.bytes) || entry.bytes < 0) errors.push(`artifact ${index} bytes are invalid`);
    if (!SHA256_PATTERN.test(entry?.sha256 ?? "")) errors.push(`artifact ${index} hash is invalid`);
  }
}

function validateGate(gate, errors) {
  if (!isRecord(gate)) {
    errors.push("gate must be an object");
    return;
  }
  for (const field of GATE_FIELDS) {
    if (typeof gate[field] !== "boolean") errors.push(`gate ${field} must be boolean`);
  }
}

function parseDate(value, label, errors) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    errors.push(`${label} is invalid`);
    return null;
  }
  return parsed;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

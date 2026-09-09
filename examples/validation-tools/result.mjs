import { VALIDATION_PROTOCOL_SCHEMA_VERSION } from "../validation/fixture-contract.mjs";

export const VALIDATION_EXIT_CODE = Object.freeze({
  passed: 0,
  failed: 1,
  inconclusive: 2
});

const VALIDATION_STATUSES = new Set(Object.keys(VALIDATION_EXIT_CODE));
const FIXTURE_STATUSES = new Set([
  "booting", "ready", "running", "failed", "device-lost", "disposed"
]);

export function validateSnapshot(value, expectedFixtureId) {
  const errors = [];
  if (!isRecord(value)) return ["snapshot must be an object"];
  if (value.schemaVersion !== VALIDATION_PROTOCOL_SCHEMA_VERSION) {
    errors.push(`snapshot schemaVersion must be ${VALIDATION_PROTOCOL_SCHEMA_VERSION}`);
  }
  if (value.fixtureId !== expectedFixtureId) {
    errors.push(`snapshot fixtureId must be '${expectedFixtureId}'`);
  }
  if (!FIXTURE_STATUSES.has(value.status)) errors.push("snapshot status is invalid");
  if (!isNonNegativeInteger(value.frame)) errors.push("snapshot frame must be a non-negative integer");
  validateDiagnostics(value.diagnostics, "snapshot diagnostics", errors);
  if (!isRecord(value.environment)) {
    errors.push("snapshot environment must be an object");
  } else if (![value.environment.width, value.environment.height, value.environment.dpr]
    .every((field) => typeof field === "number" && Number.isFinite(field) && field > 0)) {
    errors.push("snapshot environment dimensions and dpr must be positive finite numbers");
  }
  if (!isRecord(value.build) || typeof value.build.commit !== "string" ||
      typeof value.build.dirty !== "boolean" || typeof value.build.contentHash !== "string") {
    errors.push("snapshot build provenance is invalid");
  }
  return errors;
}

export function validateScenarioResult(value, validationCase, runId) {
  const errors = [];
  if (!isRecord(value)) return ["scenario result must be an object"];
  if (value.schemaVersion !== VALIDATION_PROTOCOL_SCHEMA_VERSION) {
    errors.push(`result schemaVersion must be ${VALIDATION_PROTOCOL_SCHEMA_VERSION}`);
  }
  if (value.fixtureId !== validationCase.fixture) {
    errors.push(`result fixtureId must be '${validationCase.fixture}'`);
  }
  if (value.scenarioId !== validationCase.scenario) {
    errors.push(`result scenarioId must be '${validationCase.scenario}'`);
  }
  if (value.runId !== runId) errors.push(`result runId must be '${runId}'`);
  if (!VALIDATION_STATUSES.has(value.status)) errors.push("result status is invalid");
  if (!isNonNegativeInteger(value.startedFrame)) errors.push("startedFrame must be a non-negative integer");
  if (!isNonNegativeInteger(value.completedFrame)) errors.push("completedFrame must be a non-negative integer");
  if (isNonNegativeInteger(value.startedFrame) &&
      isNonNegativeInteger(value.completedFrame) &&
      value.completedFrame <= value.startedFrame) {
    errors.push("completedFrame must be newer than startedFrame");
  }
  if (typeof value.runId !== "string" || value.runId.length === 0) errors.push("result runId must be a non-empty string");
  if (!Array.isArray(value.assertions) || value.assertions.length === 0) {
    errors.push("assertions must be a non-empty array");
  } else {
    value.assertions.forEach((assertion, index) => {
      if (!isRecord(assertion) || typeof assertion.id !== "string" || assertion.id.length === 0 ||
          typeof assertion.passed !== "boolean" || typeof assertion.message !== "string") {
        errors.push(`assertions[${index}] is invalid`);
      }
    });
    if (value.status === "passed" && value.assertions.some((assertion) => assertion?.passed !== true)) {
      errors.push("a passed result cannot contain a failed or malformed assertion");
    }
  }
  if (!isRecord(value.evidence)) errors.push("evidence must be an object");
  validateDiagnostics(value.diagnostics, "diagnostics", errors);
  return errors;
}

export function aggregateStatus(results) {
  if (results.some((result) => result.status === "failed")) return "failed";
  if (results.some((result) => result.status === "inconclusive")) return "inconclusive";
  return "passed";
}

export function exitCodeForStatus(status) {
  const code = VALIDATION_EXIT_CODE[status];
  if (code === undefined) throw new Error(`Unknown validation status '${status}'`);
  return code;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function validateDiagnostics(value, label, errors) {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  for (const name of ["validationErrorCount", "uncapturedErrorCount", "deviceLostCount"]) {
    if (!isNonNegativeInteger(value[name])) errors.push(`${label}.${name} must be a non-negative integer`);
  }
  for (const name of ["uncapturedErrors", "deviceLostReasons"]) {
    if (!Array.isArray(value[name]) || !value[name].every((entry) => typeof entry === "string")) {
      errors.push(`${label}.${name} must be a string array`);
    }
  }
}

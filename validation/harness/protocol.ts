export type ValidationState =
  | "created"
  | "negotiating"
  | "ready"
  | "warming"
  | "sampling"
  | "draining"
  | "passed"
  | "failed"
  | "unsupported"
  | "disposed";

export type ValidationOutcome = "passed" | "failed" | "unsupported";

export interface ValidationError {
  source: "case" | "gpu-validation" | "gpu-oom" | "gpu-internal" | "uncaptured" | "device-loss" | "dispose";
  message: string;
}

export interface ValidationIdentity {
  readonly caseId: string;
  readonly workloadId: string;
}

export interface ValidationSnapshot {
  schemaVersion: 1;
  caseId: string;
  workloadId: string;
  runId: string;
  nonce: string;
  registrySha256: string;
  workloadSha256: string;
  hostBuildId: string;
  documentId: string;
  navigationCount: number;
  state: ValidationState;
  outcome?: ValidationOutcome;
  startedAt: string;
  completedAt?: string;
  disposedAt?: string;
  phases: Array<{ state: ValidationState; at: string }>;
  evidence: Record<string, unknown>;
  errors: ValidationError[];
  disposeEvidence?: Record<string, unknown>;
  dispose(): Promise<void>;
}

const NEXT_STATES: Readonly<Record<ValidationState, readonly ValidationState[]>> = {
  created: ["negotiating", "failed"],
  negotiating: ["ready", "failed", "unsupported"],
  ready: ["warming", "failed"],
  warming: ["sampling", "failed"],
  sampling: ["draining", "failed"],
  draining: ["passed", "failed"],
  passed: ["failed", "disposed"],
  failed: ["disposed"],
  unsupported: ["disposed"],
  disposed: []
};

export interface ValidationController {
  readonly snapshot: ValidationSnapshot;
  transition(state: ValidationState): void;
  addEvidence(key: string, value: unknown): void;
  addError(error: ValidationError): void;
  pass(): void;
  fail(message: string): void;
  unsupported(message: string): void;
}

declare global {
  interface Window {
    __OENGINE_VALIDATION__?: ValidationSnapshot;
  }
}

export function createValidationController(
  identity: Readonly<ValidationIdentity>,
  disposeCase: () => Record<string, unknown> | void | Promise<Record<string, unknown> | void>
): ValidationController {
  const query = new URLSearchParams(window.location.search);
  const runId = requireQuery(query, "runId", 8);
  const nonce = requireHexQuery(query, "nonce", 48);
  const registrySha256 = requireHexQuery(query, "registrySha256", 64);
  const workloadSha256 = requireHexQuery(query, "workloadSha256", 64);
  const hostBuildId = requireQuery(query, "hostBuildId", 8);
  const navigationKey = `__oengine_validation_navigation__:${runId}`;
  const navigationCount = Number.parseInt(sessionStorage.getItem(navigationKey) ?? "0", 10) + 1;
  sessionStorage.setItem(navigationKey, String(navigationCount));

  let disposed = false;
  const startedAt = new Date().toISOString();
  const snapshot: ValidationSnapshot = {
    schemaVersion: 1,
    caseId: identity.caseId,
    workloadId: identity.workloadId,
    runId,
    nonce,
    registrySha256,
    workloadSha256,
    hostBuildId,
    documentId: crypto.randomUUID(),
    navigationCount,
    state: "created",
    startedAt,
    phases: [{ state: "created", at: startedAt }],
    evidence: {},
    errors: [],
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        snapshot.disposeEvidence = (await disposeCase()) ?? {};
      } catch (error) {
        snapshot.errors.push({ source: "dispose", message: errorMessage(error) });
        if (snapshot.state !== "failed") transition("failed");
        snapshot.disposeEvidence = { failed: true };
      }
      if (snapshot.outcome === "passed" && snapshot.errors.length > 0) transition("failed");
      if (snapshot.state !== "disposed") transition("disposed");
      snapshot.disposedAt = new Date().toISOString();
      sessionStorage.removeItem(navigationKey);
    }
  };

  function transition(state: ValidationState): void {
    if (!NEXT_STATES[snapshot.state].includes(state)) {
      throw new Error(`Invalid validation transition ${snapshot.state} -> ${state}`);
    }
    snapshot.state = state;
    const at = new Date().toISOString();
    snapshot.phases.push({ state, at });
    if (state === "passed" || state === "failed" || state === "unsupported") {
      snapshot.outcome = state;
      snapshot.completedAt = at;
    }
  }

  const controller: ValidationController = {
    snapshot,
    transition,
    addEvidence(key, value) {
      if (snapshot.state === "disposed") throw new Error("Cannot append evidence after dispose");
      snapshot.evidence[key] = value;
    },
    addError(error) {
      if (snapshot.state === "disposed") throw new Error("Cannot append errors after dispose");
      snapshot.errors.push(error);
    },
    pass() {
      if (snapshot.errors.length > 0) {
        transition("failed");
        return;
      }
      transition("passed");
    },
    fail(message) {
      snapshot.errors.push({ source: "case", message });
      if (snapshot.state !== "failed") transition("failed");
    },
    unsupported(message) {
      snapshot.errors.push({ source: "case", message });
      transition("unsupported");
    }
  };
  window.__OENGINE_VALIDATION__ = snapshot;
  return controller;
}

function requireQuery(query: URLSearchParams, name: string, minimumLength: number): string {
  const value = query.get(name) ?? "";
  if (value.length < minimumLength) throw new Error(`Fresh ${name} is required`);
  return value;
}

function requireHexQuery(query: URLSearchParams, name: string, length: number): string {
  const value = requireQuery(query, name, length);
  if (value.length !== length || !/^[0-9a-f]+$/u.test(value)) {
    throw new Error(`${name} must be ${length} lowercase hex characters`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

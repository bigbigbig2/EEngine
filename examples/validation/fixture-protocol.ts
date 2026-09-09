export {
  VALIDATION_FIXTURE_KEY,
  VALIDATION_PROTOCOL_SCHEMA_VERSION
} from "./fixture-contract.mjs";
import { VALIDATION_PROTOCOL_SCHEMA_VERSION } from "./fixture-contract.mjs";

export type ValidationFixtureStatus =
  | "booting"
  | "ready"
  | "running"
  | "failed"
  | "device-lost"
  | "disposed";

export type ValidationStatus = "passed" | "failed" | "inconclusive";

export interface ValidationError {
  readonly name: string;
  readonly message: string;
}

export interface ValidationGpuDiagnostics {
  readonly validationErrorCount: number;
  readonly uncapturedErrorCount: number;
  readonly deviceLostCount: number;
  readonly uncapturedErrors: readonly string[];
  readonly deviceLostReasons: readonly string[];
  readonly failedGpuCounterSamples?: number;
  readonly droppedGpuCounterSamples?: number;
}

export interface ValidationAdapterIdentity {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
  readonly features: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
}

export interface ValidationSnapshot {
  readonly schemaVersion: typeof VALIDATION_PROTOCOL_SCHEMA_VERSION;
  readonly fixtureId: string;
  readonly status: ValidationFixtureStatus;
  readonly frame: number;
  readonly activeRunId: string | null;
  readonly activeScenario: string | null;
  readonly build: {
    readonly commit: string;
    readonly dirty: boolean;
    readonly contentHash: string;
  };
  readonly environment: {
    readonly width: number;
    readonly height: number;
    readonly dpr: number;
  };
  readonly adapter: ValidationAdapterIdentity | null;
  readonly diagnostics: ValidationGpuDiagnostics;
  readonly error?: ValidationError;
}

export interface ValidationScenarioRequest {
  readonly runId: string;
  readonly scenarioId: string;
}

export interface ValidationAssertion {
  readonly id: string;
  readonly passed: boolean;
  readonly message: string;
  readonly actual?: unknown;
  readonly expected?: unknown;
}

export interface ValidationScenarioResult<
  Evidence extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>
> {
  readonly schemaVersion: typeof VALIDATION_PROTOCOL_SCHEMA_VERSION;
  readonly fixtureId: string;
  readonly runId: string;
  readonly scenarioId: string;
  readonly status: ValidationStatus;
  readonly startedFrame: number;
  readonly completedFrame: number;
  readonly evidence: Evidence;
  readonly assertions: readonly ValidationAssertion[];
  readonly diagnostics: ValidationGpuDiagnostics;
  readonly error?: ValidationError;
}

export interface ValidationFixture {
  getSnapshot(): ValidationSnapshot;
  runScenario(request: ValidationScenarioRequest): Promise<ValidationScenarioResult>;
  dispose(): Promise<void>;
}

declare global {
  interface Window {
    __OENGINE_VALIDATION_FIXTURE__?: ValidationFixture;
  }
}

export function validationError(error: unknown): ValidationError {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error)
  };
}

export function validationAssertion(
  id: string,
  passed: boolean,
  message: string,
  actual?: unknown,
  expected?: unknown
): ValidationAssertion {
  return {
    id,
    passed,
    message,
    ...(actual === undefined ? {} : { actual }),
    ...(expected === undefined ? {} : { expected })
  };
}

import {
  VALIDATION_PROTOCOL_SCHEMA_VERSION,
  type ValidationAdapterIdentity,
  type ValidationError,
  type ValidationFixtureStatus,
  type ValidationGpuDiagnostics,
  type ValidationSnapshot
} from "../fixture-protocol.ts";

export interface FixtureStateSources {
  readonly fixtureId: string;
  readonly canvas: HTMLCanvasElement;
  readonly frame: () => number;
  readonly adapter: () => ValidationAdapterIdentity | null;
  readonly diagnostics: () => ValidationGpuDiagnostics;
}

export class FixtureState {
  private statusValue: ValidationFixtureStatus = "booting";
  private activeRunIdValue: string | null = null;
  private activeScenarioValue: string | null = null;
  private errorValue: ValidationError | undefined;

  constructor(private readonly sources: FixtureStateSources) {}

  get status(): ValidationFixtureStatus {
    return this.statusValue;
  }

  ready(): void {
    this.statusValue = "ready";
    this.errorValue = undefined;
  }

  start(runId: string, scenarioId: string): void {
    if (this.statusValue === "disposed") throw new Error("Fixture is disposed");
    if (this.activeRunIdValue !== null) {
      throw new Error(`Fixture is already running '${this.activeRunIdValue}'`);
    }
    this.activeRunIdValue = runId;
    this.activeScenarioValue = scenarioId;
    this.statusValue = "running";
    this.errorValue = undefined;
  }

  finish(): void {
    this.activeRunIdValue = null;
    this.activeScenarioValue = null;
    if (this.statusValue === "running") this.statusValue = "ready";
  }

  fail(error: ValidationError): void {
    this.errorValue = error;
    this.statusValue = "failed";
    this.activeRunIdValue = null;
    this.activeScenarioValue = null;
  }

  deviceLost(error: ValidationError): void {
    this.errorValue = error;
    this.statusValue = "device-lost";
    this.activeRunIdValue = null;
    this.activeScenarioValue = null;
  }

  dispose(): void {
    this.statusValue = "disposed";
    this.activeRunIdValue = null;
    this.activeScenarioValue = null;
  }

  snapshot(): ValidationSnapshot {
    const canvas = this.sources.canvas;
    return {
      schemaVersion: VALIDATION_PROTOCOL_SCHEMA_VERSION,
      fixtureId: this.sources.fixtureId,
      status: this.statusValue,
      frame: this.sources.frame(),
      activeRunId: this.activeRunIdValue,
      activeScenario: this.activeScenarioValue,
      build: {
        commit: __BUILD_COMMIT__,
        dirty: __BUILD_DIRTY__,
        contentHash: __BUILD_CONTENT_HASH__
      },
      environment: {
        width: canvas.width,
        height: canvas.height,
        dpr: window.devicePixelRatio
      },
      adapter: this.sources.adapter(),
      diagnostics: this.sources.diagnostics(),
      ...(this.errorValue === undefined ? {} : { error: this.errorValue })
    };
  }
}

declare const __BUILD_COMMIT__: string;
declare const __BUILD_DIRTY__: boolean;
declare const __BUILD_CONTENT_HASH__: string;


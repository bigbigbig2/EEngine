import type { RenderingLabBenchmarkReport } from "./benchmark-report.js";
import type { CameraExperimentKind, CameraLodMode } from "./camera-experiments.js";
import type { RenderingLabCaseId } from "./quality-profile.js";

export interface RenderingLabFixtureSnapshot {
  readonly schemaVersion: 2;
  readonly status: "loading" | "ready" | "benchmark-running" | "benchmark-completed" | "failed";
  readonly frame: number;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly workload: Readonly<Record<string, unknown>>;
  readonly benchmark?: {
    readonly state: string;
    readonly caseId: RenderingLabCaseId | null;
    readonly caseIndex: number;
    readonly caseCount: number;
  };
  readonly error?: { readonly name: string; readonly message: string };
}

export interface RenderingLabFixture {
  getSnapshot(): RenderingLabFixtureSnapshot;
  getBenchmarkReport(): RenderingLabBenchmarkReport | null;
  runBenchmark(options?: {
    readonly cases?: readonly RenderingLabCaseId[];
    readonly smoke?: boolean;
    readonly cameraExperiment?: "none" | CameraExperimentKind | "path";
    readonly cameraLodMode?: CameraLodMode;
    /** Include/exclude the Inspector shell while measuring the same workload. */
    readonly inspectorVisible?: boolean;
    /** Counter cadence for this run; timestamps remain at record-mode cadence. */
    readonly gpuCounterSampleInterval?: number;
    /** Capacity of the asynchronous GPU counter readback ring. */
    readonly readbackRingSlots?: number;
    /** Serialize each frame behind queue completion for counter-coverage tests. */
    readonly awaitGpuEachFrame?: boolean;
  }): Promise<RenderingLabBenchmarkReport>;
  downloadBenchmarkReport(): void;
  captureScreenshot(): Promise<void>;
}

export const RENDERING_LAB_FIXTURE_KEY = "__OENGINE_RENDERING_LAB_FIXTURE__" as const;

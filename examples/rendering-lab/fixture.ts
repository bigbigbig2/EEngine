import type { RenderingLabBenchmarkReport } from "./benchmark-report.js";
import type { CameraExperimentKind, CameraLodMode } from "./camera-experiments.js";
import type { RenderingLabCaseId } from "./quality-profile.js";
import type { RenderingLabWorkloadId } from "./benchmark-workloads.js";
import type {
  SurfaceAbiRunEvidence,
  TileBackendVendorRunEvidence
} from "../../OEngine/src/debug/VisibilitySurfaceMigrationGates.js";
import type { TileBackendCostModelInput } from "../../OEngine/src/debug/TileBackendCostModel.js";

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
  /** Stop RAF/evidence, await submitted work, then release the device-root owners. */
  dispose?(): Promise<void>;
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
    /** Add per-FrameGraph-pass CPU encoding sections to a record profile. */
    readonly cpuPassTimings?: boolean;
    /** Serialize each frame behind queue completion for counter-coverage tests. */
    readonly awaitGpuEachFrame?: boolean;
    /** Keep the scene static to measure cacheable shadow/visibility work. */
    readonly animateScene?: boolean;
    /** Stable id shared by independent browser runs in one formal comparison. */
    readonly runGroupId?: string;
    /** Zero-based position within the independent run group. */
    readonly runOrdinal?: number;
    /** Deterministic scene/camera contract used by migration benchmarks. */
    readonly workloadId?: RenderingLabWorkloadId;
    /** Enable the evidence-gated TriangleSetup candidate cache for a benchmark run only. */
    readonly triangleSetupEnabled?: boolean;
    /** Screen-space coverage threshold for TriangleSetup candidate admission. */
    readonly triangleSetupThresholdPixels?: number;
    /** Optional identity-bearing M6 candidate artifact to persist with this run. */
    readonly surfaceAbiRuns?: readonly SurfaceAbiRunEvidence[];
    /** Optional identity-bearing M7 vendor artifact to persist with this run. */
    readonly tileBackendRuns?: readonly TileBackendVendorRunEvidence[];
    /** Optional evidence-only M7 tile model input; never creates a runtime backend. */
    readonly tileBackendModelInput?: TileBackendCostModelInput;
  }): Promise<RenderingLabBenchmarkReport>;
  downloadBenchmarkReport(): void;
  captureScreenshot(): Promise<void>;
}

export const RENDERING_LAB_FIXTURE_KEY = "__OENGINE_RENDERING_LAB_FIXTURE__" as const;

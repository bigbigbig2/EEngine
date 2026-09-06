import {
  BenchmarkRunController,
  type BenchmarkEnvironmentManifest,
  type BenchmarkResult,
  type BenchmarkRunProgress,
  type FrameProfiler
} from "../../OEngine/src/index.ts";
import { RENDERING_LAB_CASES, type RenderingLabCaseId } from "./quality-profile.js";

export type RenderingLabBenchmarkState = "idle" | "running" | "settling" | "completed" | "failed";

export interface RenderingLabBenchmarkSuiteHost {
  readonly profiler: FrameProfiler;
  environmentForCase(caseId: RenderingLabCaseId): BenchmarkEnvironmentManifest;
  caseManifestForCase(caseId: RenderingLabCaseId): ConstructorParameters<typeof BenchmarkRunController>[2];
  prepareCase(caseId: RenderingLabCaseId): void | Promise<void>;
  renderCaseFrame(ordinal: number): void | Promise<void>;
  settleCase(): void | Promise<void>;
}

export interface RenderingLabBenchmarkProgress extends BenchmarkRunProgress {
  readonly state: RenderingLabBenchmarkState;
  readonly caseId: RenderingLabCaseId | null;
  readonly caseIndex: number;
  readonly caseCount: number;
}

export interface RenderingLabBenchmarkSuiteResult {
  readonly cases: readonly BenchmarkResult[];
  readonly progress: RenderingLabBenchmarkProgress;
}

/** Serial case runner. Rendering ownership stays in the host; this module owns state and cadence. */
export class RenderingLabBenchmarkSuite {
  private stateValue: RenderingLabBenchmarkState = "idle";
  private currentCaseValue: RenderingLabCaseId | null = null;
  private caseIndexValue = -1;
  private progressValue: RenderingLabBenchmarkProgress;
  private readonly results: BenchmarkResult[] = [];

  constructor(
    private readonly host: RenderingLabBenchmarkSuiteHost,
    private readonly caseIds: readonly RenderingLabCaseId[] = RENDERING_LAB_CASES
  ) {
    if (caseIds.length === 0) throw new RangeError("benchmark suite requires at least one case");
    this.progressValue = {
      state: "idle", caseId: null, caseIndex: -1, caseCount: caseIds.length,
      scheduledFrames: 0, totalFrames: 0, measuredFrames: 0, pendingGpuFrames: 0
    };
  }

  get state(): RenderingLabBenchmarkState { return this.stateValue; }
  get progress(): RenderingLabBenchmarkProgress { return this.progressValue; }
  get completedCases(): readonly BenchmarkResult[] { return Object.freeze([...this.results]); }

  async run(onProgress?: (progress: RenderingLabBenchmarkProgress) => void): Promise<RenderingLabBenchmarkSuiteResult> {
    if (this.stateValue !== "idle") throw new Error(`benchmark suite cannot run from '${this.stateValue}'`);
    this.stateValue = "running";
    try {
      for (let index = 0; index < this.caseIds.length; index++) {
        const caseId = this.caseIds[index]!;
        this.caseIndexValue = index;
        this.currentCaseValue = caseId;
        await this.host.prepareCase(caseId);
        const controller = new BenchmarkRunController(
          this.host.profiler,
          this.host.environmentForCase(caseId),
          this.host.caseManifestForCase(caseId)
        );
        const result = await controller.run({
          scheduleFrame: () => Promise.resolve(),
          frame: (ordinal) => this.host.renderCaseFrame(ordinal),
          settle: () => this.host.settleCase(),
          onProgress: (progress) => {
            this.progressValue = Object.freeze({
              ...progress, state: this.stateValue, caseId,
              caseIndex: index, caseCount: this.caseIds.length
            });
            onProgress?.(this.progressValue);
          }
        });
        this.results.push(result);
      }
      this.stateValue = "completed";
      this.progressValue = Object.freeze({
        ...this.progressValue, state: this.stateValue,
        caseId: null, caseIndex: this.caseIds.length - 1
      });
      onProgress?.(this.progressValue);
      return Object.freeze({ cases: Object.freeze([...this.results]), progress: this.progressValue });
    } catch (error) {
      this.stateValue = "failed";
      this.progressValue = Object.freeze({ ...this.progressValue, state: this.stateValue });
      onProgress?.(this.progressValue);
      throw error;
    }
  }
}

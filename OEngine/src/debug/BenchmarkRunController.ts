import {
  BenchmarkHarness,
  type BenchmarkCaseManifest,
  type BenchmarkResult
} from "./BenchmarkHarness.js";
import type { BenchmarkEnvironmentManifest } from "./EnvironmentManifest.js";
import type {
  FrameProfileSnapshot,
  FrameProfiler
} from "./FrameProfiler.js";

export type BenchmarkRunState =
  | "idle"
  | "running"
  | "settling"
  | "completed"
  | "failed";

export interface BenchmarkRunProgress {
  scheduledFrames: number;
  totalFrames: number;
  measuredFrames: number;
  pendingGpuFrames: number;
}

export interface BenchmarkRunOptions {
  frame: (ordinal: number) => void | Promise<void>;
  scheduleFrame?: (ordinal: number) => void | Promise<void>;
  settle?: () => void | Promise<void>;
  gpuWaitTimeoutMs?: number;
  onProgress?: (progress: BenchmarkRunProgress) => void;
}

/**
 * Owns one reproducible warm-up/sample cadence around a FrameProfiler seam.
 * The frame callback remains responsible for driving Renderer.render() or an
 * explicitly documented smoke path that begins and ends profiler frames.
 */
export class BenchmarkRunController {
  private readonly harness: BenchmarkHarness;
  private stateValue: BenchmarkRunState = "idle";
  private scheduledFramesValue = 0;

  constructor(
    private readonly profiler: FrameProfiler,
    private readonly environment: BenchmarkEnvironmentManifest,
    caseManifest: BenchmarkCaseManifest
  ) {
    this.harness = new BenchmarkHarness(environment, caseManifest);
  }

  get state(): BenchmarkRunState {
    return this.stateValue;
  }

  get progress(): BenchmarkRunProgress {
    return {
      scheduledFrames: this.scheduledFramesValue,
      totalFrames: this.totalFrames,
      measuredFrames: this.harness.completeFrameCount,
      pendingGpuFrames: this.harness.pendingGpuFrameCount
    };
  }

  async run(options: BenchmarkRunOptions): Promise<BenchmarkResult> {
    if (this.stateValue !== "idle") {
      throw new Error(`BenchmarkRunController cannot run from '${this.stateValue}'`);
    }
    const gpuWaitTimeoutMs = positiveFinite(
      options.gpuWaitTimeoutMs ?? 5000,
      "gpuWaitTimeoutMs"
    );
    let finishPendingWait: (() => void) | null = null;
    const emitProgress = (): void => options.onProgress?.(this.progress);
    const onSnapshot = (snapshot: FrameProfileSnapshot): void => {
      this.harness.recordFrame(snapshot);
      emitProgress();
      if (this.harness.isComplete && this.harness.pendingGpuFrameCount === 0) {
        finishPendingWait?.();
      }
    };
    const unsubscribe = this.profiler.subscribe(onSnapshot);

    this.stateValue = "running";
    try {
      emitProgress();
      for (let ordinal = 0; ordinal < this.totalFrames; ordinal++) {
        if (options.scheduleFrame === undefined) {
          await scheduleAnimationFrame();
        } else {
          await options.scheduleFrame(ordinal);
        }
        await options.frame(ordinal);
        this.scheduledFramesValue++;
        emitProgress();
      }
      if (!this.harness.isComplete) {
        throw new Error(
          `Benchmark frame callback produced ${this.harness.completeFrameCount} measured frames; expected ${this.environment.run.sampleFrames}`
        );
      }

      this.stateValue = "settling";
      await options.settle?.();
      if (this.harness.pendingGpuFrameCount > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            finishPendingWait = null;
            reject(
              new Error(
                `Timed out waiting for ${this.harness.pendingGpuFrameCount} GPU timestamp frame(s)`
              )
            );
          }, gpuWaitTimeoutMs);
          finishPendingWait = () => {
            clearTimeout(timer);
            finishPendingWait = null;
            resolve();
          };
        });
      }

      const result = this.harness.complete();
      this.stateValue = "completed";
      emitProgress();
      return result;
    } catch (error) {
      this.stateValue = "failed";
      throw error;
    } finally {
      unsubscribe();
    }
  }

  private get totalFrames(): number {
    return (
      this.environment.run.warmupFrames +
      this.environment.run.sampleFrames
    );
  }
}

function scheduleAnimationFrame(): Promise<void> {
  if (typeof requestAnimationFrame !== "function") return Promise.resolve();
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number`);
  }
  return value;
}

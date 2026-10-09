import type { GraphicsContext } from "../gpu/GraphicsContext.js";
import { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";

export interface FrameEncoding {
  readonly frameIndex: number;
  readonly command: ShadeGPUCommandContext;
}

export interface FrameExecutionEvidence {
  readonly frameIndex: number;
  readonly submitLabel: string;
  readonly closed: true;
  readonly submitted: true;
}

type FrameCommandFactory = (graphics: GraphicsContext, label: string) => ShadeGPUCommandContext;

/**
 * Owns the only command context that may submit work for a render tick.
 * Subsystems receive the encode-only context and must never finish it.
 */
export class FrameCoordinator {
  private active: FrameEncoding | null = null;
  private destroyed = false;
  private readonly inFlight = new Set<FrameEncoding>();
  private submittedCount = 0;
  private completedCount = 0;
  private failedCompletionCount = 0;
  private readonly completionSamples: Array<{
    frameIndex: number;
    elapsedMs: number;
    profiled: boolean;
  }> = [];

  /** Browser-observed queue completion latency, not a GPU timestamp duration.
   * Bounded CPU samples reuse the existing fence; no readback or extra submit. */
  evidence() {
    return Object.freeze({
      submittedCount: this.submittedCount,
      completedCount: this.completedCount,
      failedCompletionCount: this.failedCompletionCount,
      inFlight: this.inFlight.size,
      inFlightLimit: 2,
      completionSamples: Object.freeze(this.completionSamples.slice()),
    });
  }

  /** Queue-completion backpressure bounds fence-retained transient resources.
   * This observes completion only; it never reads GPU work/visibility data. */
  get canBeginFrame(): boolean {
    return !this.destroyed && this.active === null && this.inFlight.size < 2;
  }

  constructor(
    private readonly graphics: GraphicsContext,
    private readonly createCommand: FrameCommandFactory = ShadeGPUCommandContext.create,
  ) {}

  beginFrame(frameIndex: number, submitLabel: string): FrameEncoding {
    if (this.destroyed) throw new Error("FrameCoordinator has been destroyed");
    if (this.active !== null) {
      throw new Error(`FrameCoordinator frame ${this.active.frameIndex} is still active`);
    }
    if (!this.canBeginFrame) throw new Error("FrameCoordinator is waiting for GPU completion");
    if (!Number.isInteger(frameIndex) || frameIndex < 0) {
      throw new RangeError("frameIndex must be a non-negative integer");
    }
    if (submitLabel.length === 0) {
      throw new Error("render-frame submit label must not be empty");
    }
    const frame: FrameEncoding = {
      frameIndex,
      command: this.createCommand(this.graphics, submitLabel),
    };
    this.active = frame;
    return frame;
  }

  submitFrame(frame: FrameEncoding): FrameExecutionEvidence {
    this.assertActive(frame);
    try {
      const profiled = this.graphics.profiler?.enabled ?? false;
      frame.command.finish();
      const startedAt = frame.command.submittedAtMs ?? performance.now();
      this.submittedCount++;
      this.inFlight.add(frame);
      const completed = () => {
        this.inFlight.delete(frame);
        if (this.destroyed) return;
        this.completedCount++;
        this.completionSamples.push(Object.freeze({
          frameIndex: frame.frameIndex,
          elapsedMs: performance.now() - startedAt,
          profiled,
        }));
        if (this.completionSamples.length > 600) this.completionSamples.shift();
      };
      void frame.command.gpuDone.then(completed, () => {
        this.inFlight.delete(frame);
        if (!this.destroyed) this.failedCompletionCount++;
      });
    } catch (cause) {
      if (!frame.command.closed) {
        try {
          frame.command.abort(cause);
        } catch (abortError) {
          console.error("Frame abort failed after submit error", abortError);
        }
      }
      throw cause;
    } finally {
      // ShadeGPUCommandContext may have already closed itself while finish
      // threw. The coordinator must never retain that dead active frame.
      this.active = null;
    }
    return {
      frameIndex: frame.frameIndex,
      submitLabel: frame.command.label,
      closed: true,
      submitted: true,
    };
  }

  abortFrame(frame: FrameEncoding, cause: unknown): void {
    this.assertActive(frame);
    this.active = null;
    frame.command.abort(cause);
  }

  destroy(): void {
    if (this.destroyed) return;
    if (this.active !== null) {
      const active = this.active;
      this.active = null;
      active.command.abort(new Error(`FrameCoordinator destroyed during frame ${active.frameIndex}`));
    }
    this.destroyed = true;
    this.inFlight.clear();
  }

  private assertActive(frame: FrameEncoding): void {
    if (this.destroyed) throw new Error("FrameCoordinator has been destroyed");
    if (this.active !== frame) {
      throw new Error("FrameEncoding is stale or is not owned by this coordinator");
    }
  }
}

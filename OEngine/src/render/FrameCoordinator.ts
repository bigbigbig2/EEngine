import type { GraphicsContext } from "../gpu/GraphicsContext.js";
import { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import { ChangeSignal } from "../core/Signal.js";

export interface FrameEncoding {
  readonly slotIndex: number;
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
export type FrameAdmissionProfile = "latency" | "throughput";
const FRAME_ADMISSION_LIMITS = Object.freeze({ latency: 2, throughput: 3 });

/**
 * Owns the only command context that may submit work for a render tick.
 * Subsystems receive the encode-only context and must never finish it.
 */
export class FrameCoordinator {
  /** Coalesced wakeup for a host whose render callback was admission-deferred.
   * Owners consume completion first; the host then reads its latest scene/input.
   * This notification never encodes or submits work itself. */
  readonly onFrameAvailable = new ChangeSignal();
  private admissionDeferred = false;
  private active: FrameEncoding | null = null;
  private destroyed = false;
  private readonly inFlight = new Set<FrameEncoding>();
  private readonly slots: (FrameEncoding | null)[] = [null, null, null];
  private profile: FrameAdmissionProfile = "latency";
  private submittedCount = 0;
  private completedCount = 0;
  private failedCompletionCount = 0;
  private peakInFlight = 0;
  private lastSubmittedAtMs: number | null = null;
  private readonly submissionSamples: Array<{
    frameIndex: number;
    submittedAtMs: number;
    intervalMs: number | null;
    encodeMs: number;
    submitMs: number;
    inFlight: number;
  }> = [];
  private encodeStartedAtMs = 0;

  /** Bounded desktop admission policy; changing it never releases resources. */
  get maxFramesInFlight(): number {
    return FRAME_ADMISSION_LIMITS[this.profile];
  }
  set maxFramesInFlight(value: number) {
    if (value !== 2 && value !== 3) {
      throw new RangeError("Frames in flight must be 2 or 3");
    }
    this.admissionProfile = value === 2 ? "latency" : "throughput";
  }
  private readonly completionSamples: Array<{
    frameIndex: number;
    elapsedMs: number;
    profiled: boolean;
    observedAtMs: number;
  }> = [];

  /** Browser-observed queue completion latency, not a GPU timestamp duration.
   * Bounded CPU samples reuse the existing fence; no readback or extra submit. */
  evidence() {
    return Object.freeze({
      submittedCount: this.submittedCount,
      completedCount: this.completedCount,
      failedCompletionCount: this.failedCompletionCount,
      inFlight: this.inFlight.size,
      inFlightLimit: FRAME_ADMISSION_LIMITS[this.profile],
      admissionProfile: this.profile,
      frameContextCapacity: this.slots.length,
      peakInFlight: this.peakInFlight,
      submissionSamples: Object.freeze(this.submissionSamples.slice()),
      completionSamples: Object.freeze(this.completionSamples.slice()),
    });
  }

  /** Queue-completion backpressure bounds fence-retained transient resources.
   * This observes completion only; it never reads GPU work/visibility data. */
  get canBeginFrame(): boolean {
    return (
      !this.destroyed && this.active === null && this.inFlight.size < FRAME_ADMISSION_LIMITS[this.profile]
    );
  }

  get admissionProfile(): FrameAdmissionProfile {
    return this.profile;
  }
  set admissionProfile(profile: FrameAdmissionProfile) {
    if (!Object.hasOwn(FRAME_ADMISSION_LIMITS, profile))
      throw new RangeError("Unknown frame admission profile");
    if (this.active !== null) throw new Error("Cannot change admission during frame encoding");
    this.profile = profile;
  }

  deferFrame(): void {
    if (!this.destroyed) {
      this.admissionDeferred = true;
    }
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
    this.encodeStartedAtMs = performance.now();
    this.admissionDeferred = false;
    const slotIndex = this.slots.findIndex((slot) => slot === null);
    if (slotIndex < 0) throw new Error("Bounded frame context capacity is exhausted");
    const frame: FrameEncoding = {
      slotIndex,
      frameIndex,
      command: this.createCommand(this.graphics, submitLabel),
    };
    this.slots[frame.slotIndex] = frame;
    this.active = frame;
    return frame;
  }

  submitFrame(frame: FrameEncoding): FrameExecutionEvidence {
    this.assertActive(frame);
    const profiled = this.graphics.profiler?.enabled ?? false;
    try {
      frame.command.finish();
      this.retainSubmittedFrame(frame, profiled);
    } catch (cause) {
      // Publication may throw after queue submission. Such a frame still owns
      // its admission slot until the captured GPU fence settles.
      if (frame.command.wasSubmitted) this.retainSubmittedFrame(frame, profiled);
      else {
        this.slots[frame.slotIndex] = null;
        if (!frame.command.closed) {
          try {
            frame.command.abort(cause);
          } catch (abortError) {
            console.error("Frame abort failed after submit error", abortError);
          }
        }
      }
      throw cause;
    } finally {
      this.active = null;
    }
    return {
      frameIndex: frame.frameIndex,
      submitLabel: frame.command.label,
      closed: true,
      submitted: true,
    };
  }

  private retainSubmittedFrame(frame: FrameEncoding, profiled: boolean): void {
    if (this.inFlight.has(frame)) return;
    const startedAt = frame.command.submittedAtMs ?? performance.now();
    this.submittedCount++;
    this.inFlight.add(frame);
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight.size);
    this.submissionSamples.push(
      Object.freeze({
        frameIndex: frame.frameIndex,
        submittedAtMs: startedAt,
        intervalMs: this.lastSubmittedAtMs === null ? null : startedAt - this.lastSubmittedAtMs,
        encodeMs: startedAt - this.encodeStartedAtMs,
        submitMs: frame.command.submitCpuMs ?? 0,
        inFlight: this.inFlight.size,
      }),
    );
    this.lastSubmittedAtMs = startedAt;
    if (this.submissionSamples.length > 600) {
      this.submissionSamples.shift();
    }
    const completed = () => {
      this.inFlight.delete(frame);
      if (this.slots[frame.slotIndex] === frame) this.slots[frame.slotIndex] = null;
      if (this.destroyed) return;
      this.completedCount++;
      const observedAtMs = performance.now();
      this.completionSamples.push(
        Object.freeze({
          frameIndex: frame.frameIndex,
          elapsedMs: observedAtMs - startedAt,
          profiled,
          observedAtMs,
        }),
      );
      if (this.completionSamples.length > 600) this.completionSamples.shift();
      if (this.admissionDeferred) {
        // Let all same-fence retirement observers run before waking the host.
        // An intervening RAF or teardown cancels this coalesced notification.
        queueMicrotask(() => {
          if (this.admissionDeferred && this.canBeginFrame) {
            this.admissionDeferred = false;
            this.onFrameAvailable.send0();
          }
        });
      }
    };
    void frame.command.gpuDone.then(completed, () => {
      this.inFlight.delete(frame);
      if (this.slots[frame.slotIndex] === frame) this.slots[frame.slotIndex] = null;
      if (!this.destroyed) this.failedCompletionCount++;
    });
  }

  abortFrame(frame: FrameEncoding, cause: unknown): void {
    this.assertActive(frame);
    this.active = null;
    this.slots[frame.slotIndex] = null;
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
    this.admissionDeferred = false;
    this.onFrameAvailable.removeAll();
    this.inFlight.clear();
    this.slots.fill(null);
  }

  private assertActive(frame: FrameEncoding): void {
    if (this.destroyed) throw new Error("FrameCoordinator has been destroyed");
    if (this.active !== frame) {
      throw new Error("FrameEncoding is stale or is not owned by this coordinator");
    }
  }
}

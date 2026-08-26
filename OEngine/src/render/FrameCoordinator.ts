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

type FrameCommandFactory = (
  graphics: GraphicsContext,
  label: string
) => ShadeGPUCommandContext;

/**
 * Owns the only command context that may submit work for a render tick.
 * Subsystems receive the encode-only context and must never finish it.
 */
export class FrameCoordinator {
  private active: FrameEncoding | null = null;
  private destroyed = false;

  constructor(
    private readonly graphics: GraphicsContext,
    private readonly createCommand: FrameCommandFactory =
      ShadeGPUCommandContext.create
  ) {}

  beginFrame(frameIndex: number, submitLabel: string): FrameEncoding {
    if (this.destroyed) throw new Error("FrameCoordinator has been destroyed");
    if (this.active !== null) {
      throw new Error(
        `FrameCoordinator frame ${this.active.frameIndex} is still active`
      );
    }
    if (!Number.isInteger(frameIndex) || frameIndex < 0) {
      throw new RangeError("frameIndex must be a non-negative integer");
    }
    if (submitLabel.length === 0) {
      throw new Error("render-frame submit label must not be empty");
    }
    const frame: FrameEncoding = {
      frameIndex,
      command: this.createCommand(this.graphics, submitLabel)
    };
    this.active = frame;
    return frame;
  }

  submitFrame(frame: FrameEncoding): FrameExecutionEvidence {
    this.assertActive(frame);
    frame.command.finish();
    this.active = null;
    return {
      frameIndex: frame.frameIndex,
      submitLabel: frame.command.label,
      closed: true,
      submitted: true
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
      active.command.abort(
        new Error(`FrameCoordinator destroyed during frame ${active.frameIndex}`)
      );
    }
    this.destroyed = true;
  }

  private assertActive(frame: FrameEncoding): void {
    if (this.destroyed) throw new Error("FrameCoordinator has been destroyed");
    if (this.active !== frame) {
      throw new Error("FrameEncoding is stale or is not owned by this coordinator");
    }
  }
}

/** HZB ping-pong texture 之外的纯状态 owner，便于无 GPU 单测覆盖失效契约。 */

export type HzbHistoryRevision = {
  readonly width: number;
  readonly height: number;
  readonly camera: number;
  readonly renderScale: number;
  readonly feature: number;
  readonly format: number;
};

export type HzbHistoryInvalidationReason =
  | "initial"
  | "resize"
  | "camera-cut"
  | "render-scale"
  | "feature-toggle"
  | "format-change"
  | "view-switch"
  | "explicit";

export class HzbHistoryState {
  valid = false;
  lastWrittenFrame = -1;
  committedTextureIndex: 0 | 1 = 0;
  writeTextureIndex: 0 | 1 = 1;
  activeFrame = -1;
  builtThisFrame = false;
  invalidationCount = 0;
  lastInvalidationReason: HzbHistoryInvalidationReason = "initial";

  private revision: HzbHistoryRevision | null = null;

  beginFrame(frameIndex: number, revision: HzbHistoryRevision): void {
    if (!Number.isInteger(frameIndex) || frameIndex < 0) {
      throw new RangeError(`HZB frame index must be non-negative, got ${frameIndex}`);
    }
    const previous = this.revision;
    if (previous !== null) {
      if (previous.width !== revision.width || previous.height !== revision.height) {
        this.invalidate("resize");
      } else if (previous.camera !== revision.camera) {
        this.invalidate("camera-cut");
      } else if (previous.renderScale !== revision.renderScale) {
        this.invalidate("render-scale");
      } else if (previous.feature !== revision.feature) {
        this.invalidate("feature-toggle");
      } else if (previous.format !== revision.format) {
        this.invalidate("format-change");
      }
    }
    if (this.valid && this.lastWrittenFrame !== frameIndex - 1) {
      this.invalidate("view-switch");
    }
    this.revision = { ...revision };
    this.activeFrame = frameIndex;
    this.builtThisFrame = false;
    this.writeTextureIndex = (1 - this.committedTextureIndex) as 0 | 1;
  }

  markBuilt(): void {
    if (this.activeFrame < 0) {
      throw new Error("HZB build must occur inside beginFrame/commit");
    }
    this.builtThisFrame = true;
  }

  commit(frameIndex: number): boolean {
    if (frameIndex !== this.activeFrame) {
      throw new Error(
        `HZB commit frame ${frameIndex} does not match active frame ${this.activeFrame}`
      );
    }
    if (!this.builtThisFrame) {
      this.activeFrame = -1;
      return false;
    }
    this.committedTextureIndex = this.writeTextureIndex;
    this.lastWrittenFrame = frameIndex;
    this.valid = true;
    this.activeFrame = -1;
    return true;
  }

  invalidate(reason: HzbHistoryInvalidationReason = "explicit"): void {
    this.valid = false;
    this.lastInvalidationReason = reason;
    this.invalidationCount++;
  }
}

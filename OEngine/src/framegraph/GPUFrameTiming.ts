import { GPUTimer, type GPUTimerResult, type GPUTimerTimestampWrites } from "./GPUTimer.js";
import type { ResourceAccounting, ResourceHandle } from "../debug/profiling/ResourceAccounting.js";

export type GPUFrameTimingMode = "production" | "coarse" | "stage" | "full";
export interface GPUFrameTimingEvidence {
  readonly mode: GPUFrameTimingMode;
  readonly queries: number;
  readonly markerPasses: number;
  readonly resolveCommands: number;
  readonly copyCommands: number;
  readonly readbackBytes: number;
  readonly truncated: boolean;
}

/** Persistent device-owned slots. Pending MAP_READ slots are never reused.
 * Saturation drops a diagnostic sample; rendering and submission never wait. */
export class GPUFrameTimingRing {
  private readonly slots: Array<{ timer: GPUTimer; busy: boolean; handle?: ResourceHandle }> = [];
  private destroyed = false;
  private dropped = 0;
  constructor(
    private readonly device: GPUDevice,
    private readonly capacity = 3,
    private readonly maxIntervals = 8192,
    private readonly accounting?: ResourceAccounting,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("Invalid timer ring capacity");
    }
    if (!Number.isSafeInteger(maxIntervals) || maxIntervals < 2) {
      throw new RangeError("Invalid query budget");
    }
  }
  acquire(mode: GPUFrameTimingMode): GPUFrameTimingSession | null {
    if (this.destroyed || mode === "production" || !this.device.features.has("timestamp-query")) {
      return null;
    }
    let slot = this.slots.find((entry) => !entry.busy);
    if (slot === undefined && this.slots.length < this.capacity) {
      slot = { timer: new GPUTimer(this.device, Math.min(1024, this.maxIntervals)), busy: false };
      this.slots.push(slot);
      const allocated = slot;
      slot.timer.onAllocationChanged = () => this.updateAccounting(allocated);
      this.updateAccounting(slot);
    }
    if (slot === undefined) {
      this.dropped++;
      return null;
    }
    slot.busy = true;
    slot.timer.reset();
    const selected = slot;
    return new GPUFrameTimingSession(selected.timer, mode, this.maxIntervals, () => {
      selected.busy = false;
      this.updateAccounting(selected);
      if (this.destroyed) {
        this.destroySlot(selected);
      }
    });
  }
  evidence(): Readonly<{
    slots: number;
    pending: number;
    dropped: number;
    bufferBytes: number;
    resolveBytes: number;
    readbackBytes: number;
    queryCapacity: number;
    queryStorageBytes: null;
  }> {
    return {
      slots: this.slots.length,
      pending: this.slots.filter((slot) => slot.busy).length,
      dropped: this.dropped,
      bufferBytes: this.slots.reduce((sum, slot) => sum + slot.timer.allocatedBytes, 0),
      resolveBytes: this.slots.reduce((sum, slot) => sum + slot.timer.allocatedBytes / 2, 0),
      readbackBytes: this.slots.reduce((sum, slot) => sum + slot.timer.allocatedBytes / 2, 0),
      queryStorageBytes: null,
      queryCapacity: this.slots.reduce((sum, slot) => sum + slot.timer.queryCapacity, 0),
    };
  }
  destroy(): void {
    this.destroyed = true;
    for (const slot of this.slots) {
      if (slot.busy && slot.handle) {
        this.accounting?.setRetired(slot.handle, true);
      }
    }
    for (let index = this.slots.length - 1; index >= 0; index--) {
      const slot = this.slots[index]!;
      if (!slot.busy) {
        this.destroySlot(slot);
      }
    }
  }
  private updateAccounting(slot: { timer: GPUTimer; handle?: ResourceHandle }): void {
    if (!this.accounting || slot.handle?.bytes === slot.timer.allocatedBytes) {
      return;
    }
    if (slot.handle) {
      this.accounting.destroyed(slot.handle);
    }
    slot.handle = this.accounting.created({
      kind: "buffer",
      category: "profiler",
      owner: "GPUFrameTimingRing",
      bytes: slot.timer.allocatedBytes,
    });
  }
  private destroySlot(slot: { timer: GPUTimer; handle?: ResourceHandle }): void {
    slot.timer.destroy();
    if (slot.handle) {
      this.accounting!.destroyed(slot.handle);
      slot.handle = undefined;
    }
    const index = this.slots.indexOf(slot as (typeof this.slots)[number]);
    if (index >= 0) {
      this.slots.splice(index, 1);
    }
  }
}

/** Uses baseline pass-boundary timestamps only. Coarse/stage marker tax is explicit.
 * Stage scopes are opened by the graph executor, outside native passes. */
export class GPUFrameTimingSession {
  private span: GPUTimerTimestampWrites | null = null;
  private stage: GPUTimerTimestampWrites | null = null;
  private stageLabel: string | null = null;
  private readonly scopes: Array<"pass" | "stage" | "span"> = [];
  private markerPasses = 0;
  private stageCount = 0;
  private truncated = false;
  private sealed = false;
  private released = false;
  constructor(
    private readonly timer: GPUTimer,
    readonly mode: GPUFrameTimingMode,
    private readonly maxIntervals: number,
    private readonly release: () => void,
  ) {}
  begin(encoder: GPUCommandEncoder): void {
    this.span = this.allocate("frame-span", "compute", "span");
    if (this.span) {
      this.marker(encoder, this.span, false);
    }
  }
  enterStage(encoder: GPUCommandEncoder, label: string): void {
    if ((this.mode !== "stage" && this.mode !== "full") || label === this.stageLabel || this.sealed) {
      return;
    }
    if (this.stage) {
      this.marker(encoder, this.stage, true);
    }
    this.stageLabel = label;
    // Finite semantic regions, independent of material/batch count. Extra regions
    // remain inside frame-span, explicitly incomplete rather than fake zeroes.
    this.stage = ++this.stageCount <= 32 ? this.allocate(label, "compute", "stage") : null;
    if (this.stage) {
      this.marker(encoder, this.stage, false);
    } else {
      this.truncated = true;
    }
  }
  writes(label: string | undefined, type: "compute" | "render"): GPUTimerTimestampWrites | undefined {
    if (this.mode !== "full" || this.sealed) {
      return undefined;
    }
    return this.allocate(label, type, "pass") ?? undefined;
  }
  resolve(encoder: GPUCommandEncoder): void {
    if (this.sealed) {
      throw new Error("Timer session already resolved");
    }
    if (this.stage) {
      this.marker(encoder, this.stage, true);
    }
    if (this.span) {
      this.marker(encoder, this.span, true);
    }
    this.sealed = true;
    this.timer.resolve(encoder);
  }
  evidence(): GPUFrameTimingEvidence {
    const bytes = this.timer.readbackByteLength;
    const pages = Math.ceil(this.scopes.length / Math.min(1024, this.maxIntervals));
    return {
      mode: this.mode,
      queries: this.scopes.length * 2,
      markerPasses: this.markerPasses,
      resolveCommands: this.sealed ? pages : 0,
      copyCommands: this.sealed ? pages : 0,
      readbackBytes: bytes,
      truncated: this.truncated,
    };
  }
  async download(): Promise<GPUTimerResult[]> {
    if (!this.sealed || this.released) {
      throw new Error("Timer session is not readable");
    }
    try {
      await this.timer.download_results();
      return this.timer
        .results_to_console_table()
        .map((result, index) => ({ ...result, scope: this.scopes[index]! }));
    } finally {
      this.releaseOnce();
    }
  }
  /** Encoder finish/submit failure may occur after resolve was encoded. */
  abort(): void {
    this.releaseOnce();
  }
  private releaseOnce(): void {
    if (!this.released) {
      this.released = true;
      this.release();
    }
  }
  private allocate(
    label: string | undefined,
    type: "compute" | "render",
    scope: "pass" | "stage" | "span",
  ): GPUTimerTimestampWrites | null {
    if (this.scopes.length >= this.maxIntervals) {
      this.truncated = true;
      return null;
    }
    this.scopes.push(scope);
    return type === "compute" ? this.timer.getComputeWrites(label) : this.timer.getRenderWrites(label);
  }
  private marker(encoder: GPUCommandEncoder, writes: GPUTimerTimestampWrites, end: boolean): void {
    encoder
      .beginComputePass({
        label: "Profiler/timestamp marker",
        timestampWrites: {
          querySet: writes.querySet,
          beginningOfPassWriteIndex: end ? writes.endOfPassWriteIndex : writes.beginningOfPassWriteIndex,
        },
      })
      .end();
    this.markerPasses++;
  }
}

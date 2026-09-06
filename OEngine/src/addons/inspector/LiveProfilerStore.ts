import type { FrameProfiler, FrameProfilerMode } from "../../debug/FrameProfiler.js";
import type { ProfileFrame } from "../../debug/profiling/ProfileFrame.js";

export type LiveProfilerMode = "monitor" | "record" | "high-detail";

export interface LiveProfilerStoreState {
  readonly mode: LiveProfilerMode;
  readonly paused: boolean;
  readonly followLatest: boolean;
  readonly selectedFrameIndex: number | null;
  readonly range: readonly [number, number] | null;
  readonly frames: readonly ProfileFrame[];
}

export type LiveProfilerStoreListener = (state: LiveProfilerStoreState) => void;

/**
 * Owns the real-time Inspector state seam. History is bounded by FrameProfiler;
 * this module owns selection, recording intent and view freezing, so panels do
 * not need to understand profiler lifecycle or asynchronous frame replacement.
 */
export class LiveProfilerStore {
  private readonly profiler: FrameProfiler;
  private readonly listeners = new Set<LiveProfilerStoreListener>();
  private readonly unsubscribeHistory: () => void;
  private modeValue: LiveProfilerMode;
  private pausedValue = false;
  private followLatestValue = true;
  private selectedFrameIndexValue: number | null = null;
  private rangeValue: readonly [number, number] | null = null;
  private disposed = false;

  constructor(profiler: FrameProfiler) {
    this.profiler = profiler;
    this.modeValue = fromProfilerMode(profiler.mode);
    this.unsubscribeHistory = profiler.historyStore?.subscribe(() => {
      if (!this.pausedValue) this.notify();
    }) ?? (() => {});
  }

  get state(): LiveProfilerStoreState {
    return Object.freeze({
      mode: this.modeValue,
      paused: this.pausedValue,
      followLatest: this.followLatestValue,
      selectedFrameIndex: this.selectedFrameIndexValue,
      range: this.rangeValue,
      frames: this.frames
    });
  }

  get frames(): readonly ProfileFrame[] { return this.profiler.historyStore?.values() ?? []; }

  get selectedFrame(): ProfileFrame | undefined {
    if (this.selectedFrameIndexValue === null) return undefined;
    return this.frames.find((frame) => frame.frameIndex === this.selectedFrameIndexValue);
  }

  get latestFrame(): ProfileFrame | undefined { return this.frames.at(-1); }

  setMode(mode: LiveProfilerMode): void {
    this.assertAlive();
    if (this.modeValue === mode) return;
    this.profiler.setMode(toProfilerMode(mode));
    this.modeValue = mode;
    this.notify();
  }

  pause(): void { this.setPaused(true); }
  resume(): void { this.setPaused(false); }

  setFollowLatest(follow: boolean): void {
    this.assertAlive();
    this.followLatestValue = follow;
    if (follow) {
      this.selectedFrameIndexValue = null;
      this.rangeValue = null;
    }
    this.notify();
  }

  selectFrame(frameIndex: number): void {
    this.assertAlive();
    validateFrameIndex(frameIndex);
    if (!this.frames.some((frame) => frame.frameIndex === frameIndex)) {
      throw new RangeError(`Unknown frame '${frameIndex}'`);
    }
    this.selectedFrameIndexValue = frameIndex;
    this.followLatestValue = false;
    this.notify();
  }

  selectRange(startFrameIndex: number, endFrameIndex: number): readonly ProfileFrame[] {
    this.assertAlive();
    validateFrameIndex(startFrameIndex);
    validateFrameIndex(endFrameIndex);
    if (startFrameIndex > endFrameIndex) throw new RangeError("Invalid frame range");
    this.followLatestValue = false;
    this.rangeValue = Object.freeze([startFrameIndex, endFrameIndex]);
    this.notify();
    return Object.freeze(this.frames.filter((frame) =>
      frame.frameIndex >= startFrameIndex && frame.frameIndex <= endFrameIndex
    ));
  }

  clearSelection(): void {
    this.assertAlive();
    this.selectedFrameIndexValue = null;
    this.rangeValue = null;
    this.followLatestValue = true;
    this.notify();
  }

  clear(): void {
    this.assertAlive();
    this.profiler.clear();
    this.clearSelection();
  }

  subscribe(listener: LiveProfilerStoreListener): () => void {
    this.assertAlive();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeHistory();
    this.listeners.clear();
  }

  private setPaused(paused: boolean): void {
    this.assertAlive();
    if (this.pausedValue === paused) return;
    this.pausedValue = paused;
    this.notify();
  }

  private notify(): void {
    if (this.disposed) return;
    const state = this.state;
    for (const listener of this.listeners) listener(state);
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error("LiveProfilerStore has been disposed");
  }
}

function validateFrameIndex(frameIndex: number): void {
  if (!Number.isInteger(frameIndex) || frameIndex < 0) {
    throw new RangeError("frameIndex must be a non-negative integer");
  }
}

function toProfilerMode(mode: LiveProfilerMode): FrameProfilerMode {
  return mode === "monitor" ? "live" : mode === "record" ? "record" : "deep-capture";
}

function fromProfilerMode(mode: FrameProfilerMode): LiveProfilerMode {
  return mode === "live" ? "monitor" : mode === "record" ? "record" : "high-detail";
}

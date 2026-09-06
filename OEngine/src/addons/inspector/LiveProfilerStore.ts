import type { FrameProfiler, FrameProfilerMode } from "../../debug/FrameProfiler.js";
import type { ProfileFrame } from "../../debug/profiling/ProfileFrame.js";

export type LiveProfilerMode = "monitor" | "record" | "high-detail";

export interface LiveProfilerStoreState {
  readonly mode: LiveProfilerMode;
  readonly recording: boolean;
  readonly paused: boolean;
  readonly followLatest: boolean;
  readonly selectedFrameIndex: number | null;
  readonly range: readonly [number, number] | null;
  readonly frames: readonly ProfileFrame[];
  readonly timelineFrames: readonly ProfileFrame[];
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
  private recordingValue: boolean;
  private pausedValue = false;
  private followLatestValue = true;
  private selectedFrameIndexValue: number | null = null;
  private rangeValue: readonly [number, number] | null = null;
  private readonly timelineFrameMap = new Map<string, ProfileFrame>();
  private disposed = false;

  constructor(profiler: FrameProfiler) {
    this.profiler = profiler;
    this.modeValue = fromProfilerMode(profiler.mode);
    this.recordingValue = this.modeValue === "record";
    if (this.recordingValue) this.seedTimelineFromLatest();
    this.unsubscribeHistory = profiler.historyStore?.subscribe((frame) => {
      this.syncTimeline(frame);
      if (!this.pausedValue) this.notify();
    }) ?? (() => {});
  }

  get state(): LiveProfilerStoreState {
    return Object.freeze({
      mode: this.modeValue,
      recording: this.recordingValue,
      paused: this.pausedValue,
      followLatest: this.followLatestValue,
      selectedFrameIndex: this.selectedFrameIndexValue,
      range: this.rangeValue,
      frames: this.frames,
      timelineFrames: this.timelineFrames
    });
  }

  get frames(): readonly ProfileFrame[] { return this.profiler.historyStore?.values() ?? []; }

  get recording(): boolean { return this.recordingValue; }

  get timelineFrames(): readonly ProfileFrame[] {
    return Object.freeze([...this.timelineFrameMap.values()]);
  }

  get selectedFrame(): ProfileFrame | undefined {
    if (this.selectedFrameIndexValue === null) return undefined;
    return this.frames.find((frame) => frame.frameIndex === this.selectedFrameIndexValue)
      ?? this.timelineFrames.find((frame) => frame.frameIndex === this.selectedFrameIndexValue);
  }

  get latestFrame(): ProfileFrame | undefined { return this.frames.at(-1); }

  setMode(mode: LiveProfilerMode): void {
    this.assertAlive();
    if (this.modeValue === mode) return;
    this.profiler.setMode(toProfilerMode(mode));
    this.modeValue = mode;
    this.recordingValue = mode === "record";
    if (this.recordingValue) this.seedTimelineFromLatest();
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
    if (!this.frames.some((frame) => frame.frameIndex === frameIndex) &&
        !this.timelineFrames.some((frame) => frame.frameIndex === frameIndex)) {
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
    const source = new Map<string, ProfileFrame>();
    for (const frame of [...this.frames, ...this.timelineFrames]) source.set(frameKey(frame), frame);
    return Object.freeze([...source.values()].filter((frame) =>
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
    this.timelineFrameMap.clear();
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
    this.timelineFrameMap.clear();
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

  private syncTimeline(frame: ProfileFrame): void {
    const key = frameKey(frame);
    if (this.recordingValue) this.timelineFrameMap.set(key, frame);
    else if (this.timelineFrameMap.has(key)) this.timelineFrameMap.set(key, frame);
    while (this.timelineFrameMap.size > this.timelineCapacity) {
      const oldest = this.timelineFrameMap.keys().next().value;
      if (oldest === undefined) break;
      this.timelineFrameMap.delete(oldest);
    }
  }

  private seedTimelineFromLatest(): void {
    const latest = this.latestFrame;
    if (latest !== undefined) this.timelineFrameMap.set(frameKey(latest), latest);
  }

  private get timelineCapacity(): number {
    return this.profiler.historyStore?.capacity ?? Math.max(1, this.frames.length);
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

function frameKey(frame: ProfileFrame): string {
  return `${frame.epoch}:${frame.frameIndex}`;
}

function toProfilerMode(mode: LiveProfilerMode): FrameProfilerMode {
  return mode === "monitor" ? "live" : mode === "record" ? "record" : "deep-capture";
}

function fromProfilerMode(mode: FrameProfilerMode): LiveProfilerMode {
  return mode === "live" ? "monitor" : mode === "record" ? "record" : "high-detail";
}

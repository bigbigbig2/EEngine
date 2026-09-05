import type { FrameProfiler, FrameProfileSnapshot } from "../../debug/FrameProfiler.js";
import type { ProfileFrame } from "../../debug/profiling/ProfileFrame.js";
import type { PerformanceCapture } from "../../debug/profiling/PerformanceCapture.js";

export type InspectorMode = "live" | "record" | "deep-capture";

export interface InspectorViewState {
  readonly mode: InspectorMode;
  readonly source: "live" | "capture";
  readonly paused: boolean;
  readonly selectedFrameIndex: number | null;
  readonly range: readonly [number, number] | null;
  readonly latest: ProfileFrame | undefined;
  readonly selected: ProfileFrame | undefined;
  readonly frames: readonly ProfileFrame[];
}

export type InspectorViewModelListener = (state: InspectorViewState) => void;

/**
 * Pure state seam for Inspector UI. It consumes immutable profiler frames and
 * never reaches into Renderer, GPU buffers or Pass implementations.
 */
export class InspectorViewModel {
  private readonly profiler: FrameProfiler;
  private readonly listeners = new Set<InspectorViewModelListener>();
  private readonly unsubscribeProfiler: () => void;
  private modeValue: InspectorMode;
  private pausedValue = false;
  private selectedFrameIndexValue: number | null = null;
  private rangeValue: readonly [number, number] | null = null;
  private captureValue: PerformanceCapture | null = null;
  private disposed = false;

  constructor(profiler: FrameProfiler) {
    this.profiler = profiler;
    this.modeValue = profiler.mode;
    const history = profiler.historyStore;
    this.unsubscribeProfiler = history?.subscribe(() => this.notify()) ?? (() => {});
  }

  get mode(): InspectorMode {
    return this.modeValue;
  }

  get paused(): boolean {
    return this.pausedValue;
  }

  get selectedFrame(): FrameProfileSnapshot | ProfileFrame | undefined {
    if (this.selectedFrameIndexValue === null) return undefined;
    if (this.captureValue === null) return this.profiler.getFrame(this.selectedFrameIndexValue);
    return this.frames.find((frame) => frame.frameIndex === this.selectedFrameIndexValue);
  }

  get latestFrame(): FrameProfileSnapshot | ProfileFrame | undefined {
    if (this.captureValue !== null) return this.frames.at(-1);
    return this.profiler.latest;
  }

  get frames(): readonly ProfileFrame[] {
    return this.captureValue?.frames ?? this.profiler.historyStore?.values() ?? [];
  }

  get loadedCapture(): PerformanceCapture | null {
    return this.captureValue;
  }

  get range(): readonly [number, number] | null {
    return this.rangeValue;
  }

  setMode(mode: InspectorMode): void {
    this.assertAlive();
    if (this.modeValue === mode) return;
    this.profiler.setMode(mode);
    this.modeValue = mode;
    this.notify();
  }

  pause(): void {
    this.assertAlive();
    if (this.pausedValue) return;
    this.pausedValue = true;
    this.notify();
  }

  resume(): void {
    this.assertAlive();
    if (!this.pausedValue) return;
    this.pausedValue = false;
    this.notify();
  }

  selectFrame(frameIndex: number): void {
    this.assertAlive();
    if (!Number.isInteger(frameIndex) || frameIndex < 0) {
      throw new RangeError("frameIndex must be a non-negative integer");
    }
    if (!this.frames.some((frame) => frame.frameIndex === frameIndex)) {
      throw new RangeError(`Unknown frame '${frameIndex}'`);
    }
    this.selectedFrameIndexValue = frameIndex;
    this.notify();
  }

  selectRange(startFrameIndex: number, endFrameIndex: number): readonly ProfileFrame[] {
    this.assertAlive();
    if (!Number.isInteger(startFrameIndex) || !Number.isInteger(endFrameIndex)) {
      throw new RangeError("Frame range must use integer indexes");
    }
    if (startFrameIndex > endFrameIndex) throw new RangeError("Invalid frame range");
    const frames = this.frames.filter((frame) =>
      frame.frameIndex >= startFrameIndex && frame.frameIndex <= endFrameIndex
    );
    this.rangeValue = Object.freeze([startFrameIndex, endFrameIndex]);
    this.notify();
    return Object.freeze([...frames]);
  }

  clearSelection(): void {
    this.assertAlive();
    this.selectedFrameIndexValue = null;
    this.rangeValue = null;
    this.notify();
  }

  clear(): void {
    this.assertAlive();
    this.profiler.clear();
    this.captureValue = null;
    this.clearSelection();
  }

  /** Replaces the visible frame source with an immutable imported capture. */
  loadCapture(capture: PerformanceCapture): void {
    this.assertAlive();
    this.captureValue = capture;
    this.modeValue = capture.sampling.mode;
    this.selectedFrameIndexValue = null;
    this.rangeValue = null;
    this.notify();
  }

  clearLoadedCapture(): void {
    this.assertAlive();
    if (this.captureValue === null) return;
    this.captureValue = null;
    this.selectedFrameIndexValue = null;
    this.rangeValue = null;
    this.notify();
  }

  snapshot(): InspectorViewState {
    return Object.freeze({
      mode: this.modeValue,
      source: this.captureValue === null ? "live" : "capture",
      paused: this.pausedValue,
      selectedFrameIndex: this.selectedFrameIndexValue,
      range: this.rangeValue,
      latest: this.frames.at(-1),
      selected: this.selectedFrameIndexValue === null
        ? undefined
        : this.frames.find((frame) => frame.frameIndex === this.selectedFrameIndexValue),
      frames: this.frames
    });
  }

  subscribe(listener: InspectorViewModelListener): () => void {
    this.assertAlive();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeProfiler();
    this.listeners.clear();
  }

  private notify(): void {
    if (this.disposed) return;
    const state = this.snapshot();
    for (const listener of this.listeners) listener(state);
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error("InspectorViewModel has been disposed");
  }
}

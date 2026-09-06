import type { FrameProfiler } from "../../debug/FrameProfiler.js";
import type { ProfileFrame } from "../../debug/profiling/ProfileFrame.js";
import {
  LiveProfilerStore,
  type LiveProfilerMode,
  type LiveProfilerStoreState
} from "./LiveProfilerStore.js";

export type InspectorMode = LiveProfilerMode;

export interface InspectorViewState {
  readonly mode: InspectorMode;
  readonly source: "live";
  readonly paused: boolean;
  readonly followLatest: boolean;
  readonly selectedFrameIndex: number | null;
  readonly range: readonly [number, number] | null;
  readonly latest: ProfileFrame | undefined;
  readonly selected: ProfileFrame | undefined;
  readonly frames: readonly ProfileFrame[];
}

export type InspectorViewModelListener = (state: InspectorViewState) => void;

/** Presentation adapter over the deep LiveProfilerStore seam. */
export class InspectorViewModel {
  readonly store: LiveProfilerStore;
  private readonly listeners = new Set<InspectorViewModelListener>();
  private readonly unsubscribeStore: () => void;
  private disposed = false;

  constructor(profiler: FrameProfiler) {
    this.store = new LiveProfilerStore(profiler);
    this.unsubscribeStore = this.store.subscribe(() => this.notify());
  }

  get mode(): InspectorMode { return this.store.state.mode; }
  get paused(): boolean { return this.store.state.paused; }
  get followLatest(): boolean { return this.store.state.followLatest; }
  get selectedFrame(): ProfileFrame | undefined { return this.store.selectedFrame; }
  get latestFrame(): ProfileFrame | undefined { return this.store.latestFrame; }
  get frames(): readonly ProfileFrame[] { return this.store.frames; }

  setMode(mode: InspectorMode): void { this.store.setMode(mode); }
  pause(): void { this.store.pause(); }
  resume(): void { this.store.resume(); }
  setFollowLatest(follow: boolean): void { this.store.setFollowLatest(follow); }
  selectFrame(frameIndex: number): void { this.store.selectFrame(frameIndex); }
  selectRange(startFrameIndex: number, endFrameIndex: number): readonly ProfileFrame[] {
    return this.store.selectRange(startFrameIndex, endFrameIndex);
  }
  clearSelection(): void { this.store.clearSelection(); }
  clear(): void { this.store.clear(); }

  snapshot(): InspectorViewState {
    const state = this.store.state;
    return Object.freeze({ ...state, source: "live" as const, latest: this.latestFrame, selected: this.selectedFrame });
  }

  subscribe(listener: InspectorViewModelListener): () => void {
    this.assertAlive();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeStore();
    this.store.dispose();
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

export type { LiveProfilerStoreState };

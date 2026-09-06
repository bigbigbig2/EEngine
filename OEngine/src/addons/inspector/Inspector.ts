import type { Renderer } from "../../render/Renderer.js";
import type { FrameProfiler, FrameProfilerMode } from "../../debug/FrameProfiler.js";
import {
  InspectorViewModel,
  type InspectorMode,
  type InspectorViewState
} from "./InspectorViewModel.js";
import type { ProfileFrame } from "../../debug/profiling/ProfileFrame.js";
import { InspectorShell, type InspectorDomainState, type InspectorStyleMode } from "./InspectorShell.js";

export type { InspectorMode } from "./InspectorViewModel.js";

export interface InspectorOptions {
  readonly container?: HTMLElement;
  readonly initialMode?: InspectorMode;
  /** Mount the shell folded while keeping the floating toggle visible. */
  readonly initiallyCollapsed?: boolean;
  readonly historyCapacity?: number;
  readonly uiRefreshHz?: number;
  readonly nonce?: string;
  readonly styles?: InspectorStyleMode;
}

interface ResolvedInspectorOptions {
  readonly container?: HTMLElement;
  readonly nonce?: string;
  readonly initialMode: InspectorMode;
  readonly initiallyCollapsed: boolean;
  readonly historyCapacity: number;
  readonly uiRefreshHz: number;
  readonly styles: InspectorStyleMode;
}

interface StoredDomainEvidence {
  readonly frameGraph: InspectorDomainState["frameGraph"];
  readonly resources: InspectorDomainState["resources"];
  readonly memory: InspectorDomainState["memory"];
}

/** Public lifecycle and real-time profiling facade for the framework-free Inspector addon. */
export class Inspector {
  readonly viewModel: InspectorViewModel;
  private readonly profiler: FrameProfiler;
  private readonly renderer: Renderer;
  private readonly options: ResolvedInspectorOptions;
  private readonly wasProfilerEnabled: boolean;
  private readonly previousMode: FrameProfilerMode;
  private shell: InspectorShell | null = null;
  private unsubscribeView: (() => void) | null = null;
  private animationFrame: number | null = null;
  private lastPaintAt = -Infinity;
  private pendingState: InspectorViewState | null = null;
  private readonly domainEvidenceByFrame = new Map<number, StoredDomainEvidence>();
  private disposed = false;

  constructor(renderer: Renderer, options: InspectorOptions = {}) {
    this.renderer = renderer;
    this.profiler = renderer.profiler;
    this.wasProfilerEnabled = this.profiler.enabled;
    this.previousMode = this.profiler.mode;
    const historyCapacity = options.historyCapacity ?? 2048;
    if (!this.profiler.enabled) {
      this.profiler.configure({ enabled: true, historyCapacity });
    } else if (options.historyCapacity !== undefined) {
      this.profiler.configure({ historyCapacity });
    }
    this.options = {
      container: options.container,
      nonce: options.nonce,
      initialMode: options.initialMode ?? "monitor",
      initiallyCollapsed: options.initiallyCollapsed ?? false,
      historyCapacity,
      uiRefreshHz: options.uiRefreshHz ?? 5,
      styles: options.styles ?? "inline"
    };
    if (!Number.isFinite(this.options.uiRefreshHz) || this.options.uiRefreshHz <= 0) {
      throw new RangeError("uiRefreshHz must be positive");
    }
    this.viewModel = new InspectorViewModel(this.profiler);
    this.viewModel.setMode(this.options.initialMode);
  }

  open(): void {
    this.assertAlive();
    if (this.shell !== null) return;
    const container = this.options.container ?? document.body;
    if (container === undefined) throw new Error("Inspector requires a DOM container");
    this.shell = new InspectorShell({
      container,
      styles: this.options.styles,
      nonce: this.options.nonce,
      onMode: (mode) => this.viewModel.setMode(mode),
      onFollowLatest: (follow) => this.viewModel.setFollowLatest(follow),
      onClose: () => this.close(),
      onStartRecording: () => this.startRecording(),
      onStopRecording: () => this.stopRecording(),
      onClear: () => this.clear(),
      onSelectFrame: (frameIndex) => this.selectFrame(frameIndex),
      onSelectRange: (startFrameIndex, endFrameIndex) => this.viewModel.selectRange(startFrameIndex, endFrameIndex),
      onDomainState: () => this.domainState()
    });
    this.shell.mount();
    if (this.options.initiallyCollapsed) this.shell.setPanelVisible(false);
    this.unsubscribeView = this.viewModel.subscribe((state) => {
      this.captureDomainEvidence(state.latest);
      this.pendingState = state;
      this.schedulePaint();
    });
    this.pendingState = this.viewModel.snapshot();
    this.captureDomainEvidence(this.pendingState.latest);
    this.schedulePaint(true);
  }

  close(): void {
    if (this.disposed) return;
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    this.unsubscribeView?.();
    this.unsubscribeView = null;
    this.shell?.unmount();
    this.shell = null;
  }

  /** Whether the Inspector shell is currently mounted in the document. */
  get isOpen(): boolean {
    return this.shell !== null;
  }

  pause(): void {
    this.assertAlive();
    this.viewModel.pause();
  }

  resume(): void {
    this.assertAlive();
    this.viewModel.resume();
  }

  setFollowLatest(follow: boolean): void {
    this.assertAlive();
    this.viewModel.setFollowLatest(follow);
  }

  startRecording(): void {
    this.assertAlive();
    this.viewModel.setFollowLatest(true);
    this.viewModel.setMode("record");
  }

  stopRecording(): void {
    this.assertAlive();
    this.viewModel.setMode("monitor");
  }

  selectFrame(frameIndex: number): void {
    this.assertAlive();
    this.viewModel.selectFrame(frameIndex);
  }

  clear(): void {
    this.assertAlive();
    this.viewModel.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.close();
    this.disposed = true;
    this.viewModel.dispose();
    this.domainEvidenceByFrame.clear();
    if (!this.wasProfilerEnabled) {
      this.profiler.configure({ enabled: false });
    } else if (this.profiler.mode !== this.previousMode) {
      this.profiler.setMode(this.previousMode);
    }
  }

  private domainState(): InspectorDomainState {
    let frameGraph: InspectorDomainState["frameGraph"] = null;
    let resources: InspectorDomainState["resources"] = null;
    let memory: InspectorDomainState["memory"] = null;
    const frame = this.viewModel.selectedFrame ?? this.viewModel.latestFrame;
    const latest = this.viewModel.latestFrame;
    const stored = frame === undefined ? undefined : this.domainEvidenceByFrame.get(frame.frameIndex);
    if (stored !== undefined) {
      frameGraph = stored.frameGraph;
      resources = stored.resources;
      memory = stored.memory;
    } else if (frame === undefined || latest?.frameIndex === frame.frameIndex) {
      this.captureDomainEvidence(frame);
      const current = frame === undefined ? undefined : this.domainEvidenceByFrame.get(frame.frameIndex);
      frameGraph = current?.frameGraph ?? null;
      resources = current?.resources ?? null;
      memory = current?.memory ?? null;
    }
    const overhead = frame?.samples["profiler.overheadMs"];
    return {
      frameGraph,
      resources,
      memory,
      diagnostics: {
        diagnostics: this.profiler.diagnostics,
        metricCatalog: this.profiler.metricCatalog,
        frame,
        mode: this.viewModel.mode,
        gpuTimestampAvailable: this.profiler.gpuTimestampAvailable,
        gpuSampleInterval: this.profiler.gpuSampleInterval,
        gpuCounterSampleInterval: this.profiler.gpuCounterSampleInterval,
        inspectorOverheadMs: overhead?.availability === "available" ? overhead.value : null,
        latestFrameIndex: this.profiler.latest?.frameIndex
      }
    };
  }

  private captureDomainEvidence(frame: ProfileFrame | undefined): void {
    if (frame === undefined) return;
    if (this.domainEvidenceByFrame.has(frame.frameIndex)) return;
    let frameGraph: StoredDomainEvidence["frameGraph"] = null;
    let resources: StoredDomainEvidence["resources"] = null;
    let memory: StoredDomainEvidence["memory"] = null;
    try { frameGraph = cloneEvidence(this.renderer.mainFrameGraphEvidence()); } catch { /* renderer not initialized */ }
    try { resources = cloneEvidence(this.renderer.graphics.profilingResourceSnapshot()); } catch { /* renderer not initialized */ }
    try { memory = cloneEvidence(this.renderer.memoryEvidence()); } catch { /* renderer not initialized */ }
    this.domainEvidenceByFrame.set(frame.frameIndex, Object.freeze({ frameGraph, resources, memory }));
    while (this.domainEvidenceByFrame.size > this.options.historyCapacity) {
      const oldest = this.domainEvidenceByFrame.keys().next().value;
      if (oldest === undefined) break;
      this.domainEvidenceByFrame.delete(oldest);
    }
  }

  private schedulePaint(immediate = false): void {
    if (this.shell === null || this.animationFrame !== null) return;
    const callback = (): void => {
      this.animationFrame = null;
      const now = performance.now();
      const interval = 1000 / this.options.uiRefreshHz;
      if (immediate || now - this.lastPaintAt >= interval) {
        this.lastPaintAt = now;
        const state = this.pendingState;
        this.pendingState = null;
        if (state !== null) this.shell?.update(state);
      }
      if (this.pendingState !== null && now - this.lastPaintAt < interval) this.schedulePaint();
    };
    this.animationFrame = requestAnimationFrame(callback);
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error("Inspector has been disposed");
  }
}

function cloneEvidence<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

import type { Renderer } from "../../render/Renderer.js";
import type { FrameProfiler } from "../../debug/FrameProfiler.js";
import {
  createPerformanceCapture,
  serializePerformanceCapture,
  type PerformanceCapture
} from "../../debug/profiling/PerformanceCapture.js";
import { serializeChromeTrace } from "../../debug/profiling/ChromeTraceExporter.js";
import {
  InspectorViewModel,
  type InspectorMode,
  type InspectorViewState
} from "./InspectorViewModel.js";
import { InspectorShell, type InspectorStyleMode } from "./InspectorShell.js";

export type { InspectorMode } from "./InspectorViewModel.js";

export interface InspectorOptions {
  readonly container?: HTMLElement;
  readonly initialMode?: InspectorMode;
  readonly historyCapacity?: number;
  readonly uiRefreshHz?: number;
  readonly nonce?: string;
  readonly styles?: InspectorStyleMode;
}

export interface RecordingStopOptions {
  readonly awaitPending?: boolean;
  readonly timeoutMs?: number;
}

interface ResolvedInspectorOptions {
  readonly container?: HTMLElement;
  readonly nonce?: string;
  readonly initialMode: InspectorMode;
  readonly historyCapacity: number;
  readonly uiRefreshHz: number;
  readonly styles: InspectorStyleMode;
}

const DEFAULT_TIMEOUT_MS = 1000;

/** Public lifecycle and capture facade for the framework-free Inspector addon. */
export class Inspector {
  readonly viewModel: InspectorViewModel;
  private readonly profiler: FrameProfiler;
  private readonly renderer: Renderer;
  private readonly options: ResolvedInspectorOptions;
  private readonly wasProfilerEnabled: boolean;
  private readonly previousMode: InspectorMode;
  private shell: InspectorShell | null = null;
  private unsubscribeView: (() => void) | null = null;
  private animationFrame: number | null = null;
  private lastPaintAt = -Infinity;
  private pendingState: InspectorViewState | null = null;
  private recordingStartFrame: number | null = null;
  private pendingCaptureReject: ((error: Error) => void) | null = null;
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
      initialMode: options.initialMode ?? "live",
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
      onPause: () => this.pause(),
      onResume: () => this.resume(),
      onClose: () => this.close(),
      onSelectFrame: (frameIndex) => this.selectFrame(frameIndex),
      onSelectRange: (startFrameIndex, endFrameIndex) => this.viewModel.selectRange(startFrameIndex, endFrameIndex)
    });
    this.shell.mount();
    this.unsubscribeView = this.viewModel.subscribe((state) => {
      this.pendingState = state;
      this.schedulePaint();
    });
    this.pendingState = this.viewModel.snapshot();
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

  pause(): void {
    this.assertAlive();
    this.viewModel.pause();
  }

  resume(): void {
    this.assertAlive();
    this.viewModel.resume();
  }

  startRecording(): void {
    this.assertAlive();
    this.viewModel.setMode("record");
    this.recordingStartFrame = (this.profiler.latest?.frameIndex ?? -1) + 1;
  }

  async stopRecording(options: RecordingStopOptions = {}): Promise<PerformanceCapture> {
    this.assertAlive();
    const start = this.recordingStartFrame ?? this.oldestFrameIndex();
    if (options.awaitPending !== false) {
      await this.waitForPending(start, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    }
    const end = this.profiler.latest?.frameIndex ?? start - 1;
    this.recordingStartFrame = null;
    return this.createCapture(start, end);
  }

  captureNextFrame(): Promise<PerformanceCapture> {
    this.assertAlive();
    this.viewModel.setMode("deep-capture");
    const target = (this.profiler.latest?.frameIndex ?? -1) + 1;
    return new Promise((resolve, reject) => {
      this.pendingCaptureReject = reject;
      const unsubscribe = this.viewModel.subscribe((state) => {
        const frame = state.frames.find((candidate) => candidate.frameIndex >= target);
        if (frame === undefined) return;
        unsubscribe();
        this.pendingCaptureReject = null;
        resolve(this.createCapture(frame.frameIndex, frame.frameIndex));
      });
      if (this.disposed) {
        unsubscribe();
        this.pendingCaptureReject = null;
        reject(new Error("Inspector has been disposed"));
      }
    });
  }

  selectFrame(frameIndex: number): void {
    this.assertAlive();
    this.viewModel.selectFrame(frameIndex);
  }

  exportCapture(capture?: PerformanceCapture): Blob {
    this.assertAlive();
    const value = capture ?? this.createCapture(this.oldestFrameIndex(), this.latestFrameIndex());
    return new Blob([serializePerformanceCapture(value)], { type: "application/json" });
  }

  exportTrace(capture?: PerformanceCapture): Blob {
    this.assertAlive();
    const value = capture ?? this.createCapture(this.oldestFrameIndex(), this.latestFrameIndex());
    return new Blob([serializeChromeTrace({ frames: value.frames })], { type: "application/json" });
  }

  dispose(): void {
    if (this.disposed) return;
    this.close();
    this.disposed = true;
    this.pendingCaptureReject?.(new Error("Inspector has been disposed"));
    this.pendingCaptureReject = null;
    this.viewModel.dispose();
    if (!this.wasProfilerEnabled) {
      this.profiler.configure({ enabled: false });
    } else if (this.profiler.mode !== this.previousMode) {
      this.profiler.setMode(this.previousMode);
    }
  }

  private createCapture(start: number, end: number): PerformanceCapture {
    const frames = start > end
      ? []
      : this.profiler.historyStore?.selectRange(start, end) ?? [];
    return createPerformanceCapture({
      engine: { name: "OEngine", profiler: "FrameProfiler" },
      environment: this.environment(),
      sampling: {
        mode: this.profiler.mode,
        warmupFrames: this.profiler.warmupRemaining,
        timestampInterval: this.profiler.gpuSampleInterval,
        counterInterval: this.profiler.gpuCounterSampleInterval,
        historyCapacity: this.options.historyCapacity
      },
      metricCatalog: this.profiler.metricCatalog,
      frames,
      diagnostics: { ...this.profiler.diagnostics }
    });
  }

  private environment(): Readonly<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    try { result.adapter = this.renderer.adapter_info; } catch { result.adapter = null; }
    try { result.capabilities = this.renderer.capabilities; } catch { result.capabilities = null; }
    return result;
  }

  private async waitForPending(startFrameIndex: number, timeoutMs: number): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError("timeoutMs must be non-negative");
    const pending = (): boolean => this.viewModel.frames.some((frame) =>
      frame.frameIndex >= startFrameIndex && !frame.complete
    );
    if (!pending()) return;
    await new Promise<void>((resolve) => {
      const started = Date.now();
      let unsubscribe: (() => void) | null = null;
      const finish = (): void => { unsubscribe?.(); unsubscribe = null; resolve(); };
      const check = (): void => {
        if (!pending() || Date.now() - started >= timeoutMs) finish();
        else setTimeout(check, 4);
      };
      unsubscribe = this.viewModel.subscribe(check);
      check();
    });
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

  private oldestFrameIndex(): number {
    return this.viewModel.frames[0]?.frameIndex ?? 0;
  }

  private latestFrameIndex(): number {
    return this.profiler.latest?.frameIndex ?? this.oldestFrameIndex();
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error("Inspector has been disposed");
  }
}

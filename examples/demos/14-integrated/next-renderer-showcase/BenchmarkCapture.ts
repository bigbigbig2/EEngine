import type { Renderer } from "../../../../OEngine/src/render/pipeline/RendererCore.ts";
import { summarizeCapture, validGpuFrame, type TimedFrame } from "./BenchmarkMetrics.ts";
import type { GPUFrameTimingMode } from "../../../../OEngine/src/framegraph/GPUFrameTiming.ts";

export interface CaptureRequest {
  width?: number;
  height?: number;
  frames?: number;
  warmup?: number;
  view?: "overview" | "detail";
  profile?: "full" | "no-ao" | "no-fsr3" | "no-bloom";
  counters?: boolean;
  coverage?: "low" | "high" | "preset";
  distanceScale?: number;
  lockCamera?: boolean;
  /** Diagnostic runner may keep the measured pose for its screenshot. */
  retainView?: boolean;
  /** Reproducible per-submitted-frame path: static / small orbit / return. */
  trajectory?: "static" | "orbit-return";
  vsm?: boolean;
  gpuTimingMode?: Exclude<GPUFrameTimingMode, "production">;
}
export interface CaptureHost {
  renderer(): Renderer;
  prepare(request: Required<CaptureRequest>): unknown;
  conditions(): unknown;
  setDistance(scale: number): void;
  stability(): { signature: string; busy: boolean; failed: boolean };
  renderFrames(count: number): Promise<void>;
  restore(retainView?: boolean): void;
  status(message: string): void;
  beginMeasurement?(frame: number, request: Required<CaptureRequest>): void;
  endMeasurement?(): void;
}
export interface CaptureReport {
  schema: string;
  evidenceRole: "diagnostic";
  accepted: false;
  conditions: unknown;
  frames: TimedFrame[];
  summary: ReturnType<typeof summarizeCapture>;
  complete: boolean;
  issues: string[];
  [key: string]: unknown;
}

/** Example-local capture; waits happen between batches, never inside Renderer.render. */
export class BenchmarkCapture {
  busy = false;
  last: CaptureReport | null = null;
  preparation: Record<string, unknown>[] = [];
  private readonly clocks = new Map<number, { cpuEncodeStartUnixMs: number; cpuEncodeEndUnixMs: number }>();
  private cancelled = false;
  constructor(private readonly host: CaptureHost) {}

  encoded(index: number, start: number, end: number): void {
    if (this.busy) this.clocks.set(index, { cpuEncodeStartUnixMs: start, cpuEncodeEndUnixMs: end });
  }
  cancel(): void {
    this.cancelled = true;
  }

  async run(input: CaptureRequest = {}) {
    if (this.busy) throw new Error("A capture is already running");
    const request: Required<CaptureRequest> = {
      width: 1280,
      height: 720,
      frames: 120,
      warmup: 60,
      view: "overview",
      profile: "full",
      counters: true,
      coverage: "low",
      distanceScale: input.coverage === "high" ? 0.5 : 1.75,
      lockCamera: false,
      retainView: false,
      trajectory: "static",
      vsm: false,
      gpuTimingMode: "full",
      ...input
    };
    for (const key of ["width", "height", "frames", "warmup"] as const) {
      if (
        !Number.isSafeInteger(request[key]) ||
        request[key] < (key === "warmup" ? 0 : 1) ||
        request[key] > 8192
      )
        throw new Error(`Invalid capture ${key}`);
    }
    if (
      !["overview", "detail"].includes(request.view) ||
      !["full", "no-ao", "no-fsr3", "no-bloom"].includes(request.profile)
    )
      throw new Error("Unknown capture profile/view");
    if (
      !["coarse", "stage", "full"].includes(request.gpuTimingMode) ||
      (request.gpuTimingMode === "full" && request.frames > 120)
    )
      throw new Error(
        "Full timestamp capture is limited to 120 frames; use a coarse/stage capture for longer runs"
      );
    if (
      !["static", "orbit-return"].includes(request.trajectory) ||
      (request.trajectory === "orbit-return" && (request.frames < 3 || request.frames % 3 !== 0))
    )
      throw new Error("Orbit trajectory requires three equal nonempty frame ranges");
    if (
      !["low", "high", "preset"].includes(request.coverage) ||
      !Number.isFinite(request.distanceScale) ||
      request.distanceScale < 0.02 ||
      request.distanceScale > 8
    )
      throw new Error("Invalid coverage/distance");
    const renderer = this.host.renderer();
    if (!renderer.device.features.has("timestamp-query"))
      throw new Error("This adapter has no timestamp-query; GPU performance capture unavailable");
    this.busy = true;
    this.cancelled = false;
    this.clocks.clear();
    this.preparation = [];
    const frames = new Map<number, TimedFrame>();
    const runId = `surface-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let begin = Infinity,
      end = Infinity;
    let hidden = document.visibilityState !== "visible";
    const onVisibility = () => {
      if (document.visibilityState !== "visible") hidden = true;
    };
    document.addEventListener("visibilitychange", onVisibility);
    const unsubscribe = renderer.profiler.subscribe((snapshot) => {
      if (snapshot.frameIndex < begin || snapshot.frameIndex >= end) return;
      const previous = frames.get(snapshot.frameIndex);
      const frame: TimedFrame = { ...snapshot, gpuValid: false, ...this.clocks.get(snapshot.frameIndex) };
      frame.gpuValid = validGpuFrame(frame);
      frame.gpuResultObservedUnixMs =
        previous?.gpuResultObservedUnixMs ?? (frame.gpuValid ? Date.now() : undefined);
      frames.set(snapshot.frameIndex, frame);
    });
    const startedAt = new Date().toISOString();
    try {
      this.host.prepare(request);
      renderer.profiler.configure({
        enabled: true,
        gpuSampleInterval: 1,
        gpuCounterSampleInterval: 1,
        gpuTimingMode: "coarse",
        historyCapacity: Math.max(256, request.frames + request.warmup + 32)
      });
      renderer.profiler.setMode("record");
      renderer.perf_gpu_counters_enabled = true;
      this.preparation.push({ phase: "warmup", time: Date.now(), frame: renderer.frame_count });
      this.host.status(`预热 ${request.warmup} 帧`);
      await this.host.renderFrames(request.warmup);
      await this.waitFor(() => !this.cancelled, renderer.device.queue.onSubmittedWorkDone());
      if (this.cancelled) throw new Error("Capture cancelled");
      const calibration: {
        distanceScale: number;
        visiblePixels: number;
        coverage: number;
        residencySignature: string;
      }[] = [];
      const band =
        request.coverage === "low" ? [0.25, 0.35] : request.coverage === "high" ? [0.8, 0.9] : [0, 1];
      let distance = request.distanceScale;
      let near = 0.02,
        far = 8;
      for (let iteration = 0; iteration < 16; iteration++) {
        this.preparation.push({
          phase: "calibration",
          iteration,
          distanceScale: distance,
          time: Date.now(),
          frame: renderer.frame_count
        });
        this.host.status(`校准 ${request.coverage} 占用率 · 距离 ${distance.toFixed(4)} · 等待几何驻留稳定`);
        this.host.setDistance(distance);
        await this.settleWorkload();
        const counter = renderer.profiler.history
          .reverse()
          .find(
            (frame) =>
              !frame.gpuCounters.pending &&
              !frame.gpuCounters.dropped &&
              frame.frameIndex >= renderer.frame_count - 16 &&
              frame.gpuCounters.values.geometryVisiblePixels !== undefined
          );
        if (!counter) throw new Error("No completed GPU coverage counter for camera calibration");
        const visiblePixels = counter.gpuCounters.values.geometryVisiblePixels!;
        const coverage = visiblePixels / (request.width * request.height);
        calibration.push({
          distanceScale: distance,
          visiblePixels,
          coverage,
          residencySignature: this.host.stability().signature
        });
        this.preparation.push({
          phase: "settled",
          ...calibration.at(-1),
          time: Date.now(),
          frame: renderer.frame_count
        });
        if (coverage >= band[0]! && coverage <= band[1]!) break;
        if (request.lockCamera)
          throw new Error(`Locked camera coverage ${coverage.toFixed(3)} is outside ${band.join("–")}`);
        if (coverage < band[0]!) far = distance;
        else near = distance;
        distance = (near + far) / 2;
      }
      const calibrated = calibration.at(-1)!;
      if (calibrated.coverage < band[0]! || calibrated.coverage > band[1]!)
        throw new Error("Unable to reach requested coverage band");
      if (request.trajectory !== "static") {
        // Warm the exact trajectory, then settle back at its initial pose.
        this.host.beginMeasurement?.(renderer.frame_count, request);
        await this.host.renderFrames(request.frames);
        this.host.endMeasurement?.();
        await this.settleWorkload();
      }
      const conditions = this.host.conditions();
      const workloadStart = this.host.stability();
      // A short independent counter run must sample every measured frame;
      // an eight-frame cadence can miss the entire three-frame window.
      renderer.profiler.configure({
        gpuCounterSampleInterval: request.counters ? 1 : 8,
        gpuTimingMode: request.gpuTimingMode
      });
      renderer.perf_gpu_counters_enabled = request.counters;
      begin = renderer.frame_count;
      end = begin + request.frames;
      this.host.beginMeasurement?.(begin, request);
      this.host.status(`采集 ${request.frames} 帧 · ${request.width}×${request.height}`);
      const captureStartUnixMs = Date.now();
      this.preparation.push({ phase: "measurement", time: captureStartUnixMs, begin, end });
      await this.host.renderFrames(request.frames);
      await this.waitFor(() => !this.cancelled, renderer.device.queue.onSubmittedWorkDone());
      await this.waitFor(
        () =>
          [...frames.values()].length === request.frames &&
          [...frames.values()].every((frame) => !frame.gpu.pending && !frame.gpuCounters.pending)
      );
      if (this.cancelled) throw new Error("Capture cancelled");
      const rows = [...frames.values()]
        .sort((a, b) => a.frameIndex - b.frameIndex)
        .map((frame) => ({
          ...frame,
          ...this.clocks.get(frame.frameIndex)
        }));
      const summary = summarizeCapture(rows);
      const diagnostics = renderer.profiler.diagnostics;
      const workloadEnd = this.host.stability();
      const coverageCounts = summary.counters.geometryVisiblePixels;
      const coverageRange = coverageCounts
        ? [
            coverageCounts.min / (request.width * request.height),
            coverageCounts.max / (request.width * request.height)
          ]
        : null;
      const issues = [
        ...(hidden ? ["Page was hidden during capture"] : []),
        ...(summary.invalidGpuFrameIds.length ? ["GPU timestamps incomplete/invalid"] : []),
        ...(summary.multipleSubmitFrameIds.length ? ["Unexpected submit count"] : []),
        ...(diagnostics.validationErrorCount ||
        diagnostics.uncapturedErrorCount ||
        diagnostics.deviceLostCount
          ? ["GPU/runtime errors recorded"]
          : []),
        ...(diagnostics.failedGpuTimestampBatches || diagnostics.failedGpuCounterSamples
          ? ["GPU readback failures recorded"]
          : []),
        ...(request.counters && !coverageCounts ? ["Measured GPU coverage counters missing"] : []),
        ...(workloadEnd.signature !== workloadStart.signature || workloadEnd.busy || workloadEnd.failed
          ? ["Geometry residency changed during fixed capture"]
          : []),
        ...(request.trajectory === "static" &&
        coverageRange &&
        (coverageRange[0]! < band[0]! || coverageRange[1]! > band[1]!)
          ? ["Measured coverage outside requested band"]
          : []),
        ...(request.trajectory === "static" && coverageCounts && coverageCounts.min !== coverageCounts.max
          ? ["Visible-pixel workload changed during fixed capture"]
          : [])
      ];
      this.last = {
        schema: "eengine-showcase-capture-v1",
        evidenceRole: "diagnostic",
        accepted: false,
        startedAt,
        captureStartUnixMs,
        captureEndUnixMs: Date.now(),
        request,
        conditions,
        frames: rows,
        summary,
        issues,
        complete: issues.length === 0,
        diagnostics,
        calibration,
        cameraDistanceScale: distance,
        preparation: this.preparation,
        coverageBand: band,
        measuredCoverageRange: coverageRange,
        workloadStart,
        workloadEnd,
        graph: renderer.mainFrameGraphEvidence(),
        adapter: renderer.adapter_info,
        deviceFeatures: [...renderer.device.features],
        deviceLimits: {
          maxStorageBuffersPerShaderStage: renderer.device.limits.maxStorageBuffersPerShaderStage,
          maxTextureDimension2D: renderer.device.limits.maxTextureDimension2D
        },
        gpuClockMapping: "CPU encoding to async GPU-result observation window; no calibrated GPU↔UTC mapping"
      };
      const timing = summary.gpuFrameSpanMs ?? summary.gpuPassSumMs;
      this.host.status(
        issues.length
          ? `采集异常：${issues.join("；")}`
          : `完成 ${rows.length} 帧 · GPU span P50 ${timing!.p50.toFixed(2)} / P95 ${timing!.p95.toFixed(2)} ms`
      );
      return this.last;
    } finally {
      this.host.endMeasurement?.();
      renderer.profiler.configure({ gpuTimingMode: "coarse" });
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
      this.host.restore(request.retainView);
      this.clocks.clear();
      this.busy = false;
    }
  }

  private async settleWorkload(): Promise<void> {
    const renderer = this.host.renderer();
    let previous = "",
      stable = 0;
    for (let attempt = 0; attempt < 24; attempt++) {
      await this.host.renderFrames(16);
      await this.waitFor(() => !this.cancelled, renderer.device.queue.onSubmittedWorkDone());
      // Delayed demand consumers may still be publishing pages after GPU completion.
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      const state = this.host.stability();
      if (state.failed) throw new Error("Geometry streaming failure during preparation");
      const counters = renderer.profiler.history.filter(
        (frame) =>
          frame.frameIndex >= renderer.frame_count - 16 &&
          !frame.gpuCounters.pending &&
          !frame.gpuCounters.dropped &&
          frame.gpuCounters.values.geometryVisiblePixels !== undefined
      );
      const values = counters.map((frame) => frame.gpuCounters.values.geometryVisiblePixels!);
      const signature = `${state.signature}:${values.at(-1)}`;
      stable =
        !state.busy &&
        values.length >= 2 &&
        values.every((value) => value === values[0]) &&
        signature === previous
          ? stable + 1
          : 0;
      this.preparation.push({
        phase: "residency-check",
        time: Date.now(),
        frame: renderer.frame_count,
        state,
        completedCounterFrames: values.length,
        visibleMin: values.length ? Math.min(...values) : null,
        visibleMax: values.length ? Math.max(...values) : null,
        stableBatches: stable
      });
      previous = signature;
      if (stable >= 2) return;
    }
    throw new Error("Geometry/coverage did not stabilize within 384 preparation frames");
  }

  private async waitFor(check: () => boolean, completion?: Promise<void>): Promise<void> {
    const deadline = performance.now() + 30000;
    if (completion)
      await Promise.race([
        completion,
        new Promise<never>((_, reject) => {
          const timer = window.setTimeout(() => reject(new Error("GPU completion timeout")), 30000);
          completion.finally(() => clearTimeout(timer)).catch(() => {});
        })
      ]);
    while (!check()) {
      if (this.cancelled) throw new Error("Capture cancelled");
      if (performance.now() > deadline) throw new Error("GPU result patch timeout");
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    }
  }
}

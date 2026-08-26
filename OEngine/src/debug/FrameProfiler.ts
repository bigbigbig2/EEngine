import {
  GPU_COUNTER_BYTE_SIZE,
  GPU_COUNTER_SCHEMA_VERSION,
  GpuFrameCounterBuffer,
  type GpuCounterFieldName,
  type GpuCounterValues
} from "./GpuFrameCounters.js";
import { BENCHMARK_GPU_COUNTER_EVIDENCE } from "./BenchmarkCapabilityEvidence.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import {
  classifyGpuFramePhase,
  type GpuFramePhase
} from "./GpuFramePhase.js";

export interface FrameProfilerOptions {
  enabled?: boolean;
  gpuSampleInterval?: number;
  gpuCounterSampleInterval?: number;
  gpuTimestampAvailable?: boolean;
  historyCapacity?: number;
  readbackRingSlots?: number;
  now?: () => number;
}

export interface FrameCountEvidence {
  count: number;
  labels: Record<string, number>;
}

export interface FrameReadbackEvidence extends FrameCountEvidence {
  bytes: number;
}

export interface FrameUploadEvidence {
  writes: number;
  bytes: number;
  labels: Record<string, number>;
}

export interface FrameGraphEvidence {
  builds: number;
  compiles: number;
  executes: number;
}

export type FrameGpuPassType = "compute" | "render";

export interface FrameGpuSegment {
  label: string;
  type: FrameGpuPassType;
  phase: GpuFramePhase;
  durationMs: number;
}

export interface FrameGpuEvidence {
  available: boolean;
  sampled: boolean;
  pending: boolean;
  segments: FrameGpuSegment[];
}

export interface FrameGpuCounterEvidence {
  available: boolean;
  sampled: boolean;
  pending: boolean;
  dropped: boolean;
  schemaVersion: number;
  values: Partial<GpuCounterValues>;
}

export interface FrameProfilerDiagnostics {
  validationErrorCount: number;
  uncapturedErrorCount: number;
  deviceLostCount: number;
  uncapturedErrors: string[];
  deviceLostReasons: string[];
  failedGpuTimestampBatches: number;
  droppedGpuCounterSamples: number;
  failedGpuCounterSamples: number;
}

export interface FrameProfileSnapshot {
  frameIndex: number;
  cpuMs: Record<string, number>;
  submits: FrameCountEvidence;
  readbacks: FrameReadbackEvidence;
  uploads: FrameUploadEvidence;
  graph: FrameGraphEvidence;
  counters: Record<string, number>;
  gpu: FrameGpuEvidence;
  gpuCounters: FrameGpuCounterEvidence;
}

export interface FrameGpuTimingInput {
  label?: string;
  type: FrameGpuPassType;
  duration_ms: number;
}

export type FrameProfileListener = (snapshot: FrameProfileSnapshot) => void;

type ActiveFrame = {
  startedAt: number;
  snapshot: FrameProfileSnapshot;
  gpuCounterSampleEncoded: boolean;
  gpuCounterFields: Set<GpuCounterFieldName>;
};

type GpuTimingBatch = {
  contextLabel: string;
  timings: FrameGpuTimingInput[] | null;
};

type GpuTimingBatchState = {
  sealed: boolean;
  batches: GpuTimingBatch[];
};

/**
 * CPU-side frame evidence collector. GPU timestamps are attached later because
 * readback is asynchronous. Disabled profiling does not retain frame history.
 */
export class FrameProfiler {
  private enabledValue: boolean;
  private gpuSampleIntervalValue: number;
  private gpuCounterSampleIntervalValue: number;
  private gpuTimestampAvailableValue: boolean;
  private historyCapacityValue: number;
  private readbackRingSlotsValue: number;
  private readonly now: () => number;
  private active: ActiveFrame | null = null;
  private readonly frames: FrameProfileSnapshot[] = [];
  private readonly listeners = new Set<FrameProfileListener>();
  private gpuDevice: GPUDevice | null = null;
  private gpuFrameCounters: GpuFrameCounterBuffer | null = null;
  private validationErrorCount = 0;
  private uncapturedErrorCount = 0;
  private deviceLostCount = 0;
  private readonly uncapturedErrors: string[] = [];
  private readonly deviceLostReasons: string[] = [];
  private failedGpuTimestampBatches = 0;
  private droppedGpuCounterSamples = 0;
  private failedGpuCounterSamples = 0;
  private readonly gpuCounterFieldsByFrame = new Map<
    number,
    GpuCounterFieldName[]
  >();
  private readonly gpuTimingBatchesByFrame = new Map<
    number,
    GpuTimingBatchState
  >();
  private deviceEpoch = 0;
  private readonly onUncapturedError = (event: GPUUncapturedErrorEvent): void => {
    const error = event.error;
    const name = error.constructor?.name || "GPUError";
    this.uncapturedErrorCount++;
    if (name === "GPUValidationError") this.validationErrorCount++;
    appendBounded(this.uncapturedErrors, `${name}: ${error.message}`);
  };

  constructor(options: FrameProfilerOptions = {}) {
    this.enabledValue = options.enabled ?? false;
    this.gpuSampleIntervalValue = positiveInteger(
      options.gpuSampleInterval ?? 60,
      "gpuSampleInterval"
    );
    this.gpuCounterSampleIntervalValue = positiveInteger(
      options.gpuCounterSampleInterval ?? 60,
      "gpuCounterSampleInterval"
    );
    this.gpuTimestampAvailableValue = options.gpuTimestampAvailable ?? false;
    this.historyCapacityValue = positiveInteger(
      options.historyCapacity ?? 2048,
      "historyCapacity"
    );
    this.readbackRingSlotsValue = positiveInteger(
      options.readbackRingSlots ?? 3,
      "readbackRingSlots"
    );
    if (this.readbackRingSlotsValue < 3) {
      throw new RangeError("readbackRingSlots must be at least 3");
    }
    this.now = options.now ?? (() => performance.now());
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  get gpuTimestampAvailable(): boolean {
    return this.gpuTimestampAvailableValue;
  }

  get gpuSampleInterval(): number {
    return this.gpuSampleIntervalValue;
  }

  get gpuCounterSampleInterval(): number {
    return this.gpuCounterSampleIntervalValue;
  }

  get readbackRingSlots(): number {
    return this.readbackRingSlotsValue;
  }

  get diagnostics(): FrameProfilerDiagnostics {
    const ring = this.gpuFrameCounters?.stats;
    return {
      validationErrorCount: this.validationErrorCount,
      uncapturedErrorCount: this.uncapturedErrorCount,
      deviceLostCount: this.deviceLostCount,
      uncapturedErrors: [...this.uncapturedErrors],
      deviceLostReasons: [...this.deviceLostReasons],
      failedGpuTimestampBatches: this.failedGpuTimestampBatches,
      droppedGpuCounterSamples: Math.max(
        this.droppedGpuCounterSamples,
        ring?.dropped ?? 0
      ),
      failedGpuCounterSamples: Math.max(
        this.failedGpuCounterSamples,
        ring?.failed ?? 0
      )
    };
  }

  get gpuCounterBuffer(): GPUBuffer | null {
    return this.gpuFrameCounters?.buffer ?? null;
  }

  subscribe(listener: FrameProfileListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  configure(options: Omit<FrameProfilerOptions, "now">): void {
    if (this.active !== null) throw new Error("Cannot configure FrameProfiler during a frame");
    if (options.enabled !== undefined) this.enabledValue = options.enabled;
    if (options.gpuTimestampAvailable !== undefined) {
      this.gpuTimestampAvailableValue = options.gpuTimestampAvailable;
    }
    if (options.gpuSampleInterval !== undefined) {
      this.gpuSampleIntervalValue = positiveInteger(
        options.gpuSampleInterval,
        "gpuSampleInterval"
      );
    }
    if (options.gpuCounterSampleInterval !== undefined) {
      this.gpuCounterSampleIntervalValue = positiveInteger(
        options.gpuCounterSampleInterval,
        "gpuCounterSampleInterval"
      );
    }
    if (options.historyCapacity !== undefined) {
      this.historyCapacityValue = positiveInteger(
        options.historyCapacity,
        "historyCapacity"
      );
      this.trimHistory();
    }
    if (options.readbackRingSlots !== undefined) {
      const slots = positiveInteger(options.readbackRingSlots, "readbackRingSlots");
      if (slots < 3) throw new RangeError("readbackRingSlots must be at least 3");
      if (slots !== this.readbackRingSlotsValue) {
        this.readbackRingSlotsValue = slots;
        this.destroyGpuCounterResources();
      }
    }
    if (!this.enabledValue) this.destroyGpuCounterResources();
  }

  attachGpuDevice(device: GPUDevice): void {
    if (this.gpuDevice === device) return;
    this.detachGpuDevice();
    this.gpuDevice = device;
    const epoch = ++this.deviceEpoch;
    device.addEventListener("uncapturederror", this.onUncapturedError);
    void device.lost.then((info) => {
      if (this.gpuDevice !== device || this.deviceEpoch !== epoch) return;
      this.deviceLostCount++;
      appendBounded(this.deviceLostReasons, `${info.reason}: ${info.message}`);
    });
  }

  detachGpuDevice(device?: GPUDevice): void {
    if (device !== undefined && this.gpuDevice !== device) return;
    const current = this.gpuDevice;
    if (current !== null) {
      current.removeEventListener("uncapturederror", this.onUncapturedError);
    }
    this.gpuDevice = null;
    this.deviceEpoch++;
    this.destroyGpuCounterResources();
  }

  beginFrame(frameIndex: number): void {
    if (!this.enabledValue) return;
    if (this.active !== null) {
      throw new Error(`FrameProfiler frame ${this.active.snapshot.frameIndex} is still active`);
    }
    if (!Number.isInteger(frameIndex) || frameIndex < 0) {
      throw new RangeError("frameIndex must be a non-negative integer");
    }
    const sampled =
      this.gpuTimestampAvailableValue &&
      frameIndex % this.gpuSampleIntervalValue === 0;
    this.active = {
      startedAt: this.now(),
      gpuCounterSampleEncoded: false,
      gpuCounterFields: new Set(),
      snapshot: {
        frameIndex,
        cpuMs: {},
        submits: { count: 0, labels: {} },
        readbacks: { count: 0, bytes: 0, labels: {} },
        uploads: { writes: 0, bytes: 0, labels: {} },
        graph: { builds: 0, compiles: 0, executes: 0 },
        counters: {},
        gpu: {
          available: this.gpuTimestampAvailableValue,
          sampled,
          pending: sampled,
          segments: []
        },
        gpuCounters: {
          available: this.gpuDevice !== null,
          sampled: false,
          pending: false,
          dropped: false,
          schemaVersion: GPU_COUNTER_SCHEMA_VERSION,
          values: {}
        }
      }
    };
    const counters = this.active.snapshot.gpuCounters;
    counters.sampled = counters.available &&
      frameIndex % this.gpuCounterSampleIntervalValue === 0;
    counters.pending = counters.sampled;
  }

  beginCpuSection(label: string): () => void {
    const active = this.active;
    if (active === null) return () => {};
    const startedAt = this.now();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      const elapsed = Math.max(0, this.now() - startedAt);
      active.snapshot.cpuMs[label] =
        (active.snapshot.cpuMs[label] ?? 0) + elapsed;
    };
  }

  measure<T>(label: string, callback: () => T): T {
    const finish = this.beginCpuSection(label);
    try {
      return callback();
    } finally {
      finish();
    }
  }

  shouldSampleGpu(): boolean {
    return this.active?.snapshot.gpu.sampled ?? false;
  }

  /**
   * 将采样帧内所有 OEngine CommandContext 登记为一个异步 timing batch。
   * batch 最终按注册顺序合并，readback 的完成顺序不会改变 artifact。
   */
  attachGpuTimingContext(
    command: ShadeGPUCommandContext,
    contextLabel: string
  ): void {
    const active = this.active;
    if (
      active === null ||
      !active.snapshot.gpu.sampled ||
      !command.device.features.has("timestamp-query")
    ) {
      return;
    }
    const frameIndex = active.snapshot.frameIndex;
    let state = this.gpuTimingBatchesByFrame.get(frameIndex);
    if (state === undefined) {
      state = { sealed: false, batches: [] };
      this.gpuTimingBatchesByFrame.set(frameIndex, state);
    }
    const batchIndex = state.batches.length;
    state.batches.push({ contextLabel, timings: null });
    command.enable_debug_timers(
      (timings) => {
        this.completeGpuTimingBatch(frameIndex, batchIndex, timings);
      },
      (error) => {
        this.failGpuTimingBatch(frameIndex, batchIndex, error);
      }
    );
  }

  shouldSampleGpuCounters(): boolean {
    return this.active?.snapshot.gpuCounters.sampled ?? false;
  }

  encodeGpuCounterClear(command: ShadeGPUCommandContext): void {
    if (!this.shouldSampleGpuCounters() || this.gpuDevice === null) return;
    this.ensureGpuFrameCounters().clear(command.gpu_encoder);
  }

  copyGpuCounter(
    command: ShadeGPUCommandContext,
    field: GpuCounterFieldName,
    source: GPUBuffer,
    sourceOffset = 0
  ): void {
    if (!this.shouldSampleGpuCounters() || this.gpuDevice === null) return;
    assertSupportedGpuCounter(field);
    this.ensureGpuFrameCounters().copyField(
      command.gpu_encoder,
      field,
      source,
      sourceOffset
    );
    this.registerGpuCounterFields([field]);
  }

  registerGpuCounterFields(fields: readonly GpuCounterFieldName[]): void {
    const active = this.active;
    if (active === null || !active.snapshot.gpuCounters.sampled) return;
    for (const field of fields) {
      assertSupportedGpuCounter(field);
      active.gpuCounterFields.add(field);
    }
  }

  encodeGpuCounterReadback(command: ShadeGPUCommandContext): void {
    const active = this.active;
    if (active === null || !active.snapshot.gpuCounters.sampled) return;
    const counters = this.ensureGpuFrameCounters();
    const ticket = counters.encodeReadback(
      command.gpu_encoder,
      active.snapshot.frameIndex
    );
    active.gpuCounterSampleEncoded = true;
    if (ticket === null) {
      active.snapshot.gpuCounters.pending = false;
      active.snapshot.gpuCounters.dropped = true;
      this.droppedGpuCounterSamples++;
      return;
    }
    command.recordReadback("gpu-counters", GPU_COUNTER_BYTE_SIZE);
    this.gpuCounterFieldsByFrame.set(
      active.snapshot.frameIndex,
      [...active.gpuCounterFields]
    );
    command.onFinished.addOne(() => counters.markSubmitted(ticket));
    command.onAborted?.addOne((_context: ShadeGPUCommandContext, cause: unknown) => {
      counters.cancel(ticket, cause);
    });
  }

  recordSubmit(label: string): void {
    const evidence = this.active?.snapshot.submits;
    if (evidence === undefined) return;
    evidence.count++;
    increment(evidence.labels, label);
  }

  recordReadback(label: string, bytes: number): void {
    const evidence = this.active?.snapshot.readbacks;
    if (evidence === undefined) return;
    evidence.count++;
    evidence.bytes += nonNegativeFinite(bytes, "readback bytes");
    increment(evidence.labels, label);
  }

  recordUpload(label: string, bytes: number): void {
    const evidence = this.active?.snapshot.uploads;
    if (evidence === undefined) return;
    const validated = nonNegativeFinite(bytes, "upload bytes");
    evidence.writes++;
    evidence.bytes += validated;
    evidence.labels[label] = (evidence.labels[label] ?? 0) + validated;
  }

  recordGraphBuild(): void {
    if (this.active !== null) this.active.snapshot.graph.builds++;
  }

  recordGraphCompile(): void {
    if (this.active !== null) this.active.snapshot.graph.compiles++;
  }

  recordGraphExecute(): void {
    if (this.active !== null) this.active.snapshot.graph.executes++;
  }

  recordCounter(label: string, value: number): void {
    if (this.active === null) return;
    this.active.snapshot.counters[label] = nonNegativeFinite(value, label);
  }

  addCounter(label: string, value: number): void {
    if (this.active === null) return;
    const validated = nonNegativeFinite(value, label);
    this.active.snapshot.counters[label] =
      (this.active.snapshot.counters[label] ?? 0) + validated;
  }

  endFrame(): FrameProfileSnapshot | undefined {
    const active = this.active;
    if (active === null) return undefined;
    if (
      active.snapshot.gpuCounters.sampled &&
      !active.gpuCounterSampleEncoded
    ) {
      active.snapshot.gpuCounters.pending = false;
      active.snapshot.gpuCounters.dropped = true;
      this.droppedGpuCounterSamples++;
    }
    if (active.snapshot.gpu.sampled) {
      const timingState = this.gpuTimingBatchesByFrame.get(
        active.snapshot.frameIndex
      );
      if (timingState !== undefined) {
        timingState.sealed = true;
        this.finalizeGpuTimingBatches(active.snapshot.frameIndex, timingState);
      }
    }
    active.snapshot.cpuMs.frame = Math.max(0, this.now() - active.startedAt);
    this.active = null;
    this.frames.push(active.snapshot);
    this.trimHistory();
    const completed = cloneSnapshot(active.snapshot);
    this.notify(completed);
    return completed;
  }

  recordGpuTimings(
    frameIndex: number,
    timings: readonly FrameGpuTimingInput[]
  ): void {
    const frame = this.frames.find((candidate) => candidate.frameIndex === frameIndex);
    if (frame === undefined || !frame.gpu.sampled) return;
    frame.gpu.segments = timings.map((timing, index) => ({
      label: timing.label ?? `unnamed-${index}`,
      type: timing.type,
      phase: classifyGpuFramePhase(timing.label ?? `unnamed-${index}`),
      durationMs: nonNegativeFinite(timing.duration_ms, "GPU duration")
    }));
    frame.gpu.pending = false;
    this.notify(cloneSnapshot(frame));
  }

  recordGpuCounters(frameIndex: number, values: GpuCounterValues): void {
    const frame = this.frames.find((candidate) => candidate.frameIndex === frameIndex);
    if (frame === undefined || !frame.gpuCounters.sampled) return;
    const fields = this.gpuCounterFieldsByFrame.get(frameIndex) ?? [];
    const supported: Partial<GpuCounterValues> = {};
    for (const field of fields) supported[field] = values[field];
    frame.gpuCounters.values = supported;
    frame.gpuCounters.pending = false;
    this.gpuCounterFieldsByFrame.delete(frameIndex);
    this.notify(cloneSnapshot(frame));
  }

  get latest(): FrameProfileSnapshot | undefined {
    const frame = this.frames[this.frames.length - 1];
    return frame === undefined ? undefined : cloneSnapshot(frame);
  }

  get history(): FrameProfileSnapshot[] {
    return this.frames.map(cloneSnapshot);
  }

  getFrame(frameIndex: number): FrameProfileSnapshot | undefined {
    const frame = this.frames.find((candidate) => candidate.frameIndex === frameIndex);
    return frame === undefined ? undefined : cloneSnapshot(frame);
  }

  clear(): void {
    if (this.active !== null) throw new Error("Cannot clear FrameProfiler during a frame");
    this.frames.length = 0;
    this.gpuCounterFieldsByFrame.clear();
    this.gpuTimingBatchesByFrame.clear();
  }

  destroy(): void {
    this.detachGpuDevice();
    this.listeners.clear();
    this.frames.length = 0;
    this.gpuTimingBatchesByFrame.clear();
  }

  private ensureGpuFrameCounters(): GpuFrameCounterBuffer {
    const device = this.gpuDevice;
    if (device === null) throw new Error("FrameProfiler has no attached GPUDevice");
    this.gpuFrameCounters ??= new GpuFrameCounterBuffer(device, {
      slotCount: this.readbackRingSlotsValue,
      onResult: (frameIndex, values) => this.recordGpuCounters(frameIndex, values),
      onError: (frameIndex, error) => {
        this.failedGpuCounterSamples++;
        const frame = this.frames.find((candidate) => candidate.frameIndex === frameIndex);
        if (frame !== undefined) {
          frame.gpuCounters.pending = false;
          this.notify(cloneSnapshot(frame));
        }
        this.gpuCounterFieldsByFrame.delete(frameIndex);
        console.error("GPU counter readback failed", error);
      }
    });
    return this.gpuFrameCounters;
  }

  private destroyGpuCounterResources(): void {
    this.gpuFrameCounters?.destroy();
    this.gpuFrameCounters = null;
    this.gpuCounterFieldsByFrame.clear();
  }

  private completeGpuTimingBatch(
    frameIndex: number,
    batchIndex: number,
    timings: readonly FrameGpuTimingInput[]
  ): void {
    const state = this.gpuTimingBatchesByFrame.get(frameIndex);
    const batch = state?.batches[batchIndex];
    if (state === undefined || batch === undefined || batch.timings !== null) {
      return;
    }
    batch.timings = timings.map((timing) => ({ ...timing }));
    this.finalizeGpuTimingBatches(frameIndex, state);
  }

  private failGpuTimingBatch(
    frameIndex: number,
    batchIndex: number,
    error: unknown
  ): void {
    const state = this.gpuTimingBatchesByFrame.get(frameIndex);
    const batch = state?.batches[batchIndex];
    if (state === undefined || batch === undefined || batch.timings !== null) {
      return;
    }
    this.failedGpuTimestampBatches++;
    batch.timings = [];
    this.finalizeGpuTimingBatches(frameIndex, state);
    console.error("GPU timestamp readback failed", error);
  }

  private finalizeGpuTimingBatches(
    frameIndex: number,
    state: GpuTimingBatchState
  ): void {
    if (!state.sealed || state.batches.some((batch) => batch.timings === null)) {
      return;
    }
    const snapshot =
      this.active?.snapshot.frameIndex === frameIndex
        ? this.active.snapshot
        : this.frames.find((candidate) => candidate.frameIndex === frameIndex);
    if (snapshot === undefined) {
      this.gpuTimingBatchesByFrame.delete(frameIndex);
      return;
    }
    snapshot.gpu.segments = state.batches.flatMap((batch) =>
      batch.timings!.map((timing, index) => {
        const label = qualifyGpuTimingLabel(
          batch.contextLabel,
          timing.label,
          index
        );
        return {
          label,
          type: timing.type,
          phase: classifyGpuFramePhase(label),
          durationMs: nonNegativeFinite(timing.duration_ms, "GPU duration")
        };
      })
    );
    snapshot.gpu.pending = false;
    this.gpuTimingBatchesByFrame.delete(frameIndex);
    if (this.active?.snapshot !== snapshot) this.notify(cloneSnapshot(snapshot));
  }

  private trimHistory(): void {
    const excess = this.frames.length - this.historyCapacityValue;
    if (excess <= 0) return;
    const removed = this.frames.splice(0, excess);
    for (const frame of removed) {
      this.gpuTimingBatchesByFrame.delete(frame.frameIndex);
      this.gpuCounterFieldsByFrame.delete(frame.frameIndex);
    }
  }

  private notify(snapshot: FrameProfileSnapshot): void {
    for (const listener of this.listeners) {
      try {
        listener(cloneSnapshot(snapshot));
      } catch (error) {
        console.error("FrameProfiler listener failed", error);
      }
    }
  }
}

function assertSupportedGpuCounter(field: GpuCounterFieldName): void {
  const declaration = BENCHMARK_GPU_COUNTER_EVIDENCE[field];
  if (declaration.status === "unsupported") {
    throw new Error(
      `GPU counter '${field}' is unsupported; implement its real producer under ${declaration.blockerTaskId} before registration`
    );
  }
}

function increment(labels: Record<string, number>, label: string): void {
  labels[label] = (labels[label] ?? 0) + 1;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
  return value;
}

function qualifyGpuTimingLabel(
  contextLabel: string,
  passLabel: string | undefined,
  index: number
): string {
  const context = contextLabel.trim() || "unlabeled-command-context";
  const pass = passLabel?.trim() || `unnamed-${index}`;
  return `${context}/${pass}`;
}

function cloneSnapshot(snapshot: FrameProfileSnapshot): FrameProfileSnapshot {
  return {
    frameIndex: snapshot.frameIndex,
    cpuMs: { ...snapshot.cpuMs },
    submits: {
      count: snapshot.submits.count,
      labels: { ...snapshot.submits.labels }
    },
    readbacks: {
      count: snapshot.readbacks.count,
      bytes: snapshot.readbacks.bytes,
      labels: { ...snapshot.readbacks.labels }
    },
    uploads: {
      writes: snapshot.uploads.writes,
      bytes: snapshot.uploads.bytes,
      labels: { ...snapshot.uploads.labels }
    },
    graph: { ...snapshot.graph },
    counters: { ...snapshot.counters },
    gpu: {
      available: snapshot.gpu.available,
      sampled: snapshot.gpu.sampled,
      pending: snapshot.gpu.pending,
      segments: snapshot.gpu.segments.map((segment) => ({ ...segment }))
    },
    gpuCounters: {
      available: snapshot.gpuCounters.available,
      sampled: snapshot.gpuCounters.sampled,
      pending: snapshot.gpuCounters.pending,
      dropped: snapshot.gpuCounters.dropped,
      schemaVersion: snapshot.gpuCounters.schemaVersion,
      values: { ...snapshot.gpuCounters.values }
    }
  };
}

function appendBounded(values: string[], value: string, capacity = 64): void {
  if (values.length < capacity) values.push(value);
}

export interface FrameProfilerOptions {
  enabled?: boolean;
  gpuSampleInterval?: number;
  gpuTimestampAvailable?: boolean;
  historyCapacity?: number;
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
  durationMs: number;
}

export interface FrameGpuEvidence {
  available: boolean;
  sampled: boolean;
  pending: boolean;
  segments: FrameGpuSegment[];
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
};

/**
 * CPU-side frame evidence collector. GPU timestamps are attached later because
 * readback is asynchronous. Disabled profiling does not retain frame history.
 */
export class FrameProfiler {
  private enabledValue: boolean;
  private gpuSampleIntervalValue: number;
  private gpuTimestampAvailableValue: boolean;
  private historyCapacityValue: number;
  private readonly now: () => number;
  private active: ActiveFrame | null = null;
  private readonly frames: FrameProfileSnapshot[] = [];
  private readonly listeners = new Set<FrameProfileListener>();

  constructor(options: FrameProfilerOptions = {}) {
    this.enabledValue = options.enabled ?? false;
    this.gpuSampleIntervalValue = positiveInteger(
      options.gpuSampleInterval ?? 60,
      "gpuSampleInterval"
    );
    this.gpuTimestampAvailableValue = options.gpuTimestampAvailable ?? false;
    this.historyCapacityValue = positiveInteger(
      options.historyCapacity ?? 2048,
      "historyCapacity"
    );
    this.now = options.now ?? (() => performance.now());
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  get gpuTimestampAvailable(): boolean {
    return this.gpuTimestampAvailableValue;
  }

  subscribe(listener: FrameProfileListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  configure(options: Omit<FrameProfilerOptions, "now">): void {
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
    if (options.historyCapacity !== undefined) {
      this.historyCapacityValue = positiveInteger(
        options.historyCapacity,
        "historyCapacity"
      );
      this.trimHistory();
    }
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
        }
      }
    };
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
      durationMs: nonNegativeFinite(timing.duration_ms, "GPU duration")
    }));
    frame.gpu.pending = false;
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
  }

  private trimHistory(): void {
    const excess = this.frames.length - this.historyCapacityValue;
    if (excess > 0) this.frames.splice(0, excess);
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
    }
  };
}

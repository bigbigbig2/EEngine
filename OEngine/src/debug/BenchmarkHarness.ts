import {
  BENCHMARK_RESULT_SCHEMA_VERSION,
  type BenchmarkEnvironmentManifest
} from "./EnvironmentManifest.js";
import type {
  FrameProfileSnapshot,
  FrameProfilerDiagnostics
} from "./FrameProfiler.js";
import { classifyGpuFramePhase } from "./GpuFramePhase.js";
import {
  createBenchmarkCapabilityEvidence,
  type BenchmarkCapabilityEvidence
} from "./BenchmarkCapabilityEvidence.js";

export interface BenchmarkCaseManifest {
  id: string;
  name: string;
  sceneAssetHashes: string[];
  seed: number;
  cameraPathHash: string;
}

export interface SeriesSummary {
  count: number;
  mean: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface BenchmarkSummary {
  cpuMs: Record<string, SeriesSummary>;
  /** 原始 pipeline/pass label，供实现级诊断。 */
  gpuMs: Record<string, SeriesSummary>;
  /** 同一帧内先求和后的稳定逻辑阶段，供跨版本比较。 */
  gpuPhaseMs: Record<string, SeriesSummary>;
  counters: Record<string, SeriesSummary>;
  gpuCounters: Record<string, SeriesSummary>;
  submits: SeriesSummary;
  readbacks: SeriesSummary;
  uploadBytes: SeriesSummary;
}

export interface BenchmarkResult {
  schemaVersion: number;
  environment: BenchmarkEnvironmentManifest;
  case: BenchmarkCaseManifest;
  capabilityEvidence: BenchmarkCapabilityEvidence;
  frames: FrameProfileSnapshot[];
  summary: BenchmarkSummary;
  diagnostics: FrameProfilerDiagnostics;
}

/** Accumulates warm and measured frames without depending on a renderer. */
export class BenchmarkHarness {
  private seenFrames = 0;
  private readonly measuredFrames: FrameProfileSnapshot[] = [];
  private readonly warmupFrameIndices = new Set<number>();
  private readonly measuredIndexByFrame = new Map<number, number>();

  constructor(
    private readonly environment: BenchmarkEnvironmentManifest,
    private readonly caseManifest: BenchmarkCaseManifest
  ) {
    if (environment.schemaVersion !== BENCHMARK_RESULT_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported environment schema ${environment.schemaVersion}`
      );
    }
  }

  get completeFrameCount(): number {
    return this.measuredFrames.length;
  }

  get isComplete(): boolean {
    return this.measuredFrames.length === this.environment.run.sampleFrames;
  }

  get pendingGpuFrameCount(): number {
    return this.measuredFrames.reduce(
      (count, frame) => count +
        (frame.gpu.pending || frame.gpuCounters.pending ? 1 : 0),
      0
    );
  }

  recordFrame(frame: FrameProfileSnapshot): void {
    const measuredIndex = this.measuredIndexByFrame.get(frame.frameIndex);
    if (measuredIndex !== undefined) {
      this.measuredFrames[measuredIndex] = cloneFrame(frame);
      return;
    }
    if (this.warmupFrameIndices.has(frame.frameIndex)) return;
    if (this.seenFrames < this.environment.run.warmupFrames) {
      this.seenFrames++;
      this.warmupFrameIndices.add(frame.frameIndex);
      return;
    }
    this.seenFrames++;
    if (this.measuredFrames.length >= this.environment.run.sampleFrames) return;
    this.measuredIndexByFrame.set(frame.frameIndex, this.measuredFrames.length);
    this.measuredFrames.push(cloneFrame(frame));
  }

  complete(
    diagnostics: FrameProfilerDiagnostics = emptyDiagnostics()
  ): BenchmarkResult {
    if (this.measuredFrames.length !== this.environment.run.sampleFrames) {
      throw new Error(
        `Benchmark incomplete: expected ${this.environment.run.sampleFrames} measured frames, got ${this.measuredFrames.length}`
      );
    }
    const frames = this.measuredFrames.map(cloneFrame);
    return {
      schemaVersion: BENCHMARK_RESULT_SCHEMA_VERSION,
      environment: cloneJson(this.environment),
      case: cloneJson(this.caseManifest),
      capabilityEvidence: createBenchmarkCapabilityEvidence(
        this.environment.run.featureSet
      ),
      frames,
      summary: summarizeFrames(frames),
      diagnostics: cloneJson(diagnostics)
    };
  }
}

export function serializeBenchmarkResult(result: BenchmarkResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function summarizeSeries(values: readonly number[]): SeriesSummary {
  if (values.length === 0) {
    throw new RangeError("Cannot summarize an empty series");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((accumulator, value) => accumulator + value, 0);
  return {
    count: sorted.length,
    mean: round(sum / sorted.length),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99)
  };
}

function summarizeFrames(frames: readonly FrameProfileSnapshot[]): BenchmarkSummary {
  const cpuValues = new Map<string, number[]>();
  const gpuValues = new Map<string, number[]>();
  const gpuPhaseValues = new Map<string, number[]>();
  const counterValues = new Map<string, number[]>();
  const gpuCounterValues = new Map<string, number[]>();
  for (const frame of frames) {
    const framePhaseTotals = new Map<string, number>();
    for (const [label, value] of Object.entries(frame.cpuMs)) {
      append(cpuValues, label, value);
    }
    for (const segment of frame.gpu.segments) {
      append(gpuValues, segment.label, segment.durationMs);
      const phase = segment.phase ?? classifyGpuFramePhase(segment.label);
      framePhaseTotals.set(
        phase,
        (framePhaseTotals.get(phase) ?? 0) + segment.durationMs
      );
    }
    for (const [phase, durationMs] of framePhaseTotals) {
      append(gpuPhaseValues, phase, durationMs);
    }
    for (const [label, value] of Object.entries(frame.counters)) {
      append(counterValues, label, value);
    }
    if (frame.gpuCounters.sampled && !frame.gpuCounters.dropped) {
      for (const [label, value] of Object.entries(frame.gpuCounters.values)) {
        if (value !== undefined) append(gpuCounterValues, label, value);
      }
    }
  }
  return {
    cpuMs: summarizeMap(cpuValues),
    gpuMs: summarizeMap(gpuValues),
    gpuPhaseMs: summarizeMap(gpuPhaseValues),
    counters: summarizeMap(counterValues),
    gpuCounters: summarizeMap(gpuCounterValues),
    submits: summarizeSeries(frames.map((frame) => frame.submits.count)),
    readbacks: summarizeSeries(frames.map((frame) => frame.readbacks.count)),
    uploadBytes: summarizeSeries(frames.map((frame) => frame.uploads.bytes))
  };
}

function emptyDiagnostics(): FrameProfilerDiagnostics {
  return {
    validationErrorCount: 0,
    uncapturedErrorCount: 0,
    deviceLostCount: 0,
    uncapturedErrors: [],
    deviceLostReasons: [],
    failedGpuTimestampBatches: 0,
    droppedGpuCounterSamples: 0,
    failedGpuCounterSamples: 0
  };
}

function append(map: Map<string, number[]>, label: string, value: number): void {
  let values = map.get(label);
  if (values === undefined) {
    values = [];
    map.set(label, values);
  }
  values.push(value);
}

function summarizeMap(values: Map<string, number[]>): Record<string, SeriesSummary> {
  const result: Record<string, SeriesSummary> = {};
  for (const label of [...values.keys()].sort((a, b) => a.localeCompare(b))) {
    result[label] = summarizeSeries(values.get(label)!);
  }
  return result;
}

function percentile(sorted: readonly number[], quantile: number): number {
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower]!;
  const upperValue = sorted[upper]!;
  return round(lowerValue + (upperValue - lowerValue) * (position - lower));
}

function round(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}

function cloneFrame(frame: FrameProfileSnapshot): FrameProfileSnapshot {
  return cloneJson(frame);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

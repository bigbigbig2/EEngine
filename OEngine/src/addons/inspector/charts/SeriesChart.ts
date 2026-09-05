import type { ProfileFrame } from "../../../debug/profiling/ProfileFrame.js";
import {
  summarizeMetricCoverage,
  summarizeProfileSeries,
  type ProfileCoverageSummary,
  type ProfileSeriesSummary
} from "../../../debug/profiling/ProfileStatistics.js";
import type { MetricSampleAvailability } from "../../../debug/profiling/Metric.js";

const STATUS_CODES: Readonly<Record<MetricSampleAvailability, number>> = Object.freeze({
  available: 0,
  pending: 1,
  unsupported: 2,
  invalid: 3,
  dropped: 4
});

export function metricStatusCode(status: MetricSampleAvailability): number {
  return STATUS_CODES[status];
}

/** Bounded typed-array storage for one metric trend. */
export class SeriesChartModel {
  readonly maxPoints: number;
  readonly frameIndices: Uint32Array;
  readonly values: Float32Array;
  readonly availability: Uint8Array;
  private countValue = 0;
  private summaryValue: ProfileSeriesSummary | null = null;
  private coverageValue: ProfileCoverageSummary = summarizeMetricCoverage([]);

  constructor(maxPoints = 2048) {
    if (!Number.isInteger(maxPoints) || maxPoints <= 0) throw new RangeError("maxPoints must be positive");
    this.maxPoints = maxPoints;
    this.frameIndices = new Uint32Array(maxPoints);
    this.values = new Float32Array(maxPoints);
    this.availability = new Uint8Array(maxPoints);
  }

  get count(): number { return this.countValue; }
  get summary(): ProfileSeriesSummary | null { return this.summaryValue; }
  get coverage(): ProfileCoverageSummary { return this.coverageValue; }

  setFrames(frames: readonly ProfileFrame[], metricId: string): void {
    const first = Math.max(0, frames.length - this.maxPoints);
    const selected = frames.slice(first);
    const samples = selected.map((frame) => frame.samples[metricId] ?? {
      metricId,
      value: null,
      availability: "unsupported" as const,
      sourceFrameIndex: frame.frameIndex,
      resolvedAtFrameIndex: null,
      instrumented: false
    });
    const numeric: number[] = [];
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index]!;
      this.frameIndices[index] = selected[index]!.frameIndex;
      this.values[index] = sample.value ?? Number.NaN;
      this.availability[index] = STATUS_CODES[sample.availability];
      if (sample.availability === "available" && sample.value !== null) numeric.push(sample.value);
    }
    this.countValue = samples.length;
    this.summaryValue = summarizeProfileSeries(numeric);
    this.coverageValue = summarizeMetricCoverage(samples);
  }
}

export class SeriesChart {
  readonly model: SeriesChartModel;
  private readonly canvas: HTMLCanvasElement;
  private cssWidth = 320;
  private cssHeight = 72;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement, maxPoints = 2048) {
    this.canvas = canvas;
    this.model = new SeriesChartModel(maxPoints);
  }

  resize(cssWidth: number, cssHeight: number, dpr = 1): void {
    if (!Number.isFinite(cssWidth) || cssWidth <= 0 || !Number.isFinite(cssHeight) || cssHeight <= 0) {
      throw new RangeError("Canvas dimensions must be positive");
    }
    if (!Number.isFinite(dpr) || dpr <= 0) throw new RangeError("dpr must be positive");
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
  }

  setFrames(frames: readonly ProfileFrame[], metricId: string): void {
    this.model.setFrames(frames, metricId);
  }

  render(): void {
    const context = this.canvas.getContext("2d");
    if (context === null) return;
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.clearRect(0, 0, this.cssWidth, this.cssHeight);
    if (this.model.count < 2) return;
    const numeric = [...this.model.values.slice(0, this.model.count)].filter(Number.isFinite);
    const min = Math.min(...numeric, 0);
    const max = Math.max(...numeric, 1);
    const scale = max === min ? 1 : (this.cssHeight - 6) / (max - min);
    context.beginPath();
    for (let index = 0; index < this.model.count; index++) {
      const value = this.model.values[index]!;
      if (!Number.isFinite(value)) continue;
      const x = index * (this.cssWidth / (this.model.count - 1));
      const y = this.cssHeight - 3 - (value - min) * scale;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.strokeStyle = "#38bdf8";
    context.lineWidth = 1.5;
    context.stroke();
  }
}

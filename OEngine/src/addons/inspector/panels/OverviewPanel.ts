import type { ProfileFrame } from "../../../debug/profiling/ProfileFrame.js";
import {
  summarizeProfileSeries,
  type ProfileSeriesSummary
} from "../../../debug/profiling/ProfileStatistics.js";
import { FrameChart } from "../charts/FrameChart.js";
import { SeriesChart } from "../charts/SeriesChart.js";

export interface OverviewStats {
  readonly frameCount: number;
  readonly fps: number | null;
  readonly cpu: ProfileSeriesSummary | null;
  readonly gpu: ProfileSeriesSummary | null;
  readonly raf: ProfileSeriesSummary | null;
  readonly highestCostPhase: string | null;
}

function valuesFor(frames: readonly ProfileFrame[], metricId: string): number[] {
  return frames.flatMap((frame) => {
    const sample = frame.samples[metricId];
    return sample?.availability === "available" && sample.value !== null ? [sample.value] : [];
  });
}

export function buildOverviewStats(
  frames: readonly ProfileFrame[],
  range: readonly [number, number] | null = null
): OverviewStats {
  const selected = range === null
    ? frames
    : frames.filter((frame) => frame.frameIndex >= range[0] && frame.frameIndex <= range[1]);
  const raf = summarizeProfileSeries(valuesFor(selected, "frame.rafIntervalMs"));
  const cpu = summarizeProfileSeries(valuesFor(selected, "cpu.frameMs"));
  const gpu = summarizeProfileSeries(valuesFor(selected, "gpu.passSumMs"));
  const phaseTotals = new Map<string, number>();
  for (const frame of selected) {
    for (const span of frame.spans) {
      if (span.duration === null || span.availability !== "available") continue;
      phaseTotals.set(span.name, (phaseTotals.get(span.name) ?? 0) + span.duration);
    }
  }
  const highestCostPhase = [...phaseTotals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    frameCount: selected.length,
    fps: raf === null || raf.mean <= 0 ? null : 1000 / raf.mean,
    cpu,
    gpu,
    raf,
    highestCostPhase
  };
}

function formatSummary(summary: ProfileSeriesSummary | null): string {
  if (summary === null) return "unsupported";
  return `P50 ${summary.p50.toFixed(2)} · P95 ${summary.p95.toFixed(2)} · P99 ${summary.p99.toFixed(2)}`;
}

/** Overview panel keeps one DOM tree and only replaces text/canvas pixels. */
export class OverviewPanel {
  readonly element: HTMLElement;
  private readonly stats: HTMLElement;
  private readonly frameCanvas: HTMLCanvasElement;
  private readonly cpuCanvas: HTMLCanvasElement;
  private readonly gpuCanvas: HTMLCanvasElement;
  private readonly frameChart: FrameChart;
  private readonly cpuChart: SeriesChart;
  private readonly gpuChart: SeriesChart;
  private readonly budgetMs: number;

  constructor(document: Document, budgetMs = 16.667) {
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new RangeError("budgetMs must be positive");
    this.budgetMs = budgetMs;
    this.element = document.createElement("section");
    this.element.className = "overview-panel";
    const heading = document.createElement("h3");
    heading.textContent = "Overview";
    this.stats = document.createElement("div");
    this.stats.className = "overview-stats";
    this.frameCanvas = this.canvas(document, "Frame budget");
    this.cpuCanvas = this.canvas(document, "CPU frame");
    this.gpuCanvas = this.canvas(document, "GPU Pass Sum");
    this.frameChart = new FrameChart(this.frameCanvas);
    this.cpuChart = new SeriesChart(this.cpuCanvas);
    this.gpuChart = new SeriesChart(this.gpuCanvas);
    this.frameChart.resize(420, 64, 1);
    this.cpuChart.resize(420, 64, 1);
    this.gpuChart.resize(420, 64, 1);
    this.element.append(heading, this.stats, this.frameCanvas, this.cpuCanvas, this.gpuCanvas);
  }

  update(frames: readonly ProfileFrame[], range: readonly [number, number] | null): void {
    const stats = buildOverviewStats(frames, range);
    this.stats.textContent = [
      `Frames ${stats.frameCount}`,
      `FPS ${stats.fps === null ? "unsupported" : stats.fps.toFixed(1)}`,
      `CPU ${formatSummary(stats.cpu)}`,
      `GPU Pass Sum ${formatSummary(stats.gpu)}`,
      `RAF ${formatSummary(stats.raf)}`,
      `Highest phase ${stats.highestCostPhase ?? "none"}`
    ].join("\n");
    this.frameChart.setFrames(frames, this.budgetMs);
    this.frameChart.render();
    this.cpuChart.setFrames(frames, "cpu.frameMs");
    this.cpuChart.render();
    this.gpuChart.setFrames(frames, "gpu.passSumMs");
    this.gpuChart.render();
  }

  private canvas(document: Document, label: string): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-label", label);
    canvas.className = "inspector-chart";
    return canvas;
  }
}

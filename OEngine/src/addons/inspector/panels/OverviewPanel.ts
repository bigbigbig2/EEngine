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
  private readonly kpis: ReadonlyMap<string, { value: HTMLElement; meta: HTMLElement }>;
  private readonly stats: HTMLElement;
  private readonly frameCanvas: HTMLCanvasElement;
  private readonly cpuCanvas: HTMLCanvasElement;
  private readonly gpuCanvas: HTMLCanvasElement;
  private readonly frameChart: FrameChart;
  private readonly cpuChart: SeriesChart;
  private readonly gpuChart: SeriesChart;
  private readonly budgetMs: number;
  private chartWidth = 0;

  constructor(document: Document, budgetMs = 16.667) {
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new RangeError("budgetMs must be positive");
    this.budgetMs = budgetMs;
    this.element = document.createElement("section");
    this.element.className = "overview-panel";
    const heading = document.createElement("h3");
    heading.textContent = "Overview";
    const subtitle = document.createElement("p");
    subtitle.className = "panel-subtitle";
    subtitle.textContent = "Presented cadence and render cost over the visible frame window.";
    const kpiGrid = document.createElement("div");
    kpiGrid.className = "overview-kpis";
    const kpis = new Map<string, { value: HTMLElement; meta: HTMLElement }>();
    for (const [id, label] of [["fps", "Presented FPS"], ["frame", "Frame interval"], ["cpu", "CPU render"], ["gpu", "GPU pass sum"]] as const) {
      const card = document.createElement("div");
      card.className = "kpi-card";
      const cardLabel = document.createElement("span");
      cardLabel.className = "kpi-label";
      cardLabel.textContent = label;
      const value = document.createElement("strong");
      value.className = "kpi-value";
      value.textContent = "—";
      const meta = document.createElement("span");
      meta.className = "kpi-meta";
      meta.textContent = "waiting for samples";
      card.append(cardLabel, value, meta);
      kpiGrid.append(card);
      kpis.set(id, { value, meta });
    }
    this.kpis = kpis;
    this.stats = document.createElement("div");
    this.stats.className = "overview-meta";
    this.frameCanvas = this.canvas(document, "Frame budget");
    this.cpuCanvas = this.canvas(document, "CPU frame");
    this.gpuCanvas = this.canvas(document, "GPU Pass Sum");
    this.frameChart = new FrameChart(this.frameCanvas);
    this.cpuChart = new SeriesChart(this.cpuCanvas);
    this.gpuChart = new SeriesChart(this.gpuCanvas);
    this.element.append(heading, subtitle, kpiGrid, this.stats, this.frameCanvas, this.cpuCanvas, this.gpuCanvas);
  }

  update(frames: readonly ProfileFrame[], range: readonly [number, number] | null): void {
    const stats = buildOverviewStats(frames, range);
    this.resizeCharts();
    this.setKpi("fps", stats.fps === null ? "—" : stats.fps.toFixed(0), "RAF cadence · selected window");
    this.setKpi("frame", stats.raf === null ? "—" : `${stats.raf.mean.toFixed(2)} ms`, "RAF interval · mean");
    this.setKpi("cpu", stats.cpu === null ? "—" : `${stats.cpu.mean.toFixed(2)} ms`, "CPU clock · mean");
    this.setKpi("gpu", stats.gpu === null ? "—" : `${stats.gpu.mean.toFixed(2)} ms`, "GPU timestamp · mean");
    this.stats.textContent = [
      `${stats.frameCount} frames · ${range === null ? "live window" : `range ${range[0]}–${range[1]}`}`,
      `CPU ${formatSummary(stats.cpu)} · GPU ${formatSummary(stats.gpu)}`,
      `Highest phase ${stats.highestCostPhase ?? "none"}`
    ].join("\n");
    this.frameChart.setFrames(frames, this.budgetMs);
    this.frameChart.render();
    this.cpuChart.setFrames(frames, "cpu.frameMs");
    this.cpuChart.render();
    this.gpuChart.setFrames(frames, "gpu.passSumMs");
    this.gpuChart.render();
  }

  private setKpi(id: string, value: string, meta: string): void {
    const kpi = this.kpis.get(id);
    if (kpi === undefined) return;
    kpi.value.textContent = value;
    kpi.meta.textContent = meta;
  }

  private resizeCharts(): void {
    const width = Math.max(280, Math.floor(this.element.clientWidth || 640) - 16);
    if (width === this.chartWidth) return;
    this.chartWidth = width;
    const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    this.frameChart.resize(width, 78, dpr);
    this.cpuChart.resize(width, 78, dpr);
    this.gpuChart.resize(width, 78, dpr);
  }

  private canvas(document: Document, label: string): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-label", label);
    canvas.className = "inspector-chart";
    return canvas;
  }
}

import type {
  FrameGpuSegment,
  FrameProfileSnapshot,
  GpuCounterValues
} from "../../OEngine/src/index.ts";

export const SHOWCASE_GPU_DOMAINS = [
  "Visibility",
  "Surface",
  "Shadow",
  "Lighting & IBL",
  "GTAO",
  "SSR",
  "Temporal",
  "Transparency",
  "Bloom",
  "Exposure",
  "Sharpen",
  "Tonemap",
  "Observability",
  "Other"
] as const;

export type ShowcaseGpuDomain = (typeof SHOWCASE_GPU_DOMAINS)[number];

export type Percentiles = {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
};

export type ShowcaseProfileSummary = {
  readonly timestampSampleCount: number;
  readonly gpuTotal: Percentiles | null;
  readonly gpuDomains: ReadonlyMap<ShowcaseGpuDomain, Percentiles>;
  readonly latestCommands: Readonly<Record<string, number>>;
  readonly latestSubmitCount: number | null;
  readonly latestGpuCounters: Readonly<Partial<GpuCounterValues>>;
  readonly latestTimestampFrame: number | null;
  readonly latestCounterFrame: number | null;
};

/** Bounded, replacement-safe window because delayed GPU evidence updates an existing frame. */
export class ShowcaseEvidenceWindow {
  private readonly frames = new Map<number, FrameProfileSnapshot>();

  constructor(private readonly capacity = 180) {}

  update(snapshot: FrameProfileSnapshot): void {
    this.frames.set(snapshot.frameIndex, snapshot);
    while (this.frames.size > this.capacity) {
      const oldest = Math.min(...this.frames.keys());
      this.frames.delete(oldest);
    }
  }

  summarize(): ShowcaseProfileSummary {
    const ordered = [...this.frames.values()].sort((a, b) => a.frameIndex - b.frameIndex);
    const completedTimings = ordered.filter((frame) =>
      frame.gpu.sampled && !frame.gpu.pending && frame.gpu.segments.length > 0
    );
    const totals = completedTimings.map((frame) =>
      frame.gpu.segments.reduce((sum, segment) => sum + segment.durationMs, 0)
    );
    const domainValues = new Map<ShowcaseGpuDomain, number[]>();
    for (const frame of completedTimings) {
      const perFrame = new Map<ShowcaseGpuDomain, number>();
      for (const segment of frame.gpu.segments) {
        const domain = classifyShowcaseGpuDomain(segment);
        perFrame.set(domain, (perFrame.get(domain) ?? 0) + segment.durationMs);
      }
      for (const domain of SHOWCASE_GPU_DOMAINS) {
        const value = perFrame.get(domain);
        if (value === undefined) continue;
        const values = domainValues.get(domain) ?? [];
        values.push(value);
        domainValues.set(domain, values);
      }
    }
    const latestTiming = completedTimings.at(-1) ?? null;
    const completedCounters = ordered.filter((frame) =>
      frame.gpuCounters.sampled && !frame.gpuCounters.pending && !frame.gpuCounters.dropped
    );
    const latestCounter = completedCounters.at(-1) ?? null;
    const gpuDomains = new Map<ShowcaseGpuDomain, Percentiles>();
    for (const [domain, values] of domainValues) {
      const summary = percentiles(values);
      if (summary !== null) gpuDomains.set(domain, summary);
    }
    return Object.freeze({
      timestampSampleCount: completedTimings.length,
      gpuTotal: percentiles(totals),
      gpuDomains,
      latestCommands: Object.freeze({ ...(latestTiming?.counters ?? {}) }),
      latestSubmitCount: latestTiming?.submits.count ?? null,
      latestGpuCounters: Object.freeze({ ...(latestCounter?.gpuCounters.values ?? {}) }),
      latestTimestampFrame: latestTiming?.frameIndex ?? null,
      latestCounterFrame: latestCounter?.frameIndex ?? null
    });
  }
}

export function percentiles(values: readonly number[]): Percentiles | null {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  return Object.freeze({
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    p99: percentile(finite, 0.99)
  });
}

export function classifyShowcaseGpuDomain(segment: FrameGpuSegment): ShowcaseGpuDomain {
  const label = segment.label.toLocaleLowerCase("en-US");
  if (/q00|counter|observability|render debug/.test(label)) return "Observability";
  if (/ssao|gtao|ambient occlusion/.test(label)) return "GTAO";
  if (/\bssr\b|screen.?space reflection|reflection resolve/.test(label)) return "SSR";
  if (/bloom/.test(label)) return "Bloom";
  if (/automatic exposure|\bexposure\b|histogram/.test(label)) return "Exposure";
  if (/sharpen/.test(label)) return "Sharpen";
  if (/tonemap|tone map|present/.test(label)) return "Tonemap";
  if (/temporal|\btaa\b|\btaau\b|\bnss\b|velocity|history|occlusion confidence/.test(label)) {
    return "Temporal";
  }
  if (/shadow|cascade|csm/.test(label)) return "Shadow";
  if (/transparent|\boit\b/.test(label)) return "Transparency";
  if (/material|surface|g.?buffer/.test(label)) return "Surface";
  if (/lighting|light cluster|environment|\bibl\b|indirect|lpv|brick4/.test(label)) {
    return "Lighting & IBL";
  }
  if (/visibility|raster|hzb|hierarch|meshlet|cluster.?cull|work generation|frustum/.test(label)) {
    return "Visibility";
  }
  return "Other";
}

function percentile(sorted: readonly number[], quantile: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index]!;
}

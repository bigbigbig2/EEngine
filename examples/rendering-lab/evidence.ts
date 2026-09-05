import type {
  FrameGpuSegment,
  FrameProfileSnapshot,
  GpuCounterValues,
  GpuFramePhase
} from "../../OEngine/src/index.ts";

export const SHOWCASE_GPU_DOMAINS = [
  "Visibility", "Surface", "Shadow", "Lighting & IBL", "GTAO", "SSR",
  "Temporal", "Transparency", "Bloom", "Exposure", "Sharpen", "Tonemap",
  "Observability", "Other"
] as const;

export type ShowcaseGpuDomain = (typeof SHOWCASE_GPU_DOMAINS)[number];

export type Percentiles = {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly sampleCount: number;
};

export type ShowcasePassTiming = Percentiles & {
  readonly label: string;
  readonly type: FrameGpuSegment["type"];
  readonly phase: GpuFramePhase;
};

export type ShowcaseFrameRegistration = {
  readonly rafIntervalMs?: number;
  readonly sampleKey?: string;
  readonly warmupFrames?: number;
};

export type ShowcaseProfileSummary = {
  /** Stable, non-counter-instrumented timestamp frames in the active epoch. */
  readonly timestampSampleCount: number;
  readonly counterSampleCount: number;
  readonly counterInstrumentedTimestampSampleCount: number;
  readonly sampleEpoch: number;
  readonly sampleKey: string;
  readonly warmupFramesRemaining: number;
  readonly frameInterval: Percentiles | null;
  readonly cpuFrame: Percentiles | null;
  /** Timestamped render/compute pass sum. This is not wall-clock GPU frame time. */
  readonly gpuPassSum: Percentiles | null;
  /** Backward-compatible alias for existing capture consumers. */
  readonly gpuTotal: Percentiles | null;
  readonly gpuPhases: ReadonlyMap<GpuFramePhase, Percentiles>;
  readonly gpuPasses: readonly ShowcasePassTiming[];
  readonly observability: Percentiles | null;
  readonly gpuDomains: ReadonlyMap<ShowcaseGpuDomain, Percentiles>;
  readonly latestCommands: Readonly<Record<string, number>>;
  readonly latestSubmitCount: number | null;
  readonly latestGpuCounters: Readonly<Partial<GpuCounterValues>>;
  readonly latestTimestampFrame: number | null;
  readonly latestCounterFrame: number | null;
};

type FrameContext = {
  readonly epoch: number;
  readonly sampleKey: string;
  readonly warmup: boolean;
  readonly rafIntervalMs: number | null;
};

type FrameRecord = {
  snapshot: FrameProfileSnapshot | null;
  context: FrameContext;
};

type PassAccumulator = {
  readonly label: string;
  readonly type: FrameGpuSegment["type"];
  readonly phase: GpuFramePhase;
  readonly values: number[];
};

/**
 * Bounded, replacement-safe evidence window.
 *
 * GPU readbacks replace their original frame asynchronously. Registering before render preserves
 * the epoch and warm-up identity when that delayed evidence eventually arrives.
 */
/**
 * Machine-readable capture helper for the Q00 browser API. Rendering Lab no
 * longer renders this data into a duplicate statistics panel; the shared
 * Performance Inspector is the canonical visible consumer.
 */
export class ShowcaseEvidenceWindow {
  private readonly frames = new Map<number, FrameRecord>();
  private activeEpoch = 0;
  private activeSampleKey = "legacy";
  private warmupFramesRemaining = 0;

  constructor(private readonly capacity = 180) {}

  beginEpoch(sampleKey: string, warmupFrames = 0): number {
    this.activeEpoch++;
    this.activeSampleKey = sampleKey;
    this.warmupFramesRemaining = Math.max(0, Math.floor(warmupFrames));
    return this.activeEpoch;
  }

  registerFrame(frameIndex: number, registration: ShowcaseFrameRegistration = {}): void {
    if (registration.sampleKey !== undefined && registration.sampleKey !== this.activeSampleKey) {
      this.beginEpoch(registration.sampleKey, registration.warmupFrames ?? 0);
    }
    const existing = this.frames.get(frameIndex);
    const warmup = this.warmupFramesRemaining > 0;
    if (warmup) this.warmupFramesRemaining--;
    this.frames.set(frameIndex, {
      snapshot: existing?.snapshot ?? null,
      context: {
        epoch: this.activeEpoch,
        sampleKey: this.activeSampleKey,
        warmup,
        rafIntervalMs: finitePositive(registration.rafIntervalMs)
      }
    });
    this.trim();
  }

  update(snapshot: FrameProfileSnapshot): void {
    const existing = this.frames.get(snapshot.frameIndex);
    this.frames.set(snapshot.frameIndex, {
      snapshot,
      context: existing?.context ?? {
        epoch: this.activeEpoch,
        sampleKey: this.activeSampleKey,
        warmup: false,
        rafIntervalMs: null
      }
    });
    this.trim();
  }

  summarize(): ShowcaseProfileSummary {
    const ordered = [...this.frames.values()]
      .filter((record): record is FrameRecord & { snapshot: FrameProfileSnapshot } =>
        record.snapshot !== null && record.context.epoch === this.activeEpoch &&
        record.context.sampleKey === this.activeSampleKey && !record.context.warmup
      )
      .sort((a, b) => a.snapshot.frameIndex - b.snapshot.frameIndex);
    const completedTimings = ordered.filter(({ snapshot }) =>
      snapshot.gpu.sampled && !snapshot.gpu.pending && snapshot.gpu.segments.length > 0
    );
    const productionTimings = completedTimings.filter(({ snapshot }) => !snapshot.gpuCounters.sampled);
    const instrumentedTimings = completedTimings.filter(({ snapshot }) => snapshot.gpuCounters.sampled);
    const completedCounters = ordered.filter(({ snapshot }) =>
      snapshot.gpuCounters.sampled && !snapshot.gpuCounters.pending && !snapshot.gpuCounters.dropped
    );

    const gpuPassSums: number[] = [];
    const phaseValues = new Map<GpuFramePhase, number[]>();
    const domainValues = new Map<ShowcaseGpuDomain, number[]>();
    const passValues = new Map<string, PassAccumulator>();
    for (const { snapshot } of productionTimings) {
      const perPhase = new Map<GpuFramePhase, number>();
      const perDomain = new Map<ShowcaseGpuDomain, number>();
      let passSum = 0;
      for (const segment of snapshot.gpu.segments) {
        if (segment.phase === "observability") continue;
        passSum += segment.durationMs;
        perPhase.set(segment.phase, (perPhase.get(segment.phase) ?? 0) + segment.durationMs);
        const domain = classifyShowcaseGpuDomain(segment);
        perDomain.set(domain, (perDomain.get(domain) ?? 0) + segment.durationMs);
        const key = `${segment.phase}\u0000${segment.type}\u0000${segment.label}`;
        const pass = passValues.get(key) ?? {
          label: segment.label, type: segment.type, phase: segment.phase, values: []
        };
        pass.values.push(segment.durationMs);
        passValues.set(key, pass);
      }
      gpuPassSums.push(passSum);
      appendFrameTotals(phaseValues, perPhase);
      appendFrameTotals(domainValues, perDomain);
    }

    const observabilityValues: number[] = [];
    for (const { snapshot } of completedTimings) {
      const total = snapshot.gpu.segments.reduce(
        (sum, segment) => sum + (segment.phase === "observability" ? segment.durationMs : 0), 0
      );
      if (total > 0) observabilityValues.push(total);
    }

    const gpuPhases = summarizeMap(phaseValues);
    const gpuDomains = summarizeMap(domainValues);
    const gpuPasses = [...passValues.values()]
      .map((pass): ShowcasePassTiming | null => {
        const timing = percentiles(pass.values);
        return timing === null ? null : Object.freeze({
          label: pass.label, type: pass.type, phase: pass.phase, ...timing
        });
      })
      .filter((pass): pass is ShowcasePassTiming => pass !== null)
      .sort((a, b) => b.p50 - a.p50);
    const latestTiming = productionTimings.at(-1)?.snapshot ?? null;
    const latestCounter = completedCounters.at(-1)?.snapshot ?? null;
    const gpuPassSum = percentiles(gpuPassSums);

    return Object.freeze({
      timestampSampleCount: productionTimings.length,
      counterSampleCount: completedCounters.length,
      counterInstrumentedTimestampSampleCount: instrumentedTimings.length,
      sampleEpoch: this.activeEpoch,
      sampleKey: this.activeSampleKey,
      warmupFramesRemaining: this.warmupFramesRemaining,
      frameInterval: percentiles(ordered.map(({ context }) => context.rafIntervalMs).filter(isNumber)),
      cpuFrame: percentiles(ordered.map(({ snapshot }) => snapshot.cpuMs.frame).filter(isNumber)),
      gpuPassSum,
      gpuTotal: gpuPassSum,
      gpuPhases,
      gpuPasses: Object.freeze(gpuPasses),
      observability: percentiles(observabilityValues),
      gpuDomains,
      latestCommands: Object.freeze({ ...(latestTiming?.counters ?? {}) }),
      latestSubmitCount: latestTiming?.submits.count ?? null,
      latestGpuCounters: Object.freeze({ ...(latestCounter?.gpuCounters.values ?? {}) }),
      latestTimestampFrame: latestTiming?.frameIndex ?? null,
      latestCounterFrame: latestCounter?.frameIndex ?? null
    });
  }

  private trim(): void {
    while (this.frames.size > this.capacity) {
      const oldest = Math.min(...this.frames.keys());
      this.frames.delete(oldest);
    }
  }
}

export function percentiles(values: readonly number[]): Percentiles | null {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  return Object.freeze({
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    p99: percentile(finite, 0.99),
    sampleCount: finite.length
  });
}

export function classifyShowcaseGpuDomain(segment: FrameGpuSegment): ShowcaseGpuDomain {
  const label = segment.label.toLocaleLowerCase("en-US");
  switch (segment.phase) {
    case "observability": return "Observability";
    case "instance-cull":
    case "hierarchy-and-cluster-cull":
    case "software-raster":
    case "hardware-raster":
    case "hzb": return "Visibility";
    case "material-resolve": return "Surface";
    case "shadow": return "Shadow";
    case "transparency": return "Transparency";
    case "temporal": return "Temporal";
    case "light-cluster": return "Lighting & IBL";
    case "lighting-and-ibl":
      if (/ssao|gtao|ambient occlusion/.test(label)) return "GTAO";
      if (/\bssr\b|screen.?space reflection|reflection resolve/.test(label)) return "SSR";
      return "Lighting & IBL";
    case "post": return classifyPostDomain(label);
    case "upload":
    case "animation":
    case "frame": return "Other";
    case "unclassified": return classifyUnclassifiedDomain(label);
  }
}

function classifyPostDomain(label: string): ShowcaseGpuDomain {
  if (/bloom/.test(label)) return "Bloom";
  if (/automatic exposure|\bexposure\b|histogram/.test(label)) return "Exposure";
  if (/sharpen/.test(label)) return "Sharpen";
  if (/tonemap|tone map|present/.test(label)) return "Tonemap";
  return "Other";
}

function classifyUnclassifiedDomain(label: string): ShowcaseGpuDomain {
  if (/q00|counter|observability|render debug/.test(label)) return "Observability";
  if (/ssao|gtao|ambient occlusion/.test(label)) return "GTAO";
  if (/\bssr\b|screen.?space reflection|reflection resolve/.test(label)) return "SSR";
  if (/shadow|cascade|csm/.test(label)) return "Shadow";
  if (/transparent|\boit\b/.test(label)) return "Transparency";
  if (/material|surface|g.?buffer/.test(label)) return "Surface";
  if (/temporal|\btaa\b|\btaau\b|\bnss\b|velocity|history|occlusion confidence/.test(label)) {
    return "Temporal";
  }
  if (/lighting|light cluster|environment|\bibl\b|indirect|lpv|brick4/.test(label)) {
    return "Lighting & IBL";
  }
  if (/visibility|raster|hzb|hierarch|meshlet|cluster.?cull|work generation|frustum/.test(label)) {
    return "Visibility";
  }
  return classifyPostDomain(label);
}

function appendFrameTotals<K extends string>(target: Map<K, number[]>, frame: ReadonlyMap<K, number>): void {
  for (const [key, value] of frame) {
    const values = target.get(key) ?? [];
    values.push(value);
    target.set(key, values);
  }
}

function summarizeMap<K extends string>(valuesByKey: ReadonlyMap<K, readonly number[]>): Map<K, Percentiles> {
  const summaries = new Map<K, Percentiles>();
  for (const [key, values] of valuesByKey) {
    const summary = percentiles(values);
    if (summary !== null) summaries.set(key, summary);
  }
  return summaries;
}

function finitePositive(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
}

function isNumber(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

function percentile(sorted: readonly number[], quantile: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index]!;
}

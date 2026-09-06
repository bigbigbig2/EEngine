import type {
  BenchmarkResult,
  BenchmarkSummary,
  SeriesSummary
} from "./BenchmarkHarness.js";

export type BenchmarkDeltaStatus =
  | "available"
  | "baseline-missing"
  | "variant-missing"
  | "insufficient-coverage"
  | "zero-baseline";

export interface BenchmarkMetricDelta {
  readonly metric: string;
  readonly baselineCaseId: string;
  readonly variantCaseId: string;
  readonly baseline: SeriesSummary | null;
  readonly variant: SeriesSummary | null;
  readonly baselineCoverage: number;
  readonly variantCoverage: number;
  readonly p50Absolute: number | null;
  readonly p95Absolute: number | null;
  readonly p99Absolute: number | null;
  readonly p50Percent: number | null;
  readonly p95Percent: number | null;
  readonly p99Percent: number | null;
  readonly status: BenchmarkDeltaStatus;
}

export interface BenchmarkComparison {
  readonly baselineCaseId: string;
  readonly variants: readonly {
    readonly caseId: string;
    readonly deltas: readonly BenchmarkMetricDelta[];
  }[];
}

const SUMMARY_GROUPS = [
  "cpuMs",
  "gpuMs",
  "gpuPhaseMs",
  "counters",
  "gpuCounters"
] as const satisfies readonly (keyof BenchmarkSummary)[];

/**
 * Compares two completed benchmark results without combining CPU and GPU clocks.
 * A delta is only ratio-qualified when both series have sufficient samples and
 * the baseline P50 is non-zero.
 */
export function compareBenchmarkResults(
  baseline: BenchmarkResult,
  variants: readonly BenchmarkResult[],
  minimumCoverage = 0.8
): BenchmarkComparison {
  if (!Number.isFinite(minimumCoverage) || minimumCoverage <= 0 || minimumCoverage > 1) {
    throw new RangeError("minimumCoverage must be in (0, 1]");
  }
  const baselineCaseId = baseline.case.id;
  return Object.freeze({
    baselineCaseId,
    variants: Object.freeze(variants.map((variant) => Object.freeze({
      caseId: variant.case.id,
      deltas: Object.freeze(comparePair(baseline, variant, minimumCoverage))
    })))
  });
}

function comparePair(
  baseline: BenchmarkResult,
  variant: BenchmarkResult,
  minimumCoverage: number
): BenchmarkMetricDelta[] {
  const metrics = new Set<string>();
  for (const group of SUMMARY_GROUPS) {
    for (const metric of Object.keys(baseline.summary[group])) metrics.add(`${group}.${metric}`);
    for (const metric of Object.keys(variant.summary[group])) metrics.add(`${group}.${metric}`);
  }
  metrics.add("submits");
  metrics.add("readbacks");
  metrics.add("uploadBytes");
  return [...metrics].sort((a, b) => a.localeCompare(b)).map((metric) => {
    const baselineSeries = readSeries(baseline.summary, metric);
    const variantSeries = readSeries(variant.summary, metric);
    const baselineCoverage = coverage(baselineSeries, baseline);
    const variantCoverage = coverage(variantSeries, variant);
    const status = resolveStatus(baselineSeries, variantSeries, baselineCoverage, variantCoverage, minimumCoverage);
    return Object.freeze({
      metric,
      baselineCaseId: baseline.case.id,
      variantCaseId: variant.case.id,
      baseline: baselineSeries,
      variant: variantSeries,
      baselineCoverage,
      variantCoverage,
      p50Absolute: status === "available" ? variantSeries!.p50 - baselineSeries!.p50 : null,
      p95Absolute: status === "available" ? variantSeries!.p95 - baselineSeries!.p95 : null,
      p99Absolute: status === "available" ? variantSeries!.p99 - baselineSeries!.p99 : null,
      p50Percent: status === "available" ? percentDelta(variantSeries!.p50, baselineSeries!.p50) : null,
      p95Percent: status === "available" ? percentDelta(variantSeries!.p95, baselineSeries!.p95) : null,
      p99Percent: status === "available" ? percentDelta(variantSeries!.p99, baselineSeries!.p99) : null,
      status
    });
  });
}

function readSeries(summary: BenchmarkSummary, metric: string): SeriesSummary | null {
  if (metric === "submits" || metric === "readbacks" || metric === "uploadBytes") {
    return summary[metric];
  }
  const separator = metric.indexOf(".");
  if (separator <= 0) return null;
  const group = metric.slice(0, separator) as keyof BenchmarkSummary;
  const name = metric.slice(separator + 1);
  const value = summary[group];
  if (value === undefined || Array.isArray(value) || typeof value !== "object") return null;
  return (value as Record<string, SeriesSummary>)[name] ?? null;
}

function coverage(series: SeriesSummary | null, result: BenchmarkResult): number {
  return series === null ? 0 : series.count / result.environment.run.sampleFrames;
}

function resolveStatus(
  baseline: SeriesSummary | null,
  variant: SeriesSummary | null,
  baselineCoverage: number,
  variantCoverage: number,
  minimumCoverage: number
): BenchmarkDeltaStatus {
  if (baseline === null) return "baseline-missing";
  if (variant === null) return "variant-missing";
  if (baselineCoverage < minimumCoverage || variantCoverage < minimumCoverage) return "insufficient-coverage";
  if (baseline.p50 === 0) return "zero-baseline";
  return "available";
}

function percentDelta(value: number, baseline: number): number | null {
  return baseline === 0 ? null : (value - baseline) / baseline * 100;
}

import type { MetricSample, MetricSampleAvailability } from "./Metric.js";

export interface ProfileSeriesSummary {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export interface ProfileCoverageSummary {
  readonly total: number;
  readonly available: number;
  readonly pending: number;
  readonly unsupported: number;
  readonly invalid: number;
  readonly dropped: number;
  readonly availableRatio: number;
}

/** Deterministic nearest-rank statistics used by benchmark and Inspector views. */
export function summarizeProfileSeries(values: readonly number[]): ProfileSeriesSummary | null {
  if (values.length === 0) return null;
  for (const value of values) {
    if (!Number.isFinite(value)) throw new RangeError("Profile series values must be finite");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean: sum / sorted.length,
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    p99: nearestRank(sorted, 0.99)
  };
}

export function summarizeMetricCoverage(
  samples: readonly Pick<MetricSample, "availability">[]
): ProfileCoverageSummary {
  const counts: Record<MetricSampleAvailability, number> = {
    available: 0,
    pending: 0,
    unsupported: 0,
    invalid: 0,
    dropped: 0
  };
  for (const sample of samples) counts[sample.availability]++;
  const total = samples.length;
  return {
    total,
    available: counts.available,
    pending: counts.pending,
    unsupported: counts.unsupported,
    invalid: counts.invalid,
    dropped: counts.dropped,
    availableRatio: total === 0 ? 0 : counts.available / total
  };
}

function nearestRank(sorted: readonly number[], quantile: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!;
}

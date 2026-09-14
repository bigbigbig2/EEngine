/** Pure aggregation for the two example pages; asynchronous patches replace a frame by id. */
export interface ExperimentFrame {
  frameIndex: number;
  cpuMs: Record<string, number>;
  counters: Record<string, number>;
  submits: { count: number };
  uploads: { bytes: number };
  readbacks: { bytes: number };
  graph?: { cacheHits: number; cacheMisses: number };
  gpu: { available: boolean; sampled: boolean; pending: boolean; segments: { label: string; phase: string; durationMs: number }[] };
  gpuCounters: { sampled: boolean; pending: boolean; dropped: boolean; values: Partial<Record<string, number>> };
  gpuValid: boolean;
}

export interface Distribution { count: number; p50: number; p95: number; mean: number; max: number }

export function distribution(values: readonly number[]): Distribution | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  // Nearest rank; sample counts accompany every percentile.
  const rank = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return { count: sorted.length, p50: rank(0.5), p95: rank(0.95), mean: sorted.reduce((a, b) => a + b, 0) / sorted.length, max: sorted.at(-1)! };
}

export function gpuRows(frames: readonly ExperimentFrame[], groupBy: "pass" | "phase"): Map<string, Distribution> {
  const series = new Map<string, number[]>();
  for (const frame of frames) {
    if (!frame.gpuValid) continue;
    const totals = new Map<string, number>();
    for (const segment of frame.gpu.segments) {
      const key = groupBy === "pass" ? segment.label : segment.phase;
      totals.set(key, (totals.get(key) ?? 0) + segment.durationMs);
    }
    // An absent pass is absent, not a fabricated zero-duration measurement.
    for (const [key, value] of totals) {
      if (!series.has(key)) series.set(key, []);
      series.get(key)!.push(value);
    }
  }
  return new Map([...series].map(([key, values]) => [key, distribution(values)!] as const).sort((a, b) => b[1].p50 - a[1].p50));
}

export function sparseRatios(frame: ExperimentFrame): { pixels: number; records: number; workgroups: number; invocations: number; amplification: number; padding: number } | null {
  const values = frame.gpuCounters.values;
  if (!frame.gpuCounters.sampled || frame.gpuCounters.pending || frame.gpuCounters.dropped) return null;
  const names = ["geometryVisiblePixels", "shadingBinWritten", "shadingBinIndirectWorkgroups", "shadingBinFrameFlags", "shadingBinErrors", "shadingBinOverflow"];
  if (names.some((name) => !Number.isFinite(values[name]))) return null;
  if (values.shadingBinFrameFlags !== 0 || values.shadingBinErrors !== 0 || values.shadingBinOverflow !== 0) return null;
  const pixels = values.geometryVisiblePixels!;
  const records = values.shadingBinWritten!;
  const workgroups = values.shadingBinIndirectWorkgroups!;
  if (pixels <= 0 || records <= 0 || workgroups < records) return null;
  return { pixels, records, workgroups, invocations: workgroups * 64, amplification: workgroups * 64 / pixels, padding: workgroups / records };
}

export function frameSeries(frames: readonly ExperimentFrame[], metric: "gpu" | "cpu" | "raf"): number[] {
  return frames.flatMap((frame) => {
    const value = metric === "gpu" ? (frame.gpuValid ? frame.gpu.segments.reduce((sum, segment) => sum + segment.durationMs, 0) : undefined)
      : metric === "cpu" ? frame.cpuMs.frame : frame.counters["frame.rafIntervalMs"];
    return value !== undefined && Number.isFinite(value) ? [value] : [];
  });
}

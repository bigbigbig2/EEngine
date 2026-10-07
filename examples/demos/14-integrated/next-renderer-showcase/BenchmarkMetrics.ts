import { distribution, type ExperimentFrame } from "../shared/PerformanceMetrics.ts";
import {
  classifySurfaceTimingPhase,
  surfaceTimingTotalsForFrame,
  SURFACE_TIMING_PHASES
} from "../../../../OEngine/src/debug/SurfacePhaseTiming.ts";
import { summarizeGpuTimingCost } from "../../../../OEngine/src/debug/GpuTimingCost.ts";

/** Local integration: fixed-range captures retain late patches and every slow frame. */
export interface TimedFrame extends ExperimentFrame {
  cpuEncodeStartUnixMs?: number;
  cpuEncodeEndUnixMs?: number;
  gpuResultObservedUnixMs?: number;
}

export function validGpuFrame(frame: ExperimentFrame): boolean {
  return (
    frame.gpu.available &&
    frame.gpu.sampled &&
    !frame.gpu.pending &&
    !(frame.counters["gpu.timing.truncated"] > 0) &&
    frame.gpu.segments.length > 0 &&
    frame.gpu.segments.every((s) => Number.isFinite(s.durationMs) && s.durationMs >= 0) &&
    frame.gpu.segments.reduce((sum, s) => sum + s.durationMs, 0) > 0
  );
}

export function summarizeCapture(frames: readonly TimedFrame[]) {
  const unique = [...new Map(frames.map((frame) => [frame.frameIndex, frame])).values()].sort(
    (a, b) => a.frameIndex - b.frameIndex
  );
  const valid = unique.filter(validGpuFrame);
  const passSeries = new Map<string, number[]>();
  const surfacePhaseSeries = new Map<string, number[]>();
  const total: number[] = [],
    surface: number[] = [],
    surfaceSpan: number[] = [],
    frameSpan: number[] = [];
  const costs = new Map<string, number[]>();
  for (const frame of valid) {
    const segments = frame.gpu.segments.map(({ label, durationMs, scope }) => ({ label, durationMs, scope }));
    const cost = summarizeGpuTimingCost(segments);
    for (const name of [
      "outsidePassMs",
      "surfaceManagementMs",
      "surfaceEvaluationMs",
      "surfaceAuxiliaryMs",
      "unclassifiedPassMs"
    ] as const) {
      const value = cost[name];
      if (value !== null) {
        const values = costs.get(name) ?? [];
        values.push(value);
        costs.set(name, values);
      }
    }
    const passes = new Map<string, number>();
    for (const segment of frame.gpu.segments)
      if (segment.scope === undefined || segment.scope === "pass")
        passes.set(segment.label, (passes.get(segment.label) ?? 0) + segment.durationMs);
    if (passes.size) total.push([...passes.values()].reduce((a, b) => a + b, 0));
    const surfaceTotals = surfaceTimingTotalsForFrame(segments);
    if (surfaceTotals.size) surface.push([...surfaceTotals.values()].reduce((sum, ms) => sum + ms, 0));
    for (const phase of SURFACE_TIMING_PHASES) {
      const ms = surfaceTotals.get(phase);
      if (ms === undefined) continue;
      if (!surfacePhaseSeries.has(phase)) surfacePhaseSeries.set(phase, []);
      surfacePhaseSeries.get(phase)!.push(ms);
    }
    const ticks = frame.gpu.segments
      .filter(
        (segment) =>
          (segment.scope === undefined || segment.scope === "pass") &&
          classifySurfaceTimingPhase({ label: segment.label }) !== null
      )
      .flatMap((segment) =>
        segment.startTick !== undefined && segment.endTick !== undefined
          ? [{ start: BigInt(segment.startTick), end: BigInt(segment.endTick) }]
          : []
      );
    const stageSpans = frame.gpu.segments.filter(
      (segment) => segment.scope === "stage" && segment.label.endsWith("/native-surface")
    );
    const elapsed = stageSpans.length
      ? stageSpans.reduce((sum, segment) => sum + segment.durationMs, 0)
      : tickSpan(ticks);
    if (elapsed !== null) {
      surfaceSpan.push(elapsed);
    }
    const allTicks = frame.gpu.segments.flatMap((segment) =>
      segment.startTick !== undefined && segment.endTick !== undefined
        ? [{ start: BigInt(segment.startTick), end: BigInt(segment.endTick) }]
        : []
    );
    const frameElapsed = cost.commandSpanMs ?? tickSpan(allTicks);
    if (frameElapsed !== null) {
      frameSpan.push(frameElapsed);
    }
    for (const [label, ms] of passes) {
      if (!passSeries.has(label)) passSeries.set(label, []);
      passSeries.get(label)!.push(ms);
    }
  }
  const counterFrames = unique.filter(
    (frame) => frame.gpuCounters.sampled && !frame.gpuCounters.pending && !frame.gpuCounters.dropped
  );
  const counterNames = new Set(counterFrames.flatMap((frame) => Object.keys(frame.gpuCounters.values)));
  const counters = Object.fromEntries(
    [...counterNames].map((name) => {
      const values = counterFrames.flatMap((frame) =>
        Number.isFinite(frame.gpuCounters.values[name]) ? [frame.gpuCounters.values[name]!] : []
      );
      return [
        name,
        values.length
          ? {
              count: values.length,
              min: Math.min(...values),
              max: Math.max(...values),
              ...distribution(values)
            }
          : null
      ];
    })
  );
  return {
    submitted: unique.length,
    completedGpu: valid.length,
    invalidGpuFrameIds: unique.filter((frame) => !validGpuFrame(frame)).map((frame) => frame.frameIndex),
    gpuPassSumMs: distribution(total),
    gpuFrameSpanMs: distribution(frameSpan),
    surfaceMs: distribution(surface),
    surfacePassSumMs: distribution(surface),
    surfaceSpanMs: distribution(surfaceSpan),
    cpuMs: distribution(unique.map((frame) => frame.cpuMs.frame)),
    // This is the sum of measured pass intervals, not queue wall time or FPS.
    passes: [...passSeries]
      .map(([label, values]) => ({ label, ...distribution(values)! }))
      .sort((a, b) => b.p50 - a.p50),
    surfacePhases: Object.fromEntries(
      [...surfacePhaseSeries].map(([phase, values]) => [phase, distribution(values)!])
    ),
    pairedCosts: Object.fromEntries([...costs].map(([name, values]) => [name, distribution(values)])),
    counters,
    multipleSubmitFrameIds: unique
      .filter((frame) => frame.submits.count !== 1)
      .map((frame) => frame.frameIndex),
    slowFrames: valid
      .filter((frame) => {
        const spans = frame.gpu.segments.filter((segment) => segment.scope === "span");
        const intervals = spans.length
          ? spans
          : frame.gpu.segments.filter((segment) => segment.scope === undefined || segment.scope === "pass");
        return intervals.reduce((total, segment) => total + segment.durationMs, 0) > 70;
      })
      .map((frame) => frame.frameIndex)
  };
}

function tickSpan(ticks: readonly { start: bigint; end: bigint }[]): number | null {
  if (ticks.length === 0) {
    return null;
  }
  let first = ticks[0]!.start;
  let last = ticks[0]!.end;
  for (const interval of ticks) {
    if (interval.start < first) {
      first = interval.start;
    }
    if (interval.end > last) {
      last = interval.end;
    }
  }
  return Number(last - first) * 1e-6;
}

/** Compare only identical workloads and quality; diagnostic ablations are sensitivity experiments. */
export function compareCaptures(
  a: { conditions: unknown; frames: TimedFrame[] },
  b: { conditions: unknown; frames: TimedFrame[] }
) {
  if (JSON.stringify(a.conditions) !== JSON.stringify(b.conditions))
    throw new Error("Capture conditions differ; performance comparison refused");
  const left = summarizeCapture(a.frames),
    right = summarizeCapture(b.frames);
  if (
    left.invalidGpuFrameIds.length ||
    right.invalidGpuFrameIds.length ||
    !left.gpuPassSumMs ||
    !right.gpuPassSumMs
  ) {
    throw new Error("Incomplete GPU capture; performance comparison refused");
  }
  return {
    baseline: left,
    current: right,
    p50Ratio: right.gpuPassSumMs.p50 / left.gpuPassSumMs.p50,
    p95Ratio: right.gpuPassSumMs.p95 / left.gpuPassSumMs.p95
  };
}

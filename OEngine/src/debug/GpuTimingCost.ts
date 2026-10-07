import {
  classifySurfaceTimingPhase,
  surfaceTimingTotalsForFrame,
  type SurfaceTimingSegment
} from "./SurfacePhaseTiming.js";

export interface GpuTimingCost {
  readonly complete: boolean;
  readonly commandSpanMs: number | null;
  readonly commandSpanCount: number;
  readonly passSumMs: number | null;
  readonly stageMs: Readonly<Record<string, number>>;
  /** Includes copy/clear/gaps and instrumentation; never called memory bandwidth. */
  readonly outsidePassMs: number | null;
  readonly surfacePassSumMs: number | null;
  readonly surfaceManagementMs: number | null;
  readonly surfaceEvaluationMs: number | null;
  readonly surfaceAuxiliaryMs: number | null;
  readonly unclassifiedPassMs: number | null;
  readonly queueCompletionMs: null;
}
export function summarizeGpuTimingCost(
  segments: readonly SurfaceTimingSegment[],
  complete = true
): GpuTimingCost {
  const spans = segments.filter((segment) => segment.scope === "span");
  const passes = segments.filter((segment) => segment.scope === undefined || segment.scope === "pass");
  const sum = (items: readonly SurfaceTimingSegment[]) =>
    items.reduce((total, segment) => total + segment.durationMs, 0);
  const commandSpanMs = spans.length ? sum(spans) : null;
  const passSumMs = passes.length ? sum(passes) : null;
  const stageMs: Record<string, number> = {};
  for (const segment of segments) {
    if (segment.scope === "stage") {
      stageMs[segment.label] = (stageMs[segment.label] ?? 0) + segment.durationMs;
    }
  }
  const totals = surfaceTimingTotalsForFrame(passes);
  let management = 0,
    evaluation = 0,
    auxiliary = 0;
  let managementMeasured = false,
    evaluationMeasured = false,
    auxiliaryMeasured = false;
  for (const [phase, value] of totals) {
    if (phase === "nativeShading" || phase === "nativeSun") {
      evaluation += value;
      evaluationMeasured = true;
    } else if (phase === "background") {
      auxiliary += value;
      auxiliaryMeasured = true;
    } else {
      management += value;
      managementMeasured = true;
    }
  }
  return {
    complete,
    commandSpanMs,
    commandSpanCount: spans.length,
    passSumMs,
    stageMs,
    outsidePassMs:
      !complete || commandSpanMs === null || passSumMs === null ? null : commandSpanMs - passSumMs,
    surfacePassSumMs: complete && totals.size ? management + evaluation + auxiliary : null,
    surfaceManagementMs: complete && managementMeasured ? management : null,
    surfaceEvaluationMs: complete && evaluationMeasured ? evaluation : null,
    surfaceAuxiliaryMs: complete && auxiliaryMeasured ? auxiliary : null,
    unclassifiedPassMs: passes.length
      ? sum(
          passes.filter(
            (segment) =>
              classifySurfaceTimingPhase(segment) === null &&
              (segment.phase === "unclassified" || segment.phase === undefined)
          )
        )
      : null,
    queueCompletionMs: null
  };
}

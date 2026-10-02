import {
  classifyGpuFramePhase,
  type GpuFramePhase
} from "./GpuFramePhase.js";

export const SURFACE_TIMING_PHASES = [
  "classify",
  "workFinalize",
  "materialLookup",
  "geometryLookup",
  "geometryFinalize",
  "geometryResolve",
  "materialFinalize",
  "materialEvaluate",
  "lighting",
  "reconstruct"
] as const;

export type SurfaceTimingPhase = (typeof SURFACE_TIMING_PHASES)[number];

export interface SurfaceTimingSegment {
  readonly label: string;
  readonly durationMs: number;
  readonly phase?: GpuFramePhase;
}

/**
 * Maps exact V3 production labels onto stable report phases. Unknown work is
 * deliberately omitted and remains an external interval in the report.
 */
export function classifySurfaceTimingPhase(
  segment: Pick<SurfaceTimingSegment, "label" | "phase">
): SurfaceTimingPhase | null {
  const label = segment.label.trim().toLocaleLowerCase("en-US");
  if (label.length === 0) return null;

  if (/surfacework\/classify(?: implicit-uniform-mixed)?$/.test(label)) {
    return "classify";
  }
  if (/surfacework\/finalize counters/.test(label)) {
    return "workFinalize";
  }
  if (/surface\/material publication lookup/.test(label)) {
    return "materialLookup";
  }
  if (/surface\/geometryrecord cache classify/.test(label)) {
    return "geometryLookup";
  }
  if (/surface\/geometryrecord miss finalize/.test(label)) {
    return "geometryFinalize";
  }
  if (/surface\/geometryrecord miss resolve|surface\/geometryrecord$/.test(label)) {
    return "geometryResolve";
  }
  if (/surface\/material miss indirect finalize|surface\/material miss queue compact/.test(label)) {
    return "materialFinalize";
  }
  if (/surface\/material miss publication evaluation|surface\/material publication kernel \d+$/.test(label)) {
    return "materialEvaluate";
  }
  if (/surface\/lighting packets/.test(label)) {
    return "lighting";
  }
  if (/surface\/reconstruct/.test(label)) {
    return "reconstruct";
  }

  return null;
}

/** Sum every matching pass once per frame before percentile aggregation. */
export function surfaceTimingTotalsForFrame(
  segments: readonly SurfaceTimingSegment[]
): ReadonlyMap<SurfaceTimingPhase, number> {
  const totals = new Map<SurfaceTimingPhase, number>();
  for (const segment of segments) {
    const phase = classifySurfaceTimingPhase(segment);
    if (phase === null) continue;
    totals.set(
      phase,
      Math.round(((totals.get(phase) ?? 0) + segment.durationMs) * 1e12) / 1e12
    );
  }
  return totals;
}

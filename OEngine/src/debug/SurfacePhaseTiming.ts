import type { GpuFramePhase } from "./GpuFramePhase.js";

export const SURFACE_TIMING_PHASES = [
  "classify",
  "geometrySetup",
  "cacheMaintenance",
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

  if (label.includes("surface/cell ")) {
    return "classify";
  }
  if (/surfacegeometry\/(?:reset|request|finalize|build)_cell_geometry/.test(label)) {
    return "geometrySetup";
  }
  if (label.includes("surface/fieldstore lookup")) {
    return "materialLookup";
  }
  if (/surface\/(?:fieldstore|signalstore) /.test(label)) {
    return "cacheMaintenance";
  }

  if (/surfacework\/classify(?: implicit-uniform-mixed)?$/.test(label)) {
    return "classify";
  }
  if (/surfacework\/finalize counters/.test(label)) {
    return "workFinalize";
  }
  if (/surface\/material publication lookup|surface\/residency epoch/.test(label)) {
    return "materialLookup";
  }
  if (/surface\/geometryrecord cache classify|surface\/input witness|surface\/view epoch/.test(label)) {
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
  if (/surface\/lighting packets|surface\/lighting classify|surface\/lighting finalize/.test(label)) {
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

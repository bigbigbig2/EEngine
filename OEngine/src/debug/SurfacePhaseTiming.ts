import type { GpuFramePhase } from "./GpuFramePhase.js";

export const SURFACE_TIMING_PHASES = [
  "classify",
  "geometrySetup",
  "cacheMaintenance",
  "workFinalize",
  "materialLookup",
  "signalLookup",
  "address",
  "certificate",
  "demand",
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
  if(/surface\/.*diagnostic/.test(label)) { return null; }
  if(/surface\/canonical field addresses/.test(label)) { return "address"; }
  if(/surface\/shared .*certificates|surface\/publish_cell_.*certificates/.test(label)) { return "certificate"; }
  if(/surface\/(?:field value and certificate lookup|lookup_surface_fields|finalize_field_support|validate_field_support|commit_field_support)/.test(label)) { return "materialLookup"; }
  if(/surface\/kind-specific signal value lookup/.test(label)) { return "signalLookup"; }
  if(/surface\/field dependency |surface\/(?:lookup|reserve|commit|resolve)_field_dependency_versions|surface\/(?:field|signal) store/.test(label)) { return "cacheMaintenance"; }
  if(/surface\/(?:emit_surface_requests|emit_signal_cache_requests|finalize_surface_requests|nominate_.*producers|resolve_.*producers|compact_surface_groups|finalize_surface_groups|order_material_groups|actual demand|publish actual indirect)/.test(label)) { return "demand"; }
  if(/surface\/(?:single coverage scan|publish actual active range)/.test(label)) { return "classify"; }
  if(/surface\/unique geometryrecord/.test(label)) { return "geometryResolve"; }
  if(/surface\/unique dirty lighting/.test(label)) { return "lighting"; }
  if (/surface\/current radiometry envelope/.test(label)) { return "classify"; }
  if(/surface\/cheap .*reconstruct/.test(label)) { return "reconstruct"; }

  if (label.includes("surface/cell ")) {
    return "classify";
  }
  if (/surfacegeometry\/(?:reset|request|finalize|build)_cell_geometry/.test(label)) {
    return "geometrySetup";
  }
  if (/surfacegeometry\/(?:publish|commit)_cell_geometry_memo/.test(label)) { return "cacheMaintenance"; }
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
  if (/surface\/(?:reconstruct|background write domain|present radiance)/.test(label)) {
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

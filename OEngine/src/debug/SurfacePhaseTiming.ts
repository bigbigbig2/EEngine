import {
  classifyGpuFramePhase,
  type GpuFramePhase
} from "./GpuFramePhase.js";

export const SURFACE_TIMING_PHASES = [
  "classify",
  "classDepth",
  "resolve",
  "lighting"
] as const;

export type SurfaceTimingPhase = (typeof SURFACE_TIMING_PHASES)[number];

export interface SurfaceTimingSegment {
  readonly label: string;
  readonly durationMs: number;
  readonly phase?: GpuFramePhase;
}

/**
 * Maps implementation-level timestamp labels onto the stable Visibility-to-
 * Surface phases used by migration A/B reports. Unknown work is deliberately
 * omitted instead of being guessed into a phase.
 */
export function classifySurfaceTimingPhase(
  segment: Pick<SurfaceTimingSegment, "label" | "phase">
): SurfaceTimingPhase | null {
  const label = segment.label.trim().toLocaleLowerCase("en-US");
  if (label.length === 0) return null;

  if (/materialkernel\/publish sampled counters/.test(label)) return null;
  if (
    /materialclassdepth/.test(label) ||
    /material class depth/.test(label) ||
    /material-depth/.test(label)
  ) {
    return "classDepth";
  }
  if (
    /materialkernel\/(?:count visible pixels|prefix scan|add block prefixes|prepare class ranges|scatter shadework)/.test(label)
  ) {
    return "classify";
  }
  if (
    /material resolve\/(?:specialized surface|fullscreen kernels)/.test(label) ||
    /material surface kernel/.test(label)
  ) {
    return "resolve";
  }

  const phase = segment.phase ?? classifyGpuFramePhase(segment.label);
  return phase === "lighting-and-ibl" ? "lighting" : null;
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

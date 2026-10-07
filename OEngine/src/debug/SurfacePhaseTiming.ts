import type { GpuFramePhase } from "./GpuFramePhase.js";

export const SURFACE_TIMING_PHASES = ["executionBins", "nativeShading", "nativeSun", "background"] as const;
export type SurfaceTimingPhase = (typeof SURFACE_TIMING_PHASES)[number];
export interface SurfaceTimingSegment {
  readonly label: string;
  readonly durationMs: number;
  readonly phase?: GpuFramePhase;
  readonly scope?: "pass" | "stage" | "span";
}

/** Physical native passes only. Fused shading includes Geometry/Material/Lighting;
 * timestamps cannot separate their instruction cost inside one shader. */
export function classifySurfaceTimingPhase(
  segment: Pick<SurfaceTimingSegment, "label">
): SurfaceTimingPhase | null {
  const raw = segment.label.toLowerCase();
  const label = raw.slice(raw.lastIndexOf("surfacev4/"));
  if (label.startsWith("surfacev4/bins ")) {
    return "executionBins";
  }
  if (label.startsWith("surfacev4/native opaque")) {
    return "nativeShading";
  }
  if (label.startsWith("surfacev4/resource-limited native sun")) {
    return "nativeSun";
  }
  if (label.startsWith("surfacev4/empty background")) {
    return "background";
  }
  return null;
}

/** Sum same-frame physical passes before percentile aggregation, excluding nested spans. */
export function surfaceTimingTotalsForFrame(
  segments: readonly SurfaceTimingSegment[]
): ReadonlyMap<SurfaceTimingPhase, number> {
  const totals = new Map<SurfaceTimingPhase, number>();
  for (const segment of segments) {
    if (segment.scope !== undefined && segment.scope !== "pass") {
      continue;
    }
    const phase = classifySurfaceTimingPhase(segment);
    if (phase !== null) {
      totals.set(phase, (totals.get(phase) ?? 0) + segment.durationMs);
    }
  }
  return totals;
}

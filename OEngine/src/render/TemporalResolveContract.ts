export const TEMPORAL_MAX_HISTORY_WEIGHT = 0.92;
export const TEMPORAL_REACTIVE_REJECT_THRESHOLD = 0.5;
export const TEMPORAL_DISOCCLUSION_REJECT_THRESHOLD = 0.2;
export const TEMPORAL_MOTION_FADE_PIXELS = 128;

export interface TemporalReprojectionInput {
  readonly currentInternalPixel: readonly [number, number];
  readonly velocityInternalPixels: readonly [number, number];
  readonly internalResolution: readonly [number, number];
}

export interface TemporalReprojectionResult {
  readonly previousInternalPixel: readonly [number, number];
  readonly historyUv: readonly [number, number];
  readonly inside: boolean;
}

export type TemporalHistoryRejectionReason =
  | "none"
  | "history-invalid"
  | "motion-invalid"
  | "reactive"
  | "disoccluded"
  | "outside";

export interface TemporalHistoryClassificationInput {
  readonly historyValid: boolean;
  readonly motionValid: boolean;
  readonly reactive: number;
  readonly disocclusionConfidence: number;
  readonly velocityMagnitudePixels: number;
  readonly currentLuminance: number;
  readonly historyLuminance: number;
  readonly reprojectedInside: boolean;
}

export interface TemporalHistoryClassification {
  readonly historyWeight: number;
  readonly rejected: boolean;
  readonly rejectionReason: TemporalHistoryRejectionReason;
}

/** Surface ABI velocity is current-minus-previous in internal-pixel units. */
export function reprojectTemporalSample(
  input: TemporalReprojectionInput
): TemporalReprojectionResult {
  const width = positiveFinite(input.internalResolution[0], "internal width");
  const height = positiveFinite(input.internalResolution[1], "internal height");
  const currentX = finite(input.currentInternalPixel[0], "current pixel x");
  const currentY = finite(input.currentInternalPixel[1], "current pixel y");
  const velocityX = finite(input.velocityInternalPixels[0], "velocity x");
  const velocityY = finite(input.velocityInternalPixels[1], "velocity y");
  const previous: readonly [number, number] = [
    currentX - velocityX,
    currentY - velocityY
  ];
  const uv: readonly [number, number] = [previous[0] / width, previous[1] / height];
  return Object.freeze({
    previousInternalPixel: previous,
    historyUv: uv,
    inside: uv[0] >= 0 && uv[1] >= 0 && uv[0] < 1 && uv[1] < 1
  });
}

/** CPU reference for the independently-authored WGSL history acceptance policy. */
export function classifyTemporalHistory(
  input: TemporalHistoryClassificationInput
): TemporalHistoryClassification {
  if (!input.historyValid) return rejected("history-invalid");
  if (!input.motionValid) return rejected("motion-invalid");
  if (clamp01(input.reactive) >= TEMPORAL_REACTIVE_REJECT_THRESHOLD) {
    return rejected("reactive");
  }
  if (
    clamp01(input.disocclusionConfidence) <
    TEMPORAL_DISOCCLUSION_REJECT_THRESHOLD
  ) return rejected("disoccluded");
  if (!input.reprojectedInside) return rejected("outside");

  const motion = Math.max(0, finite(
    input.velocityMagnitudePixels,
    "velocity magnitude"
  ));
  const currentLuminance = Math.max(0, finite(
    input.currentLuminance,
    "current luminance"
  ));
  const historyLuminance = Math.max(0, finite(
    input.historyLuminance,
    "history luminance"
  ));
  const motionConfidence = clamp01(1 - motion / TEMPORAL_MOTION_FADE_PIXELS);
  const luminanceConfidence = 1 / (
    1 + Math.abs(currentLuminance - historyLuminance)
  );
  const reactiveConfidence = 1 - clamp01(input.reactive);
  const weight = TEMPORAL_MAX_HISTORY_WEIGHT *
    motionConfidence *
    luminanceConfidence *
    reactiveConfidence *
    clamp01(input.disocclusionConfidence);
  return Object.freeze({
    historyWeight: clamp01(weight),
    rejected: false,
    rejectionReason: "none" as const
  });
}

function rejected(
  rejectionReason: Exclude<TemporalHistoryRejectionReason, "none">
): TemporalHistoryClassification {
  return Object.freeze({ historyWeight: 0, rejected: true, rejectionReason });
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, finite(value, "temporal confidence")));
}

function positiveFinite(value: number, label: string): number {
  const checked = finite(value, label);
  if (checked <= 0) throw new RangeError(`${label} must be positive`);
  return checked;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
}

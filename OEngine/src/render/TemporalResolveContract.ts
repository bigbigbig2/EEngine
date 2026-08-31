export const TEMPORAL_MAX_HISTORY_WEIGHT = 0.92;
export const TEMPORAL_MIN_LOCKED_HISTORY_WEIGHT = 0.65;
export const TEMPORAL_HISTORY_LOCK_STEP = 1 / 16;
export const TEMPORAL_VARIANCE_GAMMA = 1.25;
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
  readonly historyLock?: number;
}

export interface TemporalHistoryClassification {
  readonly historyWeight: number;
  readonly nextHistoryLock: number;
  readonly rejected: boolean;
  readonly rejectionReason: TemporalHistoryRejectionReason;
}

export interface TemporalUpscaleSampleInput {
  readonly outputPixel: readonly [number, number];
  readonly internalResolution: readonly [number, number];
  readonly outputResolution: readonly [number, number];
}

export interface TemporalUpscaleSample {
  readonly outputUv: readonly [number, number];
  readonly internalPixel: readonly [number, number];
  readonly upscaling: boolean;
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
  const nextHistoryLock = clamp01(
    clamp01(input.historyLock ?? 0) + TEMPORAL_HISTORY_LOCK_STEP
  );
  const lockedWeightLimit =
    TEMPORAL_MIN_LOCKED_HISTORY_WEIGHT +
    (TEMPORAL_MAX_HISTORY_WEIGHT - TEMPORAL_MIN_LOCKED_HISTORY_WEIGHT) *
      nextHistoryLock;
  const weight = lockedWeightLimit *
    motionConfidence *
    luminanceConfidence *
    reactiveConfidence *
    clamp01(input.disocclusionConfidence);
  return Object.freeze({
    historyWeight: clamp01(weight),
    nextHistoryLock,
    rejected: false,
    rejectionReason: "none" as const
  });
}

/** Maps an output pixel center to the current internal-resolution footprint. */
export function resolveTemporalUpscaleSample(
  input: TemporalUpscaleSampleInput
): TemporalUpscaleSample {
  const internalWidth = positiveFinite(input.internalResolution[0], "internal width");
  const internalHeight = positiveFinite(input.internalResolution[1], "internal height");
  const outputWidth = positiveFinite(input.outputResolution[0], "output width");
  const outputHeight = positiveFinite(input.outputResolution[1], "output height");
  const outputX = finite(input.outputPixel[0], "output pixel x");
  const outputY = finite(input.outputPixel[1], "output pixel y");
  if (outputX < 0 || outputY < 0 || outputX >= outputWidth || outputY >= outputHeight) {
    throw new RangeError("output pixel must be inside output resolution");
  }
  const outputUv: readonly [number, number] = [
    (outputX + 0.5) / outputWidth,
    (outputY + 0.5) / outputHeight
  ];
  return Object.freeze({
    outputUv,
    internalPixel: Object.freeze([
      outputUv[0] * internalWidth,
      outputUv[1] * internalHeight
    ]) as readonly [number, number],
    upscaling: internalWidth < outputWidth || internalHeight < outputHeight
  });
}

/** CPU oracle for the authored WGSL YCoCg variance history clip. */
export function clipTemporalHistoryYCoCg(
  historyRgb: readonly [number, number, number],
  currentNeighborhood: readonly (readonly [number, number, number])[],
  varianceGamma = TEMPORAL_VARIANCE_GAMMA
): readonly [number, number, number] {
  if (currentNeighborhood.length === 0) {
    throw new RangeError("current neighborhood must not be empty");
  }
  const gamma = Math.max(0, finite(varianceGamma, "variance gamma"));
  const minimum = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const maximum = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  const sum = [0, 0, 0];
  const squared = [0, 0, 0];
  for (const rgb of currentNeighborhood) {
    const value = rgbToYCoCg(rgb);
    for (let channel = 0; channel < 3; channel++) {
      minimum[channel] = Math.min(minimum[channel]!, value[channel]!);
      maximum[channel] = Math.max(maximum[channel]!, value[channel]!);
      sum[channel] = sum[channel]! + value[channel]!;
      squared[channel] = squared[channel]! + value[channel]! * value[channel]!;
    }
  }
  const history = rgbToYCoCg(historyRgb);
  const clipped: [number, number, number] = [0, 0, 0];
  for (let channel = 0; channel < 3; channel++) {
    const mean = sum[channel]! / currentNeighborhood.length;
    const variance = Math.max(
      0,
      squared[channel]! / currentNeighborhood.length - mean * mean
    );
    const deviation = Math.sqrt(variance);
    const lower = Math.max(minimum[channel]!, mean - gamma * deviation);
    const upper = Math.min(maximum[channel]!, mean + gamma * deviation);
    clipped[channel] = Math.max(lower, Math.min(upper, history[channel]!));
  }
  const rgb = yCoCgToRgb(clipped);
  return Object.freeze([
    Math.max(0, rgb[0]),
    Math.max(0, rgb[1]),
    Math.max(0, rgb[2])
  ]);
}

function rejected(
  rejectionReason: Exclude<TemporalHistoryRejectionReason, "none">
): TemporalHistoryClassification {
  return Object.freeze({
    historyWeight: 0,
    nextHistoryLock: 0,
    rejected: true,
    rejectionReason
  });
}

function rgbToYCoCg(
  rgb: readonly [number, number, number]
): readonly [number, number, number] {
  const r = Math.max(0, finite(rgb[0], "red"));
  const g = Math.max(0, finite(rgb[1], "green"));
  const b = Math.max(0, finite(rgb[2], "blue"));
  return [
    r * 0.25 + g * 0.5 + b * 0.25,
    r * 0.5 - b * 0.5,
    -r * 0.25 + g * 0.5 - b * 0.25
  ];
}

function yCoCgToRgb(
  value: readonly [number, number, number]
): readonly [number, number, number] {
  return [
    value[0] + value[1] - value[2],
    value[0] + value[2],
    value[0] - value[1] - value[2]
  ];
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

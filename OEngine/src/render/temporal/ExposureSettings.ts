/** Immutable metering policy for one renderer/device lifetime.
 * Luminance is un-pre-exposed working-linear Rec.2020, using the engine's
 * existing photometric normalization. Log values and headroom are in stops.
 * Percentiles refer to nonzero histogram samples, with fractional bin weights.
 */
export interface ExposureSettings {
  readonly minLogLuminance: number;
  readonly maxLogLuminance: number;
  readonly lowPercentile: number;
  readonly highPercentile: number;
  readonly highlightPercentile: number;
  readonly highlightHeadroom: number;
  readonly keyValue: number;
  /** Rate toward brighter scene luminance (decreasing exposure), per second. */
  readonly speedUp: number;
  /** Rate toward darker scene luminance (increasing exposure), per second. */
  readonly speedDown: number;
}

export const DEFAULT_EXPOSURE_SETTINGS: Readonly<ExposureSettings> = Object.freeze({
  // Includes dim scenes and un-pre-exposed HDR up to 65536; unlike the old
  // half-float test, the range applies after removing the previous exposure.
  minLogLuminance: -12,
  maxLogLuminance: 16,
  lowPercentile: 0.6,
  highPercentile: 0.95,
  // Ignore the brightest 2% for highlight protection. Retain two stops above
  // the metering target, rather than using a global maximum/firefly clamp.
  highlightPercentile: 0.98,
  highlightHeadroom: 2,
  keyValue: 0.18,
  speedUp: 3,
  speedDown: 1,
});

export function resolveExposureSettings(input: Partial<ExposureSettings> = {}): Readonly<ExposureSettings> {
  const settings = { ...DEFAULT_EXPOSURE_SETTINGS, ...input };
  if (
    !Object.values(settings).every(Number.isFinite) ||
    settings.minLogLuminance < -24 ||
    settings.maxLogLuminance > 24 ||
    settings.minLogLuminance >= settings.maxLogLuminance ||
    settings.lowPercentile < 0 ||
    settings.lowPercentile >= settings.highPercentile ||
    settings.highPercentile > settings.highlightPercentile ||
    settings.highlightPercentile > 1 ||
    settings.highlightHeadroom < 0 ||
    settings.highlightHeadroom > 16 ||
    settings.keyValue <= 0 ||
    settings.keyValue > 1 ||
    // Existing Sky/Aerial/Present and FSR consumers require this numeric P
    // domain. Reject incompatible configurations instead of clamping exposure.
    settings.keyValue / 2 ** settings.maxLogLuminance < 1e-6 ||
    settings.keyValue / 2 ** settings.minLogLuminance >= 1e6 ||
    settings.speedUp < 0 ||
    settings.speedUp > 64 ||
    settings.speedDown < 0 ||
    settings.speedDown > 64
  ) {
    throw new RangeError("Exposure settings have an invalid HDR range, percentile, key or adaptation rate");
  }
  return Object.freeze(settings);
}

/** 32-byte GPU state. First word remains the P/E multiplier consumed by
 * Surface, sky, aerial, FSR and presentation. Remaining words are diagnostics. */
export const EXPOSURE_STATE_BYTES = 32;
export const EXPOSURE_SETTINGS_BYTES = 64;
export const EXPOSURE_BIN_COUNT = 1024;

export interface ExposureDiagnostics {
  readonly autoExposure: boolean;
  readonly historyValid: boolean;
  readonly exposure: number;
  readonly adaptedLuminance: number;
  readonly meteredLuminance: number;
  readonly adaptedLogLuminance: number;
  readonly targetLogLuminance: number;
  readonly highlightLuminance: number;
  readonly selectedSamples: number;
  readonly validSamples: number;
}

/** Diagnostic CPU oracle; never reads or controls production GPU exposure. */
import { EXPOSURE_BIN_COUNT, resolveExposureSettings, type ExposureSettings } from "./ExposureSettings.js";

export interface HistogramResult {
  readonly bins: Uint32Array<ArrayBuffer>;
  readonly nonBlackPixels: number;
}
export function referenceRadiometryHistogram(
  rgba: Float32Array,
  width: number,
  height: number,
  preExposure: number,
  options: Partial<ExposureSettings> = {},
): HistogramResult {
  if (!(preExposure > 0) || !Number.isFinite(preExposure)) {
    throw new RangeError("Pre-exposure must be finite and positive");
  }
  if (rgba.length < width * height * 4) {
    throw new RangeError("Scene RGBA extent");
  }
  const settings = resolveExposureSettings(options);
  const bins = new Uint32Array(EXPOSURE_BIN_COUNT);
  let nonBlackPixels = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const p = (y * width + x) * 4;
      const luminance =
        (Math.max(0, rgba[p]!) * 0.2627 +
          Math.max(0, rgba[p + 1]!) * 0.678 +
          Math.max(0, rgba[p + 2]!) * 0.0593) /
        preExposure;
      let bin = 0;
      if (luminance > 0) {
        const unit = Math.min(
          1,
          Math.max(
            0,
            (Math.log2(luminance) - settings.minLogLuminance) /
              (settings.maxLogLuminance - settings.minLogLuminance),
          ),
        );
        bin = 1 + Math.min(1022, Math.floor(unit * 1023));
        nonBlackPixels++;
      }
      bins[bin]!++;
    }
  }
  return { bins, nonBlackPixels };
}
export interface AdaptedExposure {
  readonly luminance: number;
  readonly exposure: number;
  readonly meteredLuminance: number;
  readonly targetLogLuminance: number;
}
export function referenceRadiometryAdaptation(
  histogram: HistogramResult,
  priorLuminance: number,
  deltaSeconds: number,
  historyValid: boolean,
  options: Partial<ExposureSettings> = {},
): AdaptedExposure {
  const settings = resolveExposureSettings(options);
  const priorLog = Math.log2(priorLuminance > 0 ? priorLuminance : settings.keyValue);
  let meteredLog = priorLog;
  let targetLog = priorLog;
  if (histogram.nonBlackPixels > 0) {
    const total = histogram.nonBlackPixels;
    const low = total * settings.lowPercentile;
    const high = total * settings.highPercentile;
    let cumulative = 0,
      weighted = 0,
      selected = 0;
    let highlightLog: number | undefined;
    for (let bin = 1; bin < EXPOSURE_BIN_COUNT; bin++) {
      const count = histogram.bins[bin]!;
      const end = cumulative + count;
      const weight = Math.max(0, Math.min(end, high) - Math.max(cumulative, low));
      const log =
        settings.minLogLuminance +
        ((bin - 0.5) / 1023) * (settings.maxLogLuminance - settings.minLogLuminance);
      weighted += weight * log;
      selected += weight;
      if (highlightLog === undefined && count > 0 && end >= total * settings.highlightPercentile) {
        highlightLog = log;
      }
      cumulative = end;
    }
    meteredLog = weighted / selected;
    targetLog = Math.max(meteredLog, highlightLog! - settings.highlightHeadroom);
  }
  const speed = targetLog > priorLog ? settings.speedUp : settings.speedDown;
  const dt = Number.isFinite(deltaSeconds) ? Math.min(1, Math.max(0, deltaSeconds)) : 1 / 60;
  const adaptedLog =
    !historyValid && histogram.nonBlackPixels > 0
      ? targetLog
      : priorLog + (targetLog - priorLog) * (1 - Math.exp(-dt * speed));
  const luminance = 2 ** adaptedLog;
  return {
    luminance,
    exposure: settings.keyValue / luminance,
    meteredLuminance: 2 ** meteredLog,
    targetLogLuminance: targetLog,
  };
}

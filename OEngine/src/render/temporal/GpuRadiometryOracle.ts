/** CPU oracle for the selected Wicked Engine 1024-bin radiometry profile.
 * This module is diagnostic only and never controls the production GPU path. */
const BIN_COUNT = 1024;
const MIN_LOG = -10;
const MAX_LOG = 2;

export interface HistogramResult {
  readonly bins: Uint32Array<ArrayBuffer>;
  readonly nonBlackPixels: number;
}

export function referenceWickedHistogram(
  rgba: Float32Array, width: number, height: number, preExposure: number
): HistogramResult {
  if (!(preExposure > 0) || !Number.isFinite(preExposure)) {
    throw new RangeError("Pre-exposure must be finite and positive");
  }
  if (rgba.length < width * height * 4) throw new RangeError("Scene RGBA extent");
  const bins = new Uint32Array(new ArrayBuffer(BIN_COUNT * 4));
  let nonBlackPixels = 0;
  for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
    const p = (y * width + x) * 4;
    const r = Math.max(0, rgba[p]!);
    const g = Math.max(0, rgba[p + 1]!);
    const b = Math.max(0, rgba[p + 2]!);
    const luminance = (r * 0.2627 + g * 0.678 + b * 0.0593) / preExposure;
    let bin = 0;
    if (luminance > 0.001 && luminance <= 65504) {
      const scaled = Math.min(1, Math.max(0,
        (Math.log2(luminance) - MIN_LOG) / (MAX_LOG - MIN_LOG)));
      bin = Math.min(BIN_COUNT - 1, Math.trunc(scaled * (BIN_COUNT - 2)) + 1);
    } else if (luminance > 65504) {
      bin = BIN_COUNT - 1;
    }
    bins[bin]!++;
    if (bin !== 0) nonBlackPixels++;
  }
  return { bins, nonBlackPixels };
}

export interface AdaptedExposure {
  readonly luminance: number;
  readonly exposure: number;
}

export function referenceWickedAdaptation(
  histogram: HistogramResult, priorLuminance: number, deltaSeconds: number,
  historyValid: boolean
): AdaptedExposure {
  let weighted = 0;
  for (let bin = 1; bin < BIN_COUNT; bin++) weighted += histogram.bins[bin]! * bin;
  const prior = historyValid ? Math.min(1e4, Math.max(1e-4, priorLuminance)) : 0.18;
  const logAverage = weighted / Math.max(histogram.nonBlackPixels, 1) - 1;
  const target = 2 ** (logAverage / (BIN_COUNT - 2) * (MAX_LOG - MIN_LOG) + MIN_LOG);
  const adapted = histogram.nonBlackPixels === 0 ? prior :
    prior + (target - prior) * (1 - Math.exp(-Math.max(deltaSeconds, 0.01) * 1.5));
  const luminance = Math.min(1e4, Math.max(1e-4, adapted));
  return { luminance, exposure: Math.min(1e4, Math.max(1e-4, 0.18 / luminance)) };
}

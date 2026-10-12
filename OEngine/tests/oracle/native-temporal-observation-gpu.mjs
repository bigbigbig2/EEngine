import { NativeTemporalV2 as Candidate } from "../../.test-dist/render/temporal/NativeTemporalV2.js";
import { runFinalPixelTemporalPullGpuOracle } from "./final-pixel-temporal-pull-gpu.mjs";
import { runFinalPixelTemporalMatrixGpuOracle } from "./final-pixel-temporal-matrix-gpu.mjs";

// Actual production owner after the physical cutover; unchanged independent
// quality gates and stimuli. The frozen before stays test-only.
export async function runNativeTemporalObservationQualityGpuOracle(device) {
  return runFinalPixelTemporalPullGpuOracle(device, Candidate);
}

export async function runNativeTemporalObservationMatrixGpuOracle(device) {
  return runFinalPixelTemporalMatrixGpuOracle(device, false, Candidate);
}

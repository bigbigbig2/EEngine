/** Immutable physical consumer selected by the published opaque bin summary. */
export type GpuShadingExecutionMode =
  | "sparse-microtile"
  | "direct-single-bin";

export function gpuShadingExecutionModeForBinCount(
  activeBinCount: number
): "none" | GpuShadingExecutionMode {
  if (!Number.isInteger(activeBinCount) || activeBinCount < 0) {
    throw new RangeError("Active opaque bin count must be a non-negative integer");
  }
  if (activeBinCount === 0) return "none";
  return activeBinCount === 1 ? "direct-single-bin" : "sparse-microtile";
}

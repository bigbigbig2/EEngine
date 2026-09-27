/** One r32uint texel per internal-resolution 4×4 tile; bit 4 selects the full tile,
 * bits 0..3 select its four independent 2×2 cells. Zero means full rate. */
export const SHADING_FREQUENCY_TILE_SIZE = 4;
export const SHADING_FREQUENCY_PLAN_WORD_BYTES = 4;
export const SHADING_FREQUENCY_COARSE4_BIT = 1 << 4;

export function shadingFrequencyPlanCapacity(width: number, height: number, limits: {
  maxTextureDimension2D: number;
  maxComputeWorkgroupsPerDimension: number;
}): Readonly<{ tilesX: number; tilesY: number; bytes: number }> {
  if (!Number.isSafeInteger(width) || width <= 0 ||
      !Number.isSafeInteger(height) || height <= 0) {
    throw new RangeError("Shading frequency extent must be positive integers");
  }
  const tilesX = Math.ceil(width / SHADING_FREQUENCY_TILE_SIZE);
  const tilesY = Math.ceil(height / SHADING_FREQUENCY_TILE_SIZE);
  const bytes = tilesX * tilesY * SHADING_FREQUENCY_PLAN_WORD_BYTES;
  if (!Number.isSafeInteger(bytes) ||
      tilesX > limits.maxTextureDimension2D || tilesY > limits.maxTextureDimension2D ||
      Math.ceil(tilesX / 8) > limits.maxComputeWorkgroupsPerDimension ||
      Math.ceil(tilesY / 8) > limits.maxComputeWorkgroupsPerDimension) {
    throw new RangeError("Shading frequency plan exceeds negotiated WebGPU limits");
  }
  return Object.freeze({ tilesX, tilesY, bytes });
}

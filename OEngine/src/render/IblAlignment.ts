/** FX-03 CPU references shared with numeric tests. */
export const IBL_MIN_PERCEPTUAL_ROUGHNESS = 0.02;

export function perceptualRoughnessToLinear(value: number): number {
  const roughness = Math.min(1, Math.max(IBL_MIN_PERCEPTUAL_ROUGHNESS, value));
  return roughness * roughness;
}

export function iblRoughnessToLod(perceptualRoughness: number, mipLevelCount: number): number {
  if (!Number.isInteger(mipLevelCount) || mipLevelCount < 1) {
    throw new RangeError("mipLevelCount must be a positive integer");
  }
  return Math.min(1, Math.max(0, perceptualRoughness)) * (mipLevelCount - 1);
}

export function radicalInverseVdc(bits: number): number {
  let value = bits >>> 0;
  value = ((value << 16) | (value >>> 16)) >>> 0;
  value = (((value & 0x55555555) << 1) | ((value & 0xaaaaaaaa) >>> 1)) >>> 0;
  value = (((value & 0x33333333) << 2) | ((value & 0xcccccccc) >>> 2)) >>> 0;
  value = (((value & 0x0f0f0f0f) << 4) | ((value & 0xf0f0f0f0) >>> 4)) >>> 0;
  value = (((value & 0x00ff00ff) << 8) | ((value & 0xff00ff00) >>> 8)) >>> 0;
  return value * 2.3283064365386963e-10;
}

export function hammersley2d(index: number, count: number): [number, number] {
  if (!Number.isInteger(count) || count < 1) throw new RangeError("count must be positive");
  return [index / count, radicalInverseVdc(index)];
}

export function octEncode(direction: readonly [number, number, number]): [number, number] {
  const length = Math.abs(direction[0]) + Math.abs(direction[1]) + Math.abs(direction[2]);
  if (!(length > 0)) throw new RangeError("direction must be non-zero");
  let x = direction[0] / length;
  let y = direction[1] / length;
  if (direction[2] < 0) {
    const oldX = x;
    x = (1 - Math.abs(y)) * (oldX < 0 ? -1 : 1);
    y = (1 - Math.abs(oldX)) * (y < 0 ? -1 : 1);
  }
  return [x * 0.5 + 0.5, y * 0.5 + 0.5];
}

export function octDecode(encoded: readonly [number, number]): [number, number, number] {
  let x = encoded[0] * 2 - 1;
  let y = encoded[1] * 2 - 1;
  const z = 1 - Math.abs(x) - Math.abs(y);
  const fold = Math.max(-z, 0);
  x += x > 0 ? -fold : fold;
  y += y > 0 ? -fold : fold;
  const inverseLength = 1 / Math.hypot(x, y, z);
  return [x * inverseLength, y * inverseLength, z * inverseLength];
}

export function estimateConstantDiffuseIrradiance(radiance: readonly [number, number, number]): [number, number, number] {
  return [radiance[0] * Math.PI, radiance[1] * Math.PI, radiance[2] * Math.PI];
}

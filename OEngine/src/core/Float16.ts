/** Deterministic IEEE binary16 codec, round-to-nearest ties-to-even from f32. */
const scratch = new Float32Array(1);
const bits = new Uint32Array(scratch.buffer);

export function encodeFloat16(value: number): number {
  scratch[0] = value;
  const word = bits[0]!,
    sign = (word >>> 16) & 0x8000;
  const exponent = (word >>> 23) & 255,
    fraction = word & 0x7fffff;
  if (exponent === 255) return sign | (fraction === 0 ? 0x7c00 : 0x7e00);
  if (exponent < 102) return sign;
  if (exponent < 113) {
    const shift = 126 - exponent,
      significand = 0x800000 | fraction;
    const quotient = significand >>> shift,
      remainder = significand & ((1 << shift) - 1);
    const midpoint = 1 << (shift - 1);
    return (
      sign | (quotient + (remainder > midpoint || (remainder === midpoint && (quotient & 1) !== 0) ? 1 : 0))
    );
  }
  if (exponent >= 143) return sign | 0x7c00;
  const rounded = (fraction + 0xfff + ((fraction >>> 13) & 1)) >>> 13;
  return sign | (((exponent - 112) << 10) + rounded);
}

export function decodeFloat16(word: number): number {
  const sign = (word & 0x8000) === 0 ? 1 : -1;
  const exponent = (word >>> 10) & 31,
    fraction = word & 1023;
  if (exponent === 31) return fraction === 0 ? sign * Infinity : NaN;
  return sign * (exponent === 0 ? fraction * 2 ** -24 : (1 + fraction / 1024) * 2 ** (exponent - 15));
}

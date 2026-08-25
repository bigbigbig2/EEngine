/**
 * float16：负责资源读取、解码或场景装载。
 */

const _f32 = new Float32Array(1);
const _i32 = new Int32Array(_f32.buffer);

export function floatToHalf(e: number): number {
  let t = e;
  if (Number.isFinite(t) && t > 65504) {
    console.warn("to_half_float_uint16(): value exceeds 65504.");
    t = 65504;
  }
  _f32[0] = t;
  const n = _i32[0]!;
  let r = (n >> 16) & 32768;
  let s = (n >> 12) & 2047;
  const a = (n >> 23) & 255;
  if (a < 103) return r;
  if (a > 142) {
    r |= 31744;
    if (a === 255 && n & 8388607) r |= 512;
    return r;
  }
  if (a < 113) {
    s |= 2048;
    r |= (s >> (114 - a)) + ((s >> (113 - a)) & 1);
    return r;
  }
  r |= ((a - 112) << 10) | (s >> 1);
  r += 1 & s;
  return r;
}

export function halfToFloat(h: number): number {
  const e = h & 0xffff;
  const s = e >> 15 ? -1 : 1;
  const n = (e >> 10) & 0x1f;
  const r = e & 0x3ff;
  if (n === 0) {
    return s * ((r / 1024) * 6103515625e-14);
  }
  if (n === 31) {
    return r !== 0 ? NaN : s * Infinity;
  }
  return s * Math.pow(2, n - 15) * (1 + r / 1024);
}

export function float32ArrayToHalf(src: Float32Array): Uint16Array {
  const n = src.length;
  const out = new Uint16Array(n);
  for (let i = 0; i < n; i++) out[i] = floatToHalf(src[i]!);
  return out;
}

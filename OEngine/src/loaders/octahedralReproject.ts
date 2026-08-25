/**
 * octahedralReproject：负责资源读取、解码或场景装载。
 */

import { Sampler2D } from "../texture/Sampler2D.js";

function sign1(e: number): number {
  return e >= 0 ? 1 : -1;
}

function length3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

export function octahedralDecode(
  out: Float32Array,
  t: number,
  n: number,
  r: number
): number {
  let s = n;
  let a = r;
  const i = Math.abs(s);
  const o = Math.abs(a);
  let _ = 1 - i - o;
  if (_ < 0) {
    s = (1 - o) * sign1(s);
    a = (1 - i) * sign1(a);
  }
  const c = length3(s, _, a);
  const d = 1 / c;
  out[t] = s * d;
  out[t + 1] = _ * d;
  out[t + 2] = a * d;
  return c;
}

export function gaussian1d(sigma: number, t: number): number {
  return Math.exp((-t * t) / (sigma * sigma * 2));
}

export function vanDerCorput(base: number, index: number): number {
  let n = 0;
  let r = 1;
  let s = index >>> 0;
  while (s > 0) {
    r /= base;
    n += r * (s % base);
    s = (s / base) >>> 0;
  }
  return n;
}

export function reprojectEquirectToOctahedral(
  e: Sampler2D,
  t: number
): Sampler2D {
  const n = Sampler2D.float32(4, t, t);
  n.data.fill(1);

  const r = new Float32Array(3);
  const s = new Float32Array(32);
  for (let i = 0; i < 16; i++) {
    s[2 * i] = vanDerCorput(2, i) - 0.5;
    s[2 * i + 1] = vanDerCorput(3, i) - 0.5;
  }
  const weights = new Float32Array(16);
  let weightSum = 0;
  for (let i = 0; i < 16; i++) {
    const w =
      gaussian1d(2.7, s[2 * i]!) * gaussian1d(2.7, s[2 * i + 1]!);
    weights[i] = w;
    weightSum += w;
  }
  for (let i = 0; i < 16; i++) weights[i]! /= weightSum;

  const a = new Float32Array(48);
  for (let o = 0; o < t; o++) {
    for (let _ = 0; _ < t; _++) {
      a.fill(0);
      let c = 0;
      for (let nTap = 0; nTap < 16; nTap++) {
        octahedralDecode(
          r,
          0,
          -(((_ + s[nTap << 1]! + 0.5) / t) * 2 - 1),
          ((o + s[1 + (nTap << 1)]! + 0.5) / t) * 2 - 1
        );
        const d = Math.atan2(r[0]!, r[1]!);
        const u = Math.acos(r[2]!);
        const l = (d + Math.PI) / (2 * Math.PI);
        const f = u / Math.PI;
        const h = weights[nTap]!;
        c += h;
        for (let ch = 0; ch < 3; ch++) {
          a[ch]! += e.sampleChannelBilinearUV(l, f, ch) * h;
        }
      }
      for (let ch = 0; ch < 3; ch++) {
        n.writeChannel(_, o, ch, Math.max(0, a[ch]! / c));
      }
    }
  }
  return n;
}

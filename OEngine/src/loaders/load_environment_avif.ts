/**
 * load_environment_avif：负责资源读取、解码或场景装载。
 */

import { ShadeImage, ShadeTexture } from "../texture/ShadeTexture.js";
import { decodeAvifOo } from "./decodeAvif.js";

export interface EnvSampler2D {
  width: number;
  height: number;
  itemSize: number;
  data: ArrayLike<number>;
}

function octahedralToDirection(
  out: Float32Array,
  offset: number,
  u: number,
  v: number
): void {
  let s = u;
  let a = v;
  const i = Math.abs(s);
  const o = Math.abs(a);
  let _ = 1 - i - o;
  if (_ < 0) {
    s = (1 - o) * Math.sign(s);
    a = (1 - i) * Math.sign(a);
  }
  const len = Math.hypot(s, _, a);
  const d = 1 / (len || 1);
  out[offset] = s * d;
  out[offset + 1] = _ * d;
  out[offset + 2] = a * d;
}

export function estimateSunDirection(e: EnvSampler2D): Float32Array {
  const { width: t, height: n, data: r } = e;
  const s = e.itemSize;
  let a = 0;
  const i = t * n;
  for (let p = 0; p < i; p++) {
    const base = p * s;
    const y =
      0.2126 * (r[base] as number) +
      0.7152 * (r[base + 1] as number) +
      0.0722 * (r[base + 2] as number);
    if (y > a) a = y;
  }
  const o = 0.95 * a;
  let _ = 0;
  let c = 0;
  let d = 0;
  let u = 0;
  const l = new Float32Array(3);
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < t; col++) {
      const base = (row * t + col) * s;
      const f =
        0.2126 * (r[base] as number) +
        0.7152 * (r[base + 1] as number) +
        0.0722 * (r[base + 2] as number);
      if (f < o) continue;
      octahedralToDirection(
        l,
        0,
        ((col + 0.5) / t) * 2 - 1,
        ((row + 0.5) / n) * 2 - 1
      );
      _ += l[0]! * f;
      c += l[2]! * f;
      d += l[1]! * f;
      u += f;
    }
  }
  if (u > 0) {
    _ /= u;
    c /= u;
    d /= u;
  } else {
    _ = -0.2;
    c = 1;
    d = 0.2;
  }
  const f = Math.sqrt(_ * _ + c * c + d * d);
  if (f > 1e-6) {
    _ /= f;
    c /= f;
    d /= f;
  }
  const h = new Float32Array(3);
  h[0] = _;
  h[1] = c;
  h[2] = d;
  return h;
}

export async function load_environment_avif(url: string): Promise<{
  texture: ShadeTexture;
  sunDirection: Float32Array;
}> {
  const t = await fetch(url);
  if (!t.ok) {
    throw new Error(
      `Failed to fetch environment AVIF: ${t.status} ${t.statusText}`
    );
  }
  const n = await t.arrayBuffer();

  const r = await decodeAvifOo(n);

  const image = ShadeImage.fromSampler2D(r);
  image.color_space = 2;

  const texture = ShadeTexture.from(image);
  const sunDirection = estimateSunDirection(r);
  return { texture, sunDirection };
}

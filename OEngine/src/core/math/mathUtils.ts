/**
 * mathUtils：提供渲染系统使用的数学运算与基础数据结构。
 */

export function clamp(e: number, t: number, n: number): number {
  return e < t ? t : e > n ? n : e;
}

export function clamp01(e: number): number {
  return e < 0 ? 0 : e > 1 ? 1 : e;
}

export function roughlyEqual(e: number, t: number, n = 1e-7): boolean {
  return Math.abs(e - t) <= n;
}

export function lerp(e: number, t: number, n: number): number {
  return (t - e) * n + e;
}

export const DEG2RAD = Math.PI / 180;
export const MATH_EPS = 1e-7;
export const TWO_PI = 2 * Math.PI;

export function hypot4(e: number, t: number, n: number, r: number): number {
  return Math.sqrt(e * e + t * t + n * n + r * r);
}

export function sign(e: number): number {
  return e > 0 ? 1 : e < 0 ? -1 : 0;
}

export function distance3(
  e: number,
  t: number,
  n: number,
  r: number,
  s: number,
  a: number
): number {
  const dx = r - e;
  const dy = s - t;
  const dz = a - n;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function lengthSquared3(e: number, t: number, n: number): number {
  return e * e + t * t + n * n;
}

export function lerpVec3(
  e: { set: (x: number, y: number, z: number) => unknown },
  t: number,
  n: number,
  r: number,
  s: number,
  a: number,
  i: number,
  o: number
): void {
  const _ = lerp(t, s, o);
  const c = lerp(n, a, o);
  const d = lerp(r, i, o);
  e.set(_, c, d);
}

export function length3(e: number, t: number, n: number): number {
  return Math.sqrt(e * e + t * t + n * n);
}

export function dot3(
  e: number,
  t: number,
  n: number,
  r: number,
  s: number,
  a: number
): number {
  return e * r + t * s + n * a;
}

export function inverseLerp(e: number, t: number, n: number): number {
  const r = t - e;
  return r === 0 ? 0 : (n - e) / r;
}

export function writeNormalizedPlane4(
  e: Float32Array | number[],
  t: number,
  n: number,
  r: number,
  s: number,
  a: number
): void {
  const i = 1 / length3(n, r, s);
  e[t] = n * i;
  e[t + 1] = r * i;
  e[t + 2] = s * i;
  e[t + 3] = a * i;
}

export function hashArrayItems<T>(
  e: ArrayLike<T>,
  t: (item: T) => number,
  n?: unknown
): number {
  const r = e.length;
  let s = r;
  for (let a = 0; a < r; a++) {
    s = (s << 5) - s + t.call(n, e[a]!);
    s |= 0;
  }
  return s;
}

export function arrayDeepEquals(e: ArrayLike<unknown>, t: ArrayLike<unknown>): boolean {
  const n = e.length;
  if (n !== t.length) return false;
  let r = 0;
  for (; r < n; r++) {
    const n0 = e[r];
    const s = t[r];
    if (n0 !== s) {
      if (n0 == null || s == null) return false;
      if (typeof n0 !== "object" || typeof (n0 as { equals?: unknown }).equals !== "function") {
        return false;
      }
      if (!(n0 as { equals: (o: unknown) => boolean }).equals(s)) return false;
    }
  }
  return true;
}

export function fmax(e: number, t: number): number {
  return e < t ? t : e;
}

export function fmin(e: number, t: number): number {
  return e < t ? e : t;
}

export function lengthSquared2(e: number, t: number): number {
  return e * e + t * t;
}

export function hypot2(e: number, t: number): number {
  return Math.sqrt(e * e + t * t);
}

export function nowSeconds(): number {
  const me =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance
      : Date;
  return 0.001 * me.now();
}

export function deepOrRefEquals(e: unknown, t: unknown): boolean {
  if (e === t) return true;
  if (e === undefined || t === undefined) return false;
  if (e === null || t === null) return false;
  if (typeof e !== typeof t) return false;
  const eq = (e as { equals?: (o: unknown) => boolean }).equals;
  if (typeof eq === "function") return eq.call(e, t);
  return false;
}

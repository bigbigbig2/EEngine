/**
 * arrayUtils：提供渲染器共享的基础数据结构与通用工具。
 */

import { hashFloat } from "./hashMix.js";

export function arrayShallowEquals(
  e: ArrayLike<unknown>,
  t: ArrayLike<unknown>
): boolean {
  const n = e.length;
  if (n !== t.length) return false;
  for (let r = 0; r < n; r++) if (e[r] !== t[r]) return false;
  return true;
}

export function isTypedArray(e: unknown): e is ArrayBufferView {
  if (typeof e !== "object" || e === null) return false;
  const c = (e as { constructor?: unknown }).constructor;
  if (
    c === Uint8Array ||
    c === Uint8ClampedArray ||
    c === Uint16Array ||
    c === Uint32Array ||
    c === Int8Array ||
    c === Int16Array ||
    c === Int32Array ||
    c === Float32Array ||
    c === Float64Array ||
    c === BigUint64Array ||
    c === BigInt64Array
  ) {
    return true;
  }
  const F16 = (globalThis as { Float16Array?: unknown }).Float16Array;
  return F16 !== undefined && c === F16;
}

export function arrayRemoveFirst<T>(
  e: T[],
  t: T,
  n = 0,
  r = e.length
): boolean {
  const s = n + r;
  for (let i = n; i < s; i++) {
    if (e[i] === t) {
      e.splice(i, 1);
      return true;
    }
  }
  return false;
}

export function arrayHashFloats(e: ArrayLike<number>): number {
  const t = e.length;
  let n = t;
  for (let r = 0; r < t; r++) {
    n = (n << 5) - n + hashFloat(e[r]!);
    n |= 0;
  }
  return n;
}

export function isInstanceOf(e: unknown, t: unknown): boolean {
  return (
    t != null &&
    typeof t === "object" &&
    e instanceof (t as new (...args: never[]) => unknown)
  );
}

export function isInstanceOfCtor(
  e: unknown,
  t: unknown
): boolean {
  if (t == null) return false;
  if (typeof t === "function") {
    try {
      return e instanceof (t as new (...args: never[]) => unknown);
    } catch {
      return false;
    }
  }
  return isInstanceOf(e, t);
}

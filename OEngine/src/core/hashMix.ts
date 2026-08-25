/**
 * hashMix：提供渲染器共享的基础数据结构与通用工具。
 */

import { arrayShallowEquals } from "./arrayUtils.js";
import { bufferCopyStride } from "./memoryUtils.js";

const G = 4294967295;

export function hashFloat(e: number): number {
  const t = e | 0;
  return (G - ((((e - t) * G) >>> 0) as number)) ^ t;
}

export function hashU32Range(e: ArrayLike<number>, t: number, n: number): number {
  let r = n;
  for (let s = t; s < n; s += 1) {
    r = (r << 5) - r + ((e[s]! >>> 0) as number);
  }
  return r >>> 0;
}

export function hashMix(...e: number[]): number {
  return hashU32Range(e, 0, e.length);
}

export function hashOptional(
  e: { hash?: () => number } | null | undefined
): number {
  if (e == null) return 0;
  if (typeof e.hash === "function") return e.hash();
  return 0;
}

export function hashArrayBuffer(
  buffer: ArrayBuffer,
  offset = 0,
  byteLength?: number
): number {
  const off = offset >>> 0;
  const n = (byteLength ?? buffer.byteLength - off) >>> 0;
  const align = (off | n) & 3;
  if (align === 0) {
    const e = new Uint32Array(buffer, off, n >>> 2);
    let r = n >>> 2;
    for (let i = 0; i < e.length; ++i) r = (r << 5) - r + (e[i]! >>> 0);
    return r | 0;
  }
  if ((align & 2) === 0) {
    const e = new Uint16Array(buffer, off, n >>> 1);
    let r = n >>> 1;
    let s = 0;
    if (r & 1) {
      r = (r << 5) - r + e[s++]!;
    }
    for (; s < e.length; s += 2) {
      r = (r << 5) - r + ((e[s]! << 16) | e[s + 1]!);
    }
    return r | 0;
  }
  {
    const e = new Uint8Array(buffer, off, n);
    let r = n;
    let s = 0;
    const a = n & 3;
    for (; s < a; s++) r = (r << 5) - r + e[s]!;
    for (; s < n; s += 4) {
      r =
        (r << 5) -
        r +
        (e[s]! | (e[s + 1]! << 8) | (e[s + 2]! << 16) | (e[s + 3]! << 24));
    }
    return r | 0;
  }
}

export function arrayBufferEquals(
  a: ArrayBuffer,
  aOffset: number,
  b: ArrayBuffer,
  bOffset: number,
  byteLength: number
): boolean {
  if (a === b && aOffset === bOffset) return true;
  if (byteLength === 0) return true;
  if (a.byteLength < aOffset + byteLength || b.byteLength < bOffset + byteLength) {
    return false;
  }
  const i = bufferCopyStride(aOffset, bOffset, byteLength);
  let o: ArrayLike<number>;
  let _: ArrayLike<number>;
  if (i === 4) {
    o = new Uint32Array(a, aOffset, byteLength >>> 2);
    _ = new Uint32Array(b, bOffset, byteLength >>> 2);
  } else if (i === 2) {
    o = new Uint16Array(a, aOffset, byteLength >>> 1);
    _ = new Uint16Array(b, bOffset, byteLength >>> 1);
  } else {
    o = new Uint8Array(a, aOffset, byteLength);
    _ = new Uint8Array(b, bOffset, byteLength);
  }
  return arrayShallowEquals(o, _);
}

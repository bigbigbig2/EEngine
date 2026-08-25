/**
 * memoryUtils：提供渲染器共享的基础数据结构与通用工具。
 */

export function copyArrayRange(
  e: ArrayLike<number>,
  t: number,
  n: { [i: number]: number },
  r: number,
  s: number
): void {
  for (let o = 0; o < s; o++) {
    n[r + o] = e[t + o]!;
  }
}

export function bufferCopyStride(e: number, t: number, n: number): number {
  const r = e | t | n;
  return (r & 3) !== 0 ? ((r & 1) !== 0 ? 1 : 2) : 4;
}

export function copyArrayBufferRange(
  e: ArrayBuffer,
  t: number,
  n: ArrayBuffer,
  r: number,
  s: number
): void {
  const o = bufferCopyStride(t, r, s);
  let a: ArrayLike<number>;
  let i: { set(src: ArrayLike<number>): void };
  if (o === 4) {
    a = new Uint32Array(e, t, s >>> 2);
    i = new Uint32Array(n, r, s >>> 2);
  } else if (o === 2) {
    a = new Uint16Array(e, t, s >>> 1);
    i = new Uint16Array(n, r, s >>> 1);
  } else {
    a = new Uint8Array(e, t, s);
    i = new Uint8Array(n, r, s);
  }
  i.set(a);
}

export function copyTypedArrayContents(
  e: ArrayLike<number> & {
    length: number;
    buffer?: ArrayBuffer;
    byteOffset?: number;
    byteLength?: number;
    constructor?: unknown;
  },
  t: {
    length: number;
    set(src: ArrayLike<number>, offset?: number): void;
    buffer?: ArrayBuffer;
    byteOffset?: number;
    constructor?: unknown;
  }
): void {
  const n = t.length;
  if (n >= e.length) {
    t.set(e, 0);
    return;
  }
  if (
    e.constructor === t.constructor &&
    e.buffer != null &&
    t.buffer != null &&
    e.byteOffset != null &&
    t.byteOffset != null &&
    e.byteLength != null
  ) {
    copyArrayBufferRange(
      e.buffer,
      e.byteOffset,
      t.buffer,
      t.byteOffset,
      Math.min(e.byteLength, t.buffer.byteLength - t.byteOffset)
    );
    return;
  }
  copyArrayRange(e, 0, t as { [i: number]: number }, 0, n);
}

export function max3(e: number, t: number, n: number): number {
  let r = e;
  if (r < t) r = t;
  if (r < n) r = n;
  return r;
}

let _endianCached: boolean | null = null;
let _endianValue = true;

export function detectNativeEndianness(): boolean {
  if (_endianCached) return _endianValue;
  const e = new ArrayBuffer(2);
  const t = new Uint8Array(e);
  const n = new Uint16Array(e);
  t[0] = 19;
  _endianValue = (255 & n[0]!) === 19;
  _endianCached = true;
  return _endianValue;
}

export function countTrailingZeros32(e: number): number {
  let t = e >>> 0;
  let n = 0;
  if ((t & 65535) === 0) {
    t >>= 16;
    n += 16;
  }
  if ((t & 255) === 0) {
    t >>= 8;
    n += 8;
  }
  if ((t & 15) === 0) {
    t >>= 4;
    n += 4;
  }
  if ((t & 3) === 0) {
    t >>= 2;
    n += 2;
  }
  if ((t & 1) === 0) {
    t >>= 1;
    n += 1;
  }
  if (t === 0) n += 1;
  return n;
}

export function nextPowerOfTwo(e: number): number {
  let t = e - 1;
  t |= t >> 1;
  t |= t >> 2;
  t |= t >> 4;
  t |= t >> 8;
  t |= t >> 16;
  t++;
  return t >>> 0;
}

export function isPowerOfTwo(e: number): boolean {
  return (e & (e - 1)) === 0;
}

export function equalsViaMethod(
  e: { equals?: (o: unknown) => boolean },
  t: unknown
): boolean {
  return typeof e.equals === "function" ? e.equals(t) : false;
}

export function hashMapSlot(e: number, t: number): number {
  return ((e << 2) + e + 1) & t;
}

const DEBRUIJN_CTZ = new Uint8Array([
  0, 1, 28, 2, 29, 14, 24, 3, 30, 22, 20, 15, 25, 17, 4, 8, 31, 27, 13, 23, 21,
  19, 16, 7, 26, 12, 18, 6, 11, 5, 10, 9
]);

export function trailingZeroIndex32(e: number): number {
  return DEBRUIJN_CTZ[((125613361 * (e & -e)) >>> 27) & 31]!;
}

export function popcount32(e: number): number {
  let t = e >>> 0;
  t -= (t >>> 1) & 1431655765;
  t = (858993459 & t) + ((t >>> 2) & 858993459);
  t = (t + (t >>> 4)) & 252645135;
  return Math.imul(t, 16843009) >>> 24;
}

export function hashViaMethod(e: { hash?: () => number }): number {
  if (typeof e.hash === "function") return e.hash();
  return 0;
}

export function hashString(
  e: string | null | undefined,
  t?: number,
  n?: number
): number {
  if (e === null) return 0;
  if (e === undefined) return 1;
  let r = t ?? 0;
  let s = n ?? e.length - r;
  let a = s;
  const i = r + s;
  for (let j = r; j < i; j++) a = (a << 5) - a + e.charCodeAt(j);
  return a >>> 0;
}

export function stringApproxByteSize(e: string): number {
  const t = e.length;
  let n = 0;
  for (let r = 0; r < t; r++) {
    let c = e.charCodeAt(r);
    while (c > 255) {
      n++;
      c >>= 8;
    }
    n++;
  }
  return n;
}

export function alignCeil(e: number, t: number): number {
  return Math.ceil(e / t) * t;
}

export function aabbFromPositions(
  out: { [i: number]: number } | Float32Array | number[],
  positions: ArrayLike<number>,
  floatCount: number
): void {
  let r = Number.POSITIVE_INFINITY;
  let s = Number.POSITIVE_INFINITY;
  let a = Number.POSITIVE_INFINITY;
  let i = Number.NEGATIVE_INFINITY;
  let o = Number.NEGATIVE_INFINITY;
  let _ = Number.NEGATIVE_INFINITY;
  for (let e = 0; e < floatCount; e += 3) {
    const n = positions[e]!;
    const c = positions[e + 1]!;
    const d = positions[e + 2]!;
    if (n < r) r = n;
    if (c < s) s = c;
    if (d < a) a = d;
    if (n > i) i = n;
    if (c > o) o = c;
    if (d > _) _ = d;
  }
  out[0] = r;
  out[1] = s;
  out[2] = a;
  out[3] = i;
  out[4] = o;
  out[5] = _;
}

/**
 * Sampler2D：负责纹理数据、采样参数和 GPU 纹理资源管理。
 */

import { base64Decode, base64Encode } from "../core/base64Codec.js";
import { hashArrayBuffer, hashFloat } from "../core/hashMix.js";
import {
  ctorFromDataType,
  inferDataTypeFromArray,
  ShadeDataType
} from "./ShadeDataType.js";

function clamp(e: number, t: number, n: number): number {
  return e < t ? t : e > n ? n : e;
}

function lerp(e: number, t: number, n: number): number {
  return (t - e) * n + e;
}

function fmin(e: number, t: number): number {
  return e < t ? e : t;
}

function fmax(e: number, t: number): number {
  return e < t ? t : e;
}

function cubicInterpolate(
  e: number,
  t: number,
  n: number,
  r: number,
  s: number
): number {
  return (
    0.5 *
      (r - t + (2 * t - 5 * n + 4 * r - s + (3 * (n - r) + s - t) * e) * e) *
      e +
    n
  );
}

export type SamplerData =
  | Float32Array
  | Float64Array
  | Uint8Array
  | Uint8ClampedArray
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array
  | number[];

export class Sampler2D {
  width: number;
  height: number;
  itemSize: number;
  data: SamplerData;
  version = 0;

  constructor(e: SamplerData = [], t = 1, n = 0, r = 0) {
    if (!Number.isInteger(t) || t < 0) {
      throw new Error(`itemSize must be a non-negative integer, instead was ${t}`);
    }
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`width must be a non-negative integer, instead was ${n}`);
    }
    if (!Number.isInteger(r) || r < 0) {
      throw new Error(`height must be a non-negative integer, instead was ${r}`);
    }
    if (e === undefined) throw new Error("data was undefined");
    if (e.length < n * r * t) {
      throw new Error(
        `Buffer underflow, data.length(=${e.length}) is too small. Expected at least ${n * r * t}`
      );
    }
    this.width = n;
    this.height = r;
    this.itemSize = t;
    this.data = e;
    this.version = 0;
  }

  get isSampler2D(): boolean {
    return true;
  }

  static readonly typeName = "Sampler2D";

  readChannel(e: number, t: number, n: number): number {
    return this.data[(t * this.width + e) * this.itemSize + n]!;
  }

  read(e: number, t: number, n: number[] | Float32Array): void {
    const r = this.itemSize;
    const s = (t * this.width + e) * r;
    for (let i = 0; i < r; i++) n[i] = this.data[s + i]!;
  }

  write(e: number, t: number, n: ArrayLike<number>): void {
    const r = this.itemSize;
    const s = (t * this.width + e) * r;
    for (let i = 0; i < r; i++) this.data[s + i] = n[i]!;
    this.version++;
  }

  writeChannel(e: number, t: number, n: number, r: number): void {
    this.data[(t * this.width + e) * this.itemSize + n] = r;
    this.version++;
  }

  traverseCircle(
    e: number,
    t: number,
    n: number,
    r: (x: number, y: number, sampler: Sampler2D) => void
  ): void {
    const centerX = e | 0;
    const centerY = t | 0;
    const radiusSquared = n * n;
    const extent = Math.ceil(n);
    for (let offsetY = -extent; offsetY <= extent; offsetY++) {
      const offsetYSquared = offsetY * offsetY;
      for (let offsetX = -extent; offsetX <= extent; offsetX++) {
        if (offsetX * offsetX + offsetYSquared <= radiusSquared) {
          r(centerX + offsetX, centerY + offsetY, this);
        }
      }
    }
  }

  sampleCatmullRomUV(e: number, t: number, n: number[] | Float32Array): void {
    const r = this.itemSize;
    for (let s = 0; s < r; s++) n[s] = this.sampleChannelCatmullRomUV(e, t, s);
  }

  sampleChannelCatmullRomUV(e: number, t: number, n: number): number {
    return this.sampleChannelCatmullRom(
      e * this.width - 0.5,
      t * this.height - 0.5,
      n
    );
  }

  sampleChannelCatmullRom(e: number, t: number, n: number): number {
    const r = Math.floor(e);
    const s = Math.floor(t);
    const a = e - r;
    const i = t - s;
    const o = a * (a * (1 - 0.5 * a) - 0.5);
    const _ = i * (i * (1 - 0.5 * i) - 0.5);
    const c = a * (0.5 + a * (2 - 1.5 * a));
    const d = i * (0.5 + i * (2 - 1.5 * i));
    const u = a * a * (0.5 * a - 0.5);
    const l = i * i * (0.5 * i - 0.5);
    const f = 1 + a * a * (1.5 * a - 2.5) + c;
    const h = 1 + i * i * (1.5 * i - 2.5) + d;
    const m = r - 1;
    const g = s - 1;
    const p = r + 2;
    const v = s + 2;
    const A = r + c / f;
    const b = s + d / h;
    let w = 0;
    w += this.sampleChannelBilinear(m, g, n) * o * _;
    w += this.sampleChannelBilinear(A, g, n) * f * _;
    w += this.sampleChannelBilinear(p, g, n) * u * _;
    w += this.sampleChannelBilinear(m, b, n) * o * h;
    w += this.sampleChannelBilinear(A, b, n) * f * h;
    w += this.sampleChannelBilinear(p, b, n) * u * h;
    w += this.sampleChannelBilinear(m, v, n) * o * l;
    w += this.sampleChannelBilinear(A, v, n) * f * l;
    w += this.sampleChannelBilinear(p, v, n) * u * l;
    return w;
  }

  sampleBicubicUV(e: number, t: number, n: number[] | Float32Array): void {
    const r = this.itemSize;
    for (let s = 0; s < r; s++) n[s] = this.sampleChannelBicubicUV(e, t, s);
  }

  sampleBicubic(
    e: number,
    t: number,
    n: number[] | Float32Array,
    r = 0
  ): void {
    const s = this.itemSize;
    for (let a = 0; a < s; a++) n[a + r] = this.sampleChannelBicubic(e, t, a);
  }

  sampleChannelBicubicUV(e: number, t: number, n: number): number {
    return this.sampleChannelBicubic(
      e * this.width - 0.5,
      t * this.height - 0.5,
      n
    );
  }

  sampleChannelBicubic(e: number, t: number, n: number): number {
    const r = this.itemSize;
    const s = this.width;
    const a = this.data;
    const i = s * r;
    const o = s - 1;
    const _ = this.height - 1;
    const c = clamp(e, 0, o);
    const d = clamp(t, 0, _);
    const u = c | 0;
    const l = d | 0;
    const f = c - u;
    const h = d - l;
    const m = fmax(0, u - 1);
    const g = fmax(0, l - 1);
    const p = fmin(o, u + 1);
    const v = fmin(_, l + 1);
    const A = fmin(o, p + 1);
    const b = g * i + n;
    const w = l * i + n;
    const x = v * i + n;
    const B = fmin(_, v + 1) * i + n;
    const P = m * r;
    const z = u * r;
    const E = p * r;
    const C = A * r;
    const D = a[w + P]!;
    const Q = a[w + z]!;
    const k = a[w + E]!;
    const I = a[w + C]!;
    const F = a[x + P]!;
    const M = a[x + z]!;
    const j = a[x + E]!;
    const T = a[x + C]!;
    const L = a[B + P]!;
    const U = a[B + z]!;
    const G = a[B + E]!;
    const H = a[B + C]!;
    const O = cubicInterpolate(f, a[b + P]!, a[b + z]!, a[b + E]!, a[b + C]!);
    const S = cubicInterpolate(f, D, Q, k, I);
    const R = cubicInterpolate(f, F, M, j, T);
    const q = cubicInterpolate(f, L, U, G, H);
    return cubicInterpolate(h, O, S, R, q);
  }

  sampleChannelBilinear(e: number, t: number, n: number): number {
    const r = this.itemSize;
    const s = this.width;
    const a = s * r;
    const i = this.height - 1;
    const o = clamp(e, 0, s - 1);
    const _ = clamp(t, 0, i);
    const c = o >>> 0;
    const d = _ >>> 0;
    const u = d * a;
    const l = c * r + n;
    let f: number;
    let h: number;
    f = o === c ? c : c + 1;
    h = _ === d ? d : d + 1;
    const m = this.data;
    const g = m[u + l]!;
    if (c === f && d === h) return g;
    const p = o - c;
    const v = _ - d;
    const A = f * r + n;
    const b = h * a;
    const w = m[b + l]!;
    const x = m[b + A]!;
    const B = lerp(g, m[u + A]!, p);
    const P = lerp(w, x, p);
    return lerp(B, P, v);
  }

  sampleChannelBilinearUV(e: number, t: number, n: number): number {
    return this.sampleChannelBilinear(e * this.width - 0.5, t * this.height - 0.5, n);
  }

  sampleBilinearUV(e: number, t: number, n: number[] | Float32Array, r = 0): void {
    const s = this.itemSize;
    for (let a = 0; a < s; a++) n[a + r] = this.sampleChannelBilinearUV(e, t, a);
  }

  sampleBilinear(e: number, t: number, n: number[] | Float32Array, r = 0): void {
    const s = this.itemSize;
    for (let a = 0; a < s; a++) n[a + r] = this.sampleChannelBilinear(e, t, a);
  }

  sampleNearestUV(e: number, t: number, n: number[] | Float32Array): void {
    const r = this.width;
    const s = this.height;
    const a = Math.round(e * r - 0.5);
    const i = Math.round(t * s - 0.5);
    this.read(clamp(a, 0, r - 1), clamp(i, 0, s - 1), n);
  }

  point2index(e: number, t: number): number {
    return e + t * this.width;
  }

  index2point(e: number, t: { set: (x: number, y: number) => void }): void {
    const n = this.width;
    t.set(e % n, (e / n) | 0);
  }

  fill(e: number, t: number, n: number, r: number, s: ArrayLike<number>): void {
    const a = this.width;
    const i = this.height;
    const o = clamp(e, 0, a);
    const _ = clamp(t, 0, i);
    const c = clamp(e + n, 0, a);
    const d = clamp(t + r, 0, i);
    const u = this.data;
    const l = this.itemSize;
    const f = l * a;
    for (let h = _; h < d; h++) {
      const row = h * f;
      for (let m = o; m < c; m++) {
        const px = row + m * l;
        for (let g = 0; g < l; g++) u[px + g] = s[g]!;
      }
    }
    this.version++;
  }

  zeroFill(e: number, t: number, n: number, r: number): void {
    const s = clamp(e, 0, this.width);
    const a = clamp(t, 0, this.height);
    const i = clamp(e + n, 0, this.width);
    const o = clamp(t + r, 0, this.height);
    const _ = this.data;
    const c = this.itemSize;
    const d = c * this.width;
    const u = s * c;
    const l = i * c;
    for (let f = a; f < o; f++) {
      const row = f * d;
      if (typeof (_ as Float32Array).fill === "function") {
        (_ as Float32Array).fill(0, row + u, row + l);
      } else {
        for (let p = row + u; p < row + l; p++) _[p] = 0;
      }
    }
    this.version++;
  }

  channelFill(e: number, t: number): void {
    const n = this.itemSize;
    const r = this.data;
    const s = r.length;
    for (let a = e; a < s; a += n) r[a] = t;
    this.version++;
  }

  copy(
    e: Sampler2D,
    t: number,
    n: number,
    r: number,
    s: number,
    a: number,
    i: number
  ): void {
    const o = Math.min(a, e.width - t, this.width - r);
    const _ = Math.min(i, e.height - n, this.height - s);
    const c = this.itemSize;
    const d = e.itemSize;
    const u = Math.min(c, d);
    const l = c * this.width;
    const f = d * e.width;
    const h = e.data;
    const m = this.data;
    for (let p = 0; p < _; p++) {
      const dstRow = (p + s) * l;
      const srcRow = (p + n) * f;
      for (let g = 0; g < o; g++) {
        const dst = dstRow + (g + r) * c;
        const src = srcRow + (g + t) * d;
        for (let v = 0; v < u; v++) m[dst + v] = h[src + v]!;
      }
    }
    this.version++;
  }

  resize(e: number, t: number, n = true): void {
    const r = this.width;
    const s = this.height;
    if (r === e && s === t) return;
    const a = this.itemSize;
    const i = e * t * a;
    const o = this.data;
    const Ctor = arrayCtor(o);
    const _ = new Ctor(i) as SamplerData;
    if (n) {
      if (e === r) {
        if (Array.isArray(o)) {
          for (let k = 0; k < Math.min(o.length, i); k++) (_ as number[])[k] = o[k]!;
        } else {
          (_ as Float32Array).set((o as Float32Array).subarray(0, Math.min(o.length, i)));
        }
      } else {
        const rows = fmin(t, s);
        const cols = fmin(e, r);
        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            const dst = (row * e + col) * a;
            const src = (row * r + col) * a;
            for (let ch = 0; ch < a; ch++) _[dst + ch] = o[src + ch]!;
          }
        }
      }
    }
    this.width = e;
    this.height = t;
    this.data = _;
    this.version++;
  }

  computeByteSize(): number {
    const t = this.data;
    const e = Array.isArray(t) ? 8 * t.length : (t as ArrayBufferView).byteLength;
    return e + 280;
  }

  equals(e: Sampler2D | null | undefined): boolean {
    if (e == null) return false;
    if (this === e) return true;
    if (
      this.width !== e.width ||
      this.height !== e.height ||
      this.itemSize !== e.itemSize
    ) {
      return false;
    }
    return typedArrayEquals(this.data, e.data);
  }

  hash(): number {
    const e = this.itemSize;
    const n = this.width;
    const r = this.height;
    const s = this.data;
    let a = (((65535 & n) << 16) | (65535 & r)) ^ e;
    const i = n * r * e;
    if (isTypedArray(s)) {
      a ^= hashArrayBuffer(s.buffer as ArrayBuffer, s.byteOffset, s.byteLength);
    } else {
      for (let k = 0; k < i; ++k) a = (a << 5) - a + hashFloat(s[k]!);
    }
    return a | 0;
  }

  clone(): Sampler2D {
    let e: SamplerData;
    if (Array.isArray(this.data)) {
      e = this.data.slice();
    } else {
      const Ctor = this.data.constructor as new (src: ArrayLike<number>) => SamplerData;
      e = new Ctor(this.data);
    }
    return new Sampler2D(e, this.itemSize, this.width, this.height);
  }

  toJSON(): Sampler2DJson {
    const type = this.dataTypeString;
    let data: string;
    if (Array.isArray(this.data)) {
      const f64 = new Float64Array(this.data);
      data = base64Encode(f64.buffer);
    } else {
      const view = this.data as ArrayBufferView;
      data = base64Encode(
        new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
      );
    }
    return {
      height: this.height,
      width: this.width,
      itemSize: this.itemSize,
      type,
      data
    };
  }

  fromJSON(json: Sampler2DJson): this {
    const { height: e, width: t, itemSize: n, type: r, data: s } = json;
    const a = ctorFromDataType(r) as new (
      buf: ArrayBuffer | ArrayLike<number>
    ) => SamplerData;
    if (typeof s === "string") {
      this.data = new a(base64Decode(s)) as SamplerData;
    } else {
      if (!Array.isArray(s)) throw new Error("Unsupported data format");
      this.data = new a(s) as SamplerData;
    }
    this.height = e;
    this.width = t;
    this.itemSize = n;
    return this;
  }


  static uint8clamped(e: number, t: number, n: number): Sampler2D {
    return new Sampler2D(new Uint8ClampedArray(t * n * e), e, t, n);
  }
  static uint8(e: number, t: number, n: number): Sampler2D {
    return new Sampler2D(new Uint8Array(t * n * e), e, t, n);
  }
  static uint16(e: number, t: number, n: number): Sampler2D {
    return new Sampler2D(new Uint16Array(t * n * e), e, t, n);
  }
  static uint32(e: number, t: number, n: number): Sampler2D {
    return new Sampler2D(new Uint32Array(t * n * e), e, t, n);
  }
  static int8(e: number, t: number, n: number): Sampler2D {
    return new Sampler2D(new Int8Array(t * n * e), e, t, n);
  }
  static int16(e: number, t: number, n: number): Sampler2D {
    return new Sampler2D(new Int16Array(t * n * e), e, t, n);
  }
  static int32(e: number, t: number, n: number): Sampler2D {
    return new Sampler2D(new Int32Array(t * n * e), e, t, n);
  }
  static float16(e: number, t: number, n: number): Sampler2D {
    const F16 = (globalThis as { Float16Array?: new (n: number) => SamplerData })
      .Float16Array;
    if (typeof F16 !== "function") {
      throw new Error("Float16Array is not available in this environment");
    }
    return new Sampler2D(new F16(t * n * e), e, t, n);
  }
  static float32(e: number, t: number, n: number): Sampler2D {
    return new Sampler2D(new Float32Array(t * n * e), e, t, n);
  }
  static float64(e: number, t: number, n: number): Sampler2D {
    return new Sampler2D(new Float64Array(t * n * e), e, t, n);
  }

  get dataTypeString(): string {
    try {
      return inferDataTypeFromArray(this.data as ArrayBufferView);
    } catch {
      return Array.isArray(this.data) ? ShadeDataType.Float64 : ShadeDataType.Uint8;
    }
  }
}

export interface Sampler2DJson {
  height: number;
  width: number;
  itemSize: number;
  type: string;
  data: string | number[];
}

function isTypedArray(s: SamplerData): s is Exclude<SamplerData, number[]> {
  return !Array.isArray(s) && ArrayBuffer.isView(s);
}

function arrayCtor(o: SamplerData): new (n: number) => SamplerData {
  if (o instanceof Int8Array) return Int8Array;
  if (o instanceof Int16Array) return Int16Array;
  if (o instanceof Int32Array) return Int32Array;
  if (o instanceof Uint8Array) return Uint8Array;
  if (o instanceof Uint8ClampedArray) return Uint8ClampedArray;
  if (o instanceof Uint16Array) return Uint16Array;
  if (o instanceof Uint32Array) return Uint32Array;
  if (o instanceof Float32Array) return Float32Array;
  if (o instanceof Float64Array) return Float64Array;
  if (Array.isArray(o)) return Array as unknown as new (n: number) => SamplerData;
  const name = (o as { constructor?: { name?: string } }).constructor?.name;
  if (name === "Float16Array") {
    return (o as { constructor: new (n: number) => SamplerData }).constructor;
  }
  throw new TypeError("Unsupported array type");
}

function typedArrayEquals(t: SamplerData, n: SamplerData): boolean {
  if (t === n) return true;
  if (t.length !== n.length) return false;
  if (t.constructor !== n.constructor) return false;
  const r = t.length;
  if (r === 0) return true;
  for (let i = 0; i < r; i++) {
    if (t[i] !== n[i]) return false;
  }
  return true;
}

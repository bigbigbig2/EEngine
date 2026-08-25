/**
 * Color：提供渲染器共享的基础数据结构与通用工具。
 */

import { ChangeSignal } from "./Signal.js";
import type { BinaryReader } from "../loaders/BinaryReader.js";

function toByte(e: number): number {
  return Math.round(255 * e);
}

function fromByte(e: number): number {
  return e / 255;
}

function clamp01(e: number): number {
  return e < 0 ? 0 : e > 1 ? 1 : e;
}

function lerp(e: number, t: number, n: number): number {
  return (t - e) * n + e;
}

function hex2(e: number): string {
  const t = Math.round(e).toString(16);
  return t.length === 1 ? "0" + t : t;
}

function hexRgb(e: number, t: number, n: number): string {
  return hex2(e) + hex2(t) + hex2(n);
}

function packRgbUint(r: number, g: number, b: number): number {
  const R = toByte(r);
  const G = toByte(g);
  return (255 & toByte(b)) | ((255 & G) << 8) | ((255 & R) << 16);
}

function hsvToRgb(e: number, t: number, n: number): { r: number; g: number; b: number } {
  let r = e;
  if (r < 0) r += Math.ceil(Math.abs(r));
  r %= 1;
  const s = clamp01(t);
  const a = clamp01(n);
  let i = 0;
  let o = 0;
  let _ = 0;
  const c = Math.floor(6 * r);
  const d = 6 * r - c;
  const u = a * (1 - s);
  const l = a * (1 - d * s);
  const f = a * (1 - (1 - d) * s);
  switch (c % 6) {
    case 0:
      i = a;
      o = f;
      _ = u;
      break;
    case 1:
      i = l;
      o = a;
      _ = u;
      break;
    case 2:
      i = u;
      o = a;
      _ = f;
      break;
    case 3:
      i = u;
      o = l;
      _ = a;
      break;
    case 4:
      i = f;
      o = u;
      _ = a;
      break;
    case 5:
      i = a;
      o = u;
      _ = l;
      break;
  }
  return { r: i, g: o, b: _ };
}

function parseHexByte(e: string): number {
  return parseInt(e, 16);
}

const RE_RGB =
  /rgb\(\s*([0-9]+(?:\.[0-9]*)?),\s*([0-9]+(?:\.[0-9]*)?),\s*([0-9]+(?:\.[0-9]*)?)\s*\)/;
const RE_RGBA =
  /rgba\(\s*([0-9]+(?:\.[0-9]*)?),\s*([0-9]+(?:\.[0-9]*)?),\s*([0-9]+(?:\.[0-9]*)?),\s*([0-9]+(?:\.[0-9]*)?)\s*\)/;
const RE_HSV = /hsv\(([0-9]+(?:\.[0-9]*)?),\s*([0-9]+(?:\.[0-9]*)?),\s*([0-9]+(?:\.[0-9]*)?)\)/;

function linearToSrgbChannel(e: number): number {
  return e < 0.0031308 ? 12.92 * e : 1.055 * Math.pow(e, 0.4166666666666667) - 0.055;
}

function srgbToLinearChannel(e: number): number {
  return e < 0.04045 ? 0.0773993808 * e : Math.pow(0.9478672986 * e + 0.0521327014, 2.4);
}

function fmax(e: number, t: number): number {
  return e < t ? t : e;
}
function fmin(e: number, t: number): number {
  return e < t ? e : t;
}
function fmin3(e: number, t: number, n: number): number {
  let r = e;
  if (r > t) r = t;
  if (r > n) r = n;
  return r;
}

export class Color {
  readonly isColor = true;
  r: number;
  g: number;
  b: number;
  a: number;
  readonly onChanged = new ChangeSignal();

  constructor(r = 0, g = 0, b = 0, a = 1) {
    this.r = r;
    this.g = g;
    this.b = b;
    this.a = a;
  }

  get 0(): number {
    return this.r;
  }
  set 0(e: number) {
    this.r = e;
  }
  get 1(): number {
    return this.g;
  }
  set 1(e: number) {
    this.g = e;
  }
  get 2(): number {
    return this.b;
  }
  set 2(e: number) {
    this.b = e;
  }
  get 3(): number {
    return this.a;
  }
  set 3(e: number) {
    this.a = e;
  }

  get x(): number {
    return this.r;
  }
  get y(): number {
    return this.g;
  }
  get z(): number {
    return this.b;
  }
  get w(): number {
    return this.a;
  }

  get length(): number {
    return 4;
  }

  set(r: number, g: number, b: number, a = 1): this {
    const s = this.r;
    const ag = this.g;
    const i = this.b;
    const o = this.a;
    if (s === r && ag === g && i === b && o === a) return this;
    this.r = r;
    this.g = g;
    this.b = b;
    this.a = a;
    if (this.onChanged.hasHandlers()) {
      this.onChanged.send8(r, g, b, a, s, ag, i, o);
    }
    return this;
  }

  setRGB(r: number, g: number, b: number): this {
    return this.set(r, g, b, this.a);
  }

  setRGBUint8(e: number, t: number, n: number): this {
    return this.setRGB(fromByte(e), fromByte(t), fromByte(n));
  }

  setA(e: number): this {
    return this.set(this.r, this.g, this.b, e);
  }

  setHSL(e: number, t: number, n: number): this {
    let r = e % 1;
    if (r < 0) r += Math.ceil(Math.abs(r));
    const s = (12 * r) % 12;
    const a = (8 + 12 * r) % 12;
    const i = (4 + 12 * r) % 12;
    const o = t * fmin(n, 1 - n);
    const _ = n - o * fmax(-1, fmin3(s - 3, 9 - s, 1));
    const c = n - o * fmax(-1, fmin3(a - 3, 9 - a, 1));
    const d = n - o * fmax(-1, fmin3(i - 3, 9 - i, 1));
    return this.setRGB(_, c, d);
  }

  setHCL(e: number, t: number, n: number): this {
    let r = e % 1;
    if (r < 0) r += Math.ceil(Math.abs(r));
    const s = 6 * r;
    const a = t * (1 - Math.abs((s % 2) - 1));
    let i = 0;
    let o = 0;
    let _ = 0;
    switch (Math.floor(s)) {
      case 0:
        i = t;
        o = a;
        _ = 0;
        break;
      case 1:
        i = a;
        o = t;
        _ = 0;
        break;
      case 2:
        i = 0;
        o = t;
        _ = a;
        break;
      case 3:
        i = 0;
        o = a;
        _ = t;
        break;
      case 4:
        i = a;
        o = 0;
        _ = t;
        break;
      case 5:
        i = t;
        o = 0;
        _ = a;
        break;
    }
    const c = n - (0.3 * i + 0.59 * o + 0.11 * _);
    return this.setRGB(i + c, o + c, _ + c);
  }

  setHSI(e: number, t: number, n: number): this {
    let r = e % 1;
    if (r < 0) r += Math.ceil(Math.abs(r));
    const s = 6 * r;
    const a = 1 - Math.abs((s % 2) - 1);
    const i = (3 * n * t) / (1 + a);
    const o = i * a;
    let _ = 0;
    let c = 0;
    let d = 0;
    switch (Math.floor(s)) {
      case 0:
        _ = i;
        c = o;
        d = 0;
        break;
      case 1:
        _ = o;
        c = i;
        d = 0;
        break;
      case 2:
        _ = 0;
        c = i;
        d = o;
        break;
      case 3:
        _ = 0;
        c = o;
        d = i;
        break;
      case 4:
        _ = o;
        c = 0;
        d = i;
        break;
      case 5:
        _ = i;
        c = 0;
        d = o;
        break;
    }
    const u = n * (1 - t);
    return this.setRGB(_ + u, c + u, d + u);
  }

  setHSV(e: number, t: number, n: number): this {
    const { r, g, b } = hsvToRgb(e, t, n);
    return this.setRGB(r, g, b);
  }

  setFromPackedUint32(t: number): this {
    this.r = ((t >>> 24) & 255) / 255;
    this.g = ((t >>> 8) & 255) / 255;
    this.b = ((t >>> 16) & 255) / 255;
    this.a = (t & 255) / 255;
    return this;
  }

  getHSV(): { h: number; s: number; v: number } {
    const e = this.r;
    const t = this.g;
    const n = this.b;
    const r = Math.max(e, t, n);
    const s = Math.min(e, t, n);
    let a = 0;
    const o = r;
    const _ = r - s;
    const i = r === 0 ? 0 : _ / r;
    if (r === s) a = 0;
    else {
      switch (r) {
        case e:
          a = (t - n) / _ + (t < n ? 6 : 0);
          break;
        case t:
          a = (n - e) / _ + 2;
          break;
        case n:
          a = (e - t) / _ + 4;
          break;
      }
      a /= 6;
    }
    return { h: a, s: i, v: o };
  }

  fromArray(v: ArrayLike<number>, offset = 0): this {
    return this.set(
      v[offset] as number,
      v[offset + 1] as number,
      v[offset + 2] as number,
      v[offset + 3] ?? 1
    );
  }

  toArray(e: number[] = [], t = 0): number[] {
    e[t] = this.r;
    e[t + 1] = this.g;
    e[t + 2] = this.b;
    e[t + 3] = this.a;
    return e;
  }

  multiplyScalar(s: number): this {
    return this.set(this.r * s, this.g * s, this.b * s, this.a * s);
  }

  multiply(e: Color): this {
    return this.set(this.r * e.r, this.g * e.g, this.b * e.b, this.a * e.a);
  }

  copy(other: Color): this {
    return this.set(other.r, other.g, other.b, other.a);
  }

  clone(): Color {
    const e = new Color();
    e.copy(this);
    return e;
  }

  equals(other: Color): boolean {
    return (
      this.r === other.r &&
      this.g === other.g &&
      this.b === other.b &&
      this.a === other.a
    );
  }

  toUint(): number {
    return packRgbUint(this.r, this.g, this.b);
  }

  hash(): number {
    return this.toUint();
  }

  computeLuminance(): number {
    return 0.2126 * this.r + 0.7152 * this.g + 0.0722 * this.b;
  }

  toUint32(): number {
    return (packRgbUint(this.r, this.b, this.g) << 8) | (255 & toByte(this.a));
  }

  fromUint(e: number): this {
    return this.setRGBUint8(e >> 16, (e >> 8) & 255, 255 & e);
  }

  toHex(): string {
    return "#" + hexRgb(toByte(this.r), toByte(this.g), toByte(this.b));
  }

  toCssRGBAString(): string {
    return `rgba(${toByte(this.r)},${toByte(this.g)},${toByte(this.b)},${this.a})`;
  }

  toJSON(): { r: number; g: number; b: number; a: number } {
    return { r: this.r, g: this.g, b: this.b, a: this.a };
  }

  fromJSON({ r, g, b, a = 1 }: { r: number; g: number; b: number; a?: number }): void {
    this.set(r, g, b, a);
  }

  toString(): string {
    return `Color{r:${this.r},g:${this.g},b:${this.b},a:${this.a}}`;
  }

  *[Symbol.iterator](): Generator<number> {
    yield this.r;
    yield this.g;
    yield this.b;
    yield this.a;
  }

  toBinaryBuffer(e: BinaryReader): void {
    e.writeFloat32(this.r);
    e.writeFloat32(this.g);
    e.writeFloat32(this.b);
    e.writeFloat32(this.a);
  }

  fromBinaryBuffer(e: BinaryReader): this {
    const t = e.readFloat32();
    const n = e.readFloat32();
    const r = e.readFloat32();
    const s = e.readFloat32();
    return this.set(t, n, r, s);
  }

  parse(e: string | number): this {
    const t: number[] = [];
    const n = typeof e;
    let r = 0;
    let s = 0;
    let a = 0;
    let i = 1;
    if (n === "string") {
      const str = (e as string).toLowerCase();
      let m: RegExpMatchArray | null;
      if ((m = str.match(RE_RGB)) !== null) {
        r = parseFloat(m[1]!);
        s = parseFloat(m[2]!);
        a = parseFloat(m[3]!);
      } else if ((m = str.match(RE_RGBA)) !== null) {
        r = parseFloat(m[1]!);
        s = parseFloat(m[2]!);
        a = parseFloat(m[3]!);
        i = parseFloat(m[4]!);
      } else if ((m = str.match(RE_HSV)) !== null) {
        const rgb = hsvToRgb(parseFloat(m[1]!), parseFloat(m[2]!), parseFloat(m[3]!));
        r = toByte(rgb.r);
        s = toByte(rgb.g);
        a = toByte(rgb.b);
      } else {
        if (!str.startsWith("#")) {
          throw new Error(`Failed to decode color string '${e}' `);
        }
        const hex = {
          r: parseHexByte(str.slice(1, 3)),
          g: parseHexByte(str.slice(3, 5)),
          b: parseHexByte(str.slice(5, 7)),
          a: str.length > 7 ? parseHexByte(str.slice(7, 9)) : 255
        };
        r = hex.r;
        s = hex.g;
        a = hex.b;
        i = fromByte(hex.a);
      }
    } else {
      if (n !== "number") throw new Error(`Failed to decode color '${e}'`);
      const num = e as number;
      r = num >> 16;
      s = (num >> 8) & 255;
      a = 255 & num;
    }
    t[0] = r;
    t[1] = s;
    t[2] = a;
    t[3] = i;
    this.a = typeof t[3] === "number" ? t[3]! : 1;
    return this.setRGB(t[0]! / 255, t[1]! / 255, t[2]! / 255);
  }

  lerpColors(e: Color, t: Color, n: number): this {
    return this.set(
      lerp(e.r, t.r, n),
      lerp(e.g, t.g, n),
      lerp(e.b, t.b, n),
      lerp(e.a, t.a, n)
    );
  }

  static fromArray(e: ArrayLike<number>, t = 0): Color {
    const n = new Color();
    n.fromArray(e, t);
    return n;
  }

  static fromRGB(e: number, t: number, n: number): Color {
    return new Color(e, t, n);
  }

  static fromHSV(e: number, t: number, n: number): Color {
    const r = new Color();
    r.setHSV(e, t, n);
    return r;
  }

  static parse(e: string | number): Color {
    const t = new Color();
    t.parse(e);
    return t;
  }

  static from_linear_to_sRGB(
    e: ArrayLike<number>,
    t: Color = new Color()
  ): Color {
    t.r = linearToSrgbChannel(e[0] ?? 0);
    t.g = linearToSrgbChannel(e[1] ?? 0);
    t.b = linearToSrgbChannel(e[2] ?? 0);
    return t;
  }

  static from_sRGB_to_linear(
    e: ArrayLike<number>,
    t: Color = new Color()
  ): Color {
    t.r = srgbToLinearChannel(e[0] ?? 0);
    t.g = srgbToLinearChannel(e[1] ?? 0);
    t.b = srgbToLinearChannel(e[2] ?? 0);
    return t;
  }

  static readonly red = Object.freeze(new Color(1, 0, 0)) as Color;
  static readonly green = Object.freeze(new Color(0, 1, 0)) as Color;
  static readonly blue = Object.freeze(new Color(0, 0, 1)) as Color;
  static readonly yellow = Object.freeze(new Color(1, 1, 0)) as Color;
  static readonly cyan = Object.freeze(new Color(0, 1, 1)) as Color;
  static readonly magenta = Object.freeze(new Color(1, 0, 1)) as Color;
  static readonly white = Object.freeze(new Color(1, 1, 1)) as Color;
  static readonly black = Object.freeze(new Color(0, 0, 0)) as Color;
  static readonly transparent = Object.freeze(new Color(0, 0, 0, 0)) as Color;
}

/**
 * AABB2：提供渲染系统使用的数学运算与基础数据结构。
 */

import { clamp, fmax, fmin } from "./mathUtils.js";
import { Vec2 } from "./Vec2.js";

const _lineHit = new Float32Array(2);

export function intervalOverlaps1D(e: number, t: number, n: number, r: number): boolean {
  return t > n && r > e;
}

export function aabb2Overlaps(
  e: number,
  t: number,
  n: number,
  r: number,
  s: number,
  a: number,
  i: number,
  o: number
): boolean {
  return intervalOverlaps1D(e, n, s, i) && intervalOverlaps1D(t, r, a, o);
}

export function lineSegmentIntersect2D(
  e: number,
  t: number,
  n: number,
  r: number,
  s: number,
  a: number,
  i: number,
  o: number,
  out: { fromArray(arr: ArrayLike<number>): unknown }
): boolean {
  const d = n - e;
  const u = r - t;
  const l = i - s;
  const f = o - a;
  const h = t - a;
  const m = e - s;
  const g = 1 / (-l * u + d * f);
  const p = (-u * m + d * h) * g;
  const v = (l * h - f * m) * g;
  if (p >= 0 && p <= 1 && v >= 0 && v <= 1) {
    const y = t + v * u;
    _lineHit[0] = e + v * d;
    _lineHit[1] = y;
    out.fromArray(_lineHit);
    return true;
  }
  return false;
}

export class AABB2 {
  x0: number;
  y0: number;
  x1: number;
  y1: number;

  readonly length = 4;

  get isAABB2(): boolean {
    return true;
  }

  constructor(e = 0, t = 0, n = 0, r = 0) {
    this.x0 = e;
    this.y0 = t;
    this.x1 = n;
    this.y1 = r;
  }

  *[Symbol.iterator](): Generator<number> {
    yield this.x0;
    yield this.y0;
    yield this.x1;
    yield this.y1;
  }

  get 0(): number {
    return this.x0;
  }
  set 0(e: number) {
    this.x0 = e;
  }
  get 1(): number {
    return this.y0;
  }
  set 1(e: number) {
    this.y0 = e;
  }
  get 2(): number {
    return this.x1;
  }
  set 2(e: number) {
    this.x1 = e;
  }
  get 3(): number {
    return this.y1;
  }
  set 3(e: number) {
    this.y1 = e;
  }

  growWidth(e: number): void {
    this.x0 -= e;
    this.x1 += e;
  }

  growHeight(e: number): void {
    this.y0 -= e;
    this.y1 += e;
  }

  grow(e: number): void {
    this.growWidth(e);
    this.growHeight(e);
  }

  shrink(e: number): void {
    this.grow(-e);
  }

  applyMatrix3(e: ArrayLike<number>): void {
    const t = e[0]!;
    const n = e[1]!;
    const r = e[3]!;
    const s = e[4]!;
    const a = e[6]!;
    const i = e[7]!;
    const o = this.x0;
    const _ = this.y0;
    const c = this.x1;
    const d = this.y1;
    const u = t * o + r * _ + a;
    const l = n * o + s * _ + i;
    const f = t * c + r * d + a;
    const h = n * c + s * d + i;
    this.set(fmin(u, f), fmin(l, h), fmax(u, f), fmax(l, h));
  }

  multiplyScalar(e: number): void {
    this.set(this.x0 * e, this.y0 * e, this.x1 * e, this.y1 * e);
  }

  computeOverlap(e: AABB2, t: AABB2): boolean {
    const c = fmax(this.x0, e.x0);
    const d = fmin(this.x1, e.x1);
    if (c >= d) return false;
    const u = fmax(this.y0, e.y0);
    const l = fmin(this.y1, e.y1);
    if (u >= l) return false;
    t.set(c, u, d, l);
    return true;
  }

  overlapExists(e: AABB2): boolean {
    return aabb2Overlaps(
      this.x0,
      this.y0,
      this.x1,
      this.y1,
      e.x0,
      e.y0,
      e.x1,
      e.y1
    );
  }

  _expandToFit(e: number, t: number, n: number, r: number): void {
    this.x0 = fmin(this.x0, e);
    this.y0 = fmin(this.y0, t);
    this.x1 = fmax(this.x1, n);
    this.y1 = fmax(this.y1, r);
  }

  _expandToFitPoint(e: number, t: number): void {
    this._expandToFit(e, t, e, t);
  }

  lineIntersectionPoint(
    e: { x: number; y: number },
    t: { x: number; y: number },
    n: { fromArray(arr: ArrayLike<number>): unknown }
  ): boolean {
    const r = this.x0;
    const s = this.y0;
    const a = this.x1;
    const i = this.y1;
    return !!(
      lineSegmentIntersect2D(e.x, e.y, t.x, t.y, r, s, a, s, n) ||
      lineSegmentIntersect2D(e.x, e.y, t.x, t.y, r, i, a, i, n) ||
      lineSegmentIntersect2D(e.x, e.y, t.x, t.y, r, s, r, i, n) ||
      lineSegmentIntersect2D(e.x, e.y, t.x, t.y, a, s, a, i, n)
    );
  }

  computeNearestPointToPoint(
    e: { x: number; y: number },
    t: { set(x: number, y: number): unknown }
  ): void {
    t.set(clamp(e.x, this.x0, this.x1), clamp(e.y, this.y0, this.y1));
  }

  costForInclusion(e: AABB2): number {
    return this._costForInclusion(e.x0, e.y0, e.x1, e.y1);
  }

  _costForInclusion(e: number, t: number, n: number, r: number): number {
    let s = 0;
    let a = 0;
    const i = this.x0;
    const o = this.y0;
    const _ = this.x1;
    const c = this.y1;
    if (i > e) s += i - e;
    if (_ < n) s += n - _;
    if (o > t) a += o - t;
    if (c < r) a += r - c;
    return s * (c - o) + a * (_ - i);
  }

  computeArea(): number {
    return (this.x1 - this.x0) * (this.y1 - this.y0);
  }

  computeSurfaceArea(): number {
    return 2 * (this.x1 - this.x0 + (this.y1 - this.y0));
  }

  containsPoint(e: number, t: number): boolean {
    return e >= this.x0 && e <= this.x1 && t >= this.y0 && t <= this.y1;
  }

  expandToFit(e: AABB2): void {
    this._expandToFit(e.x0, e.y0, e.x1, e.y1);
  }

  getCenter(e: Vec2 = new Vec2()): Vec2 {
    e.set(this.centerX, this.centerY);
    return e;
  }

  midX(): never {
    throw new Error("deprecated, use .centerX instead");
  }

  midY(): never {
    throw new Error("deprecated, use .centerY instead");
  }

  get centerX(): number {
    return 0.5 * (this.x0 + this.x1);
  }
  get centerY(): number {
    return 0.5 * (this.y0 + this.y1);
  }

  getWidth(): number {
    return this.width;
  }
  get width(): number {
    return this.x1 - this.x0;
  }
  getHeight(): number {
    return this.height;
  }
  get height(): number {
    return this.y1 - this.y0;
  }

  set(e: number, t: number, n: number, r: number): this {
    this.x0 = e;
    this.y0 = t;
    this.x1 = n;
    this.y1 = r;
    return this;
  }

  setPosition(e: number, t: number): void {
    this.set(e, t, e + this.width, t + this.height);
  }

  move(e: number, t: number): this {
    return this.set(this.x0 + e, this.y0 + t, this.x1 + e, this.y1 + t);
  }

  clone(): AABB2 {
    return new AABB2(this.x0, this.y0, this.x1, this.y1);
  }

  copy(e: AABB2): this {
    return this.set(e.x0, e.y0, e.x1, e.y1);
  }

  equals(e: AABB2): boolean {
    return this.x0 === e.x0 && this.y0 === e.y0 && this.x1 === e.x1 && this.y1 === e.y1;
  }

  hash(): number {
    let e = 0;
    e = (e ^ ((73856093 * this.x0) >>> 0)) >>> 0;
    e = ((e << 13) | (e >>> 19)) >>> 0;
    e = (e ^ ((19349663 * this.y0) >>> 0)) >>> 0;
    e = ((e << 17) | (e >>> 15)) >>> 0;
    e = (e ^ ((83492791 * this.x1) >>> 0)) >>> 0;
    e = ((e << 23) | (e >>> 9)) >>> 0;
    e = (e ^ ((536870912 * this.y1) >>> 0)) >>> 0;
    e = ((e << 29) | (e >>> 3)) >>> 0;
    return e;
  }

  clamp(e: number, t: number, n: number, r: number): void {
    this.x0 = clamp(this.x0, e, n);
    this.y0 = clamp(this.y0, t, r);
    this.x1 = clamp(this.x1, e, n);
    this.y1 = clamp(this.y1, t, r);
  }

  setBoundsUnordered(e: number, t: number, n: number, r: number): void {
    let s: number;
    let a: number;
    let i: number;
    let o: number;
    if (e < n) {
      s = e;
      i = n;
    } else {
      s = n;
      i = e;
    }
    if (t < r) {
      a = t;
      o = r;
    } else {
      a = r;
      o = t;
    }
    this.set(s, a, i, o);
  }

  setNegativelyInfiniteBounds(): this {
    return this.set(
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY
    );
  }

  toString(): string {
    return `AABB2{x0:${this.x0}, y0:${this.y0}, x1:${this.x1}, y1:${this.y1}}`;
  }

  toJSON(): { x0: number; y0: number; x1: number; y1: number } {
    return { x0: this.x0, y0: this.y0, x1: this.x1, y1: this.y1 };
  }

  fromJSON(e: { x0: number; y0: number; x1: number; y1: number }): void {
    this.set(e.x0, e.y0, e.x1, e.y1);
  }

  toArray(e: number[] = [], t = 0): number[] {
    e[t] = this.x0;
    e[t + 1] = this.y0;
    e[t + 2] = this.x1;
    e[t + 3] = this.y1;
    return e;
  }

  static computeLineBetweenTwoBoxes(
    e: AABB2,
    t: AABB2,
    n: { fromArray(arr: ArrayLike<number>): unknown },
    r: { fromArray(arr: ArrayLike<number>): unknown }
  ): boolean {
    const s = new Vec2(e.centerX, e.centerY);
    const a = new Vec2(t.centerX, t.centerY);
    return !!e.lineIntersectionPoint(s, a, n) && !!t.lineIntersectionPoint(s, a, r);
  }

  static readonly zero: Readonly<AABB2> = Object.freeze(new AABB2(0, 0, 0, 0));

  static readonly unit: Readonly<AABB2> = Object.freeze(new AABB2(0, 0, 1, 1));
}

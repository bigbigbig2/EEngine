/**
 * Miniball：负责几何数据、Meshlet 或空间结构处理。
 */

import { BitSet } from "../core/BitSet.js";
import { ShadeDataType } from "../texture/ShadeDataType.js";
import { ctorFromDataType } from "../texture/ShadeDataType.js";

export function square(e: number): number {
  return e * e;
}

export function dotN(e: ArrayLike<number>, t: ArrayLike<number>, n: number): number {
  let r = 0;
  for (let s = 0; s < n; s++) r += e[s]! * t[s]!;
  return r;
}

export function dotRange(
  e: ArrayLike<number> | { [i: number]: number },
  t: number,
  n: ArrayLike<number> | { [i: number]: number },
  r: number,
  s: number
): number {
  let a = 0;
  for (let i = 0; i < s; i++) a += (e as ArrayLike<number>)[t + i]! * (n as ArrayLike<number>)[r + i]!;
  return a;
}

export function axpyRange(
  e: { [i: number]: number },
  t: number,
  n: number,
  r: ArrayLike<number> | { [i: number]: number },
  s: number,
  a: number
): void {
  for (let i = 0; i < a; ++i) {
    e[t + i] = (e[t + i] ?? 0) + n * (r as ArrayLike<number>)[s + i]!;
  }
}

export function givensCs(e: number, t: number, n: { [i: number]: number }): void {
  if (t === 0) {
    n[0] = 1;
    n[1] = 0;
  } else if (Math.abs(t) > Math.abs(e)) {
    const r = e / t;
    const s = 1 / Math.sqrt(1 + r * r);
    n[0] = s * r;
    n[1] = s;
  } else {
    const r = t / e;
    const s = 1 / Math.sqrt(1 + r * r);
    n[0] = s;
    n[1] = s * r;
  }
}

export function applyGivensRows(
  e: { [i: number]: number },
  t: number,
  n: number,
  r: number,
  s: number,
  a: number
): void {
  for (let i = 0; i < a; ++i) {
    const a0 = e[t + i]!;
    const o = e[n + i]!;
    e[t + i] = r * a0 + s * o;
    e[n + i] = r * o - s * a0;
  }
}

export class SquareMatrix {
  size: number;
  type: string;
  data: Float64Array | Float32Array | Int32Array | Uint32Array | ArrayLike<number> & {
    [i: number]: number;
    length: number;
    set(src: ArrayLike<number>): void;
    fill(v: number): void;
  };

  constructor(e: number, t: string) {
    const n = ctorFromDataType(t);
    this.size = e;
    this.type = t;
    this.data = new n(e * e) as SquareMatrix["data"];
  }

  get n(): number {
    return this.size;
  }

  get length(): number {
    return this.size * this.size;
  }

  get val(): SquareMatrix["data"] {
    return this.data;
  }

  fill(e: number): void {
    (this.data as { fill(v: number): void }).fill(e);
  }

  subtract(e: SquareMatrix): void {
    this.subtractMatrices(this, e);
  }

  subtractMatrices(e: SquareMatrix, t: SquareMatrix): void {
    const n = this.size;
    const r = n * n;
    const s = e.data;
    const a = t.data;
    const i = this.data;
    for (let k = 0; k < r; k++) (i as { [i: number]: number })[k] = s[k]! - a[k]!;
  }

  negate(): void {
    const e = this.data as { [i: number]: number; length: number };
    const t = e.length;
    for (let n = 0; n < t; n++) e[n] = -e[n]!;
  }

  clear(): void {
    this.fill(0);
  }

  eye(): void {
    const e = this.size;
    const d = this.data as { [i: number]: number };
    for (let t = 0; t < e * e; t++) d[t] = 0;
    for (let t = 0; t < e; t++) d[t * (e + 1)] = 1;
  }

  copy(e: SquareMatrix): void {
    (this.data as { set(src: ArrayLike<number>): void }).set(e.data as ArrayLike<number>);
  }

  clone(): SquareMatrix {
    const e = new SquareMatrix(this.size, this.type);
    e.copy(this);
    return e;
  }

  transpose(): void {
    const e = this.size;
    for (let t = 0; t < e; t++) {
      for (let n = t + 1; n < e; n++) {
        const a = this.getCellValue(n, t);
        const r = this.getCellValue(t, n);
        this.setCellValue(n, t, r);
        this.setCellValue(t, n, a);
      }
    }
  }

  fromArray(e: ArrayLike<number>): void {
    (this.data as { set(src: ArrayLike<number>): void }).set(e);
  }

  toArray(e: number[] = new Array(this.length), t = 0): number[] {
    const d = this.data;
    for (let i = 0; i < this.length; i++) e[t + i] = d[i]!;
    return e;
  }

  setCellValue(e: number, t: number, n: number): void {
    (this.data as { [i: number]: number })[this.size * t + e] = n;
  }

  getCellValue(e: number, t: number): number {
    return this.data[this.size * t + e]!;
  }

  readDiagonal(e: { [i: number]: number }): void {
    const t = this.size;
    const n = this.data;
    for (let r = 0; r < t; r++) e[r] = n[r * (t + 1)]!;
  }
}

export interface PointSet {
  size(): number;
  dimension(): number;
  coord(e: number, t: number): number;
}

export class PointCloud implements PointSet {
  private __data: ArrayLike<number>;
  private __size: number;
  private __dimensions: number;

  constructor(e: number, t: number, n: ArrayLike<number>) {
    this.__data = n;
    this.__size = e;
    this.__dimensions = t;
  }

  size(): number {
    return this.__size;
  }

  dimension(): number {
    return this.__dimensions;
  }

  coord(e: number, t: number): number {
    return this.__data[e * this.__dimensions + t]!;
  }
}

export class AffineSupport {
  S: PointSet;
  membership: BitSet;
  dim: number;
  members: Int32Array;
  Q: SquareMatrix;
  R: SquareMatrix;
  u: Float64Array;
  w: Float64Array;
  r: number;
  cs: Float64Array;

  constructor(e: number, t: PointSet, n: number) {
    this.S = t;
    this.membership = BitSet.fixedSize(t.size());
    this.dim = e;
    this.members = new Int32Array(e + 1);
    this.Q = new SquareMatrix(e, ShadeDataType.Float64);
    this.Q.eye();
    this.R = new SquareMatrix(e, ShadeDataType.Float64);
    this.u = new Float64Array(e);
    this.w = new Float64Array(e);
    this.r = 0;
    this.cs = new Float64Array(2);
    this.membership.set(n, true);
    this.members[this.r] = n;
  }

  dimension(): number {
    return this.dim;
  }

  size(): number {
    return this.r + 1;
  }

  isMember(e: number): boolean {
    return this.membership.get(e);
  }

  anyMember(): number {
    return this.members[this.r]!;
  }

  globalIndex(e: number): number {
    return this.members[e]!;
  }

  ind(e: number, t: number): number {
    return e * this.dim + t;
  }

  origin(): number {
    return this.members[this.r]!;
  }

  appendColumn(): void {
    const e = this.dim;
    const t = this.u;
    const n = this.Q.data as { [i: number]: number };
    const r = this.R.data as { [i: number]: number };
    const s = this.cs;
    const a = this.r * e;
    for (let k = 0; k < e; ++k) {
      r[a + k] = dotRange(n, k * e, t, 0, e);
    }
    for (let t0 = e - 1; t0 > this.r; --t0) {
      givensCs(r[a + t0 - 1]!, r[a + t0]!, s);
      const i = s[0]!;
      const o = s[1]!;
      r[a + t0 - 1] = i * r[a + t0 - 1]! + o * r[a + t0]!;
      applyGivensRows(n, (t0 - 1) * e, t0 * e, i, o, e);
    }
  }

  add(e: number): void {
    const t = this.origin();
    const n = this.dim;
    const r = this.u;
    const s = this.S;
    for (let a = 0; a < n; ++a) r[a] = s.coord(e, a) - s.coord(t, a);
    this.appendColumn();
    this.membership.set(e, true);
    this.members[this.r + 1] = this.members[this.r]!;
    this.members[this.r] = e;
    ++this.r;
  }

  shortestVectorToSpan(e: ArrayLike<number>, t: { [i: number]: number }): number {
    const n = this.origin();
    const r = this.dim;
    const s = this.S;
    for (let a = 0; a < r; ++a) t[a] = s.coord(n, a) - e[a]!;
    const a = this.Q.data as { [i: number]: number };
    const i = this.r;
    for (let k = 0; k < i; ++k) {
      const n0 = k * r;
      axpyRange(t, 0, -dotRange(t, 0, a, n0, r), a, n0, r);
    }
    return dotRange(t, 0, t, 0, r);
  }

  findAffineCoefficients(e: ArrayLike<number>, t: { [i: number]: number }): void {
    const n = this.origin();
    const r = this.dim;
    const s = this.u;
    for (let k = 0; k < r; ++k) s[k] = e[k]! - this.S.coord(n, k);
    const a = this.w;
    const i = this.Q.data as ArrayLike<number>;
    for (let k = 0; k < r; ++k) a[k] = dotRange(i, k * r, s, 0, r);
    let o = 1;
    const _ = this.R.data as ArrayLike<number>;
    const c = this.r;
    for (let e0 = c - 1; e0 >= 0; --e0) {
      const n0 = e0 * r;
      for (let n1 = e0 + 1; n1 < c; ++n1) {
        a[e0]! -= t[n1]! * _[n1 * r + e0]!;
      }
      const s0 = a[e0]! / _[n0 + e0]!;
      t[e0] = s0;
      o -= s0;
    }
    t[c] = o;
  }

  hessenberg_clear(e: number): void {
    let t = e;
    const n = this.R.data as { [i: number]: number };
    const r = this.Q.data as { [i: number]: number };
    const s = this.dim;
    const a = this.cs;
    const i = this.r;
    for (; t < i; ++t) {
      const e0 = t * s;
      givensCs(n[e0 + t]!, n[e0 + t + 1]!, a);
      const o = a[0]!;
      const _ = a[1]!;
      n[e0 + t] = o * n[e0 + t]! + _ * n[e0 + t + 1]!;
      for (let e1 = t + 1; e1 < i; ++e1) {
        const r0 = e1 * s;
        const a0 = n[r0 + t]!;
        const i0 = n[r0 + t + 1]!;
        n[r0 + t] = o * a0 + _ * i0;
        n[r0 + t + 1] = o * i0 - _ * a0;
      }
      applyGivensRows(r, e0, e0 + s, o, _, s);
    }
  }

  special_rank_1_update(): void {
    const e = this.dim;
    const t = this.w;
    const n = this.u;
    const r = this.Q.data as { [i: number]: number };
    const s = this.R.data as { [i: number]: number };
    const a = this.cs;
    const i = this.r;
    for (let k = 0; k < e; ++k) t[k] = dotRange(r, k * e, n, 0, e);
    for (let n0 = e - 1; n0 > 0; --n0) {
      givensCs(t[n0 - 1]!, t[n0]!, a);
      const o = a[0]!;
      const _ = a[1]!;
      t[n0 - 1] = o * t[n0 - 1]! + _ * t[n0]!;
      const c = (n0 - 1) * e;
      s[c + n0] = -_ * s[c + n0 - 1]!;
      s[c + n0 - 1] = s[c + n0 - 1]! * o;
      for (let t0 = n0; t0 < i; ++t0) {
        const r0 = t0 * e;
        const a0 = s[r0 + n0 - 1]!;
        const i0 = s[r0 + n0]!;
        s[r0 + n0 - 1] = o * a0 + _ * i0;
        s[r0 + n0] = o * i0 - _ * a0;
      }
      applyGivensRows(r, c, c + e, o, _, e);
    }
    const o = t[0]!;
    for (let t0 = 0; t0 < i; ++t0) s[t0 * e] = s[t0 * e]! + o;
    this.hessenberg_clear(0);
  }

  remove(e: number): void {
    this.membership.clear(this.globalIndex(e));
    if (e === this.r) {
      const e0 = this.origin();
      const t = this.globalIndex(this.r - 1);
      const n = this.dim;
      const r = this.S;
      const s = this.u;
      for (let a = 0; a < n; ++a) s[a] = r.coord(e0, a) - r.coord(t, a);
      --this.r;
      this.special_rank_1_update();
    } else {
      const t = this.dim;
      const n = this.members;
      (this.R.data as Float64Array).copyWithin(e * t, (e + 1) * t, this.r * t);
      for (let t0 = e + 1; t0 < this.r; ++t0) n[t0 - 1] = n[t0]!;
      n[this.r - 1] = n[this.r]!;
      --this.r;
      this.hessenberg_clear(e);
    }
  }
}

export class Miniball {
  iteration = 0;
  distToAff = 0;
  distToAffSquare = 0;
  __squaredRadius = 0;
  __radius = 0;
  stopper = 0;
  S: PointSet;
  __size: number;
  dim: number;
  __center: Float64Array;
  centerToAff: Float64Array;
  centerToPoint: Float64Array;
  lambdas: Float64Array;
  __support: AffineSupport;

  constructor(e: PointSet) {
    this.S = e;
    this.__size = this.S.size();
    const t = this.S.dimension();
    this.dim = t;
    const n = new ArrayBuffer(8 * (4 * t + 1));
    this.__center = new Float64Array(n, 0, t);
    this.centerToAff = new Float64Array(n, 8 * t, t);
    this.centerToPoint = new Float64Array(n, 16 * t, t);
    this.lambdas = new Float64Array(n, 24 * t, t + 1);
    this.__support = this.initBall();
    this.compute();
  }

  isEmpty(): boolean {
    return this.__size === 0;
  }

  radius(): number {
    return this.__radius;
  }

  center(): Float64Array {
    return this.__center;
  }

  get support(): AffineSupport {
    return this.__support;
  }

  size(): number {
    return this.__size;
  }

  initBall(): AffineSupport {
    let e: number;
    let t: number;
    const n = this.dim;
    const r = this.__center;
    const s = this.S;
    for (e = 0; e < n; ++e) r[e] = s.coord(0, e);
    this.__squaredRadius = 0;
    let a = 0;
    const i = s.size();
    for (t = 1; t < i; ++t) {
      let i0 = 0;
      for (e = 0; e < n; ++e) i0 += square(s.coord(t, e) - r[e]!);
      if (i0 >= this.__squaredRadius) {
        this.__squaredRadius = i0;
        a = t;
      }
    }
    this.__radius = Math.sqrt(this.__squaredRadius);
    return new AffineSupport(this.dim, s, a);
  }

  computeDistToAff(): void {
    this.distToAffSquare = this.__support.shortestVectorToSpan(
      this.__center,
      this.centerToAff
    );
    this.distToAff = Math.sqrt(this.distToAffSquare);
  }

  updateRadius(): void {
    const e = this.__support.anyMember();
    this.__squaredRadius = 0;
    const t = this.dim;
    const n = this.__center;
    const r = this.S;
    for (let s = 0; s < t; ++s) {
      this.__squaredRadius += square(r.coord(e, s) - n[s]!);
    }
    this.__radius = Math.sqrt(this.__squaredRadius);
  }

  compute(): void {
    const e = this.__center;
    const t = this.__support;
    const n = this.dim;
    const r = this.centerToAff;
    for (this.iteration = 0; this.iteration < 1e4; this.iteration++) {
      for (
        this.computeDistToAff();
        this.distToAff <= 1e-14 * this.__radius || t.size() === n + 1;

      ) {
        if (!this.successfulDrop()) return;
        this.computeDistToAff();
      }
      const s = this.findStopFraction();
      if (this.stopper >= 0) {
        for (let t0 = 0; t0 < n; ++t0) e[t0]! += s * r[t0]!;
        this.updateRadius();
        t.add(this.stopper);
      } else {
        for (let t0 = 0; t0 < n; ++t0) e[t0]! += r[t0]!;
        this.updateRadius();
        if (!this.successfulDrop()) return;
      }
    }
  }

  successfulDrop(): boolean {
    const e = this.lambdas;
    const t = this.__support;
    t.findAffineCoefficients(this.__center, e);
    let n = 0;
    let r = 1;
    const s = t.size();
    for (let t0 = 0; t0 < s; ++t0) {
      const s0 = e[t0]!;
      if (s0 < r) {
        r = s0;
        n = t0;
      }
    }
    return r <= 0 && (t.remove(n), true);
  }

  findStopFraction(): number {
    let e: number;
    let t: number;
    let n = 1;
    this.stopper = -1;
    const r = this.dim;
    const s = this.__center;
    const a = this.S;
    const i = this.__support;
    const o = this.centerToPoint;
    const _ = this.centerToAff;
    const c = this.distToAffSquare;
    const d = this.__squaredRadius;
    const u = this.__size;
    const l = 1e-14 * this.__radius * this.distToAff;
    for (t = 0; t < u; ++t) {
      if (i.isMember(t)) continue;
      for (e = 0; e < r; ++e) o[e] = a.coord(t, e) - s[e]!;
      const u0 = dotN(_, o, r);
      if (c - u0 < l) continue;
      const f = (d - dotN(o, o, r)) / 2 / (c - u0);
      if (f > 0 && f < n) {
        n = f;
        this.stopper = t;
      }
    }
    return n;
  }

  toString(): string {
    let e = "Miniball [";
    if (this.isEmpty()) e += "isEmpty=true";
    else {
      e += "center=(";
      for (let t = 0; t < this.dim; ++t) {
        e += this.__center[t];
        if (t < this.dim - 1) e += ", ";
      }
      e += `), radius=${this.__radius}, squaredRadius=${this.__squaredRadius}`;
    }
    e += "]";
    return e;
  }
}

export const eo = SquareMatrix;
export const oo = PointCloud;
export const io = Miniball;
export const ao = AffineSupport;
export const Vi = square;
export const $i = dotN;
export const to = dotRange;
export const no = axpyRange;
export const ro = givensCs;
export const so = applyGivensRows;

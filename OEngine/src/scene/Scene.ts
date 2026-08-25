/**
 * 场景根对象：组织节点树、灯光和可渲染对象，并触发全局变换更新。
 */

import { Node3D, type NodeReparentEvent } from "./Node3D.js";
import { hashFloat } from "../core/hashMix.js";
import {
  arrayRemoveFirst,
  arrayShallowEquals
} from "../core/arrayUtils.js";
import { fmax, fmin } from "../core/math/mathUtils.js";
import { Vec3 } from "../core/math/Vec3.js";
import type { Mesh } from "./Mesh.js";
import type { Light } from "../light/Light.js";
import type { ShadeMaterial } from "../material/ShadeMaterial.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";
import { TetrahedralMesh } from "../geometry/TetrahedralMesh.js";
import { buildLightProbeTetrahedralMesh } from "../geometry/LightProbeDelaunay.js";
import {
  SceneChangeSet,
  type SceneChangeSnapshot
} from "./SceneChangeSet.js";

function max2(e: number, t: number): number {
  return fmax(e, t);
}

export function aabbSetFromTransformedPositions(
  out: SceneAABB,
  positions: ArrayLike<number>,
  floatCount: number,
  matrix: ArrayLike<number>
): void {
  let s = Number.POSITIVE_INFINITY;
  let a = Number.POSITIVE_INFINITY;
  let i = Number.POSITIVE_INFINITY;
  let o = Number.NEGATIVE_INFINITY;
  let _ = Number.NEGATIVE_INFINITY;
  let c = Number.NEGATIVE_INFINITY;
  const r = matrix;
  for (let e = 0; e < floatCount; e += 3) {
    const n = positions[e]!;
    const d = positions[e + 1]!;
    const u = positions[e + 2]!;
    const l = 1 / (r[3]! * n + r[7]! * d + r[11]! * u + r[15]!);
    const f = (r[0]! * n + r[4]! * d + r[8]! * u + r[12]!) * l;
    const h = (r[1]! * n + r[5]! * d + r[9]! * u + r[13]!) * l;
    const m = (r[2]! * n + r[6]! * d + r[10]! * u + r[14]!) * l;
    s = fmin(f, s);
    a = fmin(h, a);
    i = fmin(m, i);
    o = fmax(f, o);
    _ = fmax(h, _);
    c = fmax(m, c);
  }
  out.setBounds(s, a, i, o, _, c);
}

function distanceAbovePlane(
  e: number,
  t: number,
  n: number,
  r: number,
  s: number,
  a: number,
  i: number,
  o: number,
  _: number,
  c: number
): number {
  return (
    r +
    e * (e > 0 ? o : s) +
    t * (t > 0 ? _ : a) +
    n * (n > 0 ? c : i)
  );
}

function planeSide(
  e: number,
  t: number,
  n: number,
  r: number,
  s: number,
  a: number,
  i: number,
  o: number,
  _: number,
  c: number
): number {
  let d: number;
  let u: number;
  let l: number;
  let f: number;
  let h: number;
  let g: number;
  if (e > 0) {
    d = s;
    f = o;
  } else {
    d = o;
    f = s;
  }
  if (t > 0) {
    u = a;
    h = _;
  } else {
    u = _;
    h = a;
  }
  if (n > 0) {
    l = i;
    g = c;
  } else {
    l = c;
    g = i;
  }
  const p = -r;
  const nearDot = f * e + h * t + g * n;
  const farDot = e * d + t * u + n * l;
  if (nearDot < p) return -2;
  if (farDot >= p) return 2;
  return 0;
}

function transformAabbByMatrix4(
  out: number[],
  src: ArrayLike<number>,
  m: ArrayLike<number>
): void {
  out[0] = out[3] = m[12]!;
  out[1] = out[4] = m[13]!;
  out[2] = out[5] = m[14]!;
  for (let r = 0; r < 3; r++) {
    for (let s = 0; s < 3; s++) {
      const a = m[r + 4 * s]!;
      const i = a * src[s]!;
      const o = a * src[s + 3]!;
      if (i < o) {
        out[r]! += i;
        out[r + 3]! += o;
      } else {
        out[r]! += o;
        out[r + 3]! += i;
      }
    }
  }
}

export class SceneAABB {
  declare readonly isAABB3: true;
  declare readonly length: 6;
  x0!: number;
  y0!: number;
  z0!: number;
  x1!: number;
  y1!: number;
  z1!: number;

  constructor(e = 0, t = 0, n = 0, r = 0, s = 0, a = 0) {
    this.setBounds(e, t, n, r, s, a);
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
    return this.z0;
  }
  set 2(e: number) {
    this.z0 = e;
  }
  get 3(): number {
    return this.x1;
  }
  set 3(e: number) {
    this.x1 = e;
  }
  get 4(): number {
    return this.y1;
  }
  set 4(e: number) {
    this.y1 = e;
  }
  get 5(): number {
    return this.z1;
  }
  set 5(e: number) {
    this.z1 = e;
  }

  *[Symbol.iterator](): Generator<number> {
    yield this.x0;
    yield this.y0;
    yield this.z0;
    yield this.x1;
    yield this.y1;
    yield this.z1;
  }

  setBounds(e: number, t: number, n: number, r: number, s: number, a: number): void {
    this.x0 = e;
    this.y0 = t;
    this.z0 = n;
    this.x1 = r;
    this.y1 = s;
    this.z1 = a;
  }

  setBoundsUnordered(
    e: number,
    t: number,
    n: number,
    r: number,
    s: number,
    a: number
  ): void {
    let i: number;
    let o: number;
    let _: number;
    let c: number;
    let d: number;
    let u: number;
    if (e < r) {
      i = e;
      c = r;
    } else {
      i = r;
      c = e;
    }
    if (t < s) {
      o = t;
      d = s;
    } else {
      o = s;
      d = t;
    }
    if (n < a) {
      _ = n;
      u = a;
    } else {
      _ = a;
      u = n;
    }
    this.setBounds(i, o, _, c, d, u);
  }

  setNegativelyInfiniteBounds(): void {
    this.setBounds(
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY
    );
  }

  setInfiniteBounds(): void {
    this.setBounds(
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY
    );
  }

  copy(e: {
    x0: number;
    y0: number;
    z0: number;
    x1: number;
    y1: number;
    z1: number;
  }): void {
    this.setBounds(e.x0, e.y0, e.z0, e.x1, e.y1, e.z1);
  }

  clone(): SceneAABB {
    const e = new SceneAABB();
    e.copy(this);
    return e;
  }

  equals(e: {
    x0: number;
    y0: number;
    z0: number;
    x1: number;
    y1: number;
    z1: number;
  }): boolean {
    return this._equals(e.x0, e.y0, e.z0, e.x1, e.y1, e.z1);
  }

  _equals(e: number, t: number, n: number, r: number, s: number, a: number): boolean {
    return (
      this.x0 === e &&
      this.y0 === t &&
      this.z0 === n &&
      this.x1 === r &&
      this.y1 === s &&
      this.z1 === a
    );
  }

  expandToFit(other: SceneAABB): boolean {
    return this._expandToFit(other.x0, other.y0, other.z0, other.x1, other.y1, other.z1);
  }

  union(e: {
    x0: number;
    y0: number;
    z0: number;
    x1: number;
    y1: number;
    z1: number;
  }): void {
    this._expandToFit(e.x0, e.y0, e.z0, e.x1, e.y1, e.z1);
  }

  _expandToFit(
    e: number,
    t: number,
    n: number,
    r: number,
    s: number,
    a: number
  ): boolean {
    let i = false;
    if (e < this.x0) {
      this.x0 = e;
      i = true;
    }
    if (t < this.y0) {
      this.y0 = t;
      i = true;
    }
    if (n < this.z0) {
      this.z0 = n;
      i = true;
    }
    if (r > this.x1) {
      this.x1 = r;
      i = true;
    }
    if (s > this.y1) {
      this.y1 = s;
      i = true;
    }
    if (a > this.z1) {
      this.z1 = a;
      i = true;
    }
    return i;
  }

  _expandToFitPoint(e: number, t: number, n: number): boolean {
    let r = false;
    if (e < this.x0) {
      this.x0 = e;
      r = true;
    }
    if (t < this.y0) {
      this.y0 = t;
      r = true;
    }
    if (n < this.z0) {
      this.z0 = n;
      r = true;
    }
    if (e > this.x1) {
      this.x1 = e;
      r = true;
    }
    if (t > this.y1) {
      this.y1 = t;
      r = true;
    }
    if (n > this.z1) {
      this.z1 = n;
      r = true;
    }
    return r;
  }

  containsBox(e: {
    x0: number;
    y0: number;
    z0: number;
    x1: number;
    y1: number;
    z1: number;
  }): boolean {
    return this._containsBox(e.x0, e.y0, e.z0, e.x1, e.y1, e.z1);
  }

  _containsBox(
    e: number,
    t: number,
    n: number,
    r: number,
    s: number,
    a: number
  ): boolean {
    return (
      e >= this.x0 &&
      t >= this.y0 &&
      n >= this.z0 &&
      r <= this.x1 &&
      s <= this.y1 &&
      a <= this.z1
    );
  }

  containsPointWithTolerance(e: number, t: number, n: number, r: number): boolean {
    return !(
      e + r < this.x0 ||
      e - r > this.x1 ||
      t + r < this.y0 ||
      t - r > this.y1 ||
      n + r < this.z0 ||
      n - r > this.z1
    );
  }

  getExtentsX(): number {
    return this.x1 - this.x0;
  }
  get width(): number {
    return this.getExtentsX();
  }
  getExtentsY(): number {
    return this.y1 - this.y0;
  }
  get height(): number {
    return this.getExtentsY();
  }
  getExtentsZ(): number {
    return this.z1 - this.z0;
  }
  get depth(): number {
    return this.getExtentsZ();
  }

  getHalfExtentsX(): number {
    return this.getExtentsX() / 2;
  }
  getHalfExtentsY(): number {
    return this.getExtentsY() / 2;
  }
  getHalfExtentsZ(): number {
    return this.getExtentsZ() / 2;
  }

  getExtents(e: Vec3 = new Vec3()): Vec3 {
    e.set(this.width, this.height, this.depth);
    return e;
  }

  getCenterX(): number {
    return 0.5 * (this.x0 + this.x1);
  }
  get centerX(): number {
    return this.getCenterX();
  }
  getCenterY(): number {
    return 0.5 * (this.y0 + this.y1);
  }
  get centerY(): number {
    return this.getCenterY();
  }
  getCenterZ(): number {
    return 0.5 * (this.z0 + this.z1);
  }
  get centerZ(): number {
    return this.getCenterZ();
  }

  getCenter(e: Vec3 = new Vec3()): Vec3 {
    e.set(this.getCenterX(), this.getCenterY(), this.getCenterZ());
    return e;
  }

  computeVolume(): number {
    return this.getExtentsX() * this.getExtentsY() * this.getExtentsZ();
  }

  computeSurfaceArea(): number {
    const dx = this.getExtentsX();
    const dy = this.getExtentsY();
    const dz = this.getExtentsZ();
    return 2 * (dx * dy + dx * dz + dy * dz);
  }

  getSurfaceArea(): number {
    return this.computeSurfaceArea();
  }

  _translate(e: number, t: number, n: number): void {
    this.setBounds(
      this.x0 + e,
      this.y0 + t,
      this.z0 + n,
      this.x1 + e,
      this.y1 + t,
      this.z1 + n
    );
  }

  grow(e: number): void {
    this.x0 -= e;
    this.y0 -= e;
    this.z0 -= e;
    this.x1 += e;
    this.y1 += e;
    this.z1 += e;
  }

  writeToArray(e: number[] = [], t = 0): number[] {
    e[t] = this.x0;
    e[t + 1] = this.y0;
    e[t + 2] = this.z0;
    e[t + 3] = this.x1;
    e[t + 4] = this.y1;
    e[t + 5] = this.z1;
    return e;
  }

  readFromArray(e: ArrayLike<number>, t = 0): void {
    this.setBounds(e[t]!, e[t + 1]!, e[t + 2]!, e[t + 3]!, e[t + 4]!, e[t + 5]!);
  }

  getCorners(e: number[] | Float32Array | Float64Array): void {
    const n = this.x0;
    const r = this.y0;
    const s = this.z0;
    const a = this.x1;
    const i = this.y1;
    const o = this.z1;
    e[0] = n;
    e[1] = r;
    e[2] = s;
    e[3] = a;
    e[4] = r;
    e[5] = s;
    e[6] = n;
    e[7] = i;
    e[8] = s;
    e[9] = a;
    e[10] = i;
    e[11] = s;
    e[12] = n;
    e[13] = r;
    e[14] = o;
    e[15] = a;
    e[16] = r;
    e[17] = o;
    e[18] = n;
    e[19] = i;
    e[20] = o;
    e[21] = a;
    e[22] = i;
    e[23] = o;
  }

  traverseCorners(
    e: (x: number, y: number, z: number) => void,
    t?: unknown
  ): void {
    const n = this.x0;
    const r = this.y0;
    const s = this.z0;
    const a = this.x1;
    const i = this.y1;
    const o = this.z1;
    e.call(t, n, r, s);
    e.call(t, n, r, o);
    e.call(t, n, i, s);
    e.call(t, n, i, o);
    e.call(t, a, r, s);
    e.call(t, a, r, o);
    e.call(t, a, i, s);
    e.call(t, a, i, o);
  }

  fromJSON(e: {
    x0: number;
    y0: number;
    z0: number;
    x1: number;
    y1: number;
    z1: number;
  }): void {
    this.setBounds(e.x0, e.y0, e.z0, e.x1, e.y1, e.z1);
  }

  toJSON(): {
    x0: number;
    y0: number;
    z0: number;
    x1: number;
    y1: number;
    z1: number;
  } {
    return {
      x0: this.x0,
      y0: this.y0,
      z0: this.z0,
      x1: this.x1,
      y1: this.y1,
      z1: this.z1,
    };
  }

  toString(): string {
    return `AABB3{ min:[${this.x0},${this.y0},${this.z0}], max:[${this.x1},${this.y1},${this.z1}] }`;
  }

  distanceToPoint2(e: number, t: number, n: number): number {
    const c = this.y0 - t;
    const d = t - this.y1;
    const u = this.z0 - n;
    const l = n - this.z1;
    let f = max2(this.x0 - e, e - this.x1);
    let h = max2(c, d);
    let m = max2(u, l);
    const g = Math.max(f, h, m);
    if (g > 0) {
      f = max2(f, 0);
      h = max2(h, 0);
      m = max2(m, 0);
      return f * f + h * h + m * m;
    }
    return -g * g;
  }

  distanceToBox(e: {
    x0: number;
    y0: number;
    z0: number;
    x1: number;
    y1: number;
    z1: number;
  }): number {
    return this._distanceToBox(e.x0, e.y0, e.z0, e.x1, e.y1, e.z1);
  }

  _distanceToBox(
    e: number,
    t: number,
    n: number,
    r: number,
    s: number,
    a: number
  ): number {
    const l = t - this.y1;
    const f = this.y0 - s;
    const h = n - this.z1;
    const m = this.z0 - a;
    const g = Math.max(e - this.x1, this.x0 - r);
    const p = Math.max(l, f);
    const v = Math.max(h, m);
    const A = Math.sqrt(g * g + p * p + v * v);
    return g < 0 && p < 0 && v < 0 ? -A : A;
  }

  costForInclusion(e: {
    x0: number;
    y0: number;
    z0: number;
    x1: number;
    y1: number;
    z1: number;
  }): number {
    return this._costForInclusion(e.x0, e.y0, e.z0, e.x1, e.y1, e.z1);
  }

  _costForInclusion(
    e: number,
    t: number,
    n: number,
    r: number,
    s: number,
    a: number
  ): number {
    let i = 0;
    let o = 0;
    let _ = 0;
    const c = this.x0;
    const d = this.y0;
    const u = this.z0;
    const l = this.x1;
    const f = this.y1;
    const h = this.z1;
    if (c > e) i += c - e;
    if (l < r) i += r - l;
    if (d > t) o += d - t;
    if (f < s) o += s - f;
    if (u > n) _ += u - n;
    if (h < a) _ += a - h;
    const m = l - c;
    const g = f - d;
    const p = h - u;
    return i * (g + p) + o * (m + p) + _ * (m + g);
  }

  computeDistanceAbovePlane(
    e: number,
    t: number,
    n: number,
    r: number
  ): number {
    return distanceAbovePlane(
      e,
      t,
      n,
      r,
      this.x0,
      this.y0,
      this.z0,
      this.x1,
      this.y1,
      this.z1
    );
  }

  _isBelowPlane(e: number, t: number, n: number, r: number): boolean {
    return this.computeDistanceAbovePlane(e, t, n, r) < 0;
  }

  isBelowPlane(e: {
    normal: { x: number; y: number; z: number };
    constant: number;
  }): boolean {
    const t = e.normal;
    return this._isBelowPlane(t.x, t.y, t.z, e.constant);
  }

  computePlaneSide(e: {
    normal: { x: number; y: number; z: number };
    constant: number;
  }): number {
    const t = e.normal;
    return planeSide(
      t.x,
      t.y,
      t.z,
      e.constant,
      this.x0,
      this.y0,
      this.z0,
      this.x1,
      this.y1,
      this.z1
    );
  }

  intersectSpace(
    e: ArrayLike<{ normal: { x: number; y: number; z: number }; constant: number }>
  ): boolean {
    const n = e.length;
    for (let t = 0; t < n; t++) {
      if (this.isBelowPlane(e[t]!)) return false;
    }
    return true;
  }

  intersectFrustum(e: {
    planes: ArrayLike<{
      normal: { x: number; y: number; z: number };
      constant: number;
    }>;
  }): boolean {
    const t = e.planes;
    for (let i = 0; i < 6; i++) {
      if (this.isBelowPlane(t[i]!)) return false;
    }
    return true;
  }

  intersectFrustumDegree(e: {
    planes: ArrayLike<{
      normal: { x: number; y: number; z: number };
      constant: number;
    }>;
  }): number {
    const t = e.planes;
    let r = 2;
    for (let n = 0; n < 6; n++) {
      const side = this.computePlaneSide(t[n]!);
      if (side < 0) return 0;
      if (side === 0) r = 1;
    }
    return r;
  }

  intersectFrustum_array(e: ArrayLike<number>): boolean {
    for (let o = 0; o < 24; o += 4) {
      if (
        distanceAbovePlane(
          e[o]!,
          e[o + 1]!,
          e[o + 2]!,
          e[o + 3]!,
          this.x0,
          this.y0,
          this.z0,
          this.x1,
          this.y1,
          this.z1
        ) < 0
      ) {
        return false;
      }
    }
    return true;
  }

  intersectFrustumDegree_array(e: ArrayLike<number>): number {
    let o = 2;
    for (let _ = 0; _ < 24; _ += 4) {
      const c = planeSide(
        e[_]!,
        e[_ + 1]!,
        e[_ + 2]!,
        e[_ + 3]!,
        this.x0,
        this.y0,
        this.z0,
        this.x1,
        this.y1,
        this.z1
      );
      if (c < 0) return 0;
      if (c === 0) o = 1;
    }
    return o;
  }

  applyMatrix4(e: ArrayLike<number>): void {
    const t: number[] = [];
    const n: number[] = [];
    this.writeToArray(t, 0);
    transformAabbByMatrix4(n, t, e);
    this.readFromArray(n, 0);
  }

  hash(): number {
    const t = this.length;
    let n = t;
    for (let r = 0; r < t; r++) {
      n = (n << 5) - n + hashFloat(this[r as 0 | 1 | 2 | 3 | 4 | 5]);
      n |= 0;
    }
    return n;
  }

  intersectRay(
    e: number,
    t: number,
    n: number,
    r: number,
    s: number,
    a: number
  ): boolean {
    const ox = e;
    const oy = t;
    const oz = n;
    const dx = r;
    const dy = s;
    const dz = a;
    const x0 = this.x0;
    const y0 = this.y0;
    const z0 = this.z0;
    const y1 = this.y1;
    const z1 = this.z1;
    const l = 0.5 * (this.x1 - x0);
    const f = ox - (x0 + l);
    if (f * dx >= 0 && Math.abs(f) > l) return false;
    const h = 0.5 * (y1 - y0);
    const m = oy - (y0 + h);
    if (m * dy >= 0 && Math.abs(m) > h) return false;
    const g = 0.5 * (z1 - z0);
    const p = oz - (z0 + g);
    if (p * dz >= 0 && Math.abs(p) > g) return false;
    const v = Math.abs(dy);
    const A = Math.abs(dz);
    if (Math.abs(dy * p - dz * m) > h * A + g * v) return false;
    const b = Math.abs(dx);
    if (Math.abs(dz * f - dx * p) > l * A + g * b) return false;
    return Math.abs(dx * m - dy * f) <= l * v + h * b;
  }

  intersectSegment(
    e: number,
    t: number,
    n: number,
    r: number,
    s: number,
    a: number
  ): boolean {
    const i = e;
    const o = t;
    const _ = n;
    const c = r;
    const d = s;
    const u = a;
    const x0 = this.x0;
    const y0 = this.y0;
    const z0 = this.z0;
    const y1 = this.y1;
    const z1 = this.z1;
    const v = 0.5 * (c - i);
    const l = (this.x1 - x0) / 2;
    const w = x0 + l;
    const m = 0.5 * (c + i) - w;
    const B = Math.abs(v);
    if (Math.abs(m) > l + B) return false;
    const A = 0.5 * (d - o);
    const f = (y1 - y0) / 2;
    const x = y0 + f;
    const g = 0.5 * (d + o) - x;
    const P = Math.abs(A);
    if (Math.abs(g) > f + P) return false;
    const b = 0.5 * (u - _);
    const h = (z1 - z0) / 2;
    const y = z0 + h;
    const p = 0.5 * (u + _) - y;
    const z = Math.abs(b);
    if (Math.abs(p) > h + z) return false;
    let E = A * p - b * g;
    if (Math.abs(E) > f * z + h * P) return false;
    E = b * m - v * p;
    if (Math.abs(E) > l * z + h * B) return false;
    E = v * g - A * m;
    return !(Math.abs(E) > l * P + f * B);
  }

  threeContainsBox(e: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  }): boolean {
    const t = e.min;
    const n = e.max;
    return this._containsBox(t.x, t.y, t.z, n.x, n.y, n.z);
  }
}

export interface SceneAABB {
  toArray(e?: number[], t?: number): number[];
  fromArray(e: ArrayLike<number>, t?: number): void;
}

Object.assign(SceneAABB.prototype, {
  isAABB3: true,
  length: 6,
  toArray: SceneAABB.prototype.writeToArray,
  fromArray: SceneAABB.prototype.readFromArray,
});

export class SceneInstances {
  private readonly _nodes: Node3D[] = [];
  private readonly _nodeSet = new Set<Node3D>();
  private _version = 0;
  private _meshCache: Mesh[] = [];
  private _meshCacheVersion = -1;
  private _matCache: ShadeMaterial[] = [];
  private _matCacheVersion = -1;

  get version(): number {
    return this._version;
  }

  set needsUpdate(v: boolean) {
    if (v) this._version++;
  }

  get nodes(): Node3D[] {
    return this._nodes;
  }

  get instances(): Mesh[] {
    if (this._meshCacheVersion !== this._version) {
      const out: Mesh[] = [];
      for (const n of this._nodes) {
        if ((n as Mesh).isMesh === true) out.push(n as Mesh);
      }
      this._meshCache = out;
      this._meshCacheVersion = this._version;
    }
    return this._meshCache;
  }

  get materials(): ShadeMaterial[] {
    if (this._matCacheVersion !== this._version) {
      const set = new Set<ShadeMaterial>();
      for (const m of this.instances) set.add(m.material);
      this._matCache = Array.from(set);
      this._matCacheVersion = this._version;
    }
    return this._matCache;
  }

  get bounding_box(): SceneAABB {
    const e = new SceneAABB();
    e.setNegativelyInfiniteBounds();
    const t = this.instances;
    for (let r = 0; r < t.length; r++) {
      const box = new SceneAABB(...t[r]!.bounding_box);
      if (box.width === 0 && box.height === 0 && box.depth === 0) continue;
      e.expandToFit(box);
    }
    return e;
  }

  computeTriangleCount(): number {
    let e = 0;
    const t = this.instances;
    for (let r = 0; r < t.length; r++) {
      e += t[r]!.geometry.getIndexCount() / 3;
    }
    return e;
  }

  add(node: Node3D): void {
    if (this._nodeSet.has(node)) return;
    this._nodeSet.add(node);
    this._nodes.push(node);
    this._version++;
  }

  remove(node: Node3D): boolean {
    const t = arrayRemoveFirst(this._nodes, node);
    if (t) {
      this._nodeSet.delete(node);
      this._version++;
    }
    return t;
  }

  has(node: Node3D): boolean {
    return this._nodeSet.has(node);
  }

  hash(): number {
    return 0;
  }

  equals(other: SceneInstances): boolean {
    return arrayShallowEquals(this._nodes, other._nodes);
  }
}

export class SceneLights {
  private readonly _elements: Light[] = [];
  private readonly _elementSet = new Set<Light>();
  private _version = 0;
  private _environment!: ShadeTexture;

  get version(): number {
    return this._version;
  }

  set needsUpdate(v: boolean) {
    if (v) this._version++;
  }

  get elements(): Light[] {
    return this._elements;
  }

  get environment(): ShadeTexture {
    return this._environment;
  }
  set environment(e: ShadeTexture) {
    this._environment = e;
  }

  add(light: Light): void {
    if (this._elementSet.has(light)) return;
    this._elementSet.add(light);
    this._elements.push(light);
    this._version++;
  }

  remove(light: Light): boolean {
    const removed = arrayRemoveFirst(this._elements, light);
    if (removed) {
      this._elementSet.delete(light);
      this._version++;
    }
    return removed;
  }

  has(light: Light): boolean {
    return this._elementSet.has(light);
  }

  markChanged(light: Light): void {
    if (this._elementSet.has(light)) this._version++;
  }

}

export class LightProbeVolume {
  #mesh = new TetrahedralMesh();
  #probeCount = 0;
  #positions = new Float32Array(0);
  #coefficients = new Float32Array(0);
  #version = 0;

  get coefficients(): Float32Array {
    return this.#coefficients;
  }

  get mesh(): TetrahedralMesh {
    return this.#mesh;
  }

  get positions(): Float32Array {
    return this.#positions;
  }

  set positions(e: ArrayLike<number>) {
    const t = e.length / 3;
    this.#probeCount = t;
    this.#ensureCapacity(t);
    this.#positions.set(e);
  }

  get probe_count(): number {
    return this.#probeCount;
  }

  get version(): number {
    return this.#version;
  }

  update(): void {
    this.#version++;
  }

  add_point(e: number, t: number, n: number): number {
    const r = this.#probeCount;
    this.#ensureCapacity(r + 1);
    this.#positions[3 * r] = e;
    this.#positions[3 * r + 1] = t;
    this.#positions[3 * r + 2] = n;
    this.#probeCount++;
    this.#version++;
    return r;
  }

  remove_point(e: number): void {
    for (let t = e + 1; t < this.#probeCount; t++) {
      this.#positions[3 * (t - 1)] = this.#positions[3 * t]!;
      this.#positions[3 * (t - 1) + 1] = this.#positions[3 * t + 1]!;
      this.#positions[3 * (t - 1) + 2] = this.#positions[3 * t + 2]!;
    }
    this.#probeCount--;
    this.#version++;
  }

  #ensureCapacity(e: number): void {
    if (this.#positions.length >= 3 * e) return;
    const t = new Float32Array(3 * e);
    const n = new Float32Array(27 * e);
    t.set(this.#positions);
    n.set(this.#coefficients);
    this.#positions = t;
    this.#coefficients = n;
  }

  build_mesh(): void {
    this.mesh.clear();
    buildLightProbeTetrahedralMesh(this.mesh, this.#positions, this.#probeCount);
    this.mesh.compact();
    this.#version++;
  }

  build_grid(
    bounds: SceneAABB,
    dimensions: { x: number; y: number; z: number }
  ): void {
    const sizeX = dimensions.x === undefined ? 2 : dimensions.x;
    const sizeY = dimensions.y === undefined ? 2 : dimensions.y;
    const sizeZ = dimensions.z === undefined ? 2 : dimensions.z;
    this.#ensureCapacity(sizeX * sizeY * sizeZ);

    const mesh = this.#mesh;
    const positions = this.#positions;
    mesh.clear();

    const cellsX = sizeX - 1;
    const cellsY = sizeY - 1;
    mesh.ensureCapacity(cellsX * cellsY * (sizeZ - 1) * 6);

    const extentX = bounds.getExtentsX();
    const extentY = bounds.getExtentsY();
    const extentZ = bounds.getExtentsZ();
    const vertexIndex = (x: number, y: number, z: number): number =>
      z * sizeY * sizeX + y * sizeX + x;
    const tetraIndex = (
      x: number,
      y: number,
      z: number,
      localTetra: number
    ): number => 6 * (z * cellsY * cellsX + y * cellsX + x) + localTetra;

    for (let z = 0; z < sizeZ; z++) {
      for (let y = 0; y < sizeY; y++) {
        for (let x = 0; x < sizeX; x++) {
          const offset = 3 * vertexIndex(x, y, z);
          positions[offset] = bounds.x0 + (x / (sizeX - 1)) * extentX;
          positions[offset + 1] = bounds.y0 + (y / (sizeY - 1)) * extentY;
          positions[offset + 2] = bounds.z0 + (z / (sizeZ - 1)) * extentZ;
        }
      }
    }

    const allocate = (a: number, b: number, c: number, d: number): number => {
      const tetra = mesh.allocate();
      mesh.setVertexIndex(tetra, 0, a);
      mesh.setVertexIndex(tetra, 1, b);
      mesh.setVertexIndex(tetra, 2, c);
      mesh.setVertexIndex(tetra, 3, d);
      return tetra;
    };

    for (let z = 1; z < sizeZ; z++) {
      for (let y = 1; y < sizeY; y++) {
        for (let x = 1; x < sizeX; x++) {
          const v000 = vertexIndex(x - 1, y - 1, z - 1);
          const v001 = vertexIndex(x - 1, y - 1, z);
          const v101 = vertexIndex(x, y - 1, z);
          const v100 = vertexIndex(x, y - 1, z - 1);
          const v010 = vertexIndex(x - 1, y, z - 1);
          const v011 = vertexIndex(x - 1, y, z);
          const v111 = vertexIndex(x, y, z);
          const v110 = vertexIndex(x, y, z - 1);

          const t0 = allocate(v001, v000, v100, v110);
          const t1 = allocate(v001, v000, v110, v010);
          const t2 = allocate(v110, v001, v010, v011);
          const t3 = allocate(v101, v001, v100, v110);
          const t4 = allocate(v101, v001, v110, v111);
          const t5 = allocate(v001, v110, v111, v011);

          mesh.setNeighbour(t0, 1, t3 << 2);
          mesh.setNeighbour(t0, 2, (t1 << 2) | 3);
          mesh.setNeighbour(t1, 1, (t2 << 2) | 3);
          mesh.setNeighbour(t1, 3, (t0 << 2) | 2);
          mesh.setNeighbour(t2, 2, (t5 << 2) | 2);
          mesh.setNeighbour(t2, 3, (t1 << 2) | 1);
          mesh.setNeighbour(t3, 0, (t0 << 2) | 1);
          mesh.setNeighbour(t3, 2, (t4 << 2) | 3);
          mesh.setNeighbour(t4, 0, (t5 << 2) | 3);
          mesh.setNeighbour(t4, 3, (t3 << 2) | 2);
          mesh.setNeighbour(t5, 2, (t2 << 2) | 2);
          mesh.setNeighbour(t5, 3, t4 << 2);

          if (x > 1) {
            const leftT3 = tetraIndex(x - 2, y - 1, z - 1, 3);
            const leftT4 = tetraIndex(x - 2, y - 1, z - 1, 4);
            mesh.setNeighbour(t1, 2, (leftT3 << 2) | 1);
            mesh.setNeighbour(leftT3, 1, (t1 << 2) | 2);
            mesh.setNeighbour(t2, 0, (leftT4 << 2) | 1);
            mesh.setNeighbour(leftT4, 1, t2 << 2);
          }
          if (y > 1) {
            const belowT2 = tetraIndex(x - 1, y - 2, z - 1, 2);
            const belowT5 = tetraIndex(x - 1, y - 2, z - 1, 5);
            mesh.setNeighbour(t0, 3, (belowT2 << 2) | 1);
            mesh.setNeighbour(belowT2, 1, (t0 << 2) | 3);
            mesh.setNeighbour(t3, 3, belowT5 << 2);
            mesh.setNeighbour(belowT5, 0, (t3 << 2) | 3);
          }
          if (z > 1) {
            const backT4 = tetraIndex(x - 1, y - 1, z - 2, 4);
            const backT5 = tetraIndex(x - 1, y - 1, z - 2, 5);
            mesh.setNeighbour(t0, 0, (backT4 << 2) | 2);
            mesh.setNeighbour(backT4, 2, t0 << 2);
            mesh.setNeighbour(t1, 0, (backT5 << 2) | 1);
            mesh.setNeighbour(backT5, 1, t1 << 2);
          }
        }
      }
    }

    this.#probeCount = sizeX * sizeY * sizeZ;
    mesh.compact();
    this.#version++;
  }
}

export interface ParticipatingMediaParticleSpec {
  scattering: ArrayLike<number>;
  extinction: ArrayLike<number>;
  radius: number;
  g: number;
}

export interface ParticipatingMediaVolume {
  particle_spec: ParticipatingMediaParticleSpec;
  transform: { matrix: Float32Array };
  fade_distance: number;
  density: number;
}

export class SceneVolumetrics {
  volumes: ParticipatingMediaVolume[] = [];
  version = 0;

  add(volume: ParticipatingMediaVolume): void {
    this.volumes.push(volume);
    this.version++;
  }
}

export class Scene extends Node3D {
  declare readonly isScene: boolean;
  instances = new SceneInstances();
  lights = new SceneLights();
  light_probe_volume = new LightProbeVolume();
  volumetrics = new SceneVolumetrics();
  private readonly changeSet = new SceneChangeSet();

  constructor() {
    super();
    this.onTransformChanged.add(this.onAttachedTransformChanged, this);
    this._onChildAdded.add(this.onHierarchyChildAdded, this);
    this._onChildRemoved.add(this.onHierarchyChildRemoved, this);
  }

  get change_revision(): number {
    return this.changeSet.revision;
  }

  changesSince(lastRevision: number): SceneChangeSnapshot {
    return this.changeSet.changesSince(lastRevision);
  }

  get instance_count(): number {
    return this.instances.instances.length;
  }

  get node_count(): number {
    return this.instances.nodes.length + 1;
  }

  hash(): number {
    return 0;
  }

  equals(other: Scene): boolean {
    return this.instances.equals(other.instances);
  }

  add(node: Node3D | Node3D[]): void {
    if (Array.isArray(node)) {
      for (const n of node) this.add(n);
      return;
    }
    if (node === this || this.isRegistered(node)) return;
    if (node.parent !== null) {
      throw new Error("Scene.add expects a detached hierarchy root");
    }
    super.addChild(node);
  }

  remove(node: Node3D | Node3D[]): boolean {
    if (Array.isArray(node)) {
      let removed = false;
      for (const n of node) removed = this.remove(n) || removed;
      return removed;
    }

    if (node === this || !this.isRegistered(node)) return false;
    const parent = node.parent;
    if (parent === null) return false;
    return parent.removeChild(node);
  }

  private isRegistered(node: Node3D): boolean {
    return (
      node === this ||
      this.instances.has(node) ||
      ((node as Light).isLight === true && this.lights.has(node as Light))
    );
  }

  private registerSubtree(root: Node3D): void {
    let instanceStructureChanged = false;
    root.traverse((node) => {
      if (this.isRegistered(node)) return;
      if ((node as Light).isLight === true) {
        const light = node as Light;
        this.lights.add(light);
        this.changeSet.recordLight(light);
      } else {
        this.instances.add(node);
        instanceStructureChanged = true;
      }
      node.onTransformChanged.add(this.onAttachedTransformChanged, this);
      node._onChildAdded.add(this.onHierarchyChildAdded, this);
      node._onChildRemoved.add(this.onHierarchyChildRemoved, this);
      node._onReparented.add(this.onNodeReparented, this);
    });
    if (instanceStructureChanged) {
      this.changeSet.recordInstanceStructureChanged();
    }
  }

  private unregisterSubtree(root: Node3D): void {
    let instanceStructureChanged = false;
    root.traverse((node) => {
      node.onTransformChanged.remove(this.onAttachedTransformChanged, this);
      node._onChildAdded.remove(this.onHierarchyChildAdded, this);
      node._onChildRemoved.remove(this.onHierarchyChildRemoved, this);
      node._onReparented.remove(this.onNodeReparented, this);
      if ((node as Light).isLight === true) {
        const light = node as Light;
        if (this.lights.remove(light)) this.changeSet.recordLight(light);
      } else {
        instanceStructureChanged =
          this.instances.remove(node) || instanceStructureChanged;
      }
    });
    if (instanceStructureChanged) {
      this.changeSet.recordInstanceStructureChanged();
    }
  }

  private onHierarchyChildAdded(parent: Node3D, child: Node3D): void {
    if (this.isRegistered(parent)) this.registerSubtree(child);
  }

  private onHierarchyChildRemoved(parent: Node3D, child: Node3D): void {
    if (this.isRegistered(parent)) this.unregisterSubtree(child);
  }

  private onNodeReparented(event: NodeReparentEvent): void {
    if (!this.isRegistered(event.newParent)) {
      this.unregisterSubtree(event.node);
      return;
    }
    for (const change of event.previousGlobals) {
      const node = change.node;
      if ((node as Light).isLight === true) {
        const light = node as Light;
        if (this.lights.has(light)) {
          this.lights.markChanged(light);
          this.changeSet.recordLight(light);
        }
      } else if (this.instances.has(node)) {
        this.changeSet.recordTransform(
          node,
          change.matrix,
          (node as Mesh).isMesh === true
        );
      }
    }
  }

  private onAttachedTransformChanged(node: Node3D): void {
    const changedNodes: Array<{
      node: Node3D;
      previousGlobal: Float32Array;
    }> = [];

    node.traverse((candidate) => {
      if (candidate === this || this.instances.has(candidate)) {
        changedNodes.push({
          node: candidate,
          previousGlobal: Float32Array.from(candidate.transform_global.matrix)
        });
      } else if ((candidate as Light).isLight === true) {
        const light = candidate as Light;
        if (this.lights.has(light)) {
          changedNodes.push({
            node: light,
            previousGlobal: Float32Array.from(light.transform_global.matrix)
          });
        }
      }
    });

    node.updateMatrices();
    for (const change of changedNodes) {
      if ((change.node as Light).isLight === true) {
        const light = change.node as Light;
        this.lights.markChanged(light);
        this.changeSet.recordLight(light);
      } else {
        this.changeSet.recordTransform(
          change.node,
          change.previousGlobal,
          (change.node as Mesh).isMesh === true
        );
      }
    }
  }
}

Object.assign(Scene.prototype, { isScene: true });

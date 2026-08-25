/**
 * Quat：提供渲染系统使用的数学运算与基础数据结构。
 */

import { ChangeSignal } from "../Signal.js";
import { hashFloat } from "../hashMix.js";
import { Vec3 } from "./Vec3.js";
import type { BinaryReader } from "../../loaders/BinaryReader.js";
import { Float64VectorBase } from "./Float64VectorBase.js";

const EPS = 1e-7;
const DEG2RAD = Math.PI / 180;
const TWO_PI = 2 * Math.PI;
function clamp01(e: number): number {
  return e < 0 ? 0 : e > 1 ? 1 : e;
}

function clamp(e: number, t: number, n: number): number {
  return e < t ? t : e > n ? n : e;
}

function roughlyEq(e: number, t: number, n = 1e-7): boolean {
  return Math.abs(e - t) <= n;
}

function lerpNum(e: number, t: number, n: number): number {
  return (t - e) * n + e;
}

const _T = new Vec3();
const _U = new Vec3();
const _L = new Vec3();

export class Quat extends Float64VectorBase {
  readonly onChanged = new ChangeSignal();

  constructor(x = 0, y = 0, z = 0, w = 1) {
    super(4);
    this[0] = x;
    this[1] = y;
    this[2] = z;
    this[3] = w;
  }

  static get [Symbol.species](): Float64ArrayConstructor {
    return Float64Array;
  }

  get x(): number {
    return this[0]!;
  }

  set x(value: number) {
    const old = this[0]!;
    if (old === value) return;
    this[0] = value;
    if (this.onChanged.hasHandlers()) {
      this.onChanged.send8(
        value, this[1]!, this[2]!, this[3]!,
        old, this[1]!, this[2]!, this[3]!
      );
    }
  }

  get y(): number {
    return this[1]!;
  }

  set y(value: number) {
    const old = this[1]!;
    if (old === value) return;
    this[1] = value;
    if (this.onChanged.hasHandlers()) {
      this.onChanged.send8(
        this[0]!, value, this[2]!, this[3]!,
        this[0]!, old, this[2]!, this[3]!
      );
    }
  }

  get z(): number {
    return this[2]!;
  }

  set z(value: number) {
    const old = this[2]!;
    if (old === value) return;
    this[2] = value;
    if (this.onChanged.hasHandlers()) {
      this.onChanged.send8(
        this[0]!, this[1]!, value, this[3]!,
        this[0]!, this[1]!, old, this[3]!
      );
    }
  }

  get w(): number {
    return this[3]!;
  }

  set w(value: number) {
    const old = this[3]!;
    if (old === value) return;
    this[3] = value;
    if (this.onChanged.hasHandlers()) {
      this.onChanged.send8(
        this[0]!, this[1]!, this[2]!, value,
        this[0]!, this[1]!, this[2]!, old
      );
    }
  }

  get isQuaternion(): boolean {
    return true;
  }

  set(x: number, y: number, z: number, w: number): this {
    const ox = this.x;
    const oy = this.y;
    const oz = this.z;
    const ow = this.w;
    if (ox === x && oy === y && oz === z && ow === w) return this;
    // 与 Vec3 一致，批量 mutator 只发送一次变化通知。
    this[0] = x;
    this[1] = y;
    this[2] = z;
    this[3] = w;
    if (this.onChanged.hasHandlers()) {
      this.onChanged.send8(x, y, z, w, ox, oy, oz, ow);
    }
    return this;
  }

  copy(other: { x: number; y: number; z: number; w: number }): this {
    return this.set(other.x, other.y, other.z, other.w);
  }

  clone(): Quat {
    const e = new Quat();
    e.copy(this);
    return e;
  }

  equals(other: { x: number; y: number; z: number; w: number }): boolean {
    return (
      this.x === other.x &&
      this.y === other.y &&
      this.z === other.z &&
      this.w === other.w
    );
  }

  identity(): this {
    return this.set(0, 0, 0, 1);
  }

  normalize(): this {
    const e = this.length();
    if (e < EPS) return this.set(0, 0, 0, 1);
    return this.multiplyScalar(1 / e);
  }

  length(): number {
    return Math.hypot(this.x, this.y, this.z, this.w);
  }

  multiplyScalar(e: number): this {
    return this.set(this.x * e, this.y * e, this.z * e, this.w * e);
  }

  dot(e: { x: number; y: number; z: number; w: number }): number {
    return this.x * e.x + this.y * e.y + this.z * e.z + this.w * e.w;
  }

  invert(): this {
    const e = this.x;
    const t = this.y;
    const n = this.z;
    const r = this.w;
    const s = e * e + t * t + n * n + r * r;
    if (s === 0) return this.set(0, 0, 0, 1);
    const a = 1 / s;
    return this.set(-e * a, -t * a, -n * a, r * a);
  }

  copyInverse(e: { x: number; y: number; z: number; w: number }): this {
    return this.copy(e).invert();
  }

  conjugate(): this {
    return this.set(-this.x, -this.y, -this.z, this.w);
  }

  angleTo(e: { x: number; y: number; z: number; w: number }): number {
    const t = clamp(
      this.x * e.x + this.y * e.y + this.z * e.z + this.w * e.w,
      -1,
      1
    );
    return 2 * Math.acos(Math.abs(t));
  }

  fromAxisAngle(e: { x: number; y: number; z: number }, t: number): this {
    return this._fromAxisAngle(e.x, e.y, e.z, t);
  }

  _fromAxisAngle(e: number, t: number, n: number, r: number): this {
    const s = 0.5 * r;
    const a = Math.sin(s);
    const i = e * a;
    const o = t * a;
    const _ = n * a;
    const c = Math.cos(s);
    const d = 1 / Math.sqrt(i * i + o * o + _ * _ + c * c);
    return this.set(i * d, o * d, _ * d, c * d);
  }

  static fromAxisAngle(e: { x: number; y: number; z: number }, t: number): Quat {
    const n = new Quat();
    n.fromAxisAngle(e, t);
    return n;
  }

  computeSwingAndTwist(
    e: { x: number; y: number; z: number },
    t: Quat,
    n: Quat
  ): void {
    const r = this.x;
    const s = this.y;
    const a = this.z;
    const i = this.w;
    const o = r * e.x + s * e.y + a * e.z;
    const den = e.x * e.x + e.y * e.y + e.z * e.z;
    const _ = den === 0 ? 0 : o / den;
    const c = e.x * _;
    const d = e.y * _;
    const u = e.z * _;
    if (o < 0) n.set(-c, -d, -u, -i);
    else n.set(c, d, u, i);
    n.normalize();
    t._multiplyQuaternions(r, s, a, i, -n.x, -n.y, -n.z, n.w);
  }

  computeTwistAngle(e: { x: number; y: number; z: number }): number {
    const t = new Quat();
    const n = new Quat();
    this.computeSwingAndTwist(e, t, n);
    return 2 * Math.acos(n.w);
  }

  toAxisAngle(e: { set(x: number, y: number, z: number): unknown }): number {
    const t = 2 * Math.acos(this.w);
    const n = Math.sin(0.5 * t);
    if (Math.abs(n) > EPS) e.set(this.x / n, this.y / n, this.z / n);
    else e.set(1, 0, 0);
    return t;
  }

  rotateTowards(
    e: { x: number; y: number; z: number; w: number },
    t: number
  ): this {
    Quat.rotateTowards(this, this, e, t);
    return this;
  }

  static rotateTowards(
    e: Quat,
    t: { x: number; y: number; z: number; w: number },
    n: { x: number; y: number; z: number; w: number },
    r: number
  ): void {
    const s = new Quat(t.x, t.y, t.z, t.w).angleTo(n);
    if (s === 0) e.copy(n);
    else {
      const a = clamp01(r / s);
      e.slerpQuaternions(t, n, a);
    }
  }

  process(
    e: (x: number, y: number, z: number, w: number) => void,
    t?: unknown
  ): this {
    e.call(t, this.x, this.y, this.z, this.w);
    this.onChanged.add(e as (...args: unknown[]) => void, t);
    return this;
  }

  setRandom(_e?: unknown): never {
    throw new Error("use .random() instead");
  }

  random(e: () => number = Math.random): this {
    const t = e();
    const n = Math.sqrt(1 - t);
    const r = Math.sqrt(t);
    const s = TWO_PI * e();
    const a = TWO_PI * e();
    return this.set(n * Math.cos(s), r * Math.sin(a), r * Math.cos(a), n * Math.sin(s));
  }

  static random(e: () => number = Math.random): Quat {
    const t = new Quat();
    t.random(e);
    return t;
  }

  override toString(): string {
    return `{ x: ${this.x}, y: ${this.y}, z: ${this.z}, w: ${this.w} }`;
  }

  static readonly typeName = "Quaternion";

  multiply(e: { x: number; y: number; z: number; w: number }): this {
    return this.multiplyQuaternions(this, e);
  }

  multiplyQuaternions(
    e: { x: number; y: number; z: number; w: number },
    t: { x: number; y: number; z: number; w: number }
  ): this {
    return this._multiplyQuaternions(e.x, e.y, e.z, e.w, t.x, t.y, t.z, t.w);
  }

  _multiplyQuaternions(
    e: number,
    t: number,
    n: number,
    r: number,
    s: number,
    a: number,
    i: number,
    o: number
  ): this {
    return this.set(
      e * o + r * s + t * i - n * a,
      t * o + r * a + n * s - e * i,
      n * o + r * i + e * a - t * s,
      r * o - e * s - t * a - n * i
    );
  }

  __setFromEuler(e: number, t: number, n: number, r = "XYZ"): this {
    if (r === "XYZ") this.fromEulerAnglesXYZ(e, t, n);
    else if (r === "YXZ") this.fromEulerAnglesYXZ(e, t, n);
    else if (r === "ZXY") this.fromEulerAnglesZXY(e, t, n);
    else if (r === "ZYX") this.fromEulerAnglesZYX(e, t, n);
    else if (r === "YZX") this.fromEulerAnglesYZX(e, t, n);
    else {
      if (r !== "XZY") {
        throw new Error(
          `Invalid order '${r}', bust be 3 capital letters consisting of X,Y and Z`
        );
      }
      this.fromEulerAnglesXZY(e, t, n);
    }
    return this;
  }

  toEulerAnglesXYZ(e: { set(x: number, y: number, z: number): unknown }): void {
    const t = this.x;
    const n = this.y;
    const r = this.z;
    const s = this.w;
    const a = s * s;
    const i = t * t;
    const o = n * n;
    const _ = r * r;
    const c = Math.atan2(2 * (t * s - n * r), a - i - o + _);
    const d = Math.asin(2 * (t * r + n * s));
    const u = Math.atan2(2 * (r * s - t * n), a + i - o - _);
    e.set(c, d, u);
  }

  toEulerAnglesYXZ(e: { set(x: number, y: number, z: number): unknown }): void {
    const t = this.x;
    const n = this.y;
    const r = this.z;
    const s = this.w;
    const a = r * r;
    const i = t * t;
    const o = s * s;
    const _ = n * n;
    const c = 2 * (t * r + s * n);
    const d = o - i - _ + a;
    const u = -2 * (n * r - s * t);
    const l = Math.atan2(2 * (t * n + s * r), o - i + _ - a);
    const f = Math.asin(u);
    const h = Math.atan2(c, d);
    e.set(f, h, l);
  }

  toEulerAnglesZYX(e: { set(x: number, y: number, z: number): unknown }): void {
    const t = this.x;
    const n = this.y;
    const r = this.z;
    const s = this.w;
    const a = t * t;
    const i = n * n;
    const o = r * r;
    const _ = s * s;
    const c = 2 * (t * n + s * r);
    const d = _ + a - i - o;
    const u = -2 * (t * r - s * n);
    const l = Math.atan2(2 * (n * r + s * t), _ - a - i + o);
    const f = Math.asin(u);
    const h = Math.atan2(c, d);
    e.set(l, f, h);
  }

  fromEulerAnglesXYZ(e: number, t: number, n: number): this {
    const r = 0.5 * e;
    const s = 0.5 * t;
    const a = 0.5 * n;
    const i = Math.sin(r);
    const o = Math.sin(s);
    const _ = Math.sin(a);
    const c = Math.cos(r);
    const d = Math.cos(s);
    const u = Math.cos(a);
    return this.set(
      i * d * u + c * o * _,
      c * o * u - i * d * _,
      c * d * _ + i * o * u,
      c * d * u - i * o * _
    );
  }

  fromEulerAnglesYXZ(e: number, t: number, n: number): this {
    const r = 0.5 * e;
    const s = 0.5 * t;
    const a = 0.5 * n;
    const i = Math.sin(r);
    const o = Math.sin(s);
    const _ = Math.sin(a);
    const c = Math.cos(r);
    const d = Math.cos(s);
    const u = Math.cos(a);
    return this.set(
      i * d * u + c * o * _,
      c * o * u - i * d * _,
      c * d * _ - i * o * u,
      c * d * u + i * o * _
    );
  }

  fromEulerAnglesZXY(e: number, t: number, n: number): this {
    const r = 0.5 * e;
    const s = 0.5 * t;
    const a = 0.5 * n;
    const i = Math.sin(r);
    const o = Math.sin(s);
    const _ = Math.sin(a);
    const c = Math.cos(r);
    const d = Math.cos(s);
    const u = Math.cos(a);
    return this.set(
      i * d * u - c * o * _,
      c * o * u + i * d * _,
      c * d * _ + i * o * u,
      c * d * u - i * o * _
    );
  }

  fromEulerAnglesZYX(e: number, t: number, n: number): this {
    const r = 0.5 * e;
    const s = 0.5 * t;
    const a = 0.5 * n;
    const i = Math.sin(r);
    const o = Math.sin(s);
    const _ = Math.sin(a);
    const c = Math.cos(r);
    const d = Math.cos(s);
    const u = Math.cos(a);
    return this.set(
      i * d * u - c * o * _,
      c * o * u + i * d * _,
      c * d * _ - i * o * u,
      c * d * u + i * o * _
    );
  }

  fromEulerAnglesYZX(e: number, t: number, n: number): this {
    const r = 0.5 * e;
    const s = 0.5 * t;
    const a = 0.5 * n;
    const i = Math.sin(r);
    const o = Math.sin(s);
    const _ = Math.sin(a);
    const c = Math.cos(r);
    const d = Math.cos(s);
    const u = Math.cos(a);
    return this.set(
      i * d * u + c * o * _,
      c * o * u + i * d * _,
      c * d * _ - i * o * u,
      c * d * u - i * o * _
    );
  }

  fromEulerAnglesXZY(e: number, t: number, n: number): this {
    const r = 0.5 * e;
    const s = 0.5 * t;
    const a = 0.5 * n;
    const i = Math.sin(r);
    const o = Math.sin(s);
    const _ = Math.sin(a);
    const c = Math.cos(r);
    const d = Math.cos(s);
    const u = Math.cos(a);
    return this.set(
      i * d * u - c * o * _,
      c * o * u - i * d * _,
      c * d * _ + i * o * u,
      c * d * u + i * o * _
    );
  }

  fromEulerAngles(e: number, t: number, n: number): this {
    return this.fromEulerAnglesXYZ(e, t, n);
  }

  fromDegrees(e = 0, t = 0, n = 0): this {
    return this.fromEulerAnglesXYZ(e * DEG2RAD, t * DEG2RAD, n * DEG2RAD);
  }

  static fromEulerAngles(e: number, t: number, n: number): Quat {
    const r = new Quat();
    r.fromEulerAnglesXYZ(e, t, n);
    return r;
  }

  lookAt(
    e: { x: number; y: number; z: number },
    t: { x: number; y: number; z: number },
    n: { x: number; y: number; z: number } = Vec3.up
  ): this {
    _T.subVectors(t, e);
    _T.normalize();
    return this.lookRotation(_T, n);
  }

  _lookRotation(
    e: number,
    t: number,
    n: number,
    r: number,
    s: number,
    a: number
  ): this {
    _T.set(e, t, n);
    _T.normalize();
    _U.set(s * _T.z - a * _T.y, a * _T.x - r * _T.z, r * _T.y - s * _T.x);
    if (_U.lengthSq() === 0) {
      if (Math.abs(a) === 1) _T.x += 0.001;
      else _T.z += 0.001;
      _T.normalize();
      _U.set(s * _T.z - a * _T.y, a * _T.x - r * _T.z, r * _T.y - s * _T.x);
    }
    _U.normalize();
    _L.crossVectors(_T, _U);
    return this.__setFromRotationMatrix(
      _U.x,
      _L.x,
      _T.x,
      _U.y,
      _L.y,
      _T.y,
      _U.z,
      _L.z,
      _T.z
    );
  }

  lookRotation(
    forward: { x: number; y: number; z: number },
    up: { x: number; y: number; z: number } = Vec3.up
  ): this {
    return this._lookRotation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
  }

  fromUnitVectors(
    e: { x: number; y: number; z: number },
    t: { x: number; y: number; z: number }
  ): this {
    const n = e.x;
    const r = e.y;
    const s = e.z;
    const a = t.x;
    const i = t.y;
    const o = t.z;
    const _ = n * a + r * i + s * o;
    if (_ < -0.9999999) {
      _T.crossVectors(Vec3.left, e);
      if (_T.lengthSqr() < 1e-5) _T.crossVectors(Vec3.up, e);
      _T.normalize();
      return this.set(_T.x, _T.y, _T.z, 0);
    }
    const c = Math.sqrt(2 + 2 * _);
    const d = 1 / c;
    return this.set(
      d * (r * o - s * i),
      d * (s * a - n * o),
      d * (n * i - r * a),
      0.5 * c
    );
  }

  setFromRotationMatrix(e: ArrayLike<number>): this {
    return this.__setFromRotationMatrix(
      e[0]!,
      e[4]!,
      e[8]!,
      e[1]!,
      e[5]!,
      e[9]!,
      e[2]!,
      e[6]!,
      e[10]!
    );
  }

  __setFromRotationMatrix(
    e: number,
    t: number,
    n: number,
    r: number,
    s: number,
    a: number,
    i: number,
    o: number,
    _: number
  ): this {
    const c = e + s + _;
    let d: number;
    let u: number;
    let l: number;
    let f: number;
    let h: number;
    if (c > 0) {
      h = Math.sqrt(c + 1);
      f = 0.5 * h;
      h = 0.5 / h;
      d = (o - a) * h;
      u = (n - i) * h;
      l = (r - t) * h;
    } else if (e > s && e > _) {
      h = Math.sqrt(1 + e - s - _);
      d = 0.5 * h;
      h = 0.5 / h;
      f = (o - a) * h;
      u = (t + r) * h;
      l = (n + i) * h;
    } else if (s > _) {
      h = Math.sqrt(1 + s - e - _);
      u = 0.5 * h;
      h = 0.5 / h;
      f = (n - i) * h;
      d = (t + r) * h;
      l = (a + o) * h;
    } else {
      h = Math.sqrt(1 + _ - e - s);
      l = 0.5 * h;
      h = 0.5 / h;
      f = (r - t) * h;
      d = (n + i) * h;
      u = (a + o) * h;
    }
    return this.set(d, u, l, f);
  }

  lerp(e: { x: number; y: number; z: number; w: number }, t: number): this {
    return this.lerpQuaternions(this, e, t);
  }

  lerpQuaternions(
    e: { x: number; y: number; z: number; w: number },
    t: { x: number; y: number; z: number; w: number },
    n: number
  ): this {
    return this.set(
      lerpNum(e.x, t.x, n),
      lerpNum(e.y, t.y, n),
      lerpNum(e.z, t.z, n),
      lerpNum(e.w, t.w, n)
    );
  }

  slerp(e: { x: number; y: number; z: number; w: number }, t: number): this {
    return this.slerpQuaternions(this, e, t);
  }

  slerpQuaternions(
    e: { x: number; y: number; z: number; w: number },
    t: { x: number; y: number; z: number; w: number },
    n: number
  ): this {
    const r = e.x;
    const s = e.y;
    const a = e.z;
    const i = e.w;
    let o: number;
    let _: number;
    let c = t.x;
    let d = t.y;
    let u = t.z;
    let l = t.w;
    let f = r * c + s * d + a * u + i * l;
    if (f < 0) {
      f = -f;
      c = -c;
      d = -d;
      u = -u;
      l = -l;
    }
    if (1 - f > EPS) {
      const ang = Math.acos(f);
      const invSin = 1 / Math.sin(ang);
      o = Math.sin((1 - n) * ang) * invSin;
      _ = Math.sin(n * ang) * invSin;
    } else {
      o = 1 - n;
      _ = n;
    }
    return this.set(o * r + _ * c, o * s + _ * d, o * a + _ * u, o * i + _ * l);
  }

  roughlyEquals(
    other: { x: number; y: number; z: number; w: number },
    eps = 1e-7
  ): boolean {
    return (
      roughlyEq(this.x, other.x, eps) &&
      roughlyEq(this.y, other.y, eps) &&
      roughlyEq(this.z, other.z, eps) &&
      roughlyEq(this.w, other.w, eps)
    );
  }

  get isIdentity(): boolean {
    return this.roughlyEquals({ x: 0, y: 0, z: 0, w: 1 });
  }

  hash(): number {
    return (
      hashFloat(this.x) ^
      (hashFloat(this.y) >> 2) ^
      (hashFloat(this.z) >> 1) ^
      (hashFloat(this.w) << 2)
    ) | 0;
  }

  toJSON(): { x: number; y: number; z: number; w: number } {
    return { x: this.x, y: this.y, z: this.z, w: this.w };
  }

  fromJSON(e: { x: number; y: number; z: number; w: number }): this {
    return this.set(e.x, e.y, e.z, e.w);
  }

  fromArray(e: ArrayLike<number>, t = 0): this {
    return this.set(
      e[t] as number,
      e[t + 1] as number,
      e[t + 2] as number,
      e[t + 3] as number
    );
  }

  toArray(e: number[] = [], t = 0): number[] {
    e[t] = this.x;
    e[t + 1] = this.y;
    e[t + 2] = this.z;
    e[t + 3] = this.w;
    return e;
  }

  readFromArray(e: ArrayLike<number>, t = 0): this {
    return this.fromArray(e, t);
  }

  writeToArray(e: number[] = [], t = 0): number[] {
    return this.toArray(e, t);
  }

  asArray(e: number[] = [], t = 0): number[] {
    return this.toArray(e, t);
  }

  toBinaryBuffer(e: BinaryReader): void {
    e.writeFloat64(this.x);
    e.writeFloat64(this.y);
    e.writeFloat64(this.z);
    e.writeFloat64(this.w);
  }

  fromBinaryBuffer(e: BinaryReader): this {
    return this.set(
      e.readFloat64(),
      e.readFloat64(),
      e.readFloat64(),
      e.readFloat64()
    );
  }

  toBinaryBufferFloat32(e: BinaryReader): void {
    e.writeFloat32(this.x);
    e.writeFloat32(this.y);
    e.writeFloat32(this.z);
    e.writeFloat32(this.w);
  }

  fromBinaryBufferFloat32(e: BinaryReader): this {
    return this.set(
      e.readFloat32(),
      e.readFloat32(),
      e.readFloat32(),
      e.readFloat32()
    );
  }

  static readonly identity = new Quat(0, 0, 0, 1);
}

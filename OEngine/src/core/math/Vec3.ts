/**
 * Vec3：提供渲染系统使用的数学运算与基础数据结构。
 */

import { ChangeSignal } from "../Signal.js";
import { hashFloat } from "../hashMix.js";
import type { BinaryReader } from "../../loaders/BinaryReader.js";
import { Float64VectorBase } from "./Float64VectorBase.js";

function clamp(e: number, t: number, n: number): number {
  return e < t ? t : e > n ? n : e;
}

function roughlyEq(e: number, t: number, n = 1e-7): boolean {
  return Math.abs(e - t) <= n;
}

function lerpNum(e: number, t: number, n: number): number {
  return (t - e) * n + e;
}

function sign1(e: number): number {
  return e > 0 ? 1 : e < 0 ? -1 : 0;
}

function dot3(
  e: number,
  t: number,
  n: number,
  r: number,
  s: number,
  a: number
): number {
  return e * r + t * s + n * a;
}

function lenSq3(e: number, t: number, n: number): number {
  return e * e + t * t + n * n;
}

function len3(e: number, t: number, n: number): number {
  return Math.sqrt(e * e + t * t + n * n);
}

export class Vec3 extends Float64VectorBase {
  readonly onChanged = new ChangeSignal<
    number,
    number,
    number,
    number,
    number,
    number
  >();

  constructor(x = 0, y = 0, z = 0) {
    super(3);
    this[0] = x;
    this[1] = y;
    this[2] = z;
  }

  declare 0: number;
  declare 1: number;
  declare 2: number;

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
      this.onChanged.send6(value, this[1]!, this[2]!, old, this[1]!, this[2]!);
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
      this.onChanged.send6(this[0]!, value, this[2]!, this[0]!, old, this[2]!);
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
      this.onChanged.send6(this[0]!, this[1]!, value, this[0]!, this[1]!, old);
    }
  }

  get isVector3(): boolean {
    return true;
  }

  static readonly typeName = "Vector3";

  set(x: number, y: number, z: number): this {
    const ox = this.x;
    const oy = this.y;
    const oz = this.z;
    if (ox === x && oy === y && oz === z) return this;
    // 批量 mutator 只发一次信号；直接写 TypedArray 索引不属于受支持的
    // 可观察 mutator，调用方应使用 set()/setX() 或 x/y/z 属性。
    this[0] = x;
    this[1] = y;
    this[2] = z;
    if (this.onChanged.hasHandlers()) {
      this.onChanged.send6(x, y, z, ox, oy, oz);
    }
    return this;
  }

  setScalar(v: number): this {
    return this.set(v, v, v);
  }

  setX(v: number): this {
    return this.set(v, this.y, this.z);
  }
  setY(v: number): this {
    return this.set(this.x, v, this.z);
  }
  setZ(v: number): this {
    return this.set(this.x, this.y, v);
  }

  setXY(x: number, y: number): this {
    return this.set(x, y, this.z);
  }
  setXZ(x: number, z: number): this {
    return this.set(x, this.y, z);
  }
  setYZ(y: number, z: number): this {
    return this.set(this.x, y, z);
  }

  copy(other: { x: number; y: number; z: number }): this {
    return this.set(other.x, other.y, other.z);
  }

  clone(): Vec3 {
    return new Vec3(this.x, this.y, this.z);
  }

  fromArray(v: ArrayLike<number>, offset = 0): this {
    return this.set(
      v[offset] as number,
      v[offset + 1] as number,
      v[offset + 2] as number
    );
  }

  toArray(e: number[] = [], t = 0): number[] {
    e[t] = this.x;
    e[t + 1] = this.y;
    e[t + 2] = this.z;
    return e;
  }

  toJSON(): { x: number; y: number; z: number } {
    return { x: this.x, y: this.y, z: this.z };
  }

  fromJSON(json: number | { x: number; y: number; z: number }): void {
    if (typeof json === "number") {
      this.setScalar(json);
      return;
    }
    this.copy(json);
  }

  equals(other: { x: number; y: number; z: number }): boolean {
    return this._equals(other.x, other.y, other.z);
  }

  _equals(x: number, y: number, z: number): boolean {
    return this.x === x && this.y === y && this.z === z;
  }

  roughlyEquals(
    other: { x: number; y: number; z: number },
    tolerance?: number
  ): boolean {
    return this._roughlyEquals(other.x, other.y, other.z, tolerance);
  }

  _roughlyEquals(x: number, y: number, z: number, tolerance = 1e-7): boolean {
    return (
      roughlyEq(this.x, x, tolerance) &&
      roughlyEq(this.y, y, tolerance) &&
      roughlyEq(this.z, z, tolerance)
    );
  }

  hash(): number {
    return (
      hashFloat(this.x) ^
      (hashFloat(this.y) << 1) ^
      (hashFloat(this.z) << 2)
    ) | 0;
  }

  add(other: { x: number; y: number; z: number }): this {
    return this._add(other.x, other.y, other.z);
  }

  _add(x: number, y: number, z: number): this {
    return this.set(this.x + x, this.y + y, this.z + z);
  }

  addVectors(
    e: { x: number; y: number; z: number },
    t: { x: number; y: number; z: number }
  ): this {
    return this.set(e.x + t.x, e.y + t.y, e.z + t.z);
  }

  addScaled(e: { x: number; y: number; z: number }, t: number): this {
    return this._add(e.x * t, e.y * t, e.z * t);
  }

  addScalar(val: number): this {
    return this.set(this.x + val, this.y + val, this.z + val);
  }

  sub(other: { x: number; y: number; z: number }): this {
    return this._sub(other.x, other.y, other.z);
  }

  _sub(x: number, y: number, z: number): this {
    return this.set(this.x - x, this.y - y, this.z - z);
  }

  subVectors(
    e: { x: number; y: number; z: number },
    t: { x: number; y: number; z: number }
  ): this {
    return this.set(e.x - t.x, e.y - t.y, e.z - t.z);
  }

  subScalar(val: number): this {
    return this.addScalar(-val);
  }

  multiply(e: { x: number; y: number; z: number }): this {
    return this._multiply(e.x, e.y, e.z);
  }

  _multiply(x: number, y: number, z: number): this {
    return this.set(this.x * x, this.y * y, this.z * z);
  }

  multiplyVectors(
    e: { x: number; y: number; z: number },
    t: { x: number; y: number; z: number }
  ): this {
    return this.set(e.x * t.x, e.y * t.y, e.z * t.z);
  }

  multiplyScalar(val: number): this {
    return this.set(this.x * val, this.y * val, this.z * val);
  }

  divide(e: { x: number; y: number; z: number }): this {
    return this._divide(e.x, e.y, e.z);
  }

  _divide(x: number, y: number, z: number): this {
    return this.set(this.x / x, this.y / y, this.z / z);
  }

  divideVectors(
    e: { x: number; y: number; z: number },
    t: { x: number; y: number; z: number }
  ): this {
    return this.set(e.x / t.x, e.y / t.y, e.z / t.z);
  }

  negate(): this {
    return this.set(-this.x, -this.y, -this.z);
  }

  abs(): this {
    return this.set(Math.abs(this.x), Math.abs(this.y), Math.abs(this.z));
  }

  sign(): this {
    return this.set(sign1(this.x), sign1(this.y), sign1(this.z));
  }

  cross(e: { x: number; y: number; z: number }): this {
    return this.crossVectors(this, e);
  }

  crossVectors(
    e: { x: number; y: number; z: number },
    t: { x: number; y: number; z: number }
  ): this {
    return this._crossVectors(e.x, e.y, e.z, t.x, t.y, t.z);
  }

  _crossVectors(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number
  ): this {
    return this.set(
      ay * bz - az * by,
      az * bx - ax * bz,
      ax * by - ay * bx
    );
  }

  dot(e: { x: number; y: number; z: number }): number {
    return Vec3.dot(this, e);
  }

  length(): number {
    return len3(this.x, this.y, this.z);
  }

  lengthSqr(): number {
    return lenSq3(this.x, this.y, this.z);
  }

  lengthSq(): number {
    return this.lengthSqr();
  }

  isZero(): boolean {
    return this.x === 0 && this.y === 0 && this.z === 0;
  }

  normalize(): this {
    const e = this.length();
    return e === 0 ? this : this.multiplyScalar(1 / e);
  }

  isNormalized(squared_error = 1e-5): boolean {
    return roughlyEq(this.lengthSqr(), 1, squared_error);
  }

  distanceTo(e: { x: number; y: number; z: number }): number {
    return this._distanceTo(e.x, e.y, e.z);
  }

  _distanceTo(x: number, y: number, z: number): number {
    return len3(this.x - x, this.y - y, this.z - z);
  }

  distanceSqrTo(e: { x: number; y: number; z: number }): number {
    return this._distanceSqrTo(e.x, e.y, e.z);
  }

  _distanceSqrTo(x: number, y: number, z: number): number {
    return lenSq3(this.x - x, this.y - y, this.z - z);
  }

  distanceToSquared(e: { x: number; y: number; z: number }): number {
    return this.distanceSqrTo(e);
  }

  angleTo(e: { x: number; y: number; z: number }): number {
    const i = (() => {
      const d = dot3(this.x, this.y, this.z, e.x, e.y, e.z);
      const o = this.length() * len3(e.x, e.y, e.z);
      return o === 0 ? 0 : clamp(d / o, -1, 1);
    })();
    return Math.acos(i);
  }

  applyQuaternion(e: { x: number; y: number; z: number; w: number }): this {
    const t = this.x;
    const n = this.y;
    const r = this.z;
    const s = e.x;
    const a = e.y;
    const i = e.z;
    const o = e.w;
    const _ = o * t + a * r - i * n;
    const c = o * n + i * t - s * r;
    const d = o * r + s * n - a * t;
    const u = -s * t - a * n - i * r;
    return this.set(
      _ * o + u * -s + c * -i - d * -a,
      c * o + u * -a + d * -s - _ * -i,
      d * o + u * -i + _ * -a - c * -s
    );
  }

  lerp(e: { x: number; y: number; z: number }, t: number): this {
    return this.lerpVectors(this, e, t);
  }

  lerpVectors(
    e: { x: number; y: number; z: number },
    t: { x: number; y: number; z: number },
    n: number
  ): this {
    return this.set(
      lerpNum(e.x, t.x, n),
      lerpNum(e.y, t.y, n),
      lerpNum(e.z, t.z, n)
    );
  }

  slerp(e: { x: number; y: number; z: number }, t: number): this {
    return this.slerpVectors(this, e, t);
  }

  slerpVectors(
    e: { x: number; y: number; z: number },
    t: { x: number; y: number; z: number },
    n: number
  ): this {
    const _ = dot3(e.x, e.y, e.z, t.x, t.y, t.z);
    if (_ >= 1 || _ <= -1) {
      return this.lerpVectors(e, t, n);
    }
    const c = Math.acos(_);
    const d = 1 / Math.sin(c);
    const u = Math.sin((1 - n) * c) * d;
    const l = Math.sin(n * c) * d;
    return this.set(e.x * u + t.x * l, e.y * u + t.y * l, e.z * u + t.z * l);
  }

  applyMatrix4(e: ArrayLike<number>): this {
    const t = this.x;
    const n = this.y;
    const r = this.z;
    const s = 1 / (e[3]! * t + e[7]! * n + e[11]! * r + e[15]!);
    return this.set(
      (e[0]! * t + e[4]! * n + e[8]! * r + e[12]!) * s,
      (e[1]! * t + e[5]! * n + e[9]! * r + e[13]!) * s,
      (e[2]! * t + e[6]! * n + e[10]! * r + e[14]!) * s
    );
  }

  applyDirectionMatrix4(e: ArrayLike<number>): this {
    const t = this.x;
    const n = this.y;
    const r = this.z;
    const s = e[0]! * t + e[4]! * n + e[8]! * r;
    const a = e[1]! * t + e[5]! * n + e[9]! * r;
    const i = e[2]! * t + e[6]! * n + e[10]! * r;
    const o = 1 / (len3(s, a, i) || 1);
    return this.set(s * o, a * o, i * o);
  }

  applyMatrix3(e: ArrayLike<number>): this {
    const t = this.x;
    const n = this.y;
    const r = this.z;
    return this.set(
      e[0]! * t + e[3]! * n + e[6]! * r,
      e[1]! * t + e[4]! * n + e[7]! * r,
      e[2]! * t + e[5]! * n + e[8]! * r
    );
  }

  setFromMatrixPosition(e: ArrayLike<number>): this {
    return this.set(e[12]!, e[13]!, e[14]!);
  }

  round(): this {
    return this.set(Math.round(this.x), Math.round(this.y), Math.round(this.z));
  }

  floor(): this {
    return this.set(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z));
  }

  ceil(): this {
    return this.set(Math.ceil(this.x), Math.ceil(this.y), Math.ceil(this.z));
  }

  projectOntoVector3(e: { x: number; y: number; z: number }): this {
    return this._projectVectors(this.x, this.y, this.z, e.x, e.y, e.z);
  }

  _projectVectors(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number
  ): this {
    const scale =
      dot3(x0, y0, z0, x1, y1, z1) /
      (x1 * x1 + y1 * y1 + z1 * z1);
    return this.set(x1 * scale, y1 * scale, z1 * scale);
  }

  setFromSphericalCoords(radius: number, phi: number, theta: number): this {
    const r = Math.sin(phi);
    const s = Math.cos(phi);
    const a = Math.sin(theta);
    const i = Math.cos(theta);
    return this.set(radius * r * a, radius * s, radius * r * i);
  }

  process(e: (x: number, y: number, z: number) => void, t?: unknown): this {
    e.call(t, this.x, this.y, this.z);
    this.onChanged.add(e as (...args: unknown[]) => void, t);
    return this;
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

  override toString(): string {
    return `Vector3{ x:${this.x}, y:${this.y}, z:${this.z} }`;
  }

  toBinaryBuffer(buffer: BinaryReader): void {
    buffer.writeFloat64(this.x);
    buffer.writeFloat64(this.y);
    buffer.writeFloat64(this.z);
  }

  fromBinaryBuffer(buffer: BinaryReader): void {
    this.set(buffer.readFloat64(), buffer.readFloat64(), buffer.readFloat64());
  }

  toBinaryBufferFloat32(buffer: BinaryReader): void {
    buffer.writeFloat32(this.x);
    buffer.writeFloat32(this.y);
    buffer.writeFloat32(this.z);
  }

  fromBinaryBufferFloat32(buffer: BinaryReader): void {
    this.set(buffer.readFloat32(), buffer.readFloat32(), buffer.readFloat32());
  }

  static dot(
    e: { x: number; y: number; z: number },
    t: { x: number; y: number; z: number }
  ): number {
    return e.x * t.x + e.y * t.y + e.z * t.z;
  }

  static distance(
    a: { x: number; y: number; z: number },
    b: { x: number; y: number; z: number }
  ): number {
    return len3(a.x - b.x, a.y - b.y, a.z - b.z);
  }

  static fromArray(e: ArrayLike<number>, t = 0): Vec3 {
    return new Vec3(e[t] as number, e[t + 1] as number, e[t + 2] as number);
  }

  static fromScalar(e: number): Vec3 {
    return new Vec3(e, e, e);
  }

  static readonly zero = new Vec3(0, 0, 0);
  static readonly one = new Vec3(1, 1, 1);
  static readonly minus_one = new Vec3(-1, -1, -1);
  static readonly up = new Vec3(0, 1, 0);
  static readonly down = new Vec3(0, -1, 0);
  static readonly left = new Vec3(-1, 0, 0);
  static readonly right = new Vec3(1, 0, 0);
  static readonly forward = new Vec3(0, 0, 1);
  static readonly back = new Vec3(0, 0, -1);
}

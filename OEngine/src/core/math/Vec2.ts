/**
 * Vec2：提供渲染系统使用的数学运算与基础数据结构。
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

function fmax(e: number, t: number): number {
  return e < t ? t : e;
}

function fmin(e: number, t: number): number {
  return e < t ? e : t;
}

function lenSq2(e: number, t: number): number {
  return e * e + t * t;
}

function len2(e: number, t: number): number {
  return Math.sqrt(lenSq2(e, t));
}

export class Vec2 extends Float64VectorBase {
  readonly onChanged = new ChangeSignal<number, number, number, number>();

  constructor(x = 0, y = 0) {
    super(2);
    this[0] = x;
    this[1] = y;
  }

  declare 0: number;
  declare 1: number;

  static get [Symbol.species](): Float64ArrayConstructor {
    return Float64Array;
  }

  get x(): number {
    return this[0]!;
  }

  set x(value: number) {
    this[0] = value;
  }

  get y(): number {
    return this[1]!;
  }

  set y(value: number) {
    this[1] = value;
  }

  get isVector2(): boolean {
    return true;
  }

  static readonly typeName = "Vector2";

  set(x: number, y: number): this {
    const ox = this.x;
    const oy = this.y;
    if (ox === x && oy === y) return this;
    this.x = x;
    this.y = y;
    if (this.onChanged.hasHandlers()) {
      this.onChanged.send4(x, y, ox, oy);
    }
    return this;
  }

  setSilent(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }

  setX(x: number): this {
    return this.set(x, this.y);
  }

  setY(y: number): this {
    return this.set(this.x, y);
  }

  setScalar(val: number): this {
    return this.set(val, val);
  }

  fromArray(array: ArrayLike<number>, offset = 0): this {
    return this.set(array[offset] as number, array[offset + 1] as number);
  }

  toArray(array: number[] | Float32Array, offset = 0): void {
    array[offset] = this.x;
    array[offset + 1] = this.y;
  }

  asArray(): number[] {
    const e: number[] = [];
    this.toArray(e, 0);
    return e;
  }

  declare writeToArray: (array: number[] | Float32Array, offset?: number) => void;

  declare readFromArray: (array: ArrayLike<number>, offset?: number) => this;

  copy(other: { x: number; y: number }): this {
    return this.set(other.x, other.y);
  }

  clone(): Vec2 {
    return new Vec2(this.x, this.y);
  }

  equals(other: { x: number; y: number }): boolean {
    return this.x === other.x && this.y === other.y;
  }

  roughlyEquals(other: { x: number; y: number }, tolerance = 1e-7): boolean {
    return this._roughlyEquals(other.x, other.y, tolerance);
  }

  _roughlyEquals(x: number, y: number, tolerance = 1e-7): boolean {
    return roughlyEq(this.x, x, tolerance) && roughlyEq(this.y, y, tolerance);
  }

  hash(): number {
    const e = hashFloat(this.x);
    return (e << 5) - e + hashFloat(this.y);
  }

  toJSON(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  fromJSON(json: {}): void {
    if (typeof json === "number") {
      this.set(json, json);
      return;
    }
    const { x = 0, y = 0 } = json as { x?: number; y?: number };
    this.set(x, y);
  }

  override toString(): string {
    return `Vector2{ x:${this.x}, y:${this.y} }`;
  }


  _sub(x: number, y: number): this {
    return this.set(this.x - x, this.y - y);
  }

  sub(other: { x: number; y: number }): this {
    return this._sub(other.x, other.y);
  }

  subVectors(
    a: { x: number; y: number },
    b: { x: number; y: number }
  ): this {
    return this.set(a.x - b.x, a.y - b.y);
  }

  floor(): this {
    return this.set(Math.floor(this.x), Math.floor(this.y));
  }

  ceil(): this {
    return this.set(Math.ceil(this.x), Math.ceil(this.y));
  }

  round(): this {
    return this.set(Math.round(this.x), Math.round(this.y));
  }

  abs(): this {
    return this.set(Math.abs(this.x), Math.abs(this.y));
  }

  _mod(x: number, y: number): this {
    return this.set(this.x % x, this.y % y);
  }

  mod(other: { x: number; y: number }): this {
    return this._mod(other.x, other.y);
  }

  divide(other: { x: number; y: number }): this {
    return this.set(this.x / other.x, this.y / other.y);
  }

  _multiply(x: number, y: number): this {
    return this.set(this.x * x, this.y * y);
  }

  multiply(other: { x: number; y: number }): this {
    return this._multiply(other.x, other.y);
  }

  multiplyScalar(val: number): this {
    return this.set(this.x * val, this.y * val);
  }

  divideScalar(val: number): this {
    return this.multiplyScalar(1 / val);
  }

  max(other: { x: number; y: number }): this {
    return this.set(fmax(this.x, other.x), fmax(this.y, other.y));
  }

  dot(other: { x: number; y: number }): number {
    return this.x * other.x + this.y * other.y;
  }

  negate(): this {
    return this.set(-this.x, -this.y);
  }

  _add(x: number, y: number): this {
    return this.set(this.x + x, this.y + y);
  }

  add(other: { x: number; y: number }): this {
    return this._add(other.x, other.y);
  }

  addScaled(other: { x: number; y: number }, scale: number): this {
    return this._add(other.x * scale, other.y * scale);
  }

  addScalar(val: number): this {
    return this._add(val, val);
  }

  isZero(): boolean {
    return this.x === 0 && this.y === 0;
  }

  clamp(minX: number, minY: number, maxX: number, maxY: number): this {
    return this.set(clamp(this.x, minX, maxX), clamp(this.y, minY, maxY));
  }

  clampLow(lowX: number, lowY: number): this {
    return this.set(fmax(this.x, lowX), fmax(this.y, lowY));
  }

  clampHigh(highX: number, highY: number): this {
    return this.set(fmin(this.x, highX), fmin(this.y, highY));
  }

  distanceSqrTo(other: { x: number; y: number }): number {
    return this._distanceSqrTo(other.x, other.y);
  }

  _distanceSqrTo(x: number, y: number): number {
    return lenSq2(this.x - x, this.y - y);
  }

  distanceTo(other: { x: number; y: number }): number {
    return this._distanceTo(other.x, other.y);
  }

  _distanceTo(x: number, y: number): number {
    return Math.sqrt(this._distanceSqrTo(x, y));
  }

  manhattanDistanceTo(other: { x: number; y: number }): number {
    return Math.abs(this.x - other.x) + Math.abs(this.y - other.y);
  }

  length(): number {
    return len2(this.x, this.y);
  }

  normalize(): this {
    const e = len2(this.x, this.y);
    return e === 0 ? this : this.multiplyScalar(1 / e);
  }

  lerpVectors(
    a: { x: number; y: number },
    b: { x: number; y: number },
    fraction: number
  ): this {
    return this.set(lerpNum(a.x, b.x, fraction), lerpNum(a.y, b.y, fraction));
  }

  applyMatrix3(matrix3: ArrayLike<number>): this {
    const x = this.x;
    const y = this.y;
    return this.set(
      matrix3[0]! * x + matrix3[3]! * y + matrix3[6]!,
      matrix3[1]! * x + matrix3[4]! * y + matrix3[7]!,
    );
  }

  rotate(angle: number): this {
    const t = Math.sin(angle);
    const n = Math.cos(angle);
    const r = this.x;
    const s = this.y;
    return this.set(r * n - s * t, r * t + s * n);
  }

  process(processor: (x: number, y: number) => void, thisArg?: unknown): this {
    processor.call(thisArg, this.x, this.y);
    this.onChanged.add(processor as (...args: unknown[]) => void, thisArg);
    return this;
  }

  toBinaryBuffer(buffer: BinaryReader): void {
    buffer.writeFloat64(this.x);
    buffer.writeFloat64(this.y);
  }

  fromBinaryBuffer(buffer: BinaryReader): void {
    this.set(buffer.readFloat64(), buffer.readFloat64());
  }

  toBinaryBufferFloat32(buffer: BinaryReader): void {
    buffer.writeFloat32(this.x);
    buffer.writeFloat32(this.y);
  }

  fromBinaryBufferFloat32(buffer: BinaryReader): void {
    this.set(buffer.readFloat32(), buffer.readFloat32());
  }

  static _distance(e: number, t: number, n: number, r: number): number {
    return len2(n - e, r - t);
  }

  static readonly up = new Vec2(0, 1);
  static readonly down = new Vec2(0, -1);
  static readonly left = new Vec2(-1, 0);
  static readonly right = new Vec2(1, 0);
  static readonly zero = new Vec2(0, 0);
  static readonly one = new Vec2(1, 1);
}

Vec2.prototype.writeToArray = Vec2.prototype.toArray;
Vec2.prototype.readFromArray = Vec2.prototype.fromArray;

/**
 * Transform3D：提供渲染系统使用的数学运算与基础数据结构。
 */

import { Vec3 } from "./Vec3.js";
import { Quat } from "./Quat.js";
import {
  mat4Copy,
  mat4FromTRS,
  mat4Multiply
} from "./Mat4.js";

const _scratchMat = new Float32Array(16);
const IDENTITY_QUAT = { x: 0, y: 0, z: 0, w: 1 };
const IDENTITY_MAT4 = Object.freeze([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1
] as const);

export const TransformFlag = {
  AutoUpdateMatrix: 2
} as const;

export class Transform3D {
  readonly position = new Vec3();
  readonly rotation = new Quat();
  readonly scale = new Vec3(1, 1, 1);
  readonly matrix = new Float32Array(16);
  flags = TransformFlag.AutoUpdateMatrix;

  constructor() {
    this.matrix[0] = 1;
    this.matrix[5] = 1;
    this.matrix[10] = 1;
    this.matrix[15] = 1;
    this.subscribe(this.#onComponentsChanged, this);
  }

  subscribe(fn: Function, thisArg?: unknown): void {
    const listener = fn as (...args: any[]) => any;
    this.position.onChanged.add(listener, thisArg);
    this.rotation.onChanged.add(listener, thisArg);
    this.scale.onChanged.add(listener, thisArg);
  }

  unsubscribe(fn: Function, thisArg?: unknown): void {
    const listener = fn as (...args: any[]) => any;
    this.position.onChanged.remove(listener, thisArg);
    this.rotation.onChanged.remove(listener, thisArg);
    this.scale.onChanged.remove(listener, thisArg);
  }

  #onComponentsChanged(): void {
    if (this.getFlag(TransformFlag.AutoUpdateMatrix)) {
      this.updateMatrix();
    }
  }

  setFlag(flag: number): void {
    this.flags |= flag;
  }

  clearFlag(flag: number): void {
    this.flags &= ~flag;
  }

  writeFlag(flag: number, value: boolean): void {
    if (value) this.setFlag(flag);
    else this.clearFlag(flag);
  }

  getFlag(flag: number): boolean {
    return (this.flags & flag) === flag;
  }

  get forward(): Vec3 {
    const e = Vec3.forward.clone();
    e.applyDirectionMatrix4(this.matrix);
    return e;
  }

  get right(): Vec3 {
    const e = Vec3.right.clone();
    e.applyDirectionMatrix4(this.matrix);
    return e;
  }

  get up(): Vec3 {
    const e = Vec3.up.clone();
    e.applyDirectionMatrix4(this.matrix);
    return e;
  }

  lookAt(
    target: { x: number; y: number; z: number } | Vec3,
    up: { x: number; y: number; z: number } = { x: 0, y: 1, z: 0 }
  ): void {
    const n = this.position;
    const dx = target.x - n.x;
    const dy = target.y - n.y;
    const dz = target.z - n.z;
    if (dx !== 0 || dy !== 0 || dz !== 0) {
      this.rotation._lookRotation(dx, dy, dz, up.x, up.y, up.z);
    }
  }

  updateMatrix(): void {
    mat4FromTRS(this.matrix, this.position, this.rotation, this.scale);
  }

  fromJSON(e: {
    position?: { x: number; y: number; z: number };
    rotation?: { x: number; y: number; z: number; w: number };
    scale?: { x: number; y: number; z: number };
  }): void {
    if (e.position !== undefined) this.position.fromJSON(e.position);
    else this.position.copy(Vec3.zero);
    if (e.rotation !== undefined) {
      this.rotation.fromJSON(e.rotation);
    } else {
      this.rotation.identity();
    }
    if (e.scale !== undefined) this.scale.fromJSON(e.scale);
    else this.scale.copy(Vec3.one);
  }

  toJSON(): {
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number; w: number };
    scale: { x: number; y: number; z: number };
  } {
    return {
      position: this.position.toJSON(),
      rotation: {
        x: this.rotation.x,
        y: this.rotation.y,
        z: this.rotation.z,
        w: this.rotation.w
      },
      scale: this.scale.toJSON()
    };
  }

  copy(other: Transform3D): void {
    this.clearFlag(TransformFlag.AutoUpdateMatrix);
    mat4Copy(this.matrix, other.matrix);
    this.position.copy(other.position);
    this.rotation.copy(other.rotation);
    this.scale.copy(other.scale);
    this.flags = other.flags;
  }

  clone(): Transform3D {
    const t = new Transform3D();
    t.copy(this);
    return t;
  }

  multiply(e: Transform3D): this {
    return this.multiplyTransforms(this, e);
  }

  multiplyTransforms(a: Transform3D, b: Transform3D): this {
    mat4Multiply(_scratchMat, a.matrix, b.matrix);
    return this.fromMatrix(_scratchMat);
  }

  fromMatrix(matrix: Float32Array | number[] | ArrayLike<number>): this {
    const t = this.getFlag(TransformFlag.AutoUpdateMatrix);
    this.clearFlag(TransformFlag.AutoUpdateMatrix);
    const e = matrix as ArrayLike<number>;
    this.matrix.set(e);
    const s0 = e[0] as number;
    const a0 = e[1] as number;
    const i0 = e[2] as number;
    const o = Math.sqrt(s0 * s0 + a0 * a0 + i0 * i0);
    const _ = e[4] as number;
    const c = e[5] as number;
    const d = e[6] as number;
    const u = Math.sqrt(_ * _ + c * c + d * d);
    const l = e[8] as number;
    const h = e[9] as number;
    const m = e[10] as number;
    const g = Math.sqrt(l * l + h * h + m * m);
    const p = o !== 0 ? 1 / o : 1e7;
    const v = u !== 0 ? 1 / u : 1e7;
    const A = g !== 0 ? 1 / g : 1e7;
    const b = s0 * p;
    const w = a0 * p;
    const x = i0 * p;
    const y = _ * v;
    const B = c * v;
    const P = d * v;
    const z = l * A;
    const E = h * A;
    const C = m * A;
    this.position.set(e[12] as number, e[13] as number, e[14] as number);
    this.scale.set(o, u, g);
    this.rotation.__setFromRotationMatrix(b, y, z, w, B, E, x, P, C);
    this.writeFlag(TransformFlag.AutoUpdateMatrix, t);
    return this;
  }

  toMatrix(e: Float32Array = new Float32Array(16)): Float32Array {
    mat4FromTRS(e, this.position, this.rotation, this.scale);
    return e;
  }

  makeIdentity(): void {
    this.fromMatrix(IDENTITY_MAT4);
  }

  isIdentity(): boolean {
    return (
      this.position.equals(Vec3.zero) &&
      this.rotation.equals(IDENTITY_QUAT) &&
      this.scale.equals(Vec3.one)
    );
  }

  toString(): string {
    return `Transform{ position: ${this.position}, rotation: ${this.rotation}, scale: ${this.scale} }`;
  }

  static fromMatrix(e: Float32Array | number[] | ArrayLike<number>): Transform3D {
    const t = new Transform3D();
    return t.fromMatrix(e);
  }

  static fromJSON(e: {
    position?: { x: number; y: number; z: number };
    rotation?: { x: number; y: number; z: number; w: number };
    scale?: { x: number; y: number; z: number };
  }): Transform3D {
    const t = new Transform3D();
    t.fromJSON(e);
    return t;
  }

  static readonly typeName = "Transform";
  readonly isTransform = true;

  static adjustRotation(
    e: Quat,
    t: { x: number; y: number; z: number },
    n = Infinity
  ): void {
    console.warn("deprecated, use Transform.rotation.rotateTowards instead");
    const r = new Quat();
    r.lookRotation(t);
    e.rotateTowards(r, n);
  }

  equals(other: Transform3D): boolean {
    return (
      this.position.equals(other.position) &&
      this.rotation.equals(other.rotation) &&
      this.scale.equals(other.scale)
    );
  }

  hash(): number {
    return this.position.hash();
  }

}

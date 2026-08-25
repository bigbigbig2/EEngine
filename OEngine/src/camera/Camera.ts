/**
 * 相机基类：维护视图矩阵、投影矩阵、视锥体以及相机变换状态。
 */

import { hashFloat, hashMix } from "../core/hashMix.js";
import { Transform3D } from "../core/math/Transform3D.js";
import {
  mat4ExtractFrustumPlanes,
  mat4Identity,
  mat4Multiply,
  mat4ViewFromWorldTransform
} from "../core/math/Mat4.js";

let nextCameraId = 0;

export class Camera {
  transform = new Transform3D();
  view_matrix = mat4Identity();
  projection_matrix = mat4Identity();
  view_projection_matrix = mat4Identity();
  frustum: Float32Array = new Float32Array(24);

  private readonly _id = nextCameraId++;
  private _near = 0.1;
  private _far = 2000;
  private _aspect = 1;

  get id(): number {
    return this._id;
  }

  get near(): number {
    return this._near;
  }
  set near(v: number) {
    this._near = v;
  }

  get far(): number {
    return this._far;
  }
  set far(v: number) {
    this._far = v;
  }

  get aspect(): number {
    return this._aspect;
  }
  set aspect(v: number) {
    this._aspect = v;
  }

  get isReverseZ(): boolean {
    return true;
  }

  get isInfiniteFar(): boolean {
    return false;
  }

  copy(other: Camera): void {
    this._near = other._near;
    this._far = other._far;
    this._aspect = other._aspect;
    this.frustum.set(other.frustum);
    this.transform.copy(other.transform);
    this.view_matrix.set(other.view_matrix);
    this.projection_matrix.set(other.projection_matrix);
    this.view_projection_matrix.set(other.view_projection_matrix);
  }

  clone(): Camera {
    const Ctor = this.constructor as new () => Camera;
    const e = new Ctor();
    e.copy(this);
    return e;
  }

  hash(): number {
    return hashMix(
      hashFloat(this._near),
      hashFloat(this._far),
      hashFloat(this._aspect)
    );
  }

  equals(other: Camera): boolean {
    return (
      this.near === other.near &&
      this.far === other.far &&
      this.aspect === other.aspect &&
      this.transform.equals(other.transform)
    );
  }

  update_matrices(): void {
    this.update_projection();
    this.update_view_matrix();
  }

  update_projection(): void {}

  update_view_matrix(): void {
    mat4ViewFromWorldTransform(this.view_matrix, this.transform.matrix);
  }

  update_frustum(): void {
    mat4ExtractFrustumPlanes(this.frustum, this.view_projection_matrix);
  }

  update(): void {
    this.update_matrices();
    mat4Multiply(this.view_projection_matrix, this.projection_matrix, this.view_matrix);
    this.update_frustum();
  }
}

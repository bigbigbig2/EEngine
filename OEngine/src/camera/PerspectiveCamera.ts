/**
 * 透视相机：根据视场角和宽高比生成无限远 reverse-Z 投影矩阵。
 */

import { Camera } from "./Camera.js";
import { mat4PerspectiveInfiniteReverseZ } from "../core/math/Mat4.js";

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export class PerspectiveCamera extends Camera {
  declare isPerspectiveCamera: boolean;

  private _fov = 45 * DEG2RAD;

  override get isInfiniteFar(): boolean {
    return true;
  }

  get fov(): number {
    return this._fov;
  }
  set fov(fov_radians: number) {
    this._fov = fov_radians;
  }

  get fov_degrees(): number {
    return this._fov * RAD2DEG;
  }
  set fov_degrees(degrees: number) {
    this._fov = degrees * DEG2RAD;
  }

  override equals(other: Camera): boolean {
    return (
      (other as PerspectiveCamera).isPerspectiveCamera === true &&
      this._fov === (other as PerspectiveCamera).fov &&
      super.equals(other)
    );
  }

  override copy(other: Camera): void {
    super.copy(other);
    this._fov = (other as PerspectiveCamera)._fov;
  }

  override clone(): PerspectiveCamera {
    const c = new PerspectiveCamera();
    c.copy(this);
    return c;
  }

  override update_frustum(): void {
    super.update_frustum();
    const e = this.frustum;
    e[20] = 0;
    e[21] = 0;
    e[22] = 0;
    e[23] = 0;
  }

  override update_projection(): void {
    mat4PerspectiveInfiniteReverseZ(
      this.projection_matrix,
      this._fov,
      this.aspect,
      this.near
    );
  }
}

Object.assign(PerspectiveCamera.prototype, { isPerspectiveCamera: true });

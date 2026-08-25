/**
 * OrthographicCamera：负责相机投影、视图变换或交互控制。
 */

import { Camera } from "./Camera.js";

export class OrthographicCamera extends Camera {
  readonly isOrthographicCamera = true;
  left = -1;
  right = 1;
  bottom = -1;
  top = 1;

  setProjectionPlanes(planes: ArrayLike<number>): void {
    this.left = planes[0]!;
    this.right = planes[1]!;
    this.bottom = planes[2]!;
    this.top = planes[3]!;
    this.near = planes[4]!;
    this.far = planes[5]!;
  }

  override copy(other: Camera): void {
    super.copy(other);
    if ((other as OrthographicCamera).isOrthographicCamera) {
      const source = other as OrthographicCamera;
      this.left = source.left;
      this.right = source.right;
      this.bottom = source.bottom;
      this.top = source.top;
    }
  }

  override clone(): OrthographicCamera {
    const camera = new OrthographicCamera();
    camera.copy(this);
    return camera;
  }

  override equals(other: Camera): boolean {
    const camera = other as OrthographicCamera;
    return camera.isOrthographicCamera === true &&
      camera.left === this.left &&
      camera.right === this.right &&
      camera.bottom === this.bottom &&
      camera.top === this.top &&
      super.equals(other);
  }

  override update_projection(): void {
    const inverseWidth = 1 / (this.left - this.right);
    const inverseHeight = 1 / (this.bottom - this.top);
    const inverseDepth = 1 / (this.far - this.near);
    const out = this.projection_matrix;
    out[0] = -2 * inverseWidth;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
    out[5] = -2 * inverseHeight;
    out[6] = 0;
    out[7] = 0;
    out[8] = 0;
    out[9] = 0;
    out[10] = inverseDepth;
    out[11] = 0;
    out[12] = (this.left + this.right) * inverseWidth;
    out[13] = (this.top + this.bottom) * inverseHeight;
    out[14] = this.far * inverseDepth;
    out[15] = 1;
  }
}

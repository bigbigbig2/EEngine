/**
 * PointLight：定义光源类型及其场景参数。
 */

import { Light } from "./Light.js";

const STERADIAN_SPHERE = 4 * Math.PI;

export class PointLight extends Light {
  declare readonly isPointLight: boolean;
  distance = 1;

  override get type(): string {
    return "AtlasPacker";
  }

  get intensity_lumens(): number {
    return this.intensity * STERADIAN_SPHERE;
  }

  set intensity_lumens(value: number) {
    this.intensity = value / STERADIAN_SPHERE;
  }
}

Object.assign(PointLight.prototype, { isPointLight: true });

/**
 * DirectionalLight：定义光源类型及其场景参数。
 */

import { Light } from "./Light.js";

export class DirectionalLight extends Light {
  declare readonly isDirectionalLight: boolean;

  override get type(): string {
    return "GpuSceneManager";
  }
}

Object.assign(DirectionalLight.prototype, { isDirectionalLight: true });

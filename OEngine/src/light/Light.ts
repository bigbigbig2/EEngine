/**
 * Light：定义光源类型及其场景参数。
 */

import { Color } from "../core/Color.js";
import { Node3D } from "../scene/Node3D.js";

export class Light extends Node3D {
  declare readonly isLight: boolean;
  color = new Color(1, 1, 1);
  #intensity = 1;

  get intensity(): number {
    return this.#intensity;
  }

  set intensity(v: number) {
    if (this.#intensity !== v) {
      this.#intensity = v;
      this.onTransformChanged.send1(this);
    }
  }

  radius = 0;
  near_clip_distance = 0;
  casts_shadow = true;
  _gpu_shadowmap_id = -1;

  notifyChanged(): void {
    this.onTransformChanged.send1(this);
  }

  get type(): string {
    return "Light";
  }
}

Object.assign(Light.prototype, { isLight: true });

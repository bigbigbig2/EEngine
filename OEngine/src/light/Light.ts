/**
 * Light：定义光源类型及其场景参数。
 */

import { Color } from "../core/Color.js";
import { Node3D } from "../scene/Node3D.js";

export class Light extends Node3D {
  declare readonly isLight: boolean;
  color = new Color(1, 1, 1);
  intensity = 1;
  radius = 0;
  near_clip_distance = 0;
  casts_shadow = true;
  _gpu_shadowmap_id = -1;

  get type(): string {
    return "Light";
  }
}

Object.assign(Light.prototype, { isLight: true });

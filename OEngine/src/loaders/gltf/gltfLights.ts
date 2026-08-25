/**
 * gltfLights：解析 glTF 数据并转换为引擎运行时对象。
 */

import { Color } from "../../core/Color.js";
import { clamp, clamp01, inverseLerp } from "../../core/math/mathUtils.js";
import { DirectionalLight } from "../../light/DirectionalLight.js";
import type { Light } from "../../light/Light.js";
import { PointLight } from "../../light/PointLight.js";
import { SpotLight } from "../../light/SpotLight.js";
import type { Node3D } from "../../scene/Node3D.js";
import type { GltfPunctualLight } from "./GltfLoader.js";

export function parsePunctualLight(n: GltfPunctualLight): Light {
  const r = new Color(1, 1, 1);
  if (n.color !== undefined) r.fromArray(n.color);
  else r.setRGB(1, 1, 1);
  const s = n.intensity ?? 1;
  const a = n.name ?? "";
  let i: Light;
  const o = n.type;
  switch (o) {
    case "directional":
      i = new DirectionalLight();
      break;
    case "point": {
      const pl = new PointLight();
      pl.distance = n.range ?? 1e20;
      i = pl;
      break;
    }
    case "spot": {
      const sl = new SpotLight();
      const spot = n.spot;
      const outer = spot?.outerConeAngle ?? Math.PI / 4;
      const inner = spot?.innerConeAngle ?? 0;
      sl.angle = clamp(outer, 0, Math.PI / 2);
      sl.penumbra = clamp01(inverseLerp(sl.angle, 0, inner));
      sl.distance = n.range ?? 1e20;
      i = sl;
      break;
    }
    default:
      throw new Error(`Unsupported light type ${o}`);
  }
  i.color.copy(r);
  i.intensity = s;
  i.name = a;
  i.radius = n.extras?.radius ?? 0;
  i.near_clip_distance = n.extras?.near_clip_distance ?? i.radius;
  i.casts_shadow = false;
  return i;
}

export function applyDirSpotLookRotation(node: Node3D): void {
  const any = node as Node3D & {
    isDirectionalLight?: boolean;
    isSpotLight?: boolean;
  };
  if (!any.isDirectionalLight && !any.isSpotLight) return;
  const e = node.transform_local;
  e.rotation.lookRotation(e.forward.negate());
}

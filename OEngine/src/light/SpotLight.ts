/**
 * SpotLight：定义光源类型及其场景参数。
 */

import { Light } from "./Light.js";

const SPOT_DEFAULT_DISTANCE = 34028234663852886e22;

function coneSolidAngle(angle: number): number {
  const resolvedAngle = Math.max(0.01, angle);
  return 2 * Math.PI * (1 - Math.cos(resolvedAngle));
}

export class SpotLight extends Light {
  declare readonly isSpotLight: boolean;
  distance = SPOT_DEFAULT_DISTANCE;
  angle = Math.PI / 3;
  penumbra = 0;

  override get type(): string {
    return "SpotLight";
  }

  get intensity_lumens(): number {
    return this.intensity * coneSolidAngle(this.angle);
  }

  set intensity_lumens(value: number) {
    this.intensity = value / coneSolidAngle(this.angle);
  }
}

Object.assign(SpotLight.prototype, { isSpotLight: true });

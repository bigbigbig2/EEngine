/**
 * ShadeMaterial：定义材质参数、着色模型或材质资源绑定。
 */

import type { ShadeTexture } from "../texture/ShadeTexture.js";
import {
  ShadeDrawMode,
  ShadeDrawSide,
  ShadeTransparencyMode
} from "./enums.js";

let nextShadeMaterialId = 0;

export class ShadeMaterial {
  name = "";
  transparency_mode: number = ShadeTransparencyMode.Opaque;
  draw_mode: number = ShadeDrawMode.Triangles;
  draw_side: number = ShadeDrawSide.Front;
  declare readonly isShadeMaterial: boolean;
  private readonly _id = nextShadeMaterialId++;

  get id(): number {
    return this._id;
  }

  equals(other: ShadeMaterial): boolean {
    return (
      Object.getPrototypeOf(this) === Object.getPrototypeOf(other) &&
      this.transparency_mode === other.transparency_mode &&
      this.draw_mode === other.draw_mode
    );
  }

  hash(): number {
    return this.transparency_mode ^ this.draw_mode;
  }

  get textures(): ShadeTexture[] {
    return [];
  }
}

Object.assign(ShadeMaterial.prototype, { isShadeMaterial: true });

export { ShadeDrawMode, ShadeDrawSide, ShadeTransparencyMode };

/**
 * StandardShadeMaterial：定义材质参数、着色模型或材质资源绑定。
 */

import { Color } from "../core/Color.js";
import { hashFloat, hashMix, hashOptional } from "../core/hashMix.js";
import { ShadeMaterial } from "./ShadeMaterial.js";
import { LinearModifier } from "./LinearModifier.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";

function refOrDeepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  const eq = (a as { equals?: (o: unknown) => boolean }).equals;
  if (typeof eq === "function") return eq.call(a, b);
  return false;
}

export class StandardShadeMaterial extends ShadeMaterial {
  declare readonly isStandardShadeMaterial: boolean;

  texture_albedo: ShadeTexture | undefined = undefined;
  diffuse_color = new Color(1, 1, 1, 1);
  alpha_cutoff = 0.5;
  base_color_uv_set = 0;
  base_color_uv_offset: [number, number] = [0, 0];
  base_color_uv_scale: [number, number] = [1, 1];
  base_color_uv_rotation = 0;
  texture_normal: ShadeTexture | undefined = undefined;
  normal_scale = 1;
  texture_orm: ShadeTexture | undefined = undefined;
  texture_emissive: ShadeTexture | undefined = undefined;
  is_unlit = false;
  roughness_factor = 1;
  metallic_factor = 0;
  transmission_factor = 0;
  ior_factor = 1.5;
  emissive_factor = new Color(0, 0, 0);
  ambient_factors = new LinearModifier(1, 1);


  override get textures(): ShadeTexture[] {
    const textures = this.is_unlit
      ? [this.texture_albedo]
      : [this.texture_albedo, this.texture_normal, this.texture_orm, this.texture_emissive];
    return textures.filter((e): e is ShadeTexture => e !== undefined);
  }

  override hash(): number {
    return hashMix(
      super.hash(),
      this.diffuse_color.hash(),
      hashOptional(this.texture_albedo),
      hashOptional(this.texture_normal),
      hashFloat(this.normal_scale),
      hashOptional(this.texture_orm),
      hashOptional(this.texture_emissive),
      this.is_unlit ? 1 : 0,
      hashFloat(this.alpha_cutoff),
      this.base_color_uv_set,
      hashFloat(this.base_color_uv_offset[0]),
      hashFloat(this.base_color_uv_offset[1]),
      hashFloat(this.base_color_uv_scale[0]),
      hashFloat(this.base_color_uv_scale[1]),
      hashFloat(this.base_color_uv_rotation)
    );
  }

  override equals(other: ShadeMaterial): boolean {
    if (other === this) return true;
    if (!super.equals(other)) return false;
    if (!(other instanceof StandardShadeMaterial)) return false;
    return (
      this.roughness_factor === other.roughness_factor &&
      this.metallic_factor === other.metallic_factor &&
      this.transmission_factor === other.transmission_factor &&
      this.ior_factor === other.ior_factor &&
      this.alpha_cutoff === other.alpha_cutoff &&
      this.base_color_uv_set === other.base_color_uv_set &&
      this.base_color_uv_offset[0] === other.base_color_uv_offset[0] &&
      this.base_color_uv_offset[1] === other.base_color_uv_offset[1] &&
      this.base_color_uv_scale[0] === other.base_color_uv_scale[0] &&
      this.base_color_uv_scale[1] === other.base_color_uv_scale[1] &&
      this.base_color_uv_rotation === other.base_color_uv_rotation &&
      refOrDeepEquals(this.texture_albedo, other.texture_albedo) &&
      this.diffuse_color.equals(other.diffuse_color) &&
      refOrDeepEquals(this.texture_normal, other.texture_normal) &&
      this.normal_scale === other.normal_scale &&
      refOrDeepEquals(this.texture_orm, other.texture_orm) &&
      refOrDeepEquals(this.texture_emissive, other.texture_emissive) &&
      this.is_unlit === other.is_unlit &&
      this.emissive_factor.equals(other.emissive_factor) &&
      this.ambient_factors.equals(other.ambient_factors)
    );
  }
}

Object.assign(StandardShadeMaterial.prototype, { isStandardShadeMaterial: true });

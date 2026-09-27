import type { CanonicalMaterial } from "../material/CanonicalMaterial.js";
import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";
import { encodeSamplerClass, GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE,
  isUsableTexture } from "./GpuMaterialVisibilityAbi.js";

export const GPU_CLOSURE_MATERIAL_ABI_VERSION = 1;
export const GPU_CLOSURE_TEXTURE_ROLE_STRIDE = 48;
export const GPU_CLOSURE_MATERIAL_STRIDE = 272;
export const GPU_CLOSURE_TEXTURE_ROLES = Object.freeze([
  "specular", "specularColor", "coat", "coatRoughness", "coatNormal"
] as const);

export const GPU_CLOSURE_MATERIAL_WGSL = /* wgsl */ `
struct OEngineClosureTextureRole {
  texture_ref: u32,
  uv_set: u32,
  sampler_class: u32,
  _pad: u32,
  uv_offset_scale: vec4f,
  uv_rotation: vec4f,
};
struct OEngineClosureMaterialRecord {
  // x=IOR, y=specular weight, z=coat weight, w=coat roughness.
  factors: vec4f,
  // xyz=linear specular color, w=coat normal scale.
  specular_color_and_normal_scale: vec4f,
  specular: OEngineClosureTextureRole,
  specular_color: OEngineClosureTextureRole,
  coat: OEngineClosureTextureRole,
  coat_roughness: OEngineClosureTextureRole,
  coat_normal: OEngineClosureTextureRole,
};
`;

/** Packs the five glTF extension roles; route indices 5..9 mirror this order. */
export function packGpuClosureMaterial(
  material: StandardShadeMaterial,
  canonical: CanonicalMaterial,
  textureRefs: ReadonlyMap<ShadeTexture, number>,
  mipRanges?: ReadonlyMap<ShadeTexture, readonly [number, number]>
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(GPU_CLOSURE_MATERIAL_STRIDE);
  const view = new DataView(bytes.buffer);
  const factors = [canonical.ior, canonical.specularFactor,
    canonical.coatFactor, canonical.coatRoughness];
  const color = [...canonical.specularColor, canonical.coatNormalScale];
  factors.forEach((value, index) => view.setFloat32(index * 4, value, true));
  color.forEach((value, index) => view.setFloat32(16 + index * 4, value, true));
  const roles = [
    [material.is_unlit ? undefined : material.texture_specular, material.specular_uv_set, material.specular_uv_offset,
      material.specular_uv_scale, material.specular_uv_rotation],
    [material.is_unlit ? undefined : material.texture_specular_color, material.specular_color_uv_set, material.specular_color_uv_offset,
      material.specular_color_uv_scale, material.specular_color_uv_rotation],
    [canonical.coatFactor > 0 ? material.texture_clearcoat : undefined, material.clearcoat_uv_set,
      material.clearcoat_uv_offset, material.clearcoat_uv_scale, material.clearcoat_uv_rotation],
    [canonical.coatFactor > 0 ? material.texture_clearcoat_roughness : undefined,
      material.clearcoat_roughness_uv_set, material.clearcoat_roughness_uv_offset,
      material.clearcoat_roughness_uv_scale, material.clearcoat_roughness_uv_rotation],
    [canonical.coatFactor > 0 ? material.texture_clearcoat_normal : undefined,
      material.clearcoat_normal_uv_set, material.clearcoat_normal_uv_offset,
      material.clearcoat_normal_uv_scale, material.clearcoat_normal_uv_rotation]
  ] as const;
  roles.forEach(([texture, uvSet, offset, scale, rotation], index) => {
    const start = 32 + index * GPU_CLOSURE_TEXTURE_ROLE_STRIDE;
    if (texture !== undefined && (!isUsableTexture(texture) || !textureRefs.has(texture))) {
      throw new Error(`Material '${material.name}' closure texture role ${GPU_CLOSURE_TEXTURE_ROLES[index]} is not resident`);
    }
    const sampler = encodeSamplerClass(texture ?? null,
      texture === undefined ? undefined : mipRanges?.get(texture));
    if (texture !== undefined && sampler.fallback) {
      throw new Error(`Material '${material.name}' closure texture role ${GPU_CLOSURE_TEXTURE_ROLES[index]} has an unsupported sampler`);
    }
    view.setUint32(start, texture === undefined
      ? GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE
      : textureRefs.get(texture)!, true);
    view.setUint32(start + 4, uvSet, true);
    view.setUint32(start + 8, sampler.value, true);
    view.setFloat32(start + 16, offset[0], true);
    view.setFloat32(start + 20, offset[1], true);
    view.setFloat32(start + 24, scale[0], true);
    view.setFloat32(start + 28, scale[1], true);
    view.setFloat32(start + 32, Math.cos(rotation), true);
    view.setFloat32(start + 36, Math.sin(rotation), true);
  });
  return bytes;
}

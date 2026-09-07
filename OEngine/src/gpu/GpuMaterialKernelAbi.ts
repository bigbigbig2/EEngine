import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";

export const GPU_MATERIAL_KERNEL_ABI_VERSION = 1;

/** Bounded Standard PBR feature classes. Material count never changes this set. */
export const GPU_MATERIAL_KERNEL_CLASS = Object.freeze({
  BaseFactor: 0,
  BaseTexture: 1,
  BaseOrm: 2,
  BaseOrmNormal: 3,
  BaseOrmNormalEmissive: 4,
  Unlit: 5,
  GenericStandardPbrFallback: 6
} as const);

export const GPU_MATERIAL_KERNEL_CLASS_COUNT = 7;

export function materialKernelClass(material: StandardShadeMaterial): number {
  if (material.is_unlit) return GPU_MATERIAL_KERNEL_CLASS.Unlit;
  const base = material.texture_albedo !== undefined;
  const normal = material.texture_normal !== undefined;
  const orm = material.texture_orm !== undefined;
  const emissive = material.texture_emissive !== undefined;
  if (!base && !normal && !orm && !emissive) return GPU_MATERIAL_KERNEL_CLASS.BaseFactor;
  if (base && !normal && !orm && !emissive) return GPU_MATERIAL_KERNEL_CLASS.BaseTexture;
  if (!normal && orm && !emissive) return GPU_MATERIAL_KERNEL_CLASS.BaseOrm;
  if (normal && !emissive) return GPU_MATERIAL_KERNEL_CLASS.BaseOrmNormal;
  if (normal && emissive) return GPU_MATERIAL_KERNEL_CLASS.BaseOrmNormalEmissive;
  return GPU_MATERIAL_KERNEL_CLASS.GenericStandardPbrFallback;
}


export const GPU_MATERIAL_KERNEL_WGSL = /* wgsl */ `
const OENGINE_MATERIAL_KERNEL_BASE_FACTOR: u32 = ${GPU_MATERIAL_KERNEL_CLASS.BaseFactor}u;
const OENGINE_MATERIAL_KERNEL_BASE_TEXTURE: u32 = ${GPU_MATERIAL_KERNEL_CLASS.BaseTexture}u;
const OENGINE_MATERIAL_KERNEL_BASE_ORM: u32 = ${GPU_MATERIAL_KERNEL_CLASS.BaseOrm}u;
const OENGINE_MATERIAL_KERNEL_BASE_ORM_NORMAL: u32 = ${GPU_MATERIAL_KERNEL_CLASS.BaseOrmNormal}u;
const OENGINE_MATERIAL_KERNEL_BASE_ORM_NORMAL_EMISSIVE: u32 = ${GPU_MATERIAL_KERNEL_CLASS.BaseOrmNormalEmissive}u;
const OENGINE_MATERIAL_KERNEL_UNLIT: u32 = ${GPU_MATERIAL_KERNEL_CLASS.Unlit}u;
const OENGINE_MATERIAL_KERNEL_GENERIC_STANDARD_PBR: u32 = ${GPU_MATERIAL_KERNEL_CLASS.GenericStandardPbrFallback}u;
const OENGINE_MATERIAL_KERNEL_CLASS_COUNT: u32 = ${GPU_MATERIAL_KERNEL_CLASS_COUNT}u;
`;

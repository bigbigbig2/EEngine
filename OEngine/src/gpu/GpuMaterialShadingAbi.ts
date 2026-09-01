import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";

export const GPU_MATERIAL_SHADING_ABI_VERSION = 1;
export const GPU_MATERIAL_SHADING_RECORD_STRIDE = 32;
export const GPU_MATERIAL_SHADING_INVALID_TEXTURE = 0xffffffff;
export const GPU_MATERIAL_SHADING_BANK_SHIFT = 24;
export const GPU_MATERIAL_SHADING_BANK_MASK = 0x0f000000;
export const GPU_MATERIAL_SHADING_LAYER_MASK = 0x00ffffff;
export const GPU_MATERIAL_SHADING_MAX_COMPRESSED_BANKS = 4;
export const GPU_MATERIAL_SHADING_LEGACY_BANK_COUNT = 2;

export const STANDARD_PBR_FEATURE = Object.freeze({
  AlbedoTexture: 1 << 0,
  NormalTexture: 1 << 1,
  OrmTexture: 1 << 2,
  EmissiveTexture: 1 << 3,
  Unlit: 1 << 4,
  Uv1: 1 << 5,
  Uv2: 1 << 6,
  UvTransform: 1 << 7
});

export interface GpuMaterialShadingPackedSource {
  readonly featureKey: number;
  readonly baseColorTextureRef: number;
  readonly normalTextureRef: number;
  readonly ormTextureRef: number;
  readonly emissiveTextureRef: number;
}

export const GPU_MATERIAL_SHADING_RECORD_WGSL = /* wgsl */ `
struct OEngineMaterialShadingRecord {
  feature_key: u32,
  base_color_texture_ref: u32,
  normal_texture_ref: u32,
  orm_texture_ref: u32,
  emissive_texture_ref: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

const OENGINE_STANDARD_PBR_ALBEDO_TEXTURE: u32 = ${STANDARD_PBR_FEATURE.AlbedoTexture}u;
const OENGINE_STANDARD_PBR_NORMAL_TEXTURE: u32 = ${STANDARD_PBR_FEATURE.NormalTexture}u;
const OENGINE_STANDARD_PBR_ORM_TEXTURE: u32 = ${STANDARD_PBR_FEATURE.OrmTexture}u;
const OENGINE_STANDARD_PBR_EMISSIVE_TEXTURE: u32 = ${STANDARD_PBR_FEATURE.EmissiveTexture}u;
const OENGINE_STANDARD_PBR_UNLIT: u32 = ${STANDARD_PBR_FEATURE.Unlit}u;
const OENGINE_MATERIAL_SHADING_INVALID_TEXTURE: u32 = 0xffffffffu;
const OENGINE_MATERIAL_SHADING_BANK_SHIFT: u32 = ${GPU_MATERIAL_SHADING_BANK_SHIFT}u;
const OENGINE_MATERIAL_SHADING_LAYER_MASK: u32 = 0x00ffffffu;
`;

export function encodeGpuMaterialShadingTextureRef(bank: number, layer: number): number {
  if (!Number.isInteger(bank) || bank < 0 || bank > 15) {
    throw new RangeError(`Material texture bank ${bank} is outside 0..15`);
  }
  if (!Number.isInteger(layer) || layer < 0 || layer > GPU_MATERIAL_SHADING_LAYER_MASK) {
    throw new RangeError(`Material texture layer ${layer} is outside the shading ABI`);
  }
  return ((bank << GPU_MATERIAL_SHADING_BANK_SHIFT) | layer) >>> 0;
}

export function packGpuMaterialShadingRecord(
  source: GpuMaterialShadingPackedSource
): Uint8Array {
  const bytes = new Uint8Array(GPU_MATERIAL_SHADING_RECORD_STRIDE);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, source.featureKey >>> 0, true);
  view.setUint32(4, source.baseColorTextureRef >>> 0, true);
  view.setUint32(8, source.normalTextureRef >>> 0, true);
  view.setUint32(12, source.ormTextureRef >>> 0, true);
  view.setUint32(16, source.emissiveTextureRef >>> 0, true);
  return bytes;
}

export function standardPbrFeatureKey(
  material: StandardShadeMaterial,
  available: Readonly<{
    albedo: boolean;
    normal: boolean;
    orm: boolean;
    emissive: boolean;
  }>
): number {
  let key = 0;
  if (available.albedo) key |= STANDARD_PBR_FEATURE.AlbedoTexture;
  if (!material.is_unlit && available.normal) key |= STANDARD_PBR_FEATURE.NormalTexture;
  if (!material.is_unlit && available.orm) key |= STANDARD_PBR_FEATURE.OrmTexture;
  if (!material.is_unlit && available.emissive) key |= STANDARD_PBR_FEATURE.EmissiveTexture;
  if (material.is_unlit) key |= STANDARD_PBR_FEATURE.Unlit;
  const uvSets = [
    available.albedo ? material.base_color_uv_set : 0,
    available.normal ? material.normal_uv_set : 0,
    available.orm ? material.orm_uv_set : 0,
    available.emissive ? material.emissive_uv_set : 0
  ];
  if (uvSets.includes(1)) key |= STANDARD_PBR_FEATURE.Uv1;
  if (uvSets.includes(2)) key |= STANDARD_PBR_FEATURE.Uv2;
  if (
    hasTransform(material.base_color_uv_offset, material.base_color_uv_scale, material.base_color_uv_rotation) ||
    hasTransform(material.normal_uv_offset, material.normal_uv_scale, material.normal_uv_rotation) ||
    hasTransform(material.orm_uv_offset, material.orm_uv_scale, material.orm_uv_rotation) ||
    hasTransform(material.emissive_uv_offset, material.emissive_uv_scale, material.emissive_uv_rotation)
  ) {
    key |= STANDARD_PBR_FEATURE.UvTransform;
  }
  return key >>> 0;
}

function hasTransform(
  offset: readonly [number, number],
  scale: readonly [number, number],
  rotation: number
): boolean {
  return offset[0] !== 0 || offset[1] !== 0 ||
    scale[0] !== 1 || scale[1] !== 1 || rotation !== 0;
}

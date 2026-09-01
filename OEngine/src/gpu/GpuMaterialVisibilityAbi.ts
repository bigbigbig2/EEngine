import { ShadeDrawSide, ShadeTransparencyMode } from "../material/enums.js";
import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";

export const GPU_MATERIAL_VISIBILITY_ABI_VERSION = 3;
export const GPU_MATERIAL_VISIBILITY_RECORD_STRIDE = 224;
export const GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE = 0xffffffff;
export const GPU_MATERIAL_VISIBILITY_HIGH_RESOLUTION_BIT = 0x80000000;

export const GPU_MATERIAL_VISIBILITY_ALPHA_MODE = Object.freeze({
  Opaque: 0,
  Mask: 1,
  Blend: 2
});

export const GPU_MATERIAL_VISIBILITY_FLAGS = Object.freeze({
  Valid: 1 << 0,
  DoubleSided: 1 << 1,
  HasAlphaTexture: 1 << 2,
  TextureFallback: 1 << 3,
  SamplerFallback: 1 << 4,
  HasNormalTexture: 1 << 5,
  HasOrmTexture: 1 << 6,
  HasEmissiveTexture: 1 << 7,
  Unlit: 1 << 8
});

export const GPU_MATERIAL_VISIBILITY_ADDRESS_MODE = Object.freeze({
  Clamp: 0,
  Repeat: 1,
  MirrorRepeat: 2
});

export const GPU_MATERIAL_VISIBILITY_SAMPLER = Object.freeze({
  AddressUBits: 0,
  AddressVBits: 2,
  AddressMask: 0x3,
  LinearBit: 1 << 4,
  Fallback: (1 << 4) | (1 << 2) | 1
});

export const GPU_MATERIAL_VISIBILITY_OFFSETS = Object.freeze({
  material_id: 0,
  alpha_mode: 4,
  flags: 8,
  texture_ref: 12,
  base_color_factor_alpha: 16,
  alpha_cutoff: 20,
  texture_uv_sets: 24,
  sampler_class: 28,
  uv_offset_scale: 32,
  uv_rotation: 48,
  base_color_factor: 64,
  pbr_factors: 80,
  emissive_factor: 96,
  texture_refs: 112,
  normal_uv_offset_scale: 128,
  normal_uv_rotation: 144,
  orm_uv_offset_scale: 160,
  orm_uv_rotation: 176,
  emissive_uv_offset_scale: 192,
  emissive_uv_rotation: 208
});

export interface GpuMaterialVisibilityPackedSource {
  readonly materialId: number;
  readonly alphaMode: number;
  readonly flags: number;
  readonly textureRef: number;
  readonly baseColorFactorAlpha: number;
  readonly alphaCutoff: number;
  readonly textureUvSets: number;
  readonly samplerClass: number;
  readonly uvOffset: ArrayLike<number>;
  readonly uvScale: ArrayLike<number>;
  readonly rotationCos: number;
  readonly rotationSin: number;
  readonly baseColorFactor: ArrayLike<number>;
  readonly metallicFactor: number;
  readonly perceptualRoughness: number;
  readonly normalScale: number;
  readonly occlusionStrength: number;
  readonly emissiveFactor: ArrayLike<number>;
  readonly normalTextureRef: number;
  readonly ormTextureRef: number;
  readonly emissiveTextureRef: number;
  readonly textureSamplerClasses: number;
  readonly normalUvOffset: ArrayLike<number>;
  readonly normalUvScale: ArrayLike<number>;
  readonly normalRotationCos: number;
  readonly normalRotationSin: number;
  readonly ormUvOffset: ArrayLike<number>;
  readonly ormUvScale: ArrayLike<number>;
  readonly ormRotationCos: number;
  readonly ormRotationSin: number;
  readonly emissiveUvOffset: ArrayLike<number>;
  readonly emissiveUvScale: ArrayLike<number>;
  readonly emissiveRotationCos: number;
  readonly emissiveRotationSin: number;
}

export interface GpuMaterialVisibilitySource {
  readonly packed: GpuMaterialVisibilityPackedSource;
  readonly texture: ShadeTexture | null;
  readonly textures: readonly ShadeTexture[];
  readonly textureFallback: boolean;
  readonly samplerFallback: boolean;
}

export const GPU_MATERIAL_VISIBILITY_RECORD_WGSL = /* wgsl */ `
struct OEngineMaterialVisibilityRecord {
  material_id: u32,
  alpha_mode: u32,
  flags: u32,
  texture_ref: u32,
  base_color_factor_alpha: f32,
  alpha_cutoff: f32,
  texture_uv_sets: u32,
  sampler_class: u32,
  uv_offset_scale: vec4f,
  uv_rotation: vec4f,
  base_color_factor: vec4f,
  pbr_factors: vec4f,
  emissive_factor: vec4f,
  normal_texture_ref: u32,
  orm_texture_ref: u32,
  emissive_texture_ref: u32,
  texture_sampler_classes: u32,
  normal_uv_offset_scale: vec4f,
  normal_uv_rotation: vec4f,
  orm_uv_offset_scale: vec4f,
  orm_uv_rotation: vec4f,
  emissive_uv_offset_scale: vec4f,
  emissive_uv_rotation: vec4f,
};

const OENGINE_MATERIAL_ALPHA_OPAQUE: u32 = ${GPU_MATERIAL_VISIBILITY_ALPHA_MODE.Opaque}u;
const OENGINE_MATERIAL_ALPHA_MASK: u32 = ${GPU_MATERIAL_VISIBILITY_ALPHA_MODE.Mask}u;
const OENGINE_MATERIAL_ALPHA_BLEND: u32 = ${GPU_MATERIAL_VISIBILITY_ALPHA_MODE.Blend}u;
const OENGINE_MATERIAL_VISIBILITY_VALID: u32 = ${GPU_MATERIAL_VISIBILITY_FLAGS.Valid}u;
const OENGINE_MATERIAL_VISIBILITY_DOUBLE_SIDED: u32 = ${GPU_MATERIAL_VISIBILITY_FLAGS.DoubleSided}u;
const OENGINE_MATERIAL_VISIBILITY_HAS_ALPHA_TEXTURE: u32 = ${GPU_MATERIAL_VISIBILITY_FLAGS.HasAlphaTexture}u;
const OENGINE_MATERIAL_HAS_NORMAL_TEXTURE: u32 = ${GPU_MATERIAL_VISIBILITY_FLAGS.HasNormalTexture}u;
const OENGINE_MATERIAL_HAS_ORM_TEXTURE: u32 = ${GPU_MATERIAL_VISIBILITY_FLAGS.HasOrmTexture}u;
const OENGINE_MATERIAL_HAS_EMISSIVE_TEXTURE: u32 = ${GPU_MATERIAL_VISIBILITY_FLAGS.HasEmissiveTexture}u;
const OENGINE_MATERIAL_UNLIT: u32 = ${GPU_MATERIAL_VISIBILITY_FLAGS.Unlit}u;
const OENGINE_MATERIAL_VISIBILITY_INVALID_TEXTURE: u32 = 0xffffffffu;
const OENGINE_MATERIAL_HIGH_RESOLUTION_BIT: u32 = 0x80000000u;
const OENGINE_MATERIAL_TEXTURE_LAYER_MASK: u32 = 0x7fffffffu;
const OENGINE_MATERIAL_SAMPLER_ADDRESS_MASK: u32 = ${GPU_MATERIAL_VISIBILITY_SAMPLER.AddressMask}u;
const OENGINE_MATERIAL_SAMPLER_ADDRESS_V_BITS: u32 = ${GPU_MATERIAL_VISIBILITY_SAMPLER.AddressVBits}u;
const OENGINE_MATERIAL_SAMPLER_LINEAR: u32 = ${GPU_MATERIAL_VISIBILITY_SAMPLER.LinearBit}u;
`;

export function materialVisibilitySource(
  material: StandardShadeMaterial,
  textureRefs: Readonly<{
    baseColor?: number;
    normal?: number;
    orm?: number;
    emissive?: number;
  }> | number,
  materialSlot: number
): GpuMaterialVisibilitySource {
  const refs = typeof textureRefs === "number"
    ? { baseColor: textureRefs }
    : textureRefs;
  const textureRef = refs.baseColor ?? GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE;
  const normalTextureRef = refs.normal ?? GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE;
  const ormTextureRef = refs.orm ?? GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE;
  const emissiveTextureRef = refs.emissive ?? GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE;
  const texture = material.texture_albedo ?? null;
  const normalTexture = material.is_unlit ? undefined : material.texture_normal;
  const ormTexture = material.is_unlit ? undefined : material.texture_orm;
  const emissiveTexture = material.is_unlit ? undefined : material.texture_emissive;
  const requestedTextures = [
    [material.texture_albedo, textureRef],
    [normalTexture, normalTextureRef],
    [ormTexture, ormTextureRef],
    [emissiveTexture, emissiveTextureRef]
  ] as const;
  const baseTextureFallback = texture !== null && (
    !isUsableTexture(texture) || textureRef === GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE
  );
  const textureFallback = requestedTextures.some(([candidate, ref]) =>
    candidate !== undefined && (!isUsableTexture(candidate) || ref === GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE)
  );
  const sampler = encodeSamplerClass(texture);
  const normalSampler = encodeSamplerClass(normalTexture ?? null);
  const ormSampler = encodeSamplerClass(ormTexture ?? null);
  const emissiveSampler = encodeSamplerClass(emissiveTexture ?? null);
  let flags = GPU_MATERIAL_VISIBILITY_FLAGS.Valid;
  if (material.draw_side === ShadeDrawSide.Double) {
    flags |= GPU_MATERIAL_VISIBILITY_FLAGS.DoubleSided;
  }
  if (texture !== null && !baseTextureFallback && textureRef !== GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE) {
    flags |= GPU_MATERIAL_VISIBILITY_FLAGS.HasAlphaTexture;
  }
  if (normalTexture !== undefined && normalTextureRef !== GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE) {
    flags |= GPU_MATERIAL_VISIBILITY_FLAGS.HasNormalTexture;
  }
  if (ormTexture !== undefined && ormTextureRef !== GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE) {
    flags |= GPU_MATERIAL_VISIBILITY_FLAGS.HasOrmTexture;
  }
  if (emissiveTexture !== undefined && emissiveTextureRef !== GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE) {
    flags |= GPU_MATERIAL_VISIBILITY_FLAGS.HasEmissiveTexture;
  }
  if (material.is_unlit) flags |= GPU_MATERIAL_VISIBILITY_FLAGS.Unlit;
  if (textureFallback) flags |= GPU_MATERIAL_VISIBILITY_FLAGS.TextureFallback;
  if (sampler.fallback || normalSampler.fallback || ormSampler.fallback || emissiveSampler.fallback) {
    flags |= GPU_MATERIAL_VISIBILITY_FLAGS.SamplerFallback;
  }
  const baseRotation = finiteOr(material.base_color_uv_rotation, 0);
  const normalRotation = finiteOr(material.normal_uv_rotation, 0);
  const ormRotation = finiteOr(material.orm_uv_rotation, 0);
  const emissiveRotation = finiteOr(material.emissive_uv_rotation, 0);
  const textureUvSets = packTextureUvSets(material);
  return Object.freeze({
    packed: Object.freeze({
      materialId: checkedU32(materialSlot, "resident material slot"),
      alphaMode: alphaMode(material.transparency_mode),
      flags,
      textureRef: checkedU32(textureRef, "texture ref"),
      baseColorFactorAlpha: finiteOr(material.diffuse_color.a, 1),
      alphaCutoff: clamp01(finiteOr(material.alpha_cutoff, 0.5)),
      textureUvSets,
      samplerClass: sampler.value,
      uvOffset: material.base_color_uv_offset,
      uvScale: material.base_color_uv_scale,
      rotationCos: Math.cos(baseRotation),
      rotationSin: Math.sin(baseRotation),
      baseColorFactor: [
        material.diffuse_color.r,
        material.diffuse_color.g,
        material.diffuse_color.b,
        material.diffuse_color.a
      ],
      metallicFactor: clamp01(finiteOr(material.metallic_factor, 0)),
      perceptualRoughness: clamp01(finiteOr(material.roughness_factor, 1)),
      normalScale: finiteOr(material.normal_scale, 1),
      occlusionStrength: clamp01(finiteOr(material.ambient_factors.a, 1)),
      emissiveFactor: [
        material.emissive_factor.r,
        material.emissive_factor.g,
        material.emissive_factor.b,
        1
      ],
      normalTextureRef,
      ormTextureRef,
      emissiveTextureRef,
      textureSamplerClasses:
        (normalSampler.value & 0xff) |
        ((ormSampler.value & 0xff) << 8) |
        ((emissiveSampler.value & 0xff) << 16),
      normalUvOffset: material.normal_uv_offset,
      normalUvScale: material.normal_uv_scale,
      normalRotationCos: Math.cos(normalRotation),
      normalRotationSin: Math.sin(normalRotation),
      ormUvOffset: material.orm_uv_offset,
      ormUvScale: material.orm_uv_scale,
      ormRotationCos: Math.cos(ormRotation),
      ormRotationSin: Math.sin(ormRotation),
      emissiveUvOffset: material.emissive_uv_offset,
      emissiveUvScale: material.emissive_uv_scale,
      emissiveRotationCos: Math.cos(emissiveRotation),
      emissiveRotationSin: Math.sin(emissiveRotation)
    }),
    texture: textureFallback ? null : texture,
    textures: Object.freeze(requestedTextures
      .filter((entry): entry is readonly [ShadeTexture, number] => entry[0] !== undefined)
      .map(([candidate]) => candidate)),
    textureFallback,
    samplerFallback:
      sampler.fallback || normalSampler.fallback || ormSampler.fallback || emissiveSampler.fallback
  });
}

export function packGpuMaterialVisibilityRecord(
  source: GpuMaterialVisibilityPackedSource,
  target: ArrayBuffer = new ArrayBuffer(GPU_MATERIAL_VISIBILITY_RECORD_STRIDE),
  byteOffset = 0
): ArrayBuffer {
  if (
    !Number.isInteger(byteOffset) || byteOffset < 0 ||
    byteOffset + GPU_MATERIAL_VISIBILITY_RECORD_STRIDE > target.byteLength
  ) {
    throw new RangeError("MaterialVisibilityRecord target is too small");
  }
  const view = new DataView(target, byteOffset, GPU_MATERIAL_VISIBILITY_RECORD_STRIDE);
  view.setUint32(0, checkedU32(source.materialId, "material id"), true);
  view.setUint32(4, checkedU32(source.alphaMode, "alpha mode"), true);
  view.setUint32(8, checkedU32(source.flags, "flags"), true);
  view.setUint32(12, checkedU32(source.textureRef, "texture ref"), true);
  view.setFloat32(16, finiteOr(source.baseColorFactorAlpha, 1), true);
  view.setFloat32(20, clamp01(finiteOr(source.alphaCutoff, 0.5)), true);
  view.setUint32(24, checkedU32(source.textureUvSets, "texture UV sets"), true);
  view.setUint32(28, checkedU32(source.samplerClass, "sampler class"), true);
  writeVec2(view, 32, source.uvOffset, [0, 0]);
  writeVec2(view, 40, source.uvScale, [1, 1]);
  view.setFloat32(48, finiteOr(source.rotationCos, 1), true);
  view.setFloat32(52, finiteOr(source.rotationSin, 0), true);
  writeVec4(view, 64, source.baseColorFactor, [1, 1, 1, 1]);
  view.setFloat32(80, clamp01(finiteOr(source.metallicFactor, 0)), true);
  view.setFloat32(84, clamp01(finiteOr(source.perceptualRoughness, 1)), true);
  view.setFloat32(88, finiteOr(source.normalScale, 1), true);
  view.setFloat32(92, clamp01(finiteOr(source.occlusionStrength, 1)), true);
  writeVec4(view, 96, source.emissiveFactor, [0, 0, 0, 1]);
  view.setUint32(112, checkedU32(source.normalTextureRef, "normal texture ref"), true);
  view.setUint32(116, checkedU32(source.ormTextureRef, "ORM texture ref"), true);
  view.setUint32(120, checkedU32(source.emissiveTextureRef, "emissive texture ref"), true);
  view.setUint32(124, checkedU32(source.textureSamplerClasses, "texture sampler classes"), true);
  writeUvTransform(view, 128, source.normalUvOffset, source.normalUvScale,
    source.normalRotationCos, source.normalRotationSin);
  writeUvTransform(view, 160, source.ormUvOffset, source.ormUvScale,
    source.ormRotationCos, source.ormRotationSin);
  writeUvTransform(view, 192, source.emissiveUvOffset, source.emissiveUvScale,
    source.emissiveRotationCos, source.emissiveRotationSin);
  return target;
}

function packTextureUvSets(material: StandardShadeMaterial): number {
  const sets = [
    material.base_color_uv_set,
    material.normal_uv_set,
    material.orm_uv_set,
    material.emissive_uv_set
  ];
  let packed = 0;
  for (let index = 0; index < sets.length; index++) {
    const set = sets[index]!;
    if (!Number.isInteger(set) || set < 0 || set > 2) {
      throw new RangeError(
        `Material '${material.name}' requests TEXCOORD_${set}; ` +
        "MaterialRecord v3 supports TEXCOORD_0, TEXCOORD_1 and TEXCOORD_2"
      );
    }
    packed |= (set & 0xff) << (index * 8);
  }
  return packed >>> 0;
}

function writeUvTransform(
  view: DataView,
  byteOffset: number,
  offset: ArrayLike<number>,
  scale: ArrayLike<number>,
  rotationCos: number,
  rotationSin: number
): void {
  writeVec2(view, byteOffset, offset, [0, 0]);
  writeVec2(view, byteOffset + 8, scale, [1, 1]);
  view.setFloat32(byteOffset + 16, finiteOr(rotationCos, 1), true);
  view.setFloat32(byteOffset + 20, finiteOr(rotationSin, 0), true);
}

function alphaMode(mode: number): number {
  if (mode === ShadeTransparencyMode.AlphaTested) {
    return GPU_MATERIAL_VISIBILITY_ALPHA_MODE.Mask;
  }
  if (mode === ShadeTransparencyMode.Transparent) {
    return GPU_MATERIAL_VISIBILITY_ALPHA_MODE.Blend;
  }
  return GPU_MATERIAL_VISIBILITY_ALPHA_MODE.Opaque;
}

function encodeSamplerClass(texture: ShadeTexture | null): {
  readonly value: number;
  readonly fallback: boolean;
} {
  if (texture === null) {
    return { value: GPU_MATERIAL_VISIBILITY_SAMPLER.Fallback, fallback: false };
  }
  const u = addressMode(texture.wrapS);
  const v = addressMode(texture.wrapT);
  const nearest = texture.magFilter === 0 && texture.minFilter === 0;
  const linear = texture.magFilter === 1 && texture.minFilter === 1;
  const fallback = u === null || v === null || u !== v || (!nearest && !linear);
  if (fallback) {
    return { value: GPU_MATERIAL_VISIBILITY_SAMPLER.Fallback, fallback: true };
  }
  return {
    value: u | (v << GPU_MATERIAL_VISIBILITY_SAMPLER.AddressVBits) |
      (linear ? GPU_MATERIAL_VISIBILITY_SAMPLER.LinearBit : 0),
    fallback: false
  };
}

function addressMode(value: number): number | null {
  if (value === 0) return GPU_MATERIAL_VISIBILITY_ADDRESS_MODE.Clamp;
  if (value === 1) return GPU_MATERIAL_VISIBILITY_ADDRESS_MODE.Repeat;
  if (value === 2) return GPU_MATERIAL_VISIBILITY_ADDRESS_MODE.MirrorRepeat;
  return null;
}

function isUsableTexture(texture: ShadeTexture): boolean {
  const image = texture.image;
  return image !== undefined && image.width > 0 && image.height > 0 && image.depth <= 1;
}

function writeVec2(
  view: DataView,
  byteOffset: number,
  values: ArrayLike<number>,
  fallback: readonly [number, number]
): void {
  view.setFloat32(byteOffset, finiteOr(values[0], fallback[0]), true);
  view.setFloat32(byteOffset + 4, finiteOr(values[1], fallback[1]), true);
}

function writeVec4(
  view: DataView,
  byteOffset: number,
  values: ArrayLike<number>,
  fallback: readonly [number, number, number, number]
): void {
  for (let index = 0; index < 4; index++) {
    view.setFloat32(
      byteOffset + index * 4,
      finiteOr(values[index], fallback[index]!),
      true
    );
  }
}

function finiteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? value! : fallback;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function checkedU32(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`MaterialVisibilityRecord ${label} is outside u32`);
  }
  return value >>> 0;
}

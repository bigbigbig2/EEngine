import { ShadeDrawSide, ShadeTransparencyMode } from "../material/enums.js";
import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";

export const GPU_MATERIAL_VISIBILITY_ABI_VERSION = 1;
export const GPU_MATERIAL_VISIBILITY_RECORD_STRIDE = 64;
export const GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE = 0xffffffff;

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
  SamplerFallback: 1 << 4
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
  uv_set: 24,
  sampler_class: 28,
  uv_offset_scale: 32,
  uv_rotation: 48
});

export interface GpuMaterialVisibilityPackedSource {
  readonly materialId: number;
  readonly alphaMode: number;
  readonly flags: number;
  readonly textureRef: number;
  readonly baseColorFactorAlpha: number;
  readonly alphaCutoff: number;
  readonly uvSet: number;
  readonly samplerClass: number;
  readonly uvOffset: ArrayLike<number>;
  readonly uvScale: ArrayLike<number>;
  readonly rotationCos: number;
  readonly rotationSin: number;
}

export interface GpuMaterialVisibilitySource {
  readonly packed: GpuMaterialVisibilityPackedSource;
  readonly texture: ShadeTexture | null;
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
  uv_set: u32,
  sampler_class: u32,
  uv_offset_scale: vec4f,
  uv_rotation: vec4f,
};

const OENGINE_MATERIAL_ALPHA_OPAQUE: u32 = ${GPU_MATERIAL_VISIBILITY_ALPHA_MODE.Opaque}u;
const OENGINE_MATERIAL_ALPHA_MASK: u32 = ${GPU_MATERIAL_VISIBILITY_ALPHA_MODE.Mask}u;
const OENGINE_MATERIAL_ALPHA_BLEND: u32 = ${GPU_MATERIAL_VISIBILITY_ALPHA_MODE.Blend}u;
const OENGINE_MATERIAL_VISIBILITY_VALID: u32 = ${GPU_MATERIAL_VISIBILITY_FLAGS.Valid}u;
const OENGINE_MATERIAL_VISIBILITY_DOUBLE_SIDED: u32 = ${GPU_MATERIAL_VISIBILITY_FLAGS.DoubleSided}u;
const OENGINE_MATERIAL_VISIBILITY_HAS_ALPHA_TEXTURE: u32 = ${GPU_MATERIAL_VISIBILITY_FLAGS.HasAlphaTexture}u;
const OENGINE_MATERIAL_VISIBILITY_INVALID_TEXTURE: u32 = 0xffffffffu;
const OENGINE_MATERIAL_SAMPLER_ADDRESS_MASK: u32 = ${GPU_MATERIAL_VISIBILITY_SAMPLER.AddressMask}u;
const OENGINE_MATERIAL_SAMPLER_ADDRESS_V_BITS: u32 = ${GPU_MATERIAL_VISIBILITY_SAMPLER.AddressVBits}u;
const OENGINE_MATERIAL_SAMPLER_LINEAR: u32 = ${GPU_MATERIAL_VISIBILITY_SAMPLER.LinearBit}u;
`;

export function materialVisibilitySource(
  material: StandardShadeMaterial,
  textureRef = GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE
): GpuMaterialVisibilitySource {
  const texture = material.texture_albedo ?? null;
  const textureFallback = texture !== null && (
    !isUsableTexture(texture) ||
    textureRef === GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE
  );
  const sampler = encodeSamplerClass(texture);
  let flags = GPU_MATERIAL_VISIBILITY_FLAGS.Valid;
  if (material.draw_side === ShadeDrawSide.Double) {
    flags |= GPU_MATERIAL_VISIBILITY_FLAGS.DoubleSided;
  }
  if (texture !== null && !textureFallback && textureRef !== GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE) {
    flags |= GPU_MATERIAL_VISIBILITY_FLAGS.HasAlphaTexture;
  }
  if (textureFallback) flags |= GPU_MATERIAL_VISIBILITY_FLAGS.TextureFallback;
  if (sampler.fallback) flags |= GPU_MATERIAL_VISIBILITY_FLAGS.SamplerFallback;
  const rotation = finiteOr(material.base_color_uv_rotation, 0);
  return Object.freeze({
    packed: Object.freeze({
      materialId: checkedU32(material.id, "material id"),
      alphaMode: alphaMode(material.transparency_mode),
      flags,
      textureRef: checkedU32(textureRef, "texture ref"),
      baseColorFactorAlpha: finiteOr(material.diffuse_color.a, 1),
      alphaCutoff: clamp01(finiteOr(material.alpha_cutoff, 0.5)),
      uvSet: checkedU32(material.base_color_uv_set, "base color UV set"),
      samplerClass: sampler.value,
      uvOffset: material.base_color_uv_offset,
      uvScale: material.base_color_uv_scale,
      rotationCos: Math.cos(rotation),
      rotationSin: Math.sin(rotation)
    }),
    texture: textureFallback ? null : texture,
    textureFallback,
    samplerFallback: sampler.fallback
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
  view.setUint32(24, checkedU32(source.uvSet, "UV set"), true);
  view.setUint32(28, checkedU32(source.samplerClass, "sampler class"), true);
  writeVec2(view, 32, source.uvOffset, [0, 0]);
  writeVec2(view, 40, source.uvScale, [1, 1]);
  view.setFloat32(48, finiteOr(source.rotationCos, 1), true);
  view.setFloat32(52, finiteOr(source.rotationSin, 0), true);
  return target;
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
  const fallback = u === null || v === null || (!nearest && !linear);
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

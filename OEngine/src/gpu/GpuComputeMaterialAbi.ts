/** ADR-0009 Step 3 compact material working-set / SurfaceLite ABI. */
export const GPU_COMPUTE_MATERIAL_ABI_VERSION = 2;

/**
 * Four storage textures stay on the portable maxStorageTexturesPerShaderStage
 * floor. `material` is rg32uint and stores:
 * x = metallic UNORM8 | roughness UNORM8 << 8 | Surface flags << 16
 * y = RGB9E5 emissive/unlit radiance
 *
 * Material slot identity is recovered from VisibilityKey -> MeshletWork when
 * a debug consumer requests it; it is not duplicated per pixel.
 */
export const GPU_COMPUTE_MATERIAL_FORMATS = Object.freeze({
  normal: "rgba16uint",
  albedoAo: "rgba8unorm",
  material: "rg32uint",
  velocity: "rg16float"
} as const);

export interface GpuShadingSurfaceNormalEncoding {
  readonly format: "rgba16uint";
  readonly maxValue: 65535;
}

export const GPU_SHADING_SURFACE_NORMAL_OVERRIDE_NAME =
  "OENGINE_SURFACE_NORMAL_MAX_VALUE" as const;

export const GPU_SHADING_SURFACE_NORMAL_ENCODING: GpuShadingSurfaceNormalEncoding =
  Object.freeze({
    format: GPU_COMPUTE_MATERIAL_FORMATS.normal,
    maxValue: 65535
  });

/** WGSL declaration shared by compact ShadingSurfaceLite normal consumers. */
export const GPU_SHADING_SURFACE_NORMAL_WGSL = /* wgsl */ `
override ${GPU_SHADING_SURFACE_NORMAL_OVERRIDE_NAME}: f32 = ${GPU_SHADING_SURFACE_NORMAL_ENCODING.maxValue}.0;
`;

export function gpuShadingSurfaceNormalPipelineConstants(
  encoding: GpuShadingSurfaceNormalEncoding = GPU_SHADING_SURFACE_NORMAL_ENCODING
): Readonly<Record<typeof GPU_SHADING_SURFACE_NORMAL_OVERRIDE_NAME, number>> {
  if (encoding.maxValue !== 65535) {
    throw new RangeError("Unsupported ShadingSurfaceLite normal encoding max value");
  }
  return Object.freeze({
    [GPU_SHADING_SURFACE_NORMAL_OVERRIDE_NAME]: encoding.maxValue
  }) as Readonly<Record<typeof GPU_SHADING_SURFACE_NORMAL_OVERRIDE_NAME, number>>;
}

export const GPU_SHADING_SURFACE_FLAGS = Object.freeze({
  Valid: 1 << 0,
  MotionValid: 1 << 1,
  Reactive: 1 << 2,
  GradientFallback: 1 << 3,
  NormalTexture: 1 << 4,
  OrmTexture: 1 << 5,
  EmissiveTexture: 1 << 6,
  Unlit: 1 << 7
} as const);

export const GPU_SHADING_SURFACE_DEFINED_FLAGS_MASK = 0x00ff;
export const GPU_SHADING_SURFACE_FLAGS_SHIFT = 16;
export const GPU_SHADING_SURFACE_PACKED_FLAGS_MASK = 0xffff0000;

/**
 * Shared compact flag/normal helpers. This is deliberately not a declaration
 * of the deleted Surface V1 attachment set: material identity comes from
 * VisibilityKey -> MeshletWork and velocity is a conditional companion.
 */
export const GPU_SHADING_SURFACE_LITE_WGSL = /* wgsl */ `
const OENGINE_SURFACE_FLAGS_SHIFT: u32 = ${GPU_SHADING_SURFACE_FLAGS_SHIFT}u;
const OENGINE_SURFACE_DEFINED_FLAGS_MASK: u32 = ${GPU_SHADING_SURFACE_DEFINED_FLAGS_MASK}u;
const OENGINE_SURFACE_PACKED_FLAGS_MASK: u32 = ${GPU_SHADING_SURFACE_PACKED_FLAGS_MASK}u;

const OENGINE_SURFACE_FLAG_VALID: u32 = ${GPU_SHADING_SURFACE_FLAGS.Valid}u;
const OENGINE_SURFACE_FLAG_MOTION_VALID: u32 = ${GPU_SHADING_SURFACE_FLAGS.MotionValid}u;
const OENGINE_SURFACE_FLAG_REACTIVE: u32 = ${GPU_SHADING_SURFACE_FLAGS.Reactive}u;
const OENGINE_SURFACE_FLAG_GRADIENT_FALLBACK: u32 = ${GPU_SHADING_SURFACE_FLAGS.GradientFallback}u;
const OENGINE_SURFACE_FLAG_NORMAL_TEXTURE: u32 = ${GPU_SHADING_SURFACE_FLAGS.NormalTexture}u;
const OENGINE_SURFACE_FLAG_ORM_TEXTURE: u32 = ${GPU_SHADING_SURFACE_FLAGS.OrmTexture}u;
const OENGINE_SURFACE_FLAG_EMISSIVE_TEXTURE: u32 = ${GPU_SHADING_SURFACE_FLAGS.EmissiveTexture}u;
const OENGINE_SURFACE_FLAG_UNLIT: u32 = ${GPU_SHADING_SURFACE_FLAGS.Unlit}u;

fn oengine_surface_flags(packed: u32) -> u32 {
  return (packed >> OENGINE_SURFACE_FLAGS_SHIFT) &
    OENGINE_SURFACE_DEFINED_FLAGS_MASK;
}

fn oengine_surface_has_flag(packed: u32, flag: u32) -> bool {
  return (oengine_surface_flags(packed) & flag) != 0u;
}
`;

export const GPU_COMPUTE_MATERIAL_BYTES_PER_PIXEL_WITHOUT_VELOCITY = 20;
export const GPU_COMPUTE_MATERIAL_BYTES_PER_PIXEL = 24;

export function gpuComputeMaterialBytesPerPixel(
  options: Readonly<{ velocity: boolean }>
): number {
  return options.velocity
    ? GPU_COMPUTE_MATERIAL_BYTES_PER_PIXEL
    : GPU_COMPUTE_MATERIAL_BYTES_PER_PIXEL_WITHOUT_VELOCITY;
}

export interface GpuShadingSurfaceLiteProfile {
  readonly version: number;
  readonly normalEncoding: GpuShadingSurfaceNormalEncoding;
  readonly bytesPerPixelWithVelocity: number;
  readonly bytesPerPixelWithoutVelocity: number;
}

/** The sole production compact ShadingSurfaceLite physical profile. */
export const GPU_SHADING_SURFACE_LITE_PROFILE: GpuShadingSurfaceLiteProfile =
  Object.freeze({
    version: GPU_COMPUTE_MATERIAL_ABI_VERSION,
    normalEncoding: GPU_SHADING_SURFACE_NORMAL_ENCODING,
    bytesPerPixelWithVelocity: GPU_COMPUTE_MATERIAL_BYTES_PER_PIXEL,
    bytesPerPixelWithoutVelocity:
      GPU_COMPUTE_MATERIAL_BYTES_PER_PIXEL_WITHOUT_VELOCITY
  });

export const GPU_COMPUTE_MATERIAL_PACKED_CHANNELS = Object.freeze({
  pbrFlags: 0,
  emissive: 1
} as const);

export function packComputeMaterialPbr(
  metallic: number,
  roughness: number
): number {
  return packUnorm8(metallic) | (packUnorm8(roughness) << 8);
}

export function unpackComputeMaterialPbr(
  packed: number
): readonly [number, number] {
  if (!Number.isInteger(packed) || packed < 0 || packed > 0xffff) {
    throw new RangeError("Packed SurfaceLite PBR must be a u16");
  }
  return Object.freeze([
    (packed & 0xff) / 0xff,
    ((packed >>> 8) & 0xff) / 0xff
  ] as const);
}

export const GPU_COMPUTE_MATERIAL_ABI_WGSL = /* wgsl */ `
const OENGINE_SURFACE_LITE_ABI_VERSION: u32 = ${GPU_COMPUTE_MATERIAL_ABI_VERSION}u;

fn oengine_surface_lite_pack_material(
  metallic: f32,
  roughness: f32,
  flags: u32
) -> u32 {
  let m = u32(round(clamp(metallic, 0.0, 1.0) * 255.0));
  let r = u32(round(clamp(roughness, 0.0, 1.0) * 255.0));
  return m | (r << 8u) |
    ((flags & OENGINE_SURFACE_DEFINED_FLAGS_MASK) << OENGINE_SURFACE_FLAGS_SHIFT);
}

fn oengine_surface_lite_metallic(value: vec4u) -> f32 {
  return f32(value.x & 0xffu) / 255.0;
}

fn oengine_surface_lite_roughness(value: vec4u) -> f32 {
  return f32((value.x >> 8u) & 0xffu) / 255.0;
}

fn oengine_surface_lite_flags(value: vec4u) -> u32 {
  return (value.x >> OENGINE_SURFACE_FLAGS_SHIFT) &
    OENGINE_SURFACE_DEFINED_FLAGS_MASK;
}

fn oengine_surface_lite_metadata(value: vec4u) -> u32 {
  return value.x & OENGINE_SURFACE_PACKED_FLAGS_MASK;
}
`;

function packUnorm8(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError("UNORM8 input must be finite");
  return Math.round(Math.min(1, Math.max(0, value)) * 0xff) & 0xff;
}

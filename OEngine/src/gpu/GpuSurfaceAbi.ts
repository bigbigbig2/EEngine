/**
 * R5-00 resolved Surface ABI.
 *
 * This is the single source of truth for resolved Surface formats, metadata
 * packing and velocity semantics used by Packed Resolve and downstream passes.
 * The metadata attachment stays r32uint / 4 B per pixel.
 */

export const GPU_SURFACE_ABI_VERSION = 1;

export const GPU_SURFACE_FORMATS = Object.freeze({
  depth: "depth32float",
  pbr: "rg8unorm",
  normal: "rgba16uint",
  albedoAo: "rgba8unorm",
  emissive: "r32uint",
  velocity: "rg16float",
  metadata: "r32uint",
  hdrColor: "rgba16float"
} as const);

export const GPU_SURFACE_DEPTH_CONVENTION = Object.freeze({
  reverseZ: true,
  empty: 0
} as const);

export const GPU_SURFACE_CHANNEL_SEMANTICS = Object.freeze({
  pbr: Object.freeze({
    r: "metallic",
    g: "perceptual-roughness"
  } as const),
  normal: Object.freeze({
    xy: "encoded-shading-normal",
    zw: "encoded-geometric-normal"
  } as const),
  albedoAo: Object.freeze({
    rgb: "working-linear-base-color",
    a: "ambient-occlusion"
  } as const),
  emissive: "rgb9e5-linear-scene-referred"
} as const);

export const GPU_SURFACE_ATTACHMENT_BYTES = Object.freeze({
  pbr: 2,
  normal: 8,
  albedoAo: 4,
  emissive: 4,
  velocity: 4,
  metadata: 4
} as const);

/** Resolved color Surface only; depth is owned separately by Visibility. */
export const GPU_SURFACE_BYTES_PER_PIXEL =
  GPU_SURFACE_ATTACHMENT_BYTES.pbr +
  GPU_SURFACE_ATTACHMENT_BYTES.normal +
  GPU_SURFACE_ATTACHMENT_BYTES.albedoAo +
  GPU_SURFACE_ATTACHMENT_BYTES.emissive +
  GPU_SURFACE_ATTACHMENT_BYTES.velocity +
  GPU_SURFACE_ATTACHMENT_BYTES.metadata;

export const GPU_SURFACE_MATERIAL_SLOT_BITS = 16;
export const GPU_SURFACE_MATERIAL_SLOT_SHIFT = 0;
export const GPU_SURFACE_MATERIAL_SLOT_MASK = 0x0000ffff;
export const GPU_SURFACE_MAX_MATERIAL_SLOT = 0x0000ffff;

export const GPU_SURFACE_FLAGS_BITS = 16;
export const GPU_SURFACE_FLAGS_SHIFT = 16;
export const GPU_SURFACE_FLAGS_VALUE_MASK = 0x0000ffff;
export const GPU_SURFACE_PACKED_FLAGS_MASK = 0xffff0000;

export const GPU_SURFACE_FLAGS = Object.freeze({
  Valid: 1 << 0,
  MotionValid: 1 << 1,
  Reactive: 1 << 2,
  GradientFallback: 1 << 3,
  NormalTexture: 1 << 4,
  OrmTexture: 1 << 5,
  EmissiveTexture: 1 << 6,
  Unlit: 1 << 7
} as const);

export const GPU_SURFACE_DEFINED_FLAGS_MASK = 0x00ff;
export const GPU_SURFACE_RESERVED_FLAGS_MASK = 0xff00;
export const GPU_SURFACE_EMPTY_METADATA = 0;

export const GPU_SURFACE_VELOCITY_CONVENTION = Object.freeze({
  space: "internal-pixel",
  direction: "current-minus-previous",
  jitter: "projection-matrix-inclusive",
  invalidVelocity: Object.freeze([0, 0] as const),
  invalidMotionValid: false,
  invalidReactive: true
} as const);

export interface GpuSurfaceMetadata {
  readonly materialSlot: number;
  readonly flags: number;
}

export const GPU_SURFACE_ABI_SCHEMA = Object.freeze({
  name: "OEngineSurfaceV1",
  version: GPU_SURFACE_ABI_VERSION,
  formats: GPU_SURFACE_FORMATS,
  depth: GPU_SURFACE_DEPTH_CONVENTION,
  channels: GPU_SURFACE_CHANNEL_SEMANTICS,
  bytesPerPixel: GPU_SURFACE_BYTES_PER_PIXEL,
  metadata: Object.freeze({
    format: GPU_SURFACE_FORMATS.metadata,
    materialSlot: Object.freeze({
      bitOffset: GPU_SURFACE_MATERIAL_SLOT_SHIFT,
      bitCount: GPU_SURFACE_MATERIAL_SLOT_BITS,
      mask: GPU_SURFACE_MATERIAL_SLOT_MASK,
      maxValue: GPU_SURFACE_MAX_MATERIAL_SLOT
    }),
    flags: Object.freeze({
      bitOffset: GPU_SURFACE_FLAGS_SHIFT,
      bitCount: GPU_SURFACE_FLAGS_BITS,
      valueMask: GPU_SURFACE_FLAGS_VALUE_MASK,
      packedMask: GPU_SURFACE_PACKED_FLAGS_MASK,
      definedMask: GPU_SURFACE_DEFINED_FLAGS_MASK,
      reservedMask: GPU_SURFACE_RESERVED_FLAGS_MASK
    })
  }),
  velocity: GPU_SURFACE_VELOCITY_CONVENTION
});

export function packGpuSurfaceMetadata(
  materialSlot: number,
  flags: number
): number {
  assertIntegerInRange(
    materialSlot,
    0,
    GPU_SURFACE_MAX_MATERIAL_SLOT,
    "Surface materialSlot"
  );
  assertIntegerInRange(
    flags,
    0,
    GPU_SURFACE_FLAGS_VALUE_MASK,
    "Surface flags"
  );
  if ((flags & GPU_SURFACE_RESERVED_FLAGS_MASK) !== 0) {
    throw new RangeError("Surface flags must not set reserved v1 bits");
  }
  return (
    (materialSlot & GPU_SURFACE_MATERIAL_SLOT_MASK) |
    ((flags & GPU_SURFACE_FLAGS_VALUE_MASK) << GPU_SURFACE_FLAGS_SHIFT)
  ) >>> 0;
}

export function decodeGpuSurfaceMetadata(packed: number): GpuSurfaceMetadata {
  assertU32(packed, "Surface metadata");
  return Object.freeze({
    materialSlot:
      (packed >>> GPU_SURFACE_MATERIAL_SLOT_SHIFT) &
      GPU_SURFACE_MATERIAL_SLOT_MASK,
    flags:
      (packed >>> GPU_SURFACE_FLAGS_SHIFT) &
      GPU_SURFACE_FLAGS_VALUE_MASK
  });
}

export function gpuSurfaceMetadataHasFlag(
  packed: number,
  flag: number
): boolean {
  assertU32(packed, "Surface metadata");
  assertIntegerInRange(
    flag,
    0,
    GPU_SURFACE_FLAGS_VALUE_MASK,
    "Surface flag"
  );
  return (decodeGpuSurfaceMetadata(packed).flags & flag) !== 0;
}

export const GPU_SURFACE_ABI_WGSL = /* wgsl */ `
const OENGINE_SURFACE_ABI_VERSION: u32 = ${GPU_SURFACE_ABI_VERSION}u;
const OENGINE_SURFACE_MATERIAL_SLOT_BITS: u32 = ${GPU_SURFACE_MATERIAL_SLOT_BITS}u;
const OENGINE_SURFACE_MATERIAL_SLOT_SHIFT: u32 = ${GPU_SURFACE_MATERIAL_SLOT_SHIFT}u;
const OENGINE_SURFACE_MATERIAL_SLOT_MASK: u32 = ${GPU_SURFACE_MATERIAL_SLOT_MASK}u;
const OENGINE_SURFACE_MAX_MATERIAL_SLOT: u32 = ${GPU_SURFACE_MAX_MATERIAL_SLOT}u;
const OENGINE_SURFACE_FLAGS_BITS: u32 = ${GPU_SURFACE_FLAGS_BITS}u;
const OENGINE_SURFACE_FLAGS_SHIFT: u32 = ${GPU_SURFACE_FLAGS_SHIFT}u;
const OENGINE_SURFACE_FLAGS_VALUE_MASK: u32 = ${GPU_SURFACE_FLAGS_VALUE_MASK}u;
const OENGINE_SURFACE_PACKED_FLAGS_MASK: u32 = ${GPU_SURFACE_PACKED_FLAGS_MASK}u;
const OENGINE_SURFACE_DEFINED_FLAGS_MASK: u32 = ${GPU_SURFACE_DEFINED_FLAGS_MASK}u;
const OENGINE_SURFACE_RESERVED_FLAGS_MASK: u32 = ${GPU_SURFACE_RESERVED_FLAGS_MASK}u;
const OENGINE_SURFACE_EMPTY_METADATA: u32 = ${GPU_SURFACE_EMPTY_METADATA}u;

const OENGINE_SURFACE_FLAG_VALID: u32 = ${GPU_SURFACE_FLAGS.Valid}u;
const OENGINE_SURFACE_FLAG_MOTION_VALID: u32 = ${GPU_SURFACE_FLAGS.MotionValid}u;
const OENGINE_SURFACE_FLAG_REACTIVE: u32 = ${GPU_SURFACE_FLAGS.Reactive}u;
const OENGINE_SURFACE_FLAG_GRADIENT_FALLBACK: u32 = ${GPU_SURFACE_FLAGS.GradientFallback}u;
const OENGINE_SURFACE_FLAG_NORMAL_TEXTURE: u32 = ${GPU_SURFACE_FLAGS.NormalTexture}u;
const OENGINE_SURFACE_FLAG_ORM_TEXTURE: u32 = ${GPU_SURFACE_FLAGS.OrmTexture}u;
const OENGINE_SURFACE_FLAG_EMISSIVE_TEXTURE: u32 = ${GPU_SURFACE_FLAGS.EmissiveTexture}u;
const OENGINE_SURFACE_FLAG_UNLIT: u32 = ${GPU_SURFACE_FLAGS.Unlit}u;

fn oengine_surface_material_slot(packed: u32) -> u32 {
  return (packed >> OENGINE_SURFACE_MATERIAL_SLOT_SHIFT) &
    OENGINE_SURFACE_MATERIAL_SLOT_MASK;
}

fn oengine_surface_flags(packed: u32) -> u32 {
  return (packed >> OENGINE_SURFACE_FLAGS_SHIFT) &
    OENGINE_SURFACE_FLAGS_VALUE_MASK;
}

fn oengine_surface_pack(material_slot: u32, flags: u32) -> u32 {
  return
    (material_slot & OENGINE_SURFACE_MATERIAL_SLOT_MASK) |
    ((flags & OENGINE_SURFACE_DEFINED_FLAGS_MASK) << OENGINE_SURFACE_FLAGS_SHIFT);
}

fn oengine_surface_has_flag(packed: u32, flag: u32) -> bool {
  return (oengine_surface_flags(packed) & flag) != 0u;
}
`;

function assertU32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${label} must be a u32`);
  }
}

function assertIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  label: string
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${label} must be an integer in [${minimum}, ${maximum}]`
    );
  }
}

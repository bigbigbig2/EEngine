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

/**
 * M6 candidate only.  This is deliberately not wired into RenderTargets or
 * any pipeline until the identity-bearing parity/bytes/memory gate passes.
 * Keeping the candidate here gives the A/B harness one canonical layout to
 * compare instead of letting each benchmark invent a format contract.
 */
export const GPU_SURFACE_ABI_V2_CANDIDATE_FORMATS = Object.freeze({
  ...GPU_SURFACE_FORMATS,
  normal: "rgba8uint"
} as const);

export interface GpuSurfaceNormalEncoding {
  readonly format: "rgba16uint" | "rgba8uint";
  readonly maxValue: 255 | 65535;
}

export const GPU_SURFACE_NORMAL_OVERRIDE_NAME = "OENGINE_SURFACE_NORMAL_MAX_VALUE" as const;

export const GPU_SURFACE_NORMAL_ENCODING_V1: GpuSurfaceNormalEncoding = Object.freeze({
  format: "rgba16uint",
  maxValue: 65535
});

export const GPU_SURFACE_NORMAL_ENCODING_V2_CANDIDATE: GpuSurfaceNormalEncoding = Object.freeze({
  format: "rgba8uint",
  maxValue: 255
});

/** WGSL declaration shared by Surface-normal consumers; pipeline may override the default. */
export const GPU_SURFACE_NORMAL_ABI_WGSL = /* wgsl */ `
override ${GPU_SURFACE_NORMAL_OVERRIDE_NAME}: f32 = ${GPU_SURFACE_NORMAL_ENCODING_V1.maxValue}.0;
`;

/** Pipeline constants shared by every Surface-normal consumer. */
export function gpuSurfaceNormalPipelineConstants(
  encoding: GpuSurfaceNormalEncoding = GPU_SURFACE_NORMAL_ENCODING_V1
): Readonly<Record<typeof GPU_SURFACE_NORMAL_OVERRIDE_NAME, number>> {
  if (encoding.maxValue !== 255 && encoding.maxValue !== 65535) {
    throw new RangeError("Unsupported Surface normal encoding max value");
  }
  return Object.freeze({
    [GPU_SURFACE_NORMAL_OVERRIDE_NAME]: encoding.maxValue
  }) as Readonly<Record<typeof GPU_SURFACE_NORMAL_OVERRIDE_NAME, number>>;
}

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

/** Candidate layout byte count; GPU_SURFACE_ABI_VERSION remains v1. */
export const GPU_SURFACE_ABI_V2_CANDIDATE_BYTES_PER_PIXEL =
  GPU_SURFACE_BYTES_PER_PIXEL - GPU_SURFACE_ATTACHMENT_BYTES.normal + 4;

export function gpuSurfaceBytesPerPixel(
  options: Readonly<{ velocity: boolean }>
): number {
  return GPU_SURFACE_BYTES_PER_PIXEL -
    (options.velocity ? 0 : GPU_SURFACE_ATTACHMENT_BYTES.velocity);
}

export function gpuSurfaceCandidateBytesPerPixel(
  options: Readonly<{ velocity: boolean }>
): number {
  return GPU_SURFACE_ABI_V2_CANDIDATE_BYTES_PER_PIXEL -
    (options.velocity ? 0 : GPU_SURFACE_ATTACHMENT_BYTES.velocity);
}

export interface GpuSurfaceAbiProfile {
  readonly version: number;
  readonly formats:
    | typeof GPU_SURFACE_FORMATS
    | typeof GPU_SURFACE_ABI_V2_CANDIDATE_FORMATS;
  readonly normalEncoding: GpuSurfaceNormalEncoding;
  readonly bytesPerPixelWithVelocity: number;
  readonly bytesPerPixelWithoutVelocity: number;
  readonly benchmarkOnly: boolean;
}

/** Active production profile; changing this requires the M6 promotion gate. */
export const GPU_SURFACE_ABI_V1_PROFILE: GpuSurfaceAbiProfile = Object.freeze({
  version: GPU_SURFACE_ABI_VERSION,
  formats: GPU_SURFACE_FORMATS,
  normalEncoding: GPU_SURFACE_NORMAL_ENCODING_V1,
  bytesPerPixelWithVelocity: gpuSurfaceBytesPerPixel({ velocity: true }),
  bytesPerPixelWithoutVelocity: gpuSurfaceBytesPerPixel({ velocity: false }),
  benchmarkOnly: false
});

/** Isolated M6 candidate profile; never selected by the production Renderer. */
export const GPU_SURFACE_ABI_V2_CANDIDATE_PROFILE: GpuSurfaceAbiProfile = Object.freeze({
  version: 2,
  formats: GPU_SURFACE_ABI_V2_CANDIDATE_FORMATS,
  normalEncoding: GPU_SURFACE_NORMAL_ENCODING_V2_CANDIDATE,
  bytesPerPixelWithVelocity: gpuSurfaceCandidateBytesPerPixel({ velocity: true }),
  bytesPerPixelWithoutVelocity: gpuSurfaceCandidateBytesPerPixel({ velocity: false }),
  benchmarkOnly: true
});

/** CPU oracle shared by M6 artifact preparation; WGSL must match truncation. */
export function encodeGpuSurfaceNormal(
  normal: readonly [number, number, number],
  encoding: GpuSurfaceNormalEncoding
): readonly [number, number] {
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  if (!Number.isFinite(length) || length <= 0) throw new RangeError("Surface normal must be finite and non-zero");
  const x = normal[0] / length;
  const y = normal[1] / length;
  const z = normal[2] / length;
  const denominator = Math.abs(x) + Math.abs(y) + Math.abs(z);
  let projectedX = x / denominator;
  let projectedY = y / denominator;
  if (z < 0) {
    const foldedX = (1 - Math.abs(projectedY)) * (projectedX < 0 ? -1 : 1);
    const foldedY = (1 - Math.abs(projectedX)) * (projectedY < 0 ? -1 : 1);
    projectedX = foldedX;
    projectedY = foldedY;
  }
  const encodedX = clampUnit(0.5 + 0.5 * projectedX);
  const encodedY = clampUnit(0.5 + 0.5 * projectedY);
  return Object.freeze([
    Math.min(encoding.maxValue, Math.max(0, Math.trunc(encodedX * encoding.maxValue))),
    Math.min(encoding.maxValue, Math.max(0, Math.trunc(encodedY * encoding.maxValue)))
  ] as const);
}

export function decodeGpuSurfaceNormal(
  encoded: readonly [number, number],
  encoding: GpuSurfaceNormalEncoding
): readonly [number, number, number] {
  if (!encoded.every((value) => Number.isInteger(value) && value >= 0 && value <= encoding.maxValue)) {
    throw new RangeError("Encoded Surface normal is outside the selected ABI range");
  }
  const projectedX = encoded[0] / encoding.maxValue * 2 - 1;
  const projectedY = encoded[1] / encoding.maxValue * 2 - 1;
  let x = projectedX;
  let y = projectedY;
  let z = 1 - Math.abs(x) - Math.abs(y);
  const correction = Math.max(-z, 0);
  x += x > 0 ? -correction : correction;
  y += y > 0 ? -correction : correction;
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length <= 0) throw new RangeError("Encoded Surface normal decodes to zero");
  return Object.freeze([x / length, y / length, z / length] as const);
}

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

/** Serializable M6 candidate schema; never used by the v1 runtime producer. */
export const GPU_SURFACE_ABI_V2_CANDIDATE_SCHEMA = Object.freeze({
  ...GPU_SURFACE_ABI_SCHEMA,
  name: "OEngineSurfaceV2Candidate",
  version: GPU_SURFACE_ABI_V2_CANDIDATE_PROFILE.version,
  formats: GPU_SURFACE_ABI_V2_CANDIDATE_PROFILE.formats,
  bytesPerPixel: GPU_SURFACE_ABI_V2_CANDIDATE_PROFILE.bytesPerPixelWithVelocity,
  bytesPerPixelWithVelocity: GPU_SURFACE_ABI_V2_CANDIDATE_PROFILE.bytesPerPixelWithVelocity,
  bytesPerPixelWithoutVelocity: GPU_SURFACE_ABI_V2_CANDIDATE_PROFILE.bytesPerPixelWithoutVelocity,
  normalEncoding: Object.freeze({
    format: GPU_SURFACE_NORMAL_ENCODING_V2_CANDIDATE.format,
    maxValue: GPU_SURFACE_NORMAL_ENCODING_V2_CANDIDATE.maxValue,
    scheme: "octahedral-unorm-trunc" as const
  }),
  promotionGate: Object.freeze({
    activeRuntimeVersion: GPU_SURFACE_ABI_VERSION,
    minimumIndependentRuns: 3,
    requireCorrectnessParity: true,
    requireConversionPassesAdded: 0,
    requireResidentPeakNonIncrease: true,
    requireTransientPeakNonIncrease: true
  })
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

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

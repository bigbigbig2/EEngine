import {
  GPU_RASTER_WORK_SCHEMA,
  GPU_WORK_QUEUE_HEADER_SCHEMA,
  type RasterWorkCpu,
  type VisibleClusterRecordCpu
} from "./GpuWorkGenerationAbi.js";

/** R4 frame-local visibility identity shared by Hardware and Software raster. */
export const GPU_VISIBILITY_KEY_ABI_VERSION = 1;
export const GPU_VISIBILITY_KEY_LOCAL_TRIANGLE_BITS = 7;
export const GPU_VISIBILITY_KEY_LOCAL_TRIANGLE_SHIFT = 0;
export const GPU_VISIBILITY_KEY_LOCAL_TRIANGLE_MASK = 0x0000007f;
export const GPU_VISIBILITY_KEY_MAX_LOCAL_TRIANGLE = 0x7f;
export const GPU_VISIBILITY_KEY_RASTER_WORK_SLOT_BITS = 25;
export const GPU_VISIBILITY_KEY_RASTER_WORK_SLOT_SHIFT = 7;
export const GPU_VISIBILITY_KEY_RASTER_WORK_SLOT_MASK = 0x01ffffff;
export const GPU_VISIBILITY_KEY_RESERVED_RASTER_WORK_SLOT = 0x01ffffff;
export const GPU_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT = 0x01fffffe;
export const GPU_VISIBILITY_KEY_MAX_RASTER_WORK_CAPACITY = 0x01ffffff;
export const GPU_VISIBILITY_KEY_INVALID = 0xffffff80;
export const GPU_VISIBILITY_KEY_EMPTY = 0xffffffff;

export interface GpuVisibilityKeyFieldSchema {
  readonly name: "localTriangle" | "rasterWorkSlot";
  readonly bitOffset: number;
  readonly bitCount: number;
  readonly mask: number;
  readonly maxValue: number;
}

const GPU_VISIBILITY_KEY_FIELDS: readonly GpuVisibilityKeyFieldSchema[] =
  Object.freeze([
    Object.freeze({
      name: "localTriangle" as const,
      bitOffset: GPU_VISIBILITY_KEY_LOCAL_TRIANGLE_SHIFT,
      bitCount: GPU_VISIBILITY_KEY_LOCAL_TRIANGLE_BITS,
      mask: GPU_VISIBILITY_KEY_LOCAL_TRIANGLE_MASK,
      maxValue: GPU_VISIBILITY_KEY_MAX_LOCAL_TRIANGLE
    }),
    Object.freeze({
      name: "rasterWorkSlot" as const,
      bitOffset: GPU_VISIBILITY_KEY_RASTER_WORK_SLOT_SHIFT,
      bitCount: GPU_VISIBILITY_KEY_RASTER_WORK_SLOT_BITS,
      mask: GPU_VISIBILITY_KEY_RASTER_WORK_SLOT_MASK,
      maxValue: GPU_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT
    })
  ]);

export const GPU_VISIBILITY_KEY_SCHEMA = Object.freeze({
  name: "OEngineVisibilityKeyV1",
  version: GPU_VISIBILITY_KEY_ABI_VERSION,
  bitCount: 32,
  fields: GPU_VISIBILITY_KEY_FIELDS,
  invalid: GPU_VISIBILITY_KEY_INVALID,
  empty: GPU_VISIBILITY_KEY_EMPTY,
  reservedRasterWorkSlot: GPU_VISIBILITY_KEY_RESERVED_RASTER_WORK_SLOT,
  maxRasterWorkCapacity: GPU_VISIBILITY_KEY_MAX_RASTER_WORK_CAPACITY
});

export const GPU_VISIBILITY_KEY_WGSL = /* wgsl */ `
const OENGINE_VISIBILITY_KEY_ABI_VERSION: u32 = ${GPU_VISIBILITY_KEY_ABI_VERSION}u;
const OENGINE_VISIBILITY_KEY_LOCAL_TRIANGLE_BITS: u32 = ${GPU_VISIBILITY_KEY_LOCAL_TRIANGLE_BITS}u;
const OENGINE_VISIBILITY_KEY_LOCAL_TRIANGLE_SHIFT: u32 = ${GPU_VISIBILITY_KEY_LOCAL_TRIANGLE_SHIFT}u;
const OENGINE_VISIBILITY_KEY_LOCAL_TRIANGLE_MASK: u32 = ${GPU_VISIBILITY_KEY_LOCAL_TRIANGLE_MASK}u;
const OENGINE_VISIBILITY_KEY_MAX_LOCAL_TRIANGLE: u32 = ${GPU_VISIBILITY_KEY_MAX_LOCAL_TRIANGLE}u;
const OENGINE_VISIBILITY_KEY_RASTER_WORK_SLOT_BITS: u32 = ${GPU_VISIBILITY_KEY_RASTER_WORK_SLOT_BITS}u;
const OENGINE_VISIBILITY_KEY_RASTER_WORK_SLOT_SHIFT: u32 = ${GPU_VISIBILITY_KEY_RASTER_WORK_SLOT_SHIFT}u;
const OENGINE_VISIBILITY_KEY_RASTER_WORK_SLOT_MASK: u32 = ${GPU_VISIBILITY_KEY_RASTER_WORK_SLOT_MASK}u;
const OENGINE_VISIBILITY_KEY_RESERVED_RASTER_WORK_SLOT: u32 = ${GPU_VISIBILITY_KEY_RESERVED_RASTER_WORK_SLOT}u;
const OENGINE_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT: u32 = ${GPU_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT}u;
const OENGINE_VISIBILITY_KEY_MAX_RASTER_WORK_CAPACITY: u32 = ${GPU_VISIBILITY_KEY_MAX_RASTER_WORK_CAPACITY}u;
const OENGINE_VISIBILITY_KEY_INVALID: u32 = ${GPU_VISIBILITY_KEY_INVALID}u;
const OENGINE_VISIBILITY_KEY_EMPTY: u32 = ${GPU_VISIBILITY_KEY_EMPTY}u;

struct OEngineVisibilityKeyEncodeResult {
  key: u32,
  valid: u32,
};

fn oengine_visibility_key_is_empty(key: u32) -> bool {
  return key == OENGINE_VISIBILITY_KEY_EMPTY;
}

fn oengine_visibility_key_raster_work_slot(key: u32) -> u32 {
  return (key >> OENGINE_VISIBILITY_KEY_RASTER_WORK_SLOT_SHIFT) &
    OENGINE_VISIBILITY_KEY_RASTER_WORK_SLOT_MASK;
}

fn oengine_visibility_key_local_triangle(key: u32) -> u32 {
  return (key >> OENGINE_VISIBILITY_KEY_LOCAL_TRIANGLE_SHIFT) &
    OENGINE_VISIBILITY_KEY_LOCAL_TRIANGLE_MASK;
}

fn oengine_visibility_key_is_valid(key: u32) -> bool {
  return !oengine_visibility_key_is_empty(key) &&
    oengine_visibility_key_raster_work_slot(key) !=
      OENGINE_VISIBILITY_KEY_RESERVED_RASTER_WORK_SLOT;
}

fn oengine_visibility_key_can_encode(
  raster_work_slot: u32,
  local_triangle: u32
) -> bool {
  return raster_work_slot <= OENGINE_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT &&
    local_triangle <= OENGINE_VISIBILITY_KEY_MAX_LOCAL_TRIANGLE;
}

fn oengine_visibility_key_try_encode(
  raster_work_slot: u32,
  local_triangle: u32
) -> OEngineVisibilityKeyEncodeResult {
  if (!oengine_visibility_key_can_encode(raster_work_slot, local_triangle)) {
    return OEngineVisibilityKeyEncodeResult(OENGINE_VISIBILITY_KEY_INVALID, 0u);
  }
  return OEngineVisibilityKeyEncodeResult(
    (raster_work_slot << OENGINE_VISIBILITY_KEY_RASTER_WORK_SLOT_SHIFT) |
      (local_triangle << OENGINE_VISIBILITY_KEY_LOCAL_TRIANGLE_SHIFT),
    1u
  );
}
`;

export type VisibilityKeyDecodeResult =
  | Readonly<{ kind: "empty" }>
  | Readonly<{
      kind: "invalid";
      reason: "reserved-raster-work-slot";
      rasterWorkSlot: number;
      localTriangle: number;
    }>
  | Readonly<{
      kind: "valid";
      rasterWorkSlot: number;
      localTriangle: number;
    }>;

export type VisibilityKeyLookupResult =
  | Extract<VisibilityKeyDecodeResult, { kind: "empty" }>
  | Readonly<{
      kind: "invalid";
      reason:
        | "reserved-raster-work-slot"
        | "raster-work-out-of-range"
        | "invalid-raster-work-record"
        | "visible-cluster-out-of-range";
      rasterWorkSlot: number;
      localTriangle: number;
    }>
  | Readonly<{
      kind: "valid";
      rasterWorkSlot: number;
      localTriangle: number;
      rasterWork: RasterWorkCpu;
      visibleCluster: VisibleClusterRecordCpu;
    }>;

export interface GpuVisibilityBufferLimits {
  readonly maxBufferSize: number;
  readonly maxStorageBufferBindingSize: number;
}

export interface GpuVisibilityRasterWorkCapacity {
  readonly keyCapacity: number;
  readonly adapterCapacity: number;
  readonly effectiveCapacity: number;
  readonly effectiveByteLimit: number;
  readonly queueHeaderFits: boolean;
}

export function encodeVisibilityKey(
  rasterWorkSlot: number,
  localTriangle: number
): number {
  assertIntegerInRange(
    rasterWorkSlot,
    0,
    GPU_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT,
    "VisibilityKey rasterWorkSlot"
  );
  assertIntegerInRange(
    localTriangle,
    0,
    GPU_VISIBILITY_KEY_MAX_LOCAL_TRIANGLE,
    "VisibilityKey localTriangle"
  );
  return (
    (rasterWorkSlot << GPU_VISIBILITY_KEY_RASTER_WORK_SLOT_SHIFT) |
    (localTriangle << GPU_VISIBILITY_KEY_LOCAL_TRIANGLE_SHIFT)
  ) >>> 0;
}

export function decodeVisibilityKey(key: number): VisibilityKeyDecodeResult {
  assertU32(key, "VisibilityKey");
  if (key === GPU_VISIBILITY_KEY_EMPTY) {
    return Object.freeze({ kind: "empty" });
  }
  const rasterWorkSlot =
    (key >>> GPU_VISIBILITY_KEY_RASTER_WORK_SLOT_SHIFT) &
    GPU_VISIBILITY_KEY_RASTER_WORK_SLOT_MASK;
  const localTriangle =
    (key >>> GPU_VISIBILITY_KEY_LOCAL_TRIANGLE_SHIFT) &
    GPU_VISIBILITY_KEY_LOCAL_TRIANGLE_MASK;
  if (rasterWorkSlot === GPU_VISIBILITY_KEY_RESERVED_RASTER_WORK_SLOT) {
    return Object.freeze({
      kind: "invalid",
      reason: "reserved-raster-work-slot",
      rasterWorkSlot,
      localTriangle
    });
  }
  return Object.freeze({ kind: "valid", rasterWorkSlot, localTriangle });
}

export function isVisibilityKeyEmpty(key: number): boolean {
  assertU32(key, "VisibilityKey");
  return key === GPU_VISIBILITY_KEY_EMPTY;
}

export function isVisibilityKeyValid(key: number): boolean {
  return decodeVisibilityKey(key).kind === "valid";
}

export function visibilityRasterWorkBufferByteLength(capacity: number): number {
  assertIntegerInRange(
    capacity,
    0,
    GPU_VISIBILITY_KEY_MAX_RASTER_WORK_CAPACITY,
    "Visibility RasterWork capacity"
  );
  return GPU_WORK_QUEUE_HEADER_SCHEMA.stride +
    capacity * GPU_RASTER_WORK_SCHEMA.stride;
}

export function getGpuVisibilityRasterWorkCapacity(
  limits: GpuVisibilityBufferLimits
): Readonly<GpuVisibilityRasterWorkCapacity> {
  assertNonNegativeSafeInteger(limits.maxBufferSize, "maxBufferSize");
  assertNonNegativeSafeInteger(
    limits.maxStorageBufferBindingSize,
    "maxStorageBufferBindingSize"
  );
  const effectiveByteLimit = Math.min(
    limits.maxBufferSize,
    limits.maxStorageBufferBindingSize
  );
  const queueHeaderFits = effectiveByteLimit >= GPU_WORK_QUEUE_HEADER_SCHEMA.stride;
  const adapterCapacity = queueHeaderFits
    ? Math.floor(
        (effectiveByteLimit - GPU_WORK_QUEUE_HEADER_SCHEMA.stride) /
          GPU_RASTER_WORK_SCHEMA.stride
      )
    : 0;
  return Object.freeze({
    keyCapacity: GPU_VISIBILITY_KEY_MAX_RASTER_WORK_CAPACITY,
    adapterCapacity,
    effectiveCapacity: Math.min(
      GPU_VISIBILITY_KEY_MAX_RASTER_WORK_CAPACITY,
      adapterCapacity
    ),
    effectiveByteLimit,
    queueHeaderFits
  });
}

/** Producer-side guard. Failure is explicit; callers must not truncate work. */
export function assertGpuVisibilityRasterWorkCapacity(
  requiredCapacity: number,
  limits: GpuVisibilityBufferLimits
): Readonly<GpuVisibilityRasterWorkCapacity> {
  assertNonNegativeSafeInteger(
    requiredCapacity,
    "Required Visibility RasterWork capacity"
  );
  const capacity = getGpuVisibilityRasterWorkCapacity(limits);
  if (!capacity.queueHeaderFits) {
    throw new RangeError(
      `Visibility RasterWork queue header requires ${GPU_WORK_QUEUE_HEADER_SCHEMA.stride} bytes, ` +
      `but the adapter limit is ${capacity.effectiveByteLimit} bytes`
    );
  }
  if (requiredCapacity > capacity.keyCapacity) {
    throw new RangeError(
      `Required Visibility RasterWork capacity ${requiredCapacity} exceeds ` +
      `VisibilityKey v1 capacity ${capacity.keyCapacity}`
    );
  }
  if (requiredCapacity > capacity.adapterCapacity) {
    throw new RangeError(
      `Required Visibility RasterWork capacity ${requiredCapacity} exceeds ` +
      `adapter capacity ${capacity.adapterCapacity}`
    );
  }
  return capacity;
}

/** CPU oracle for VisibilityKey -> RasterWork -> VisibleCluster lookup. */
export function resolveVisibilityKeyReference(
  key: number,
  rasterWorkRecords: readonly RasterWorkCpu[],
  visibleClusterRecords: readonly VisibleClusterRecordCpu[]
): VisibilityKeyLookupResult {
  const decoded = decodeVisibilityKey(key);
  if (decoded.kind !== "valid") return decoded;

  const rasterWork = rasterWorkRecords[decoded.rasterWorkSlot];
  if (rasterWork === undefined) {
    return invalidLookup(decoded, "raster-work-out-of-range");
  }
  if (
    !isU32(rasterWork.visibleClusterSlot) ||
    !isU32(rasterWork.meshletRecordIndex)
  ) {
    return invalidLookup(decoded, "invalid-raster-work-record");
  }
  const visibleCluster = visibleClusterRecords[rasterWork.visibleClusterSlot];
  if (visibleCluster === undefined) {
    return invalidLookup(decoded, "visible-cluster-out-of-range");
  }
  return Object.freeze({
    kind: "valid",
    rasterWorkSlot: decoded.rasterWorkSlot,
    localTriangle: decoded.localTriangle,
    rasterWork,
    visibleCluster
  });
}

function invalidLookup(
  decoded: Extract<VisibilityKeyDecodeResult, { kind: "valid" }>,
  reason: Extract<VisibilityKeyLookupResult, { kind: "invalid" }>["reason"]
): Extract<VisibilityKeyLookupResult, { kind: "invalid" }> {
  return Object.freeze({
    kind: "invalid",
    reason,
    rasterWorkSlot: decoded.rasterWorkSlot,
    localTriangle: decoded.localTriangle
  });
}

function isU32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function assertU32(value: number, label: string): void {
  if (!isU32(value)) throw new RangeError(`${label} must be a u32`);
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

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

import {
  GPU_CLASSIFIED_RASTER_HEADER_BYTES,
  GPU_RASTER_WORK_SCHEMA,
  type RasterWorkCpu
} from "./GpuWorkGenerationAbi.js";

/** One frame-local key directly addresses one exact-triangle RasterWork. */
export const GPU_VISIBILITY_KEY_ABI_VERSION = 2;
export const GPU_VISIBILITY_KEY_EMPTY = 0xffffffff;
export const GPU_VISIBILITY_KEY_INVALID = 0xfffffffe;
export const GPU_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT = 0xfffffffd;
export const GPU_VISIBILITY_KEY_MAX_RASTER_WORK_CAPACITY = 0xfffffffe;
export const GPU_VISIBILITY_KEY_MAX_CLASS_CAPACITY =
  Math.floor(GPU_VISIBILITY_KEY_MAX_RASTER_WORK_CAPACITY / 2);

export const GPU_VISIBILITY_KEY_SCHEMA = Object.freeze({
  name: "OEngineVisibilityKey",
  version: GPU_VISIBILITY_KEY_ABI_VERSION,
  bitCount: 32,
  fields: Object.freeze([
    Object.freeze({
      name: "rasterWorkSlot" as const,
      bitOffset: 0,
      bitCount: 32,
      mask: 0xffffffff,
      maxValue: GPU_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT
    })
  ]),
  empty: GPU_VISIBILITY_KEY_EMPTY,
  invalid: GPU_VISIBILITY_KEY_INVALID,
  maxRasterWorkCapacity: GPU_VISIBILITY_KEY_MAX_RASTER_WORK_CAPACITY
});

export const GPU_VISIBILITY_KEY_WGSL = /* wgsl */ `
const OENGINE_VISIBILITY_KEY_EMPTY: u32 = ${GPU_VISIBILITY_KEY_EMPTY}u;
const OENGINE_VISIBILITY_KEY_INVALID: u32 = ${GPU_VISIBILITY_KEY_INVALID}u;
const OENGINE_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT: u32 =
  ${GPU_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT}u;

struct OEngineVisibilityKeyEncodeResult {
  key: u32,
  valid: u32,
};

struct OEngineVisibilityKeyDecodeResult {
  raster_work_slot: u32,
  valid: u32,
  empty: u32,
};

fn oengine_visibility_key_try_encode(
  raster_work_slot: u32
) -> OEngineVisibilityKeyEncodeResult {
  if raster_work_slot > OENGINE_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT {
    return OEngineVisibilityKeyEncodeResult(
      OENGINE_VISIBILITY_KEY_INVALID,
      0u
    );
  }
  return OEngineVisibilityKeyEncodeResult(raster_work_slot, 1u);
}

fn oengine_visibility_key_decode(
  key: u32
) -> OEngineVisibilityKeyDecodeResult {
  if key == OENGINE_VISIBILITY_KEY_EMPTY {
    return OEngineVisibilityKeyDecodeResult(0u, 0u, 1u);
  }
  if key == OENGINE_VISIBILITY_KEY_INVALID ||
    key > OENGINE_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT {
    return OEngineVisibilityKeyDecodeResult(0u, 0u, 0u);
  }
  return OEngineVisibilityKeyDecodeResult(key, 1u, 0u);
}

fn oengine_visibility_key_is_valid(key: u32) -> bool {
  return key <= OENGINE_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT;
}

fn oengine_visibility_key_is_empty(key: u32) -> bool {
  return key == OENGINE_VISIBILITY_KEY_EMPTY;
}

fn oengine_visibility_key_raster_work_slot(key: u32) -> u32 {
  return key;
}
`;

export type VisibilityKeyDecodeResult =
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "invalid"; key: number }>
  | Readonly<{ kind: "valid"; rasterWorkSlot: number }>;

export type VisibilityKeyLookupResult =
  | Extract<VisibilityKeyDecodeResult, { kind: "empty" }>
  | Readonly<{
      kind: "invalid";
      key: number;
      rasterWorkSlot?: number;
      reason: "reserved-key" | "raster-work-out-of-range" | "invalid-raster-work";
    }>
  | Readonly<{
      kind: "valid";
      key: number;
      rasterWorkSlot: number;
      rasterWork: RasterWorkCpu;
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

export function encodeVisibilityKey(rasterWorkSlot: number): number {
  assertIntegerInRange(
    rasterWorkSlot,
    0,
    GPU_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT,
    "VisibilityKey rasterWorkSlot"
  );
  return rasterWorkSlot >>> 0;
}

export function decodeVisibilityKey(key: number): VisibilityKeyDecodeResult {
  assertU32(key, "VisibilityKey");
  if (key === GPU_VISIBILITY_KEY_EMPTY) {
    return Object.freeze({ kind: "empty" });
  }
  if (key === GPU_VISIBILITY_KEY_INVALID ||
    key > GPU_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT) {
    return Object.freeze({ kind: "invalid", key });
  }
  return Object.freeze({ kind: "valid", rasterWorkSlot: key });
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
  const bytes = GPU_CLASSIFIED_RASTER_HEADER_BYTES +
    capacity * 2 * GPU_RASTER_WORK_SCHEMA.stride;
  if (!Number.isSafeInteger(bytes)) {
    throw new RangeError("Visibility RasterWork byte length is not a safe integer");
  }
  return bytes;
}

export function getGpuVisibilityRasterWorkCapacity(
  limits: GpuVisibilityBufferLimits
): Readonly<GpuVisibilityRasterWorkCapacity> {
  const maxBufferSize = finiteNonNegativeInteger(limits.maxBufferSize, "maxBufferSize");
  const maxStorageBufferBindingSize = finiteNonNegativeInteger(
    limits.maxStorageBufferBindingSize,
    "maxStorageBufferBindingSize"
  );
  const effectiveByteLimit = Math.min(maxBufferSize, maxStorageBufferBindingSize);
  const queueHeaderFits = effectiveByteLimit >= GPU_CLASSIFIED_RASTER_HEADER_BYTES;
  const adapterCapacity = queueHeaderFits
    ? Math.floor(
        (effectiveByteLimit - GPU_CLASSIFIED_RASTER_HEADER_BYTES) /
          (GPU_RASTER_WORK_SCHEMA.stride * 2)
      )
    : 0;
  return Object.freeze({
    keyCapacity: GPU_VISIBILITY_KEY_MAX_CLASS_CAPACITY,
    adapterCapacity,
    effectiveCapacity: Math.min(
      GPU_VISIBILITY_KEY_MAX_CLASS_CAPACITY,
      adapterCapacity
    ),
    effectiveByteLimit,
    queueHeaderFits
  });
}

export function assertGpuVisibilityRasterWorkCapacity(
  requiredCapacity: number,
  limits: GpuVisibilityBufferLimits
): Readonly<GpuVisibilityRasterWorkCapacity> {
  assertIntegerInRange(
    requiredCapacity,
    0,
    GPU_VISIBILITY_KEY_MAX_CLASS_CAPACITY,
    "Required Visibility RasterWork capacity"
  );
  const capacity = getGpuVisibilityRasterWorkCapacity(limits);
  if (!capacity.queueHeaderFits) {
    throw new RangeError(
      `Visibility classified RasterWork headers require ${GPU_CLASSIFIED_RASTER_HEADER_BYTES} bytes, ` +
      `but the adapter limit is ${capacity.effectiveByteLimit} bytes`
    );
  }
  if (requiredCapacity > capacity.effectiveCapacity) {
    throw new RangeError(
      `Required Visibility RasterWork capacity ${requiredCapacity} exceeds ` +
      `effective capacity ${capacity.effectiveCapacity}`
    );
  }
  return capacity;
}

/** CPU oracle for VisibilityKey -> exact RasterWork lookup. */
export function resolveVisibilityKeyReference(
  key: number,
  rasterWorkRecords: readonly RasterWorkCpu[]
): VisibilityKeyLookupResult {
  const decoded = decodeVisibilityKey(key);
  if (decoded.kind === "empty") return decoded;
  if (decoded.kind === "invalid") {
    return Object.freeze({
      kind: "invalid",
      key,
      reason: "reserved-key" as const
    });
  }
  const rasterWork = rasterWorkRecords[decoded.rasterWorkSlot];
  if (rasterWork === undefined) {
    return Object.freeze({
      kind: "invalid",
      key,
      rasterWorkSlot: decoded.rasterWorkSlot,
      reason: "raster-work-out-of-range" as const
    });
  }
  if (!isRasterWorkValid(rasterWork)) {
    return Object.freeze({
      kind: "invalid",
      key,
      rasterWorkSlot: decoded.rasterWorkSlot,
      reason: "invalid-raster-work" as const
    });
  }
  return Object.freeze({
    kind: "valid",
    key,
    rasterWorkSlot: decoded.rasterWorkSlot,
    rasterWork
  });
}

function isRasterWorkValid(work: RasterWorkCpu): boolean {
  return isU32(work.instanceRecordIndex) &&
    isU32(work.geometryRecordIndex) &&
    isU32(work.meshletRecordIndex) &&
    isU32(work.localTriangleIndex) &&
    isU32(work.materialHandle) &&
    isU32(work.rasterFlags);
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

function finiteNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

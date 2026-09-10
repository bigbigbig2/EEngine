import { GPU_CLASSIFIED_RASTER_HEADER_BYTES } from "./GpuWorkGenerationAbi.js";
import { GPU_EXACT_RASTER_RECORD_STRIDE } from "./GpuExactRasterAbi.js";
import type { GpuMeshletRasterWorkCpu } from "./GpuMeshletRasterWorkAbi.js";

/**
 * ADR-0008 VisibilityKey V2 physical encoding.
 *
 * The key is frame-local. Its queue partition and generation are external
 * context and must be validated before dereferencing a MeshletWork slot.
 */
export const GPU_VISIBILITY_KEY_ABI_VERSION = 4;
export const GPU_VISIBILITY_KEY_EMPTY = 0xffffffff;
export const GPU_VISIBILITY_KEY_INVALID = 0xfffffffe;
export const GPU_VISIBILITY_KEY_MESHLET_WORK_SLOT_BITS = 24;
export const GPU_VISIBILITY_KEY_MESHLET_WORK_SLOT_MASK = 0x00ffffff;
export const GPU_VISIBILITY_KEY_LOCAL_PRIMITIVE_BITS = 8;
export const GPU_VISIBILITY_KEY_LOCAL_PRIMITIVE_SHIFT = 24;
export const GPU_VISIBILITY_KEY_LOCAL_PRIMITIVE_MASK = 0xff000000;
/** Cooker/meshlet ABI ceiling is 128 triangles, indexed 0..127. */
export const GPU_VISIBILITY_KEY_MAX_LOCAL_PRIMITIVE = 127;
export const GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_SLOT =
  GPU_VISIBILITY_KEY_MESHLET_WORK_SLOT_MASK;
export const GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_CAPACITY =
  GPU_VISIBILITY_KEY_MESHLET_WORK_SLOT_MASK + 1;
/** V2 currently binds exactly one queue partition. */
export const GPU_VISIBILITY_KEY_PARTITION = 0;
export const GPU_VISIBILITY_KEY_PARTITION_COUNT = 1;

export const GPU_VISIBILITY_KEY_SCHEMA = Object.freeze({
  name: "OEngineVisibilityKeyV2",
  version: GPU_VISIBILITY_KEY_ABI_VERSION,
  bitCount: 32,
  fields: Object.freeze([
    Object.freeze({
      name: "meshletWorkSlot" as const,
      bitOffset: 0,
      bitCount: GPU_VISIBILITY_KEY_MESHLET_WORK_SLOT_BITS,
      mask: GPU_VISIBILITY_KEY_MESHLET_WORK_SLOT_MASK,
      maxValue: GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_SLOT
    }),
    Object.freeze({
      name: "localPrimitive" as const,
      bitOffset: GPU_VISIBILITY_KEY_LOCAL_PRIMITIVE_SHIFT,
      bitCount: GPU_VISIBILITY_KEY_LOCAL_PRIMITIVE_BITS,
      mask: GPU_VISIBILITY_KEY_LOCAL_PRIMITIVE_MASK,
      maxValue: GPU_VISIBILITY_KEY_MAX_LOCAL_PRIMITIVE
    })
  ]),
  empty: GPU_VISIBILITY_KEY_EMPTY,
  invalid: GPU_VISIBILITY_KEY_INVALID,
  maxMeshletWorkCapacity: GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_CAPACITY,
  partition: GPU_VISIBILITY_KEY_PARTITION,
  partitionCount: GPU_VISIBILITY_KEY_PARTITION_COUNT,
  generation: "external-queue-header" as const
});

export const GPU_VISIBILITY_KEY_WGSL = /* wgsl */ `
const OENGINE_VISIBILITY_KEY_EMPTY: u32 = ${GPU_VISIBILITY_KEY_EMPTY}u;
const OENGINE_VISIBILITY_KEY_INVALID: u32 = ${GPU_VISIBILITY_KEY_INVALID}u;
const OENGINE_VISIBILITY_KEY_MESHLET_WORK_SLOT_MASK: u32 = ${GPU_VISIBILITY_KEY_MESHLET_WORK_SLOT_MASK}u;
const OENGINE_VISIBILITY_KEY_LOCAL_PRIMITIVE_SHIFT: u32 = ${GPU_VISIBILITY_KEY_LOCAL_PRIMITIVE_SHIFT}u;
const OENGINE_VISIBILITY_KEY_MAX_LOCAL_PRIMITIVE: u32 = ${GPU_VISIBILITY_KEY_MAX_LOCAL_PRIMITIVE}u;
const OENGINE_VISIBILITY_KEY_PARTITION: u32 = ${GPU_VISIBILITY_KEY_PARTITION}u;

struct OEngineVisibilityKeyEncodeResult {
  key: u32,
  valid: u32,
};

struct OEngineVisibilityKeyDecodeResult {
  meshlet_work_slot: u32,
  local_primitive: u32,
  valid: u32,
  empty: u32,
};

fn oengine_visibility_key_try_encode(
  meshlet_work_slot: u32,
  local_primitive: u32
) -> OEngineVisibilityKeyEncodeResult {
  if meshlet_work_slot > OENGINE_VISIBILITY_KEY_MESHLET_WORK_SLOT_MASK ||
      local_primitive > OENGINE_VISIBILITY_KEY_MAX_LOCAL_PRIMITIVE {
    return OEngineVisibilityKeyEncodeResult(OENGINE_VISIBILITY_KEY_INVALID, 0u);
  }
  return OEngineVisibilityKeyEncodeResult(
    meshlet_work_slot |
      (local_primitive << OENGINE_VISIBILITY_KEY_LOCAL_PRIMITIVE_SHIFT),
    1u
  );
}

fn oengine_visibility_key_decode(key: u32) -> OEngineVisibilityKeyDecodeResult {
  if key == OENGINE_VISIBILITY_KEY_EMPTY {
    return OEngineVisibilityKeyDecodeResult(0u, 0u, 0u, 1u);
  }
  let local_primitive = key >> OENGINE_VISIBILITY_KEY_LOCAL_PRIMITIVE_SHIFT;
  if key == OENGINE_VISIBILITY_KEY_INVALID ||
      local_primitive > OENGINE_VISIBILITY_KEY_MAX_LOCAL_PRIMITIVE {
    return OEngineVisibilityKeyDecodeResult(0u, 0u, 0u, 0u);
  }
  return OEngineVisibilityKeyDecodeResult(
    key & OENGINE_VISIBILITY_KEY_MESHLET_WORK_SLOT_MASK,
    local_primitive,
    1u,
    0u
  );
}

fn oengine_visibility_key_is_valid(key: u32) -> bool {
  return key != OENGINE_VISIBILITY_KEY_EMPTY &&
    key != OENGINE_VISIBILITY_KEY_INVALID &&
    (key >> OENGINE_VISIBILITY_KEY_LOCAL_PRIMITIVE_SHIFT) <=
      OENGINE_VISIBILITY_KEY_MAX_LOCAL_PRIMITIVE;
}

fn oengine_visibility_key_is_empty(key: u32) -> bool {
  return key == OENGINE_VISIBILITY_KEY_EMPTY;
}

fn oengine_visibility_key_meshlet_work_slot(key: u32) -> u32 {
  return key & OENGINE_VISIBILITY_KEY_MESHLET_WORK_SLOT_MASK;
}

fn oengine_visibility_key_local_primitive(key: u32) -> u32 {
  return key >> OENGINE_VISIBILITY_KEY_LOCAL_PRIMITIVE_SHIFT;
}

fn oengine_visibility_key_context_is_valid(
  visibility_generation: u32,
  queue_generation: u32,
  queue_partition: u32
) -> bool {
  return visibility_generation != 0u &&
    visibility_generation == queue_generation &&
    queue_partition == OENGINE_VISIBILITY_KEY_PARTITION;
}
`;

export type VisibilityKeyDecodeResult =
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "invalid"; key: number }>
  | Readonly<{ kind: "valid"; meshletWorkSlot: number; localPrimitive: number }>;

export interface VisibilityKeyQueueContext {
  readonly partition: number;
  readonly generation: number;
}

export type VisibilityKeyLookupResult =
  | Extract<VisibilityKeyDecodeResult, { kind: "empty" }>
  | Readonly<{
      kind: "invalid";
      key: number;
      meshletWorkSlot?: number;
      localPrimitive?: number;
      reason:
        | "reserved-key"
        | "unsupported-partition"
        | "generation-mismatch"
        | "meshlet-work-out-of-range"
        | "invalid-meshlet-work";
    }>
  | Readonly<{
      kind: "valid";
      key: number;
      meshletWorkSlot: number;
      localPrimitive: number;
      meshletWork: GpuMeshletRasterWorkCpu;
      context: VisibilityKeyQueueContext;
    }>;

export interface GpuVisibilityBufferLimits {
  readonly maxBufferSize: number;
  readonly maxStorageBufferBindingSize: number;
}

/** Legacy exact-table capacity evidence retained until ADR-0008 Step 7 deletes it. */
export interface GpuVisibilityRasterWorkCapacity {
  readonly keyCapacity: number;
  readonly adapterCapacity: number;
  readonly effectiveCapacity: number;
  readonly effectiveByteLimit: number;
  readonly queueHeaderFits: boolean;
}

export function tryEncodeVisibilityKey(
  meshletWorkSlot: number,
  localPrimitive: number
): Readonly<{ key: number; valid: boolean }> {
  const valid = Number.isInteger(meshletWorkSlot) &&
    meshletWorkSlot >= 0 &&
    meshletWorkSlot <= GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_SLOT &&
    Number.isInteger(localPrimitive) &&
    localPrimitive >= 0 &&
    localPrimitive <= GPU_VISIBILITY_KEY_MAX_LOCAL_PRIMITIVE;
  return Object.freeze({
    key: valid
      ? ((meshletWorkSlot |
          (localPrimitive << GPU_VISIBILITY_KEY_LOCAL_PRIMITIVE_SHIFT)) >>> 0)
      : GPU_VISIBILITY_KEY_INVALID,
    valid
  });
}

/** Strict convenience encoder for CPU fixtures and reference paths. */
export function encodeVisibilityKey(meshletWorkSlot: number, localPrimitive: number): number {
  assertIntegerInRange(
    meshletWorkSlot,
    0,
    GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_SLOT,
    "VisibilityKey meshletWorkSlot"
  );
  assertIntegerInRange(
    localPrimitive,
    0,
    GPU_VISIBILITY_KEY_MAX_LOCAL_PRIMITIVE,
    "VisibilityKey localPrimitive"
  );
  return tryEncodeVisibilityKey(meshletWorkSlot, localPrimitive).key;
}

export function decodeVisibilityKey(key: number): VisibilityKeyDecodeResult {
  assertU32(key, "VisibilityKey");
  if (key === GPU_VISIBILITY_KEY_EMPTY) return Object.freeze({ kind: "empty" });
  const localPrimitive = key >>> GPU_VISIBILITY_KEY_LOCAL_PRIMITIVE_SHIFT;
  if (key === GPU_VISIBILITY_KEY_INVALID ||
      localPrimitive > GPU_VISIBILITY_KEY_MAX_LOCAL_PRIMITIVE) {
    return Object.freeze({ kind: "invalid", key });
  }
  return Object.freeze({
    kind: "valid",
    meshletWorkSlot: key & GPU_VISIBILITY_KEY_MESHLET_WORK_SLOT_MASK,
    localPrimitive
  });
}

export function isVisibilityKeyEmpty(key: number): boolean {
  assertU32(key, "VisibilityKey");
  return key === GPU_VISIBILITY_KEY_EMPTY;
}

export function isVisibilityKeyValid(key: number): boolean {
  return decodeVisibilityKey(key).kind === "valid";
}

export function isVisibilityKeyContextValid(
  visibilityGeneration: number,
  queueGeneration: number,
  partition: number
): boolean {
  assertU32(visibilityGeneration, "VisibilityKey generation");
  assertU32(queueGeneration, "MeshletWork generation");
  assertU32(partition, "VisibilityKey partition");
  return visibilityGeneration !== 0 &&
    visibilityGeneration === queueGeneration &&
    partition === GPU_VISIBILITY_KEY_PARTITION;
}

/** Legacy exact RasterWork byte sizing; removed with the old table in Step 7. */
export function visibilityRasterWorkBufferByteLength(capacity: number): number {
  assertIntegerInRange(
    capacity,
    0,
    GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_CAPACITY,
    "Visibility RasterWork class capacity"
  );
  const bytes = GPU_CLASSIFIED_RASTER_HEADER_BYTES +
    capacity * 2 * GPU_EXACT_RASTER_RECORD_STRIDE;
  if (!Number.isSafeInteger(bytes)) {
    throw new RangeError("Visibility RasterWork byte length is not a safe integer");
  }
  return bytes;
}

/** Legacy exact-table adapter gate retained until Step 7. */
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
        (GPU_EXACT_RASTER_RECORD_STRIDE * 2)
      )
    : 0;
  return Object.freeze({
    keyCapacity: GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_CAPACITY,
    adapterCapacity,
    effectiveCapacity: Math.min(
      GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_CAPACITY,
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
    GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_CAPACITY,
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

/** CPU oracle for VisibilityKey V2 plus its external queue lifetime context. */
export function resolveVisibilityKeyReference(
  key: number,
  meshletWorkRecords: readonly GpuMeshletRasterWorkCpu[],
  keyContext: VisibilityKeyQueueContext,
  queueContext: VisibilityKeyQueueContext
): VisibilityKeyLookupResult {
  const decoded = decodeVisibilityKey(key);
  if (decoded.kind === "empty") return decoded;
  if (decoded.kind === "invalid") {
    return Object.freeze({ kind: "invalid", key, reason: "reserved-key" as const });
  }
  const identity = {
    meshletWorkSlot: decoded.meshletWorkSlot,
    localPrimitive: decoded.localPrimitive
  };
  if (keyContext.partition !== GPU_VISIBILITY_KEY_PARTITION ||
      queueContext.partition !== keyContext.partition) {
    return Object.freeze({
      kind: "invalid", key, ...identity, reason: "unsupported-partition" as const
    });
  }
  if (keyContext.generation === 0 || queueContext.generation !== keyContext.generation) {
    return Object.freeze({
      kind: "invalid", key, ...identity, reason: "generation-mismatch" as const
    });
  }
  const meshletWork = meshletWorkRecords[decoded.meshletWorkSlot];
  if (meshletWork === undefined) {
    return Object.freeze({
      kind: "invalid", key, ...identity, reason: "meshlet-work-out-of-range" as const
    });
  }
  if (!isMeshletWorkValid(meshletWork)) {
    return Object.freeze({
      kind: "invalid", key, ...identity, reason: "invalid-meshlet-work" as const
    });
  }
  return Object.freeze({
    kind: "valid",
    key,
    ...identity,
    meshletWork,
    context: Object.freeze({ ...queueContext })
  });
}

function isMeshletWorkValid(work: GpuMeshletRasterWorkCpu): boolean {
  return isU32(work.instanceSlot) &&
    isU32(work.geometrySlot) &&
    isU32(work.meshletSlot) &&
    isU32(work.materialSlotOrRange) &&
    isU32(work.packedRasterFlags) &&
    isU32(work.packedProfileLod) &&
    (work.packedProfileLod >>> 24) === GPU_VISIBILITY_KEY_PARTITION;
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
    throw new RangeError(`${label} must be an integer in [${minimum}, ${maximum}]`);
  }
}

function finiteNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

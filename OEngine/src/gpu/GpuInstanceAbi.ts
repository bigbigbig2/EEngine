import { mat4 } from "gl-matrix";

export const GPU_INSTANCE_ABI_VERSION = 2;
export const GPU_INSTANCE_RECORD_STRIDE = 192;
export const GPU_INSTANCE_FALLBACK_RECORD_INDEX = 0;
export const GPU_INSTANCE_MOTION_RELATIVE_DETERMINANT_EPSILON = 1e-8;

export const GPU_INSTANCE_FLAGS = Object.freeze({
  Active: 1 << 0,
  CastsShadow: 1 << 1,
  ReceivesShadow: 1 << 2,
  AlphaTested: 1 << 3,
  DoubleSided: 1 << 4,
  /** Velocity must output zero because current-to-previous motion is not invertible. */
  MotionInvalid: 1 << 5,
  /** BLEND material routed to a bounded transparent SecondaryRasterWork queue. */
  Transparent: 1 << 6
} as const);

export const GPU_INSTANCE_RECORD_OFFSETS = Object.freeze({
  geometry_record_index: 0,
  material_handle: 4,
  flags: 8,
  debug_id: 12,
  bounds_sphere: 16,
  bounds_min: 32,
  bounds_max: 48,
  current_object_to_world: 64,
  previous_from_current: 128
} as const);

export const GPU_INSTANCE_RECORD_SCHEMA = Object.freeze({
  abiVersion: GPU_INSTANCE_ABI_VERSION,
  stride: GPU_INSTANCE_RECORD_STRIDE,
  offsets: GPU_INSTANCE_RECORD_OFFSETS
} as const);

export interface GpuInstanceRecordCpu {
  readonly geometryRecordIndex: number;
  readonly materialHandle: number;
  readonly flags: number;
  readonly debugId: number;
  readonly boundsSphere: ArrayLike<number>;
  readonly boundsMin: ArrayLike<number>;
  readonly boundsMax: ArrayLike<number>;
  readonly currentObjectToWorld: ArrayLike<number>;
  /** Previous-frame object-to-world; the packer converts it to previous_from_current. */
  readonly previousObjectToWorld: ArrayLike<number>;
}

export interface GpuInstanceMotionScratch {
  readonly current: Float32Array;
  readonly previous: Float32Array;
  readonly inverseCurrent: Float32Array;
  readonly previousFromCurrent: Float32Array;
}

export const GPU_INSTANCE_RECORD_WGSL = /* wgsl */ `
struct OEngineInstanceRecord {
  geometry_record_index: u32,
  material_handle: u32,
  flags: u32,
  debug_id: u32,
  bounds_sphere: vec4f,
  bounds_min: vec4f,
  bounds_max: vec4f,
  current_object_to_world: mat4x4f,
  previous_from_current: mat4x4f,
}

fn oengine_instance_active(instance: OEngineInstanceRecord) -> bool {
  return (instance.flags & ${GPU_INSTANCE_FLAGS.Active}u) != 0u;
}

fn oengine_instance_motion_valid(instance: OEngineInstanceRecord) -> bool {
  return (instance.flags & ${GPU_INSTANCE_FLAGS.MotionInvalid}u) == 0u;
}
`;

export function packGpuInstanceRecord(
  record: GpuInstanceRecordCpu
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(GPU_INSTANCE_RECORD_STRIDE);
  writeGpuInstanceRecord(bytes, 0, record);
  return bytes;
}

export function packGpuInstanceRecords(
  records: readonly GpuInstanceRecordCpu[]
): Uint8Array<ArrayBuffer> {
  assertU32(records.length, "Instance record count");
  const byteLength = records.length * GPU_INSTANCE_RECORD_STRIDE;
  if (!Number.isSafeInteger(byteLength)) {
    throw new RangeError("Instance record byte length exceeds the JS safe integer range");
  }
  const bytes = new Uint8Array(byteLength);
  const scratch = createGpuInstanceMotionScratch();
  for (let index = 0; index < records.length; index++) {
    writeGpuInstanceRecord(
      bytes,
      index * GPU_INSTANCE_RECORD_STRIDE,
      records[index]!,
      scratch
    );
  }
  return bytes;
}

export function writeGpuInstanceRecord(
  destination: Uint8Array,
  byteOffset: number,
  record: GpuInstanceRecordCpu,
  scratch = createGpuInstanceMotionScratch()
): void {
  if (
    !Number.isSafeInteger(byteOffset) ||
    byteOffset < 0 ||
    byteOffset + GPU_INSTANCE_RECORD_STRIDE > destination.byteLength
  ) {
    throw new RangeError("Instance record destination range is invalid");
  }
  const view = new DataView(
    destination.buffer,
    destination.byteOffset + byteOffset,
    GPU_INSTANCE_RECORD_STRIDE
  );
  writeU32(view, GPU_INSTANCE_RECORD_OFFSETS.geometry_record_index, record.geometryRecordIndex, "geometryRecordIndex");
  writeU32(view, GPU_INSTANCE_RECORD_OFFSETS.material_handle, record.materialHandle, "materialHandle");
  const previousFromCurrent = scratch.previousFromCurrent;
  const motionValid = computePreviousFromCurrent(
    previousFromCurrent,
    record.currentObjectToWorld,
    record.previousObjectToWorld,
    0,
    0,
    scratch
  );
  const flags = (motionValid
    ? record.flags & ~GPU_INSTANCE_FLAGS.MotionInvalid
    : record.flags | GPU_INSTANCE_FLAGS.MotionInvalid) >>> 0;
  writeU32(view, GPU_INSTANCE_RECORD_OFFSETS.flags, flags, "flags");
  writeU32(view, GPU_INSTANCE_RECORD_OFFSETS.debug_id, record.debugId, "debugId");
  writeF32Array(view, GPU_INSTANCE_RECORD_OFFSETS.bounds_sphere, record.boundsSphere, 4, "boundsSphere");
  writeF32Array(view, GPU_INSTANCE_RECORD_OFFSETS.bounds_min, record.boundsMin, 3, "boundsMin");
  writeF32Array(view, GPU_INSTANCE_RECORD_OFFSETS.bounds_max, record.boundsMax, 3, "boundsMax");
  writeF32Array(
    view,
    GPU_INSTANCE_RECORD_OFFSETS.current_object_to_world,
    record.currentObjectToWorld,
    16,
    "currentObjectToWorld"
  );
  writeF32Array(
    view,
    GPU_INSTANCE_RECORD_OFFSETS.previous_from_current,
    previousFromCurrent,
    16,
    "previousFromCurrent"
  );
}

export function createGpuInstanceMotionScratch(): GpuInstanceMotionScratch {
  return {
    current: new Float32Array(16),
    previous: new Float32Array(16),
    inverseCurrent: new Float32Array(16),
    previousFromCurrent: new Float32Array(16)
  };
}

/**
 * Builds `previousObjectToWorld * inverse(currentObjectToWorld)` using the
 * locked gl-matrix implementation. The destination is identity when current
 * is singular or a result is non-finite, so shaders never consume NaN/Inf.
 */
export function computePreviousFromCurrent(
  destination: Float32Array,
  currentObjectToWorld: ArrayLike<number>,
  previousObjectToWorld: ArrayLike<number>,
  currentOffset = 0,
  previousOffset = 0,
  scratch = createGpuInstanceMotionScratch()
): boolean {
  if (destination.length < 16) {
    throw new RangeError("previousFromCurrent destination must contain 16 values");
  }
  copyFiniteMatrix(scratch.current, currentObjectToWorld, currentOffset, "currentObjectToWorld");
  copyFiniteMatrix(scratch.previous, previousObjectToWorld, previousOffset, "previousObjectToWorld");
  if (matricesEqual(scratch.current, scratch.previous)) {
    mat4.identity(destination);
    return true;
  }
  if (!isConditionedAffineTransform(scratch.current)) {
    mat4.identity(destination);
    return false;
  }
  if (mat4.invert(scratch.inverseCurrent, scratch.current) === null) {
    mat4.identity(destination);
    return false;
  }
  mat4.multiply(destination, scratch.previous, scratch.inverseCurrent);
  for (let index = 0; index < 16; index++) {
    if (!Number.isFinite(destination[index])) {
      mat4.identity(destination);
      return false;
    }
  }
  return true;
}

function copyFiniteMatrix(
  destination: Float32Array,
  source: ArrayLike<number>,
  sourceOffset: number,
  label: string
): void {
  if (source.length < sourceOffset + 16) {
    throw new RangeError(`${label} must contain 16 values from offset ${sourceOffset}`);
  }
  for (let index = 0; index < 16; index++) {
    const value = Number(source[sourceOffset + index]);
    if (!Number.isFinite(value)) throw new RangeError(`${label}[${sourceOffset + index}] must be finite`);
    destination[index] = value;
  }
}

function matricesEqual(left: Float32Array, right: Float32Array): boolean {
  for (let index = 0; index < 16; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function isConditionedAffineTransform(matrix: Float32Array): boolean {
  if (
    Math.abs(matrix[3]!) > 1e-6 ||
    Math.abs(matrix[7]!) > 1e-6 ||
    Math.abs(matrix[11]!) > 1e-6 ||
    Math.abs(matrix[15]! - 1) > 1e-6
  ) {
    return false;
  }
  const xLength = Math.hypot(matrix[0]!, matrix[1]!, matrix[2]!);
  const yLength = Math.hypot(matrix[4]!, matrix[5]!, matrix[6]!);
  const zLength = Math.hypot(matrix[8]!, matrix[9]!, matrix[10]!);
  const scaleProduct = xLength * yLength * zLength;
  if (!Number.isFinite(scaleProduct) || scaleProduct === 0) return false;
  const crossX = matrix[5]! * matrix[10]! - matrix[6]! * matrix[9]!;
  const crossY = matrix[6]! * matrix[8]! - matrix[4]! * matrix[10]!;
  const crossZ = matrix[4]! * matrix[9]! - matrix[5]! * matrix[8]!;
  const determinant = matrix[0]! * crossX + matrix[1]! * crossY + matrix[2]! * crossZ;
  return Math.abs(determinant) >
    scaleProduct * GPU_INSTANCE_MOTION_RELATIVE_DETERMINANT_EPSILON;
}

function writeU32(
  view: DataView,
  offset: number,
  value: number,
  label: string
): void {
  assertU32(value, label);
  view.setUint32(offset, value, true);
}

function writeF32Array(
  view: DataView,
  byteOffset: number,
  values: ArrayLike<number>,
  count: number,
  label: string
): void {
  if (values.length < count) {
    throw new RangeError(`${label} must contain at least ${count} values`);
  }
  for (let index = 0; index < count; index++) {
    const value = Number(values[index]);
    if (!Number.isFinite(value)) {
      throw new RangeError(`${label}[${index}] must be finite`);
    }
    view.setFloat32(byteOffset + index * 4, value, true);
  }
}

function assertU32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${label} ${value} is outside the R2 u32 ABI`);
  }
}

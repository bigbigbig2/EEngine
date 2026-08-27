export const GPU_INSTANCE_ABI_VERSION = 1;
export const GPU_INSTANCE_RECORD_STRIDE = 192;
export const GPU_INSTANCE_FALLBACK_RECORD_INDEX = 0;

export const GPU_INSTANCE_FLAGS = Object.freeze({
  Active: 1 << 0,
  CastsShadow: 1 << 1,
  ReceivesShadow: 1 << 2,
  AlphaTested: 1 << 3,
  DoubleSided: 1 << 4
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
  previous_object_to_world: 128
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
  readonly previousObjectToWorld: ArrayLike<number>;
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
  previous_object_to_world: mat4x4f,
}

fn oengine_instance_active(instance: OEngineInstanceRecord) -> bool {
  return (instance.flags & ${GPU_INSTANCE_FLAGS.Active}u) != 0u;
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
  for (let index = 0; index < records.length; index++) {
    writeGpuInstanceRecord(
      bytes,
      index * GPU_INSTANCE_RECORD_STRIDE,
      records[index]!
    );
  }
  return bytes;
}

export function writeGpuInstanceRecord(
  destination: Uint8Array,
  byteOffset: number,
  record: GpuInstanceRecordCpu
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
  writeU32(view, GPU_INSTANCE_RECORD_OFFSETS.flags, record.flags, "flags");
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
    GPU_INSTANCE_RECORD_OFFSETS.previous_object_to_world,
    record.previousObjectToWorld,
    16,
    "previousObjectToWorld"
  );
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

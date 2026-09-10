/** ADR-0008 frame-local meshlet raster work and queue ABI. */
export const GPU_MESHLET_RASTER_WORK_ABI_VERSION = 1;
export const GPU_MESHLET_RASTER_WORK_RECORD_STRIDE = 24;
export const GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE = 32;
export const GPU_MESHLET_WORK_INVALID_GENERATION = 0;
export const GPU_MESHLET_WORK_QUEUE_CLASS = "CorrectnessCritical" as const;

export const GPU_MESHLET_RASTER_FLAGS = Object.freeze({
  DoubleSided: 1 << 0,
  AlphaTested: 1 << 1,
  Transparent: 1 << 2,
  ForceExact: 1 << 3
} as const);

export const GPU_MESHLET_DECODE_PROFILE = Object.freeze({
  Invalid: 0,
  StaticPbrCompactV2: 1,
  ExplicitFloat32FallbackV2: 2
} as const);

export const GPU_MESHLET_WORK_QUEUE_HEADER_OFFSETS = Object.freeze({
  attemptedCount: 0,
  writtenCount: 4,
  consumedCount: 8,
  capacity: 12,
  overflowCount: 16,
  generation: 20,
  invalidCount: 24,
  reserved: 28
} as const);

export const GPU_MESHLET_RASTER_WORK_OFFSETS = Object.freeze({
  instanceSlot: 0,
  geometrySlot: 4,
  meshletSlot: 8,
  materialSlotOrRange: 12,
  packedRasterFlags: 16,
  packedProfileLod: 20
} as const);

export const GPU_MESHLET_RASTER_WORK_WGSL = /* wgsl */ `
struct OEngineMeshletWorkQueueHeader {
  attempted_count: atomic<u32>,
  written_count: atomic<u32>,
  consumed_count: atomic<u32>,
  capacity: u32,
  overflow_count: atomic<u32>,
  generation: atomic<u32>,
  invalid_count: atomic<u32>,
  reserved: u32,
};

struct OEngineMeshletWorkQueueHeaderRead {
  attempted_count: u32,
  written_count: u32,
  consumed_count: u32,
  capacity: u32,
  overflow_count: u32,
  generation: u32,
  invalid_count: u32,
  reserved: u32,
};

struct OEngineMeshletRasterWork {
  instance_slot: u32,
  geometry_slot: u32,
  meshlet_slot: u32,
  material_slot_or_range: u32,
  packed_raster_flags: u32,
  packed_profile_lod: u32,
};

struct OEngineMeshletWorkQueue {
  header: OEngineMeshletWorkQueueHeader,
  elements: array<OEngineMeshletRasterWork>,
};

struct OEngineMeshletWorkQueueRead {
  header: OEngineMeshletWorkQueueHeaderRead,
  elements: array<OEngineMeshletRasterWork>,
};
`;

export interface GpuMeshletRasterWorkCpu {
  readonly instanceSlot: number;
  readonly geometrySlot: number;
  readonly meshletSlot: number;
  readonly materialSlotOrRange: number;
  readonly packedRasterFlags: number;
  readonly packedProfileLod: number;
}

export interface GpuMeshletWorkQueueHeaderCpu {
  readonly attemptedCount: number;
  readonly writtenCount: number;
  readonly consumedCount: number;
  readonly capacity: number;
  readonly overflowCount: number;
  readonly generation: number;
  readonly invalidCount: number;
}

export interface GpuMeshletWorkReservation {
  readonly header: GpuMeshletWorkQueueHeaderCpu;
  readonly offset: number | null;
}

export function packGpuMeshletRasterWork(
  work: GpuMeshletRasterWorkCpu
): Uint8Array<ArrayBuffer> {
  const values = [
    work.instanceSlot,
    work.geometrySlot,
    work.meshletSlot,
    work.materialSlotOrRange,
    work.packedRasterFlags,
    work.packedProfileLod
  ];
  values.forEach((value, index) => assertU32(value, `MeshletRasterWork field ${index}`));
  return new Uint8Array(new Uint32Array(values).buffer);
}

export function unpackGpuMeshletRasterWork(
  bytes: Uint8Array,
  byteOffset = 0
): Readonly<GpuMeshletRasterWorkCpu> {
  assertByteRange(bytes, byteOffset, GPU_MESHLET_RASTER_WORK_RECORD_STRIDE, "MeshletRasterWork");
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + byteOffset,
    GPU_MESHLET_RASTER_WORK_RECORD_STRIDE
  );
  return Object.freeze({
    instanceSlot: view.getUint32(0, true),
    geometrySlot: view.getUint32(4, true),
    meshletSlot: view.getUint32(8, true),
    materialSlotOrRange: view.getUint32(12, true),
    packedRasterFlags: view.getUint32(16, true),
    packedProfileLod: view.getUint32(20, true)
  });
}

export function packGpuMeshletWorkQueueHeader(
  header: GpuMeshletWorkQueueHeaderCpu
): Uint8Array<ArrayBuffer> {
  validateGpuMeshletWorkQueueHeader(header);
  return new Uint8Array(new Uint32Array([
    header.attemptedCount,
    header.writtenCount,
    header.consumedCount,
    header.capacity,
    header.overflowCount,
    header.generation,
    header.invalidCount,
    0
  ]).buffer);
}

export function unpackGpuMeshletWorkQueueHeader(
  bytes: Uint8Array,
  byteOffset = 0
): Readonly<GpuMeshletWorkQueueHeaderCpu> {
  assertByteRange(bytes, byteOffset, GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE, "MeshletWork queue header");
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + byteOffset,
    GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE
  );
  const header = {
    attemptedCount: view.getUint32(0, true),
    writtenCount: view.getUint32(4, true),
    consumedCount: view.getUint32(8, true),
    capacity: view.getUint32(12, true),
    overflowCount: view.getUint32(16, true),
    generation: view.getUint32(20, true),
    invalidCount: view.getUint32(24, true)
  };
  validateGpuMeshletWorkQueueHeader(header);
  return Object.freeze(header);
}

export function gpuMeshletWorkQueueByteLength(capacity: number): number {
  assertPositiveU32(capacity, "MeshletWork queue capacity");
  const bytes = GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE +
    capacity * GPU_MESHLET_RASTER_WORK_RECORD_STRIDE;
  if (!Number.isSafeInteger(bytes)) {
    throw new RangeError("MeshletWork queue byte length is invalid");
  }
  return bytes;
}

/** CPU oracle for the GPU queue's all-or-nothing reservation contract. */
export function reserveGpuMeshletWork(
  current: GpuMeshletWorkQueueHeaderCpu,
  count: number
): Readonly<GpuMeshletWorkReservation> {
  validateGpuMeshletWorkQueueHeader(current);
  assertU32(count, "MeshletWork reservation count");
  const attemptedCount = saturatingAddU32(current.attemptedCount, count);
  const fits = count > 0 && count <= current.capacity - current.writtenCount;
  const writtenCount = fits ? current.writtenCount + count : current.writtenCount;
  const next = Object.freeze({
    ...current,
    attemptedCount,
    writtenCount,
    overflowCount: attemptedCount - writtenCount
  });
  validateGpuMeshletWorkQueueHeader(next);
  return Object.freeze({ header: next, offset: fits ? current.writtenCount : null });
}

export function packGpuMeshletProfileLod(decodeProfile: number, lod: number): number {
  assertBits(decodeProfile, 8, "Meshlet decode profile");
  assertBits(lod, 8, "Meshlet LOD");
  return (decodeProfile | (lod << 8)) >>> 0;
}

export function unpackGpuMeshletProfileLod(value: number): Readonly<{
  decodeProfile: number;
  lod: number;
}> {
  assertU32(value, "packed Meshlet profile/LOD");
  return Object.freeze({ decodeProfile: value & 0xff, lod: (value >>> 8) & 0xff });
}

export function nextGpuMeshletWorkGeneration(current: number): number {
  assertU32(current, "MeshletWork generation");
  const next = (current + 1) >>> 0;
  return next === GPU_MESHLET_WORK_INVALID_GENERATION ? 1 : next;
}

function validateGpuMeshletWorkQueueHeader(header: GpuMeshletWorkQueueHeaderCpu): void {
  for (const [name, value] of Object.entries(header)) assertU32(value, name);
  if (header.capacity === 0) throw new RangeError("MeshletWork queue capacity must be positive");
  if (header.writtenCount > header.capacity) {
    throw new RangeError("MeshletWork written count exceeds capacity");
  }
  if (header.consumedCount > header.writtenCount) {
    throw new RangeError("MeshletWork consumed count exceeds written count");
  }
  if (header.overflowCount !== header.attemptedCount - header.writtenCount) {
    throw new RangeError("MeshletWork overflow must equal attempted minus written");
  }
}

function saturatingAddU32(left: number, right: number): number {
  return Math.min(0xffffffff, left + right);
}

function assertBits(value: number, bits: number, label: string): void {
  assertU32(value, label);
  if (value >= 2 ** bits) throw new RangeError(`${label} exceeds ${bits} bits`);
}

function assertPositiveU32(value: number, label: string): void {
  assertU32(value, label);
  if (value === 0) throw new RangeError(`${label} must be positive`);
}

function assertU32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${label} must be a u32`);
  }
}

function assertByteRange(
  bytes: Uint8Array,
  byteOffset: number,
  byteLength: number,
  label: string
): void {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 ||
    byteOffset + byteLength > bytes.byteLength) {
    throw new RangeError(`${label} byte range is invalid`);
  }
}

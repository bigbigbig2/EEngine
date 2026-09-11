import { GPU_MATERIAL_KERNEL_CLASS_COUNT } from "./GpuMaterialKernelAbi.js";
import { TEXTURE_BINDING_SET_MAX_RESIDENT_SETS } from "./TextureBindingSetPolicy.js";

/** ADR-0009 bounded tile/class work ABI shared by TypeScript and WGSL. */
export const GPU_MATERIAL_TILE_WORK_ABI_VERSION = 1;
export const GPU_MATERIAL_TILE_WORK_QUEUE_CLASS = "CorrectnessCritical" as const;
export const GPU_MATERIAL_TILE_WORK_INVALID_GENERATION = 0;
export const GPU_MATERIAL_TILE_WORK_RECORD_STRIDE = 16;
export const GPU_MATERIAL_TILE_QUEUE_HEADER_STRIDE = 32;
export const GPU_MATERIAL_CLASSIFICATION_CONTROL_STRIDE = 32;
export const GPU_MATERIAL_TILE_DISPATCH_INDIRECT_STRIDE = 12;
export const GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT =
  GPU_MATERIAL_KERNEL_CLASS_COUNT * TEXTURE_BINDING_SET_MAX_RESIDENT_SETS;

export const GPU_MATERIAL_TILE_WORK_OFFSETS = Object.freeze({
  tileLinearId: 0,
  kernelClassId: 4,
  textureBindingSetId: 8,
  generation: 12
} as const);

export const GPU_MATERIAL_TILE_QUEUE_HEADER_OFFSETS = Object.freeze({
  attemptedCount: 0,
  writtenCount: 4,
  consumedCount: 8,
  capacity: 12,
  overflowCount: 16,
  generation: 20,
  invalidCount: 24,
  reserved: 28
} as const);

export const GPU_MATERIAL_CLASSIFICATION_CONTROL_OFFSETS = Object.freeze({
  validPixelCount: 0,
  shadedPixelCount: 4,
  unassignedPixelCount: 8,
  duplicateShadingPixelCount: 12,
  overflowQueueCount: 16,
  frameInvalid: 20,
  generation: 24,
  dispatchClassCount: 28
} as const);

export const GPU_MATERIAL_TILE_WORK_WGSL = /* wgsl */ `
const OENGINE_MATERIAL_TILE_WORK_ABI_VERSION: u32 = ${GPU_MATERIAL_TILE_WORK_ABI_VERSION}u;
const OENGINE_MATERIAL_TILE_DISPATCH_CLASS_COUNT: u32 = ${GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT}u;

struct OEngineMaterialTileWork {
  tile_linear_id: u32,
  kernel_class_id: u32,
  texture_binding_set_id: u32,
  generation: u32,
};

struct OEngineMaterialTileQueueHeader {
  attempted_count: atomic<u32>,
  written_count: atomic<u32>,
  consumed_count: atomic<u32>,
  capacity: u32,
  overflow_count: atomic<u32>,
  generation: atomic<u32>,
  invalid_count: atomic<u32>,
  reserved: u32,
};

struct OEngineMaterialTileQueueHeaderRead {
  attempted_count: u32,
  written_count: u32,
  consumed_count: u32,
  capacity: u32,
  overflow_count: u32,
  generation: u32,
  invalid_count: u32,
  reserved: u32,
};

struct OEngineMaterialClassificationControl {
  valid_pixel_count: atomic<u32>,
  shaded_pixel_count: atomic<u32>,
  unassigned_pixel_count: atomic<u32>,
  duplicate_shading_pixel_count: atomic<u32>,
  overflow_queue_count: atomic<u32>,
  frame_invalid: atomic<u32>,
  generation: u32,
  dispatch_class_count: u32,
};

struct OEngineDispatchIndirectArgs {
  workgroup_count_x: u32,
  workgroup_count_y: u32,
  workgroup_count_z: u32,
};

fn oengine_material_dispatch_class_id(
  kernel_class_id: u32,
  texture_binding_set_id: u32
) -> u32 {
  return texture_binding_set_id * ${GPU_MATERIAL_KERNEL_CLASS_COUNT}u + kernel_class_id;
}
`;

export interface GpuMaterialTileWorkCpu {
  readonly tileLinearId: number;
  readonly kernelClassId: number;
  readonly textureBindingSetId: number;
  readonly generation: number;
}

export interface GpuMaterialTileQueueHeaderCpu {
  readonly attemptedCount: number;
  readonly writtenCount: number;
  readonly consumedCount: number;
  readonly capacity: number;
  readonly overflowCount: number;
  readonly generation: number;
  readonly invalidCount: number;
}

export interface GpuMaterialClassificationControlCpu {
  readonly validPixelCount: number;
  readonly shadedPixelCount: number;
  readonly unassignedPixelCount: number;
  readonly duplicateShadingPixelCount: number;
  readonly overflowQueueCount: number;
  readonly frameInvalid: 0 | 1;
  readonly generation: number;
  readonly dispatchClassCount: number;
}

export interface GpuMaterialTileWorkReservation {
  readonly header: GpuMaterialTileQueueHeaderCpu;
  readonly offset: number | null;
}

export function materialShadingDispatchClassId(
  kernelClassId: number,
  textureBindingSetId: number
): number {
  assertRange(
    kernelClassId,
    GPU_MATERIAL_KERNEL_CLASS_COUNT,
    "Material kernel class"
  );
  assertRange(
    textureBindingSetId,
    TEXTURE_BINDING_SET_MAX_RESIDENT_SETS,
    "Texture binding set"
  );
  return textureBindingSetId * GPU_MATERIAL_KERNEL_CLASS_COUNT + kernelClassId;
}

export function decodeMaterialShadingDispatchClassId(
  dispatchClassId: number
): Readonly<{ kernelClassId: number; textureBindingSetId: number }> {
  assertRange(
    dispatchClassId,
    GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT,
    "Material shading dispatch class"
  );
  return Object.freeze({
    kernelClassId: dispatchClassId % GPU_MATERIAL_KERNEL_CLASS_COUNT,
    textureBindingSetId: Math.floor(
      dispatchClassId / GPU_MATERIAL_KERNEL_CLASS_COUNT
    )
  });
}

export function packGpuMaterialTileWork(
  work: GpuMaterialTileWorkCpu
): Uint8Array<ArrayBuffer> {
  validateGpuMaterialTileWork(work);
  return packU32([
    work.tileLinearId,
    work.kernelClassId,
    work.textureBindingSetId,
    work.generation
  ]);
}

export function unpackGpuMaterialTileWork(
  bytes: Uint8Array,
  byteOffset = 0
): Readonly<GpuMaterialTileWorkCpu> {
  assertByteRange(
    bytes,
    byteOffset,
    GPU_MATERIAL_TILE_WORK_RECORD_STRIDE,
    "MaterialTileWork"
  );
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + byteOffset,
    GPU_MATERIAL_TILE_WORK_RECORD_STRIDE
  );
  const work = {
    tileLinearId: view.getUint32(0, true),
    kernelClassId: view.getUint32(4, true),
    textureBindingSetId: view.getUint32(8, true),
    generation: view.getUint32(12, true)
  };
  validateGpuMaterialTileWork(work);
  return Object.freeze(work);
}

export function packGpuMaterialTileQueueHeader(
  header: GpuMaterialTileQueueHeaderCpu
): Uint8Array<ArrayBuffer> {
  validateGpuMaterialTileQueueHeader(header);
  return packU32([
    header.attemptedCount,
    header.writtenCount,
    header.consumedCount,
    header.capacity,
    header.overflowCount,
    header.generation,
    header.invalidCount,
    0
  ]);
}

export function packGpuMaterialTileQueueHeaders(
  capacity: number,
  generation: number
): Uint8Array<ArrayBuffer> {
  assertPositiveU32(capacity, "MaterialTileWork queue capacity");
  assertGeneration(generation, "MaterialTileWork queue generation");
  const bytes = new Uint8Array(
    GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT *
      GPU_MATERIAL_TILE_QUEUE_HEADER_STRIDE
  );
  const header = packGpuMaterialTileQueueHeader({
    attemptedCount: 0,
    writtenCount: 0,
    consumedCount: 0,
    capacity,
    overflowCount: 0,
    generation,
    invalidCount: 0
  });
  for (
    let dispatchClassId = 0;
    dispatchClassId < GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT;
    dispatchClassId++
  ) {
    bytes.set(header, materialTileQueueHeaderByteOffset(dispatchClassId));
  }
  return bytes;
}

export function unpackGpuMaterialTileQueueHeader(
  bytes: Uint8Array,
  byteOffset = 0
): Readonly<GpuMaterialTileQueueHeaderCpu> {
  assertByteRange(
    bytes,
    byteOffset,
    GPU_MATERIAL_TILE_QUEUE_HEADER_STRIDE,
    "MaterialTileWork queue header"
  );
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + byteOffset,
    GPU_MATERIAL_TILE_QUEUE_HEADER_STRIDE
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
  validateGpuMaterialTileQueueHeader(header);
  return Object.freeze(header);
}

export function packGpuMaterialClassificationControl(
  control: GpuMaterialClassificationControlCpu
): Uint8Array<ArrayBuffer> {
  validateGpuMaterialClassificationControl(control);
  return packU32([
    control.validPixelCount,
    control.shadedPixelCount,
    control.unassignedPixelCount,
    control.duplicateShadingPixelCount,
    control.overflowQueueCount,
    control.frameInvalid,
    control.generation,
    control.dispatchClassCount
  ]);
}

export function unpackGpuMaterialClassificationControl(
  bytes: Uint8Array,
  byteOffset = 0
): Readonly<GpuMaterialClassificationControlCpu> {
  assertByteRange(
    bytes,
    byteOffset,
    GPU_MATERIAL_CLASSIFICATION_CONTROL_STRIDE,
    "Material classification control"
  );
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + byteOffset,
    GPU_MATERIAL_CLASSIFICATION_CONTROL_STRIDE
  );
  const control = {
    validPixelCount: view.getUint32(0, true),
    shadedPixelCount: view.getUint32(4, true),
    unassignedPixelCount: view.getUint32(8, true),
    duplicateShadingPixelCount: view.getUint32(12, true),
    overflowQueueCount: view.getUint32(16, true),
    frameInvalid: view.getUint32(20, true) as 0 | 1,
    generation: view.getUint32(24, true),
    dispatchClassCount: view.getUint32(28, true)
  };
  validateGpuMaterialClassificationControl(control);
  return Object.freeze(control);
}

export function validateFinalGpuMaterialClassificationControl(
  control: GpuMaterialClassificationControlCpu
): void {
  validateGpuMaterialClassificationControl(control);
  const correctnessFailure =
    control.unassignedPixelCount !== 0 ||
    control.duplicateShadingPixelCount !== 0 ||
    control.overflowQueueCount !== 0 ||
    control.shadedPixelCount !== control.validPixelCount;
  if (control.frameInvalid !== (correctnessFailure ? 1 : 0)) {
    throw new Error(
      "Material classification frame-invalid flag does not match final correctness counters"
    );
  }
}

export function materialTileWorkQueueBufferByteLength(
  tileCapacityPerDispatchClass: number
): number {
  assertPositiveU32(tileCapacityPerDispatchClass, "MaterialTileWork queue capacity");
  const bytes = GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT *
      GPU_MATERIAL_TILE_QUEUE_HEADER_STRIDE +
    GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT * tileCapacityPerDispatchClass *
      GPU_MATERIAL_TILE_WORK_RECORD_STRIDE;
  if (!Number.isSafeInteger(bytes)) {
    throw new RangeError("MaterialTileWork queue byte length is invalid");
  }
  return bytes;
}

export function materialTileQueueHeaderByteOffset(dispatchClassId: number): number {
  assertRange(
    dispatchClassId,
    GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT,
    "Material shading dispatch class"
  );
  return dispatchClassId * GPU_MATERIAL_TILE_QUEUE_HEADER_STRIDE;
}

export function materialTileWorkElementByteOffset(
  dispatchClassId: number,
  elementIndex: number,
  tileCapacityPerDispatchClass: number
): number {
  assertRange(
    dispatchClassId,
    GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT,
    "Material shading dispatch class"
  );
  assertPositiveU32(tileCapacityPerDispatchClass, "MaterialTileWork queue capacity");
  assertU32(elementIndex, "MaterialTileWork element index");
  if (elementIndex >= tileCapacityPerDispatchClass) {
    throw new RangeError("MaterialTileWork element index exceeds queue capacity");
  }
  const headerBytes = GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT *
    GPU_MATERIAL_TILE_QUEUE_HEADER_STRIDE;
  return headerBytes +
    (dispatchClassId * tileCapacityPerDispatchClass + elementIndex) *
      GPU_MATERIAL_TILE_WORK_RECORD_STRIDE;
}

export function materialTileDispatchIndirectByteLength(): number {
  return GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT *
    GPU_MATERIAL_TILE_DISPATCH_INDIRECT_STRIDE;
}

export function materialTileDispatchIndirectByteOffset(
  dispatchClassId: number
): number {
  assertRange(
    dispatchClassId,
    GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT,
    "Material shading dispatch class"
  );
  return dispatchClassId * GPU_MATERIAL_TILE_DISPATCH_INDIRECT_STRIDE;
}

/** CPU oracle for one correctness-critical per-dispatch-class reservation. */
export function reserveGpuMaterialTileWork(
  current: GpuMaterialTileQueueHeaderCpu,
  count: number
): Readonly<GpuMaterialTileWorkReservation> {
  validateGpuMaterialTileQueueHeader(current);
  assertU32(count, "MaterialTileWork reservation count");
  const attemptedCount = saturatingAddU32(current.attemptedCount, count);
  const fits = count > 0 && count <= current.capacity - current.writtenCount;
  const writtenCount = fits ? current.writtenCount + count : current.writtenCount;
  const next = Object.freeze({
    ...current,
    attemptedCount,
    writtenCount,
    overflowCount: attemptedCount - writtenCount
  });
  validateGpuMaterialTileQueueHeader(next);
  return Object.freeze({
    header: next,
    offset: fits ? current.writtenCount : null
  });
}

export function nextGpuMaterialTileWorkGeneration(current: number): number {
  assertU32(current, "MaterialTileWork generation");
  const next = (current + 1) >>> 0;
  return next === GPU_MATERIAL_TILE_WORK_INVALID_GENERATION ? 1 : next;
}

function validateGpuMaterialTileWork(work: GpuMaterialTileWorkCpu): void {
  assertU32(work.tileLinearId, "MaterialTileWork tileLinearId");
  assertRange(
    work.kernelClassId,
    GPU_MATERIAL_KERNEL_CLASS_COUNT,
    "MaterialTileWork kernelClassId"
  );
  assertRange(
    work.textureBindingSetId,
    TEXTURE_BINDING_SET_MAX_RESIDENT_SETS,
    "MaterialTileWork textureBindingSetId"
  );
  assertGeneration(work.generation, "MaterialTileWork generation");
}

function validateGpuMaterialTileQueueHeader(
  header: GpuMaterialTileQueueHeaderCpu
): void {
  for (const [name, value] of Object.entries(header)) assertU32(value, name);
  if (header.capacity === 0) {
    throw new RangeError("MaterialTileWork queue capacity must be positive");
  }
  if (header.writtenCount > header.capacity) {
    throw new RangeError("MaterialTileWork written count exceeds capacity");
  }
  if (header.consumedCount > header.writtenCount) {
    throw new RangeError("MaterialTileWork consumed count exceeds written count");
  }
  if (header.attemptedCount < header.writtenCount) {
    throw new RangeError("MaterialTileWork attempted count is below written count");
  }
  if (header.overflowCount !== header.attemptedCount - header.writtenCount) {
    throw new RangeError(
      "MaterialTileWork overflow count must equal attempted minus written"
    );
  }
  assertGeneration(header.generation, "MaterialTileWork queue generation");
}

function validateGpuMaterialClassificationControl(
  control: GpuMaterialClassificationControlCpu
): void {
  for (const [name, value] of Object.entries(control)) assertU32(value, name);
  if (control.frameInvalid !== 0 && control.frameInvalid !== 1) {
    throw new RangeError("Material classification frameInvalid must be 0 or 1");
  }
  assertGeneration(control.generation, "Material classification generation");
  assertDispatchClassCount(control.dispatchClassCount);
}

function assertDispatchClassCount(value: number): void {
  assertU32(value, "Material shading dispatch class count");
  if (value !== GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT) {
    throw new RangeError(
      `Material shading dispatch class count must equal ${GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT}`
    );
  }
}

function assertGeneration(value: number, label: string): void {
  assertU32(value, label);
  if (value === GPU_MATERIAL_TILE_WORK_INVALID_GENERATION) {
    throw new RangeError(`${label} must not use the invalid generation`);
  }
}

function assertRange(value: number, count: number, label: string): void {
  assertU32(value, label);
  if (value >= count) {
    throw new RangeError(`${label} ${value} is outside [0, ${count - 1}]`);
  }
}

function assertPositiveU32(value: number, label: string): void {
  assertU32(value, label);
  if (value === 0) throw new RangeError(`${label} must be a positive u32`);
}

function assertU32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${label} ${value} is outside u32`);
  }
}

function assertByteRange(
  bytes: Uint8Array,
  byteOffset: number,
  byteLength: number,
  label: string
): void {
  if (
    !Number.isSafeInteger(byteOffset) ||
    !Number.isSafeInteger(byteLength) ||
    byteOffset < 0 ||
    byteLength < 0 ||
    byteOffset + byteLength > bytes.byteLength
  ) {
    throw new RangeError(`${label} byte range is invalid`);
  }
}

function packU32(values: readonly number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new Uint32Array(values).buffer);
}

function saturatingAddU32(left: number, right: number): number {
  return Math.min(0xffffffff, left + right);
}

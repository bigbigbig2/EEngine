import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";

export const GPU_MATERIAL_KERNEL_ABI_VERSION = 1;

/** Bounded Standard PBR feature classes. Material count never changes this set. */
export const GPU_MATERIAL_KERNEL_CLASS = Object.freeze({
  BaseFactor: 0,
  BaseTexture: 1,
  BaseOrm: 2,
  BaseOrmNormal: 3,
  BaseOrmNormalEmissive: 4,
  Unlit: 5,
  GenericStandardPbrFallback: 6
} as const);

export const GPU_MATERIAL_KERNEL_CLASS_COUNT = 7;
export const GPU_SHADE_WORK_RECORD_STRIDE = 4;
export const GPU_SHADE_CLASS_STATE_STRIDE = 16;
export const GPU_SHADE_DRAW_INDIRECT_STRIDE = 16;
export const GPU_SHADE_CLASS_STATE_BYTES =
  GPU_MATERIAL_KERNEL_CLASS_COUNT * GPU_SHADE_CLASS_STATE_STRIDE;
export const GPU_SHADE_DRAW_INDIRECT_BYTES =
  GPU_MATERIAL_KERNEL_CLASS_COUNT * GPU_SHADE_DRAW_INDIRECT_STRIDE;
export const GPU_SHADE_CLASSIFICATION_WORKGROUP_SIZE = 256;

export interface GpuShadeWorkCapacity {
  readonly pixelCapacity: number;
  readonly workgroupCount: number;
  readonly dispatchWorkgroupsX: number;
  readonly dispatchWorkgroupsY: number;
  readonly queueBytes: number;
  readonly groupCountBytes: number;
  readonly groupPrefixBytes: number;
  readonly scanLevelElementCounts: readonly number[];
  readonly scanScratchBytes: number;
}

export function materialKernelClass(material: StandardShadeMaterial): number {
  if (material.is_unlit) return GPU_MATERIAL_KERNEL_CLASS.Unlit;
  const base = material.texture_albedo !== undefined;
  const normal = material.texture_normal !== undefined;
  const orm = material.texture_orm !== undefined;
  const emissive = material.texture_emissive !== undefined;
  if (!base && !normal && !orm && !emissive) return GPU_MATERIAL_KERNEL_CLASS.BaseFactor;
  if (base && !normal && !orm && !emissive) return GPU_MATERIAL_KERNEL_CLASS.BaseTexture;
  if (!normal && orm && !emissive) return GPU_MATERIAL_KERNEL_CLASS.BaseOrm;
  if (normal && !emissive) return GPU_MATERIAL_KERNEL_CLASS.BaseOrmNormal;
  if (normal && emissive) return GPU_MATERIAL_KERNEL_CLASS.BaseOrmNormalEmissive;
  return GPU_MATERIAL_KERNEL_CLASS.GenericStandardPbrFallback;
}

export function computeGpuShadeWorkCapacity(
  width: number,
  height: number,
  limits: Readonly<{
    maxBufferSize: number;
    maxStorageBufferBindingSize: number;
    maxComputeWorkgroupsPerDimension?: number;
  }>
): GpuShadeWorkCapacity {
  assertPositiveU32(width, "ShadeWork width");
  assertPositiveU32(height, "ShadeWork height");
  const pixelCapacity = safeMultiply(width, height, "ShadeWork pixel capacity");
  const workgroupCount = Math.ceil(pixelCapacity / GPU_SHADE_CLASSIFICATION_WORKGROUP_SIZE);
  const maxDispatch = Number(limits.maxComputeWorkgroupsPerDimension ?? 65_535);
  assertPositiveU32(maxDispatch, "maxComputeWorkgroupsPerDimension");
  const dispatchWorkgroupsY = Math.ceil(workgroupCount / maxDispatch);
  if (dispatchWorkgroupsY > maxDispatch) {
    throw new RangeError(
      `ShadeWork requires ${workgroupCount} workgroups but the 2D dispatch limit is ${maxDispatch}²`
    );
  }
  const dispatchWorkgroupsX = Math.ceil(workgroupCount / dispatchWorkgroupsY);
  const queueBytes = align4(safeMultiply(pixelCapacity, GPU_SHADE_WORK_RECORD_STRIDE, "ShadeWork queue bytes"));
  const groupElements = safeMultiply(workgroupCount, GPU_MATERIAL_KERNEL_CLASS_COUNT, "ShadeWork group counts");
  const groupCountBytes = align4(safeMultiply(groupElements, 4, "ShadeWork group-count bytes"));
  const scanLevelElementCounts: number[] = [];
  let elements = workgroupCount;
  do {
    const blocks = Math.ceil(elements / GPU_SHADE_CLASSIFICATION_WORKGROUP_SIZE);
    scanLevelElementCounts.push(blocks);
    elements = blocks;
  } while (elements > 1);
  let scanScratchBytes = 0;
  for (let level = 0; level < scanLevelElementCounts.length; level++) {
    const levelBytes = safeMultiply(
      scanLevelElementCounts[level]!,
      GPU_MATERIAL_KERNEL_CLASS_COUNT * 4,
      "ShadeWork scan level"
    );
    scanScratchBytes = safeAdd(
      scanScratchBytes,
      safeMultiply(levelBytes, level < scanLevelElementCounts.length - 1 ? 2 : 1, "ShadeWork scan buffers"),
      "ShadeWork scan scratch"
    );
  }
  const bindingLimit = Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize);
  for (const [label, bytes] of [["queue", queueBytes], ["group counts", groupCountBytes]] as const) {
    if (bytes > bindingLimit) {
      throw new RangeError(`ShadeWork ${label} requires ${bytes} bytes but the binding limit is ${bindingLimit}`);
    }
  }
  return Object.freeze({
    pixelCapacity,
    workgroupCount,
    dispatchWorkgroupsX,
    dispatchWorkgroupsY,
    queueBytes,
    groupCountBytes,
    groupPrefixBytes: groupCountBytes,
    scanLevelElementCounts: Object.freeze(scanLevelElementCounts),
    scanScratchBytes: align4(scanScratchBytes)
  });
}

/** CPU correctness oracle for the recursive GPU exclusive scan. */
export function exclusivePrefixSumReference(values: ArrayLike<number>): Uint32Array {
  if (!Number.isSafeInteger(values.length) || values.length < 0 || values.length > 0xffffffff) {
    throw new RangeError("Prefix-sum input length must be a u32");
  }
  const output = new Uint32Array(values.length);
  let sum = 0;
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new RangeError(`Prefix-sum value ${index} must be a u32`);
    }
    output[index] = sum;
    sum = safeAdd(sum, value, "Prefix-sum total");
  }
  return output;
}

export const GPU_MATERIAL_KERNEL_WGSL = /* wgsl */ `
const OENGINE_MATERIAL_KERNEL_BASE_FACTOR: u32 = ${GPU_MATERIAL_KERNEL_CLASS.BaseFactor}u;
const OENGINE_MATERIAL_KERNEL_BASE_TEXTURE: u32 = ${GPU_MATERIAL_KERNEL_CLASS.BaseTexture}u;
const OENGINE_MATERIAL_KERNEL_BASE_ORM: u32 = ${GPU_MATERIAL_KERNEL_CLASS.BaseOrm}u;
const OENGINE_MATERIAL_KERNEL_BASE_ORM_NORMAL: u32 = ${GPU_MATERIAL_KERNEL_CLASS.BaseOrmNormal}u;
const OENGINE_MATERIAL_KERNEL_BASE_ORM_NORMAL_EMISSIVE: u32 = ${GPU_MATERIAL_KERNEL_CLASS.BaseOrmNormalEmissive}u;
const OENGINE_MATERIAL_KERNEL_UNLIT: u32 = ${GPU_MATERIAL_KERNEL_CLASS.Unlit}u;
const OENGINE_MATERIAL_KERNEL_GENERIC_STANDARD_PBR: u32 = ${GPU_MATERIAL_KERNEL_CLASS.GenericStandardPbrFallback}u;
const OENGINE_MATERIAL_KERNEL_CLASS_COUNT: u32 = ${GPU_MATERIAL_KERNEL_CLASS_COUNT}u;
`;

function assertPositiveU32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffffffff) {
    throw new RangeError(`${label} must be a positive u32`);
  }
}

function safeMultiply(left: number, right: number, label: string): number {
  const value = left * right;
  if (!Number.isSafeInteger(value) || value > 0xffffffff) throw new RangeError(`${label} exceeds u32`);
  return value;
}

function safeAdd(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value > 0xffffffff) throw new RangeError(`${label} exceeds u32`);
  return value;
}

function align4(value: number): number {
  return (value + 3) & ~3;
}

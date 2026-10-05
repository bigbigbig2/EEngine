import {
  GPU_MATERIAL_VISIBILITY_RECORD_STRIDE,
  GPU_MATERIAL_VISIBILITY_RECORD_WGSL,
  packGpuMaterialVisibilityRecord,
  type GpuMaterialVisibilityPackedSource,
} from "./GpuMaterialVisibilityAbi.js";
import { decodeGpuShadingBinId, GPU_SHADING_PROGRAM_COUNT } from "./GpuShadingProgramAbi.js";
import { GPU_CLOSURE_MATERIAL_STRIDE, GPU_CLOSURE_MATERIAL_WGSL } from "./GpuClosureMaterialAbi.js";

export const GPU_SHADING_MATERIAL_ABI_VERSION = 7;
export const GPU_SHADING_MATERIAL_HEADER_STRIDE = 48;
export const GPU_SHADING_MATERIAL_RECORD_STRIDE =
  GPU_SHADING_MATERIAL_HEADER_STRIDE + GPU_MATERIAL_VISIBILITY_RECORD_STRIDE + GPU_CLOSURE_MATERIAL_STRIDE;
export const GPU_SHADING_TEXTURE_ROUTE_STRIDE = 64;
export const GPU_SHADING_TEXTURE_ROUTES_PER_MATERIAL = 10;
/** Publication-time facts, separate from Material Visibility payload flags. */
export const GPU_SHADING_MATERIAL_FLAGS = Object.freeze({
  /** Unlit base source is one texel; TextureResidency fills its physical layer and mips uniformly. */
  UniformBaseTexture: 1 << 0,
} as const);

export const GPU_SHADING_MATERIAL_HEADER_OFFSETS = Object.freeze({
  programId: 0,
  textureBindingSetId: 4,
  materialGeneration: 8,
  textureGeneration: 12,
  publicationRevision: 16,
  flags: 20,
  family: 24,
  featureMask: 28,
  temporalSignature: 32,
  samplingSignature: 36,
} as const);

export interface GpuShadingMaterialRecordHeader {
  readonly programId: number;
  readonly textureBindingSetId: number;
  readonly materialGeneration: number;
  readonly textureGeneration: number;
  readonly publicationRevision: number;
  readonly flags: number;
  readonly family?: number;
  readonly featureMask?: number;
}

export interface GpuShadingTextureRouteRecord {
  readonly textureRef: number;
  readonly textureGeneration: number;
  readonly publicationRevision: number;
  readonly textureBindingSetId: number;
  readonly residencySlot?: number;
  readonly residencyRevision?: number;
  readonly variationKnown?: boolean;
  readonly samplingSignature?: number;
  readonly variationLow?: readonly [number, number, number, number];
  readonly variationHigh?: readonly [number, number, number, number];
}

export function packGpuShadingMaterialRecord(
  header: GpuShadingMaterialRecordHeader,
  payload: GpuMaterialVisibilityPackedSource,
  closure?: Uint8Array,
): Uint8Array<ArrayBuffer> {
  validateHeader(header);
  const bytes = new Uint8Array(GPU_SHADING_MATERIAL_RECORD_STRIDE);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, header.programId, true);
  view.setUint32(4, header.textureBindingSetId, true);
  view.setUint32(8, header.materialGeneration, true);
  view.setUint32(12, header.textureGeneration, true);
  view.setUint32(16, header.publicationRevision, true);
  view.setUint32(20, header.flags, true);
  view.setUint32(24, header.family ?? 0, true);
  view.setUint32(28, header.featureMask ?? 0, true);
  const packedPayload = new Uint8Array(packGpuMaterialVisibilityRecord(payload));
  bytes.set(packedPayload, GPU_SHADING_MATERIAL_HEADER_STRIDE);
  if (closure !== undefined) {
    if (closure.byteLength !== GPU_CLOSURE_MATERIAL_STRIDE) {
      throw new RangeError("Shading closure material record has an invalid stride");
    }
    bytes.set(closure, GPU_SHADING_MATERIAL_HEADER_STRIDE + GPU_MATERIAL_VISIBILITY_RECORD_STRIDE);
  }
  // Content identity is per material, not the global publication generation.
  // One upload-time hash avoids hashing hundreds of material bytes per pixel.
  let signature = 2166136261;
  for (let index = GPU_SHADING_MATERIAL_HEADER_STRIDE; index < bytes.byteLength; index++) {
    signature = Math.imul(signature ^ bytes[index]!, 16777619) >>> 0;
  }
  view.setUint32(GPU_SHADING_MATERIAL_HEADER_OFFSETS.temporalSignature, signature, true);
  view.setUint32(GPU_SHADING_MATERIAL_HEADER_OFFSETS.samplingSignature, signature, true);
  return bytes;
}

export function unpackGpuShadingMaterialHeader(
  bytes: Uint8Array,
  byteOffset = 0,
): Readonly<GpuShadingMaterialRecordHeader & { readonly temporalSignature: number }> {
  if (
    !Number.isSafeInteger(byteOffset) ||
    byteOffset < 0 ||
    byteOffset + GPU_SHADING_MATERIAL_RECORD_STRIDE > bytes.byteLength
  ) {
    throw new RangeError("Shading material record range is invalid");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + byteOffset);
  const header = {
    programId: view.getUint32(0, true),
    textureBindingSetId: view.getUint32(4, true),
    materialGeneration: view.getUint32(8, true),
    textureGeneration: view.getUint32(12, true),
    publicationRevision: view.getUint32(16, true),
    flags: view.getUint32(20, true),
    family: view.getUint32(24, true),
    featureMask: view.getUint32(28, true),
    temporalSignature: view.getUint32(GPU_SHADING_MATERIAL_HEADER_OFFSETS.temporalSignature, true),
  };
  validateHeader(header);
  return Object.freeze(header);
}

export function packGpuShadingTextureRoute(route: GpuShadingTextureRouteRecord): Uint8Array<ArrayBuffer> {
  validateRoute(route);
  const bytes = new Uint8Array(GPU_SHADING_TEXTURE_ROUTE_STRIDE);
  const view = new DataView(bytes.buffer);
  [
    route.textureRef,
    route.textureGeneration,
    route.publicationRevision,
    route.textureBindingSetId,
    route.residencySlot ?? 0,
    route.residencyRevision ?? 0,
    Number(route.variationKnown ?? false),
    route.samplingSignature ?? 0,
  ].forEach((value, index) => view.setUint32(index * 4, value, true));
  (route.variationLow ?? [0, 0, 0, 0]).forEach((value, index) =>
    view.setFloat32(32 + index * 4, value, true),
  );
  (route.variationHigh ?? [1, 1, 1, 1]).forEach((value, index) =>
    view.setFloat32(48 + index * 4, value, true),
  );
  return bytes;
}

export function unpackGpuShadingTextureRoute(
  bytes: Uint8Array,
  byteOffset = 0,
): Readonly<GpuShadingTextureRouteRecord> {
  if (
    !Number.isSafeInteger(byteOffset) ||
    byteOffset < 0 ||
    byteOffset + GPU_SHADING_TEXTURE_ROUTE_STRIDE > bytes.byteLength
  ) {
    throw new RangeError("Shading texture route range is invalid");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + byteOffset);
  const route = {
    textureRef: view.getUint32(0, true),
    textureGeneration: view.getUint32(4, true),
    publicationRevision: view.getUint32(8, true),
    textureBindingSetId: view.getUint32(12, true),
    residencySlot: view.getUint32(16, true),
    residencyRevision: view.getUint32(20, true),
    variationKnown: view.getUint32(24, true) === 1,
    samplingSignature: view.getUint32(28, true),
    variationLow: [0, 1, 2, 3].map((index) => view.getFloat32(32 + index * 4, true)) as [
      number,
      number,
      number,
      number,
    ],
    variationHigh: [0, 1, 2, 3].map((index) => view.getFloat32(48 + index * 4, true)) as [
      number,
      number,
      number,
      number,
    ],
  };
  validateRoute(route);
  return Object.freeze(route);
}

export const GPU_SHADING_MATERIAL_WGSL = /* wgsl */ `
${GPU_MATERIAL_VISIBILITY_RECORD_WGSL}
${GPU_CLOSURE_MATERIAL_WGSL}
struct OEngineShadingMaterialRecord {
  program_id: u32,
  texture_binding_set_id: u32,
  material_generation: u32,
  texture_generation: u32,
  publication_revision: u32,
  flags: u32,
  family: u32,
  feature_mask: u32,
  temporal_signature: u32,
  sampling_signature: u32,
  _temporal_pad1: u32,
  _temporal_pad2: u32,
  payload: OEngineMaterialVisibilityRecord,
  closure: OEngineClosureMaterialRecord,
};

struct OEngineShadingTextureRoute {
  texture_ref: u32,
  texture_generation: u32,
  publication_revision: u32,
  texture_binding_set_id: u32,
  residency_slot: u32,
  residency_revision: u32,
  variation_known: u32,
  sampling_signature: u32,
  variation_low: vec4f,
  variation_high: vec4f,
};
`;

function validateHeader(header: GpuShadingMaterialRecordHeader): void {
  if (
    !Number.isInteger(header.programId) ||
    header.programId < 0 ||
    header.programId >= GPU_SHADING_PROGRAM_COUNT
  ) {
    throw new RangeError("Shading material program id must be in [0, 15]");
  }
  const bin = decodeGpuShadingBinId((header.textureBindingSetId << 4) | header.programId);
  if (bin.textureBindingSetId !== header.textureBindingSetId) {
    throw new RangeError("Shading material TextureBindingSet id must be in [0, 3]");
  }
  assertNonZeroU32(header.materialGeneration, "material generation");
  assertNonZeroU32(header.textureGeneration, "texture generation");
  assertNonZeroU32(header.publicationRevision, "publication revision");
  assertU32(header.flags, "material flags");
  assertU32(header.family ?? 0, "material family");
  assertU32(header.featureMask ?? 0, "material feature mask");
}

function validateRoute(route: GpuShadingTextureRouteRecord): void {
  assertU32(route.textureRef, "texture ref");
  assertU32(route.residencySlot ?? 0, "residency slot");
  assertU32(route.residencyRevision ?? 0, "residency revision");
  assertU32(route.samplingSignature ?? 0, "sampling signature");
  const low = route.variationLow ?? [0, 0, 0, 0],
    high = route.variationHigh ?? [1, 1, 1, 1];
  if (
    low.length !== 4 ||
    high.length !== 4 ||
    !low.every(
      (value, index) => Number.isFinite(value) && Number.isFinite(high[index]) && value <= high[index]!,
    )
  ) {
    throw new RangeError("Shading texture variation bounds are invalid");
  }
  assertNonZeroU32(route.textureGeneration, "texture route generation");
  assertNonZeroU32(route.publicationRevision, "texture route publication revision");
  if (
    !Number.isInteger(route.textureBindingSetId) ||
    route.textureBindingSetId < 0 ||
    route.textureBindingSetId > 3
  ) {
    throw new RangeError("Texture route TextureBindingSet id must be in [0, 3]");
  }
}

function assertNonZeroU32(value: number, label: string): void {
  assertU32(value, label);
  if (value === 0) throw new RangeError(`Shading ${label} must be non-zero`);
}

function assertU32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`Shading ${label} must be a u32`);
  }
}

import {
  GPU_MATERIAL_VISIBILITY_RECORD_STRIDE,
  GPU_MATERIAL_VISIBILITY_RECORD_WGSL,
  packGpuMaterialVisibilityRecord,
  type GpuMaterialVisibilityPackedSource
} from "./GpuMaterialVisibilityAbi.js";
import {
  decodeGpuShadingBinId,
  GPU_SHADING_PROGRAM_COUNT
} from "./GpuShadingProgramAbi.js";

export const GPU_SHADING_MATERIAL_ABI_VERSION = 3;
export const GPU_SHADING_MATERIAL_HEADER_STRIDE = 32;
export const GPU_SHADING_MATERIAL_RECORD_STRIDE =
  GPU_SHADING_MATERIAL_HEADER_STRIDE + GPU_MATERIAL_VISIBILITY_RECORD_STRIDE;
export const GPU_SHADING_TEXTURE_ROUTE_STRIDE = 16;
export const GPU_SHADING_TEXTURE_ROUTES_PER_MATERIAL = 5;

export const GPU_SHADING_MATERIAL_HEADER_OFFSETS = Object.freeze({
  programId: 0,
  textureBindingSetId: 4,
  materialGeneration: 8,
  textureGeneration: 12,
  publicationRevision: 16,
  flags: 20
} as const);

export interface GpuShadingMaterialRecordHeader {
  readonly programId: number;
  readonly textureBindingSetId: number;
  readonly materialGeneration: number;
  readonly textureGeneration: number;
  readonly publicationRevision: number;
  readonly flags: number;
}

export interface GpuShadingTextureRouteRecord {
  readonly textureRef: number;
  readonly textureGeneration: number;
  readonly publicationRevision: number;
  readonly textureBindingSetId: number;
}

export function packGpuShadingMaterialRecord(
  header: GpuShadingMaterialRecordHeader,
  payload: GpuMaterialVisibilityPackedSource
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
  const packedPayload = new Uint8Array(packGpuMaterialVisibilityRecord(payload));
  bytes.set(packedPayload, GPU_SHADING_MATERIAL_HEADER_STRIDE);
  return bytes;
}

export function unpackGpuShadingMaterialHeader(
  bytes: Uint8Array,
  byteOffset = 0
): Readonly<GpuShadingMaterialRecordHeader> {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 ||
      byteOffset + GPU_SHADING_MATERIAL_RECORD_STRIDE > bytes.byteLength) {
    throw new RangeError("Shading material record range is invalid");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + byteOffset);
  const header = {
    programId: view.getUint32(0, true),
    textureBindingSetId: view.getUint32(4, true),
    materialGeneration: view.getUint32(8, true),
    textureGeneration: view.getUint32(12, true),
    publicationRevision: view.getUint32(16, true),
    flags: view.getUint32(20, true)
  };
  validateHeader(header);
  return Object.freeze(header);
}

export function packGpuShadingTextureRoute(
  route: GpuShadingTextureRouteRecord
): Uint8Array<ArrayBuffer> {
  validateRoute(route);
  return new Uint8Array(new Uint32Array([
    route.textureRef,
    route.textureGeneration,
    route.publicationRevision,
    route.textureBindingSetId
  ]).buffer);
}

export function unpackGpuShadingTextureRoute(
  bytes: Uint8Array,
  byteOffset = 0
): Readonly<GpuShadingTextureRouteRecord> {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 ||
      byteOffset + GPU_SHADING_TEXTURE_ROUTE_STRIDE > bytes.byteLength) {
    throw new RangeError("Shading texture route range is invalid");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + byteOffset);
  const route = {
    textureRef: view.getUint32(0, true),
    textureGeneration: view.getUint32(4, true),
    publicationRevision: view.getUint32(8, true),
    textureBindingSetId: view.getUint32(12, true)
  };
  validateRoute(route);
  return Object.freeze(route);
}

export const GPU_SHADING_MATERIAL_WGSL = /* wgsl */ `
${GPU_MATERIAL_VISIBILITY_RECORD_WGSL}
struct OEngineShadingMaterialRecord {
  program_id: u32,
  texture_binding_set_id: u32,
  material_generation: u32,
  texture_generation: u32,
  publication_revision: u32,
  flags: u32,
  _header_pad0: u32,
  _header_pad1: u32,
  payload: OEngineMaterialVisibilityRecord,
};

struct OEngineShadingTextureRoute {
  texture_ref: u32,
  texture_generation: u32,
  publication_revision: u32,
  texture_binding_set_id: u32,
};
`;

function validateHeader(header: GpuShadingMaterialRecordHeader): void {
  if (!Number.isInteger(header.programId) || header.programId < 0 ||
      header.programId >= GPU_SHADING_PROGRAM_COUNT) {
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
}

function validateRoute(route: GpuShadingTextureRouteRecord): void {
  assertU32(route.textureRef, "texture ref");
  assertNonZeroU32(route.textureGeneration, "texture route generation");
  assertNonZeroU32(route.publicationRevision, "texture route publication revision");
  if (!Number.isInteger(route.textureBindingSetId) || route.textureBindingSetId < 0 ||
      route.textureBindingSetId > 3) {
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

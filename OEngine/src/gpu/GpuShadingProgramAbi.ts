import { TEXTURE_BINDING_SET_MAX_RESIDENT_SETS } from "./TextureBindingSetPolicy.js";

/** ADR-0013 compile-time shading identity shared by CPU publication and WGSL. */
export const GPU_SHADING_PROGRAM_ABI_VERSION = 1;
export const GPU_SHADING_DEPENDENCY_LUT_VERSION = 1;
export const GPU_SHADING_PROGRAM_COUNT = 16;
export const GPU_SHADING_PROGRAM_INVALID = 0xff;
export const GPU_SHADING_BIN_PROGRAM_MASK = 0x0f;
export const GPU_SHADING_BIN_TEXTURE_SET_SHIFT = 4;
export const GPU_SHADING_BIN_TEXTURE_SET_MASK = 0x30;
export const GPU_SHADING_BIN_RESERVED_MASK = 0xc0;

export const GPU_SHADING_PROGRAM = Object.freeze({
  UnlitFactor: 0,
  UnlitFactorColor: 1,
  UnlitTexture: 2,
  UnlitTextureColor: 3,
  PbrFactor: 4,
  PbrBase: 5,
  PbrOrm: 6,
  PbrBaseOrm: 7,
  PbrNormal: 8,
  PbrBaseNormal: 9,
  PbrOrmNormal: 10,
  PbrBaseOrmNormal: 11,
  PbrBaseOrmNormalEmissive: 12,
  PbrBaseEmissive: 13,
  PbrOrmNormalEmissive: 14,
  PbrGeneric: 15
} as const);

export const GPU_SHADING_DEPENDENCY = Object.freeze({
  AuthoredVertexColor: 1 << 0,
  Uv0: 1 << 1,
  Normal: 1 << 2,
  Tangent: 1 << 3,
  BaseTexture: 1 << 4,
  OrmTexture: 1 << 5,
  NormalTexture: 1 << 6,
  EmissiveTexture: 1 << 7,
  Lit: 1 << 8
} as const);

export const GPU_SHADING_DEPENDENCY_VALID_MASK = (1 << 9) - 1;

export type GpuShadingModel = "unlit" | "standard-pbr";

export interface GpuShadingMaterialProfile {
  readonly shadingModel: GpuShadingModel | (string & {});
  readonly hasBaseTexture: boolean;
  readonly hasOrmTexture: boolean;
  readonly hasNormalTexture: boolean;
  readonly hasEmissiveTexture: boolean;
  readonly textureBindingSetId: number;
}

export interface GpuShadingGeometryProfile {
  readonly hasAuthoredVertexColor: boolean;
  readonly hasUv0: boolean;
  readonly hasNormal: boolean;
  readonly hasTangent: boolean;
}

export interface GpuShadingIdentity {
  readonly dependencyMask: number;
  readonly programId: number;
  readonly textureBindingSetId: number;
  readonly binId: number;
}

export type ShadingIdentityPublicationErrorCode =
  | "UNSUPPORTED_SHADING_MODEL"
  | "MISSING_UV0"
  | "MISSING_NORMAL"
  | "MISSING_TANGENT"
  | "INVALID_TEXTURE_BINDING_SET"
  | "INVALID_DEPENDENCY_MASK";

export class ShadingIdentityPublicationError extends Error {
  readonly code: ShadingIdentityPublicationErrorCode;

  constructor(code: ShadingIdentityPublicationErrorCode, message: string) {
    super(message);
    this.name = "ShadingIdentityPublicationError";
    this.code = code;
  }
}

const LUT_LIT_BIT = 1 << 0;
const LUT_COLOR_BIT = 1 << 1;
const LUT_BASE_BIT = 1 << 2;
const LUT_ORM_BIT = 1 << 3;
const LUT_NORMAL_BIT = 1 << 4;
const LUT_EMISSIVE_BIT = 1 << 5;
const LUT_ENTRY_COUNT = 1 << 6;

/**
 * Versioned material/geometry dependency LUT. Invalid entries are 0xff. The
 * same frozen values are emitted into GPU_SHADING_PROGRAM_WGSL.
 */
export const GPU_SHADING_PROGRAM_LUT = Object.freeze(
  Array.from({ length: LUT_ENTRY_COUNT }, (_, index) => programForLutIndex(index))
);

export const GPU_SHADING_PROGRAM_NAMES = Object.freeze([
  "UnlitFactor",
  "UnlitFactorColor",
  "UnlitTexture",
  "UnlitTextureColor",
  "PbrFactor",
  "PbrBase",
  "PbrOrm",
  "PbrBaseOrm",
  "PbrNormal",
  "PbrBaseNormal",
  "PbrOrmNormal",
  "PbrBaseOrmNormal",
  "PbrBaseOrmNormalEmissive",
  "PbrBaseEmissive",
  "PbrOrmNormalEmissive",
  "PbrGeneric"
] as const);

export function deriveGpuShadingIdentity(
  material: GpuShadingMaterialProfile,
  geometry: GpuShadingGeometryProfile
): Readonly<GpuShadingIdentity> {
  validateTextureBindingSetId(material.textureBindingSetId);
  if (material.shadingModel !== "unlit" && material.shadingModel !== "standard-pbr") {
    throw new ShadingIdentityPublicationError(
      "UNSUPPORTED_SHADING_MODEL",
      `Unsupported shading model '${material.shadingModel}'`
    );
  }

  const usesAnyTexture = material.hasBaseTexture || material.hasOrmTexture ||
    material.hasNormalTexture || material.hasEmissiveTexture;
  if (usesAnyTexture && !geometry.hasUv0) {
    throw new ShadingIdentityPublicationError(
      "MISSING_UV0",
      "Textured shading requires geometry UV0"
    );
  }
  if (material.shadingModel === "standard-pbr" && !geometry.hasNormal) {
    throw new ShadingIdentityPublicationError(
      "MISSING_NORMAL",
      "Standard PBR shading requires geometry normals"
    );
  }
  if (material.hasNormalTexture && !geometry.hasTangent) {
    throw new ShadingIdentityPublicationError(
      "MISSING_TANGENT",
      "Normal-textured shading requires geometry tangents"
    );
  }
  if (material.shadingModel === "unlit" &&
      (material.hasOrmTexture || material.hasNormalTexture || material.hasEmissiveTexture)) {
    throw new ShadingIdentityPublicationError(
      "UNSUPPORTED_SHADING_MODEL",
      "Unlit V1 supports only factor and base texture dependencies"
    );
  }

  let dependencyMask = geometry.hasAuthoredVertexColor
    ? GPU_SHADING_DEPENDENCY.AuthoredVertexColor
    : 0;
  if (usesAnyTexture) dependencyMask |= GPU_SHADING_DEPENDENCY.Uv0;
  if (material.shadingModel === "standard-pbr") {
    dependencyMask |= GPU_SHADING_DEPENDENCY.Lit | GPU_SHADING_DEPENDENCY.Normal;
  }
  if (material.hasNormalTexture) dependencyMask |= GPU_SHADING_DEPENDENCY.Tangent;
  if (material.hasBaseTexture) dependencyMask |= GPU_SHADING_DEPENDENCY.BaseTexture;
  if (material.hasOrmTexture) dependencyMask |= GPU_SHADING_DEPENDENCY.OrmTexture;
  if (material.hasNormalTexture) dependencyMask |= GPU_SHADING_DEPENDENCY.NormalTexture;
  if (material.hasEmissiveTexture) dependencyMask |= GPU_SHADING_DEPENDENCY.EmissiveTexture;

  const programId = shadingProgramIdForDependencyMask(dependencyMask);
  const textureBindingSetId = shadingProgramUsesTextures(programId)
    ? material.textureBindingSetId
    : 0;
  return Object.freeze({
    dependencyMask,
    programId,
    textureBindingSetId,
    binId: encodeGpuShadingBinId(programId, textureBindingSetId)
  });
}

export function shadingProgramIdForDependencyMask(dependencyMask: number): number {
  validateDependencyMask(dependencyMask);
  const index = dependencyLutIndex(dependencyMask);
  const programId = GPU_SHADING_PROGRAM_LUT[index];
  if (programId === undefined || programId === GPU_SHADING_PROGRAM_INVALID) {
    throw new ShadingIdentityPublicationError(
      "INVALID_DEPENDENCY_MASK",
      `Dependency mask 0x${dependencyMask.toString(16)} is not a legal V1 shading combination`
    );
  }
  return programId;
}

export function shadingProgramUsesTextures(programId: number): boolean {
  validateProgramId(programId);
  return programId !== GPU_SHADING_PROGRAM.UnlitFactor &&
    programId !== GPU_SHADING_PROGRAM.UnlitFactorColor &&
    programId !== GPU_SHADING_PROGRAM.PbrFactor;
}

export function encodeGpuShadingBinId(
  programId: number,
  textureBindingSetId: number
): number {
  validateProgramId(programId);
  validateTextureBindingSetId(textureBindingSetId);
  return (textureBindingSetId << GPU_SHADING_BIN_TEXTURE_SET_SHIFT) | programId;
}

export function decodeGpuShadingBinId(binId: number): Readonly<{
  programId: number;
  textureBindingSetId: number;
}> {
  if (!Number.isInteger(binId) || binId < 0 || binId >= 64) {
    throw new RangeError("ShadingBinId must be in [0, 63]");
  }
  const programId = binId & GPU_SHADING_BIN_PROGRAM_MASK;
  const textureBindingSetId =
    (binId & GPU_SHADING_BIN_TEXTURE_SET_MASK) >>> GPU_SHADING_BIN_TEXTURE_SET_SHIFT;
  return Object.freeze({ programId, textureBindingSetId });
}

export const GPU_SHADING_PROGRAM_WGSL = /* wgsl */ `
const OENGINE_SHADING_PROGRAM_ABI_VERSION: u32 = ${GPU_SHADING_PROGRAM_ABI_VERSION}u;
const OENGINE_SHADING_DEPENDENCY_LUT_VERSION: u32 = ${GPU_SHADING_DEPENDENCY_LUT_VERSION}u;
const OENGINE_SHADING_PROGRAM_COUNT: u32 = ${GPU_SHADING_PROGRAM_COUNT}u;
const OENGINE_SHADING_PROGRAM_INVALID: u32 = ${GPU_SHADING_PROGRAM_INVALID}u;
const OENGINE_SHADING_BIN_PROGRAM_MASK: u32 = ${GPU_SHADING_BIN_PROGRAM_MASK}u;
const OENGINE_SHADING_BIN_TEXTURE_SET_SHIFT: u32 = ${GPU_SHADING_BIN_TEXTURE_SET_SHIFT}u;
const OENGINE_SHADING_BIN_TEXTURE_SET_MASK: u32 = ${GPU_SHADING_BIN_TEXTURE_SET_MASK}u;
const OENGINE_SHADING_BIN_RESERVED_MASK: u32 = ${GPU_SHADING_BIN_RESERVED_MASK}u;
const OENGINE_SHADING_DEPENDENCY_AUTHORED_VERTEX_COLOR: u32 = ${GPU_SHADING_DEPENDENCY.AuthoredVertexColor}u;
const OENGINE_SHADING_DEPENDENCY_UV0: u32 = ${GPU_SHADING_DEPENDENCY.Uv0}u;
const OENGINE_SHADING_DEPENDENCY_NORMAL: u32 = ${GPU_SHADING_DEPENDENCY.Normal}u;
const OENGINE_SHADING_DEPENDENCY_TANGENT: u32 = ${GPU_SHADING_DEPENDENCY.Tangent}u;
const OENGINE_SHADING_DEPENDENCY_BASE_TEXTURE: u32 = ${GPU_SHADING_DEPENDENCY.BaseTexture}u;
const OENGINE_SHADING_DEPENDENCY_ORM_TEXTURE: u32 = ${GPU_SHADING_DEPENDENCY.OrmTexture}u;
const OENGINE_SHADING_DEPENDENCY_NORMAL_TEXTURE: u32 = ${GPU_SHADING_DEPENDENCY.NormalTexture}u;
const OENGINE_SHADING_DEPENDENCY_EMISSIVE_TEXTURE: u32 = ${GPU_SHADING_DEPENDENCY.EmissiveTexture}u;
const OENGINE_SHADING_DEPENDENCY_LIT: u32 = ${GPU_SHADING_DEPENDENCY.Lit}u;
${GPU_SHADING_PROGRAM_NAMES.map((name, programId) =>
  `const OENGINE_SHADING_PROGRAM_${toWgslConstant(name)}: u32 = ${programId}u;`
).join("\n")}
const OENGINE_SHADING_PROGRAM_LUT: array<u32, ${LUT_ENTRY_COUNT}> = array<u32, ${LUT_ENTRY_COUNT}>(
  ${GPU_SHADING_PROGRAM_LUT.map((value) => `${value}u`).join(", ")}
);

fn oengine_shading_program_for_dependencies(dependency_mask: u32) -> u32 {
  let index =
    select(0u, ${LUT_LIT_BIT}u, (dependency_mask & ${GPU_SHADING_DEPENDENCY.Lit}u) != 0u) |
    select(0u, ${LUT_COLOR_BIT}u, (dependency_mask & ${GPU_SHADING_DEPENDENCY.AuthoredVertexColor}u) != 0u) |
    select(0u, ${LUT_BASE_BIT}u, (dependency_mask & ${GPU_SHADING_DEPENDENCY.BaseTexture}u) != 0u) |
    select(0u, ${LUT_ORM_BIT}u, (dependency_mask & ${GPU_SHADING_DEPENDENCY.OrmTexture}u) != 0u) |
    select(0u, ${LUT_NORMAL_BIT}u, (dependency_mask & ${GPU_SHADING_DEPENDENCY.NormalTexture}u) != 0u) |
    select(0u, ${LUT_EMISSIVE_BIT}u, (dependency_mask & ${GPU_SHADING_DEPENDENCY.EmissiveTexture}u) != 0u);
  return OENGINE_SHADING_PROGRAM_LUT[index];
}

fn oengine_shading_bin_id(program_id: u32, texture_binding_set_id: u32) -> u32 {
  return (texture_binding_set_id << OENGINE_SHADING_BIN_TEXTURE_SET_SHIFT) | program_id;
}

fn oengine_shading_bin_program_id(bin_id: u32) -> u32 {
  return bin_id & OENGINE_SHADING_BIN_PROGRAM_MASK;
}

fn oengine_shading_bin_texture_binding_set_id(bin_id: u32) -> u32 {
  return (bin_id & OENGINE_SHADING_BIN_TEXTURE_SET_MASK) >>
    OENGINE_SHADING_BIN_TEXTURE_SET_SHIFT;
}
`;

function programForLutIndex(index: number): number {
  const lit = (index & LUT_LIT_BIT) !== 0;
  const color = (index & LUT_COLOR_BIT) !== 0;
  const base = (index & LUT_BASE_BIT) !== 0;
  const orm = (index & LUT_ORM_BIT) !== 0;
  const normal = (index & LUT_NORMAL_BIT) !== 0;
  const emissive = (index & LUT_EMISSIVE_BIT) !== 0;
  if (!lit) {
    if (orm || normal || emissive) return GPU_SHADING_PROGRAM_INVALID;
    if (base) return color
      ? GPU_SHADING_PROGRAM.UnlitTextureColor
      : GPU_SHADING_PROGRAM.UnlitTexture;
    return color ? GPU_SHADING_PROGRAM.UnlitFactorColor : GPU_SHADING_PROGRAM.UnlitFactor;
  }
  const textureBits = (base ? 1 : 0) | (orm ? 2 : 0) |
    (normal ? 4 : 0) | (emissive ? 8 : 0);
  switch (textureBits) {
    case 0: return GPU_SHADING_PROGRAM.PbrFactor;
    case 1: return GPU_SHADING_PROGRAM.PbrBase;
    case 2: return GPU_SHADING_PROGRAM.PbrOrm;
    case 3: return GPU_SHADING_PROGRAM.PbrBaseOrm;
    case 4: return GPU_SHADING_PROGRAM.PbrNormal;
    case 5: return GPU_SHADING_PROGRAM.PbrBaseNormal;
    case 6: return GPU_SHADING_PROGRAM.PbrOrmNormal;
    case 7: return GPU_SHADING_PROGRAM.PbrBaseOrmNormal;
    case 9: return GPU_SHADING_PROGRAM.PbrBaseEmissive;
    case 14: return GPU_SHADING_PROGRAM.PbrOrmNormalEmissive;
    case 15: return GPU_SHADING_PROGRAM.PbrBaseOrmNormalEmissive;
    default: return GPU_SHADING_PROGRAM.PbrGeneric;
  }
}

function dependencyLutIndex(dependencyMask: number): number {
  return ((dependencyMask & GPU_SHADING_DEPENDENCY.Lit) !== 0 ? LUT_LIT_BIT : 0) |
    ((dependencyMask & GPU_SHADING_DEPENDENCY.AuthoredVertexColor) !== 0 ? LUT_COLOR_BIT : 0) |
    ((dependencyMask & GPU_SHADING_DEPENDENCY.BaseTexture) !== 0 ? LUT_BASE_BIT : 0) |
    ((dependencyMask & GPU_SHADING_DEPENDENCY.OrmTexture) !== 0 ? LUT_ORM_BIT : 0) |
    ((dependencyMask & GPU_SHADING_DEPENDENCY.NormalTexture) !== 0 ? LUT_NORMAL_BIT : 0) |
    ((dependencyMask & GPU_SHADING_DEPENDENCY.EmissiveTexture) !== 0 ? LUT_EMISSIVE_BIT : 0);
}

function validateDependencyMask(dependencyMask: number): void {
  if (!Number.isInteger(dependencyMask) || dependencyMask < 0 ||
      (dependencyMask & ~GPU_SHADING_DEPENDENCY_VALID_MASK) !== 0) {
    throw new ShadingIdentityPublicationError(
      "INVALID_DEPENDENCY_MASK",
      "Shading dependency mask contains invalid or reserved bits"
    );
  }
  const lit = (dependencyMask & GPU_SHADING_DEPENDENCY.Lit) !== 0;
  const uv = (dependencyMask & GPU_SHADING_DEPENDENCY.Uv0) !== 0;
  const normalAttribute = (dependencyMask & GPU_SHADING_DEPENDENCY.Normal) !== 0;
  const tangentAttribute = (dependencyMask & GPU_SHADING_DEPENDENCY.Tangent) !== 0;
  const usesTexture = (dependencyMask & (
    GPU_SHADING_DEPENDENCY.BaseTexture |
    GPU_SHADING_DEPENDENCY.OrmTexture |
    GPU_SHADING_DEPENDENCY.NormalTexture |
    GPU_SHADING_DEPENDENCY.EmissiveTexture
  )) !== 0;
  const normalTexture = (dependencyMask & GPU_SHADING_DEPENDENCY.NormalTexture) !== 0;
  if ((usesTexture && !uv) || (lit && !normalAttribute) ||
      (normalTexture && !tangentAttribute) || (tangentAttribute && !normalTexture)) {
    throw new ShadingIdentityPublicationError(
      "INVALID_DEPENDENCY_MASK",
      `Dependency mask 0x${dependencyMask.toString(16)} has inconsistent attributes`
    );
  }
}

function validateProgramId(programId: number): void {
  if (!Number.isInteger(programId) || programId < 0 || programId >= GPU_SHADING_PROGRAM_COUNT) {
    throw new RangeError(`ShadingProgramId must be in [0, ${GPU_SHADING_PROGRAM_COUNT - 1}]`);
  }
}

function validateTextureBindingSetId(textureBindingSetId: number): void {
  if (!Number.isInteger(textureBindingSetId) || textureBindingSetId < 0 ||
      textureBindingSetId >= TEXTURE_BINDING_SET_MAX_RESIDENT_SETS) {
    throw new ShadingIdentityPublicationError(
      "INVALID_TEXTURE_BINDING_SET",
      `TextureBindingSetId must be in [0, ${TEXTURE_BINDING_SET_MAX_RESIDENT_SETS - 1}]`
    );
  }
}

function toWgslConstant(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toUpperCase();
}

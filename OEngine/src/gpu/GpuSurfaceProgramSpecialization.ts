import {
  GPU_SHADING_DEPENDENCY,
  GPU_SHADING_PROGRAM,
  GPU_SHADING_PROGRAM_COUNT,
  GPU_SHADING_PROGRAM_NAMES,
} from "./GpuShadingProgramAbi.js";

/** Logical kernel demands. These bits do not describe attachments or bind groups. */
export const GPU_SURFACE_KERNEL_DEMAND = Object.freeze({
  ShadingSurface: 1 << 0,
  DiffuseSurface: 1 << 1,
  Motion: 1 << 2,
  EnvironmentIbl: 1 << 3,
} as const);
export const GPU_SURFACE_KERNEL_DEMAND_VALID_MASK = (1 << 4) - 1;

export interface GpuSurfaceProgramSpecialization {
  readonly programId: number;
  readonly name: string;
  readonly dependencyMask: number;
  readonly lit: boolean;
  readonly authoredVertexColor: "never" | "required" | "geometry-conditional";
  readonly baseTexture: "never" | "required" | "material-conditional";
  readonly ormTexture: "never" | "required" | "material-conditional";
  readonly normalTexture: "never" | "required" | "material-conditional";
  readonly emissiveTexture: "never" | "required" | "material-conditional";
  readonly occlusionTexture: "never" | "required" | "material-conditional";
  readonly reconstructTriangle: boolean;
  readonly outputDependencyMask: number;
  readonly publishesShadingSurface: boolean;
  readonly publishesDiffuseSurface: boolean;
  readonly publishesVelocity: boolean;
}

/** Extracted once from the published 16-family material dependency LUT. */
const FIXED_PROGRAM_DEPENDENCIES = Object.freeze([
  0,
  GPU_SHADING_DEPENDENCY.AuthoredVertexColor,
  GPU_SHADING_DEPENDENCY.Uv0 | GPU_SHADING_DEPENDENCY.BaseTexture,
  GPU_SHADING_DEPENDENCY.AuthoredVertexColor |
    GPU_SHADING_DEPENDENCY.Uv0 |
    GPU_SHADING_DEPENDENCY.BaseTexture,
  GPU_SHADING_DEPENDENCY.Normal | GPU_SHADING_DEPENDENCY.Lit,
  GPU_SHADING_DEPENDENCY.Normal |
    GPU_SHADING_DEPENDENCY.BaseTexture |
    GPU_SHADING_DEPENDENCY.Uv0 |
    GPU_SHADING_DEPENDENCY.Lit,
  GPU_SHADING_DEPENDENCY.Normal |
    GPU_SHADING_DEPENDENCY.OrmTexture |
    GPU_SHADING_DEPENDENCY.Uv0 |
    GPU_SHADING_DEPENDENCY.Lit,
  GPU_SHADING_DEPENDENCY.Normal |
    GPU_SHADING_DEPENDENCY.BaseTexture |
    GPU_SHADING_DEPENDENCY.OrmTexture |
    GPU_SHADING_DEPENDENCY.Uv0 |
    GPU_SHADING_DEPENDENCY.Lit,
  GPU_SHADING_DEPENDENCY.Normal |
    GPU_SHADING_DEPENDENCY.NormalTexture |
    GPU_SHADING_DEPENDENCY.Uv0 |
    GPU_SHADING_DEPENDENCY.Lit,
  GPU_SHADING_DEPENDENCY.Normal |
    GPU_SHADING_DEPENDENCY.BaseTexture |
    GPU_SHADING_DEPENDENCY.NormalTexture |
    GPU_SHADING_DEPENDENCY.Uv0 |
    GPU_SHADING_DEPENDENCY.Lit,
  GPU_SHADING_DEPENDENCY.Normal |
    GPU_SHADING_DEPENDENCY.OrmTexture |
    GPU_SHADING_DEPENDENCY.NormalTexture |
    GPU_SHADING_DEPENDENCY.Uv0 |
    GPU_SHADING_DEPENDENCY.Lit,
  GPU_SHADING_DEPENDENCY.Normal |
    GPU_SHADING_DEPENDENCY.BaseTexture |
    GPU_SHADING_DEPENDENCY.OrmTexture |
    GPU_SHADING_DEPENDENCY.NormalTexture |
    GPU_SHADING_DEPENDENCY.Uv0 |
    GPU_SHADING_DEPENDENCY.Lit,
  GPU_SHADING_DEPENDENCY.Normal |
    GPU_SHADING_DEPENDENCY.BaseTexture |
    GPU_SHADING_DEPENDENCY.OrmTexture |
    GPU_SHADING_DEPENDENCY.NormalTexture |
    GPU_SHADING_DEPENDENCY.EmissiveTexture |
    GPU_SHADING_DEPENDENCY.Uv0 |
    GPU_SHADING_DEPENDENCY.Lit,
  GPU_SHADING_DEPENDENCY.Normal |
    GPU_SHADING_DEPENDENCY.BaseTexture |
    GPU_SHADING_DEPENDENCY.EmissiveTexture |
    GPU_SHADING_DEPENDENCY.Uv0 |
    GPU_SHADING_DEPENDENCY.Lit,
  GPU_SHADING_DEPENDENCY.Normal |
    GPU_SHADING_DEPENDENCY.OrmTexture |
    GPU_SHADING_DEPENDENCY.NormalTexture |
    GPU_SHADING_DEPENDENCY.EmissiveTexture |
    GPU_SHADING_DEPENDENCY.Uv0 |
    GPU_SHADING_DEPENDENCY.Lit,
  GPU_SHADING_DEPENDENCY.Normal |
    GPU_SHADING_DEPENDENCY.BaseTexture |
    GPU_SHADING_DEPENDENCY.OrmTexture |
    GPU_SHADING_DEPENDENCY.NormalTexture |
    GPU_SHADING_DEPENDENCY.EmissiveTexture |
    GPU_SHADING_DEPENDENCY.OcclusionTexture |
    GPU_SHADING_DEPENDENCY.Uv0 |
    GPU_SHADING_DEPENDENCY.Lit,
]);

export function gpuSurfaceProgramSpecialization(
  programId: number,
  outputDependencyMask: number,
): Readonly<GpuSurfaceProgramSpecialization> {
  if (!Number.isInteger(programId) || programId < 0 || programId >= GPU_SHADING_PROGRAM_COUNT) {
    throw new RangeError("Shading program id must be in [0, 15]");
  }
  if (
    !Number.isInteger(outputDependencyMask) ||
    outputDependencyMask < 0 ||
    (outputDependencyMask & ~GPU_SURFACE_KERNEL_DEMAND_VALID_MASK) !== 0
  ) {
    throw new RangeError("Surface kernel demand mask has reserved bits");
  }
  const dependencyMask = FIXED_PROGRAM_DEPENDENCIES[programId]!;
  const generic = programId === GPU_SHADING_PROGRAM.PbrGeneric;
  const lit = programId >= GPU_SHADING_PROGRAM.PbrFactor;
  const has = (dependency: number): boolean => (dependencyMask & dependency) !== 0;
  return Object.freeze({
    programId,
    name: GPU_SHADING_PROGRAM_NAMES[programId]!,
    dependencyMask,
    lit,
    authoredVertexColor: lit
      ? "geometry-conditional"
      : has(GPU_SHADING_DEPENDENCY.AuthoredVertexColor)
        ? "required"
        : "never",
    baseTexture: generic
      ? "material-conditional"
      : has(GPU_SHADING_DEPENDENCY.BaseTexture)
        ? "required"
        : "never",
    ormTexture: generic
      ? "material-conditional"
      : has(GPU_SHADING_DEPENDENCY.OrmTexture)
        ? "required"
        : "never",
    normalTexture: generic
      ? "material-conditional"
      : has(GPU_SHADING_DEPENDENCY.NormalTexture)
        ? "required"
        : "never",
    emissiveTexture: generic
      ? "material-conditional"
      : has(GPU_SHADING_DEPENDENCY.EmissiveTexture)
        ? "required"
        : "never",
    occlusionTexture: generic ? "material-conditional" : "never",
    reconstructTriangle:
      lit ||
      programId !== GPU_SHADING_PROGRAM.UnlitFactor ||
      (outputDependencyMask & GPU_SURFACE_KERNEL_DEMAND.Motion) !== 0,
    outputDependencyMask,
    publishesShadingSurface: (outputDependencyMask & GPU_SURFACE_KERNEL_DEMAND.ShadingSurface) !== 0,
    publishesDiffuseSurface: (outputDependencyMask & GPU_SURFACE_KERNEL_DEMAND.DiffuseSurface) !== 0,
    publishesVelocity: (outputDependencyMask & GPU_SURFACE_KERNEL_DEMAND.Motion) !== 0,
  });
}

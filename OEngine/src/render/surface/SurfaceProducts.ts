import { GPU_SHADING_PROGRAM_COUNT } from "../../gpu/GpuShadingProgramAbi.js";
import type { SurfaceKernelProfile } from "../../shaders/surface_material_kernel.js";

/** Logical values; none of these names promises a physical attachment. */
export const SURFACE_PRODUCT = Object.freeze({
  Radiance: "radiance",
  GeometricNormal: "geometric-normal",
  ShadingNormal: "shading-normal",
  Motion: "motion",
  MaterialIdentity: "material-identity"
} as const);

export type SurfaceProductKind = typeof SURFACE_PRODUCT[keyof typeof SURFACE_PRODUCT];
export type SurfaceProductContract = Readonly<{
  kind: SurfaceProductKind;
  resolution: "internal-full";
  coverage: "opaque-visibility-hit";
  missing: "no-hit-or-explicit-error";
  space: string;
  units: string;
  precision: "floating-point" | "integer-exact";
  colorSpace: "linear-working-space" | "not-color";
  exposure: "pre-exposed" | "not-radiance";
  filter: "none" | "reconstruct-with-identity";
  temporalIdentity: "scene-object-material-geometry-generation";
}>;

export const SURFACE_PRODUCT_CONTRACTS: Readonly<Record<SurfaceProductKind, SurfaceProductContract>> = Object.freeze({
  radiance: Object.freeze({
    kind: "radiance", resolution: "internal-full", coverage: "opaque-visibility-hit",
    missing: "no-hit-or-explicit-error", space: "scene-linear-pre-exposed", units: "relative-radiance",
    precision: "floating-point", colorSpace: "linear-working-space", exposure: "pre-exposed",
    filter: "reconstruct-with-identity", temporalIdentity: "scene-object-material-geometry-generation"
  }),
  "geometric-normal": Object.freeze({
    kind: "geometric-normal", resolution: "internal-full", coverage: "opaque-visibility-hit",
    missing: "no-hit-or-explicit-error", space: "world", units: "unit-vector",
    precision: "floating-point", colorSpace: "not-color", exposure: "not-radiance",
    filter: "none", temporalIdentity: "scene-object-material-geometry-generation"
  }),
  "shading-normal": Object.freeze({
    kind: "shading-normal", resolution: "internal-full", coverage: "opaque-visibility-hit",
    missing: "no-hit-or-explicit-error", space: "world", units: "unit-vector",
    precision: "floating-point", colorSpace: "not-color", exposure: "not-radiance",
    filter: "reconstruct-with-identity", temporalIdentity: "scene-object-material-geometry-generation"
  }),
  motion: Object.freeze({
    kind: "motion", resolution: "internal-full", coverage: "opaque-visibility-hit",
    missing: "no-hit-or-explicit-error", space: "current-uv-minus-previous-uv", units: "normalized-view",
    precision: "floating-point", colorSpace: "not-color", exposure: "not-radiance",
    filter: "none", temporalIdentity: "scene-object-material-geometry-generation"
  }),
  "material-identity": Object.freeze({
    kind: "material-identity", resolution: "internal-full", coverage: "opaque-visibility-hit",
    missing: "no-hit-or-explicit-error", space: "scene-publication", units: "stable-generation-key",
    precision: "integer-exact", colorSpace: "not-color", exposure: "not-radiance",
    filter: "none", temporalIdentity: "scene-object-material-geometry-generation"
  })
});

/** A program depends only on source, layout, negotiated capability and kernel specialization. */
export interface SurfaceProgramClosure {
  readonly kernel: Readonly<SurfaceKernelProfile>;
  readonly virtualGeometry: boolean;
  readonly lighting: "unlit" | "direct";
  readonly source: string;
  readonly layoutSignature: string;
  readonly capabilityFingerprint: string;
  readonly formatProfile: string;
}

export function surfaceProgramKey(closure: Readonly<SurfaceProgramClosure>): string {
  const { kernel } = closure;
  if (!Number.isInteger(kernel.programId) || kernel.programId < 0 ||
      kernel.programId >= GPU_SHADING_PROGRAM_COUNT) throw new RangeError("Surface programId is invalid");
  for (const [name, value] of [
    ["outputDependencyMask", kernel.outputDependencyMask],
    ["textureBankMask", kernel.textureBankMask]
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new RangeError(`Surface ${name} is invalid`);
    }
  }
  if (closure.lighting !== "unlit" && closure.lighting !== "direct") {
    throw new RangeError("Surface lighting specialization is invalid");
  }
  for (const [name, value] of [
    ["source", closure.source], ["layoutSignature", closure.layoutSignature],
    ["capabilityFingerprint", closure.capabilityFingerprint], ["formatProfile", closure.formatProfile]
  ] as const) {
    if (value.length === 0) throw new RangeError(`Surface ${name} is required`);
  }
  return JSON.stringify([
    1, kernel.programId, kernel.outputDependencyMask, kernel.textureBankMask,
    closure.virtualGeometry, closure.lighting, closure.layoutSignature,
    closure.capabilityFingerprint, closure.formatProfile, closure.source
  ]);
}

/** Binding lifetime is a Scene/Product publication; the resource objects remain in the owning GPU revision. */
export interface SurfaceBindingRevision {
  readonly programKey: string;
  readonly publicationRevision: number;
  readonly materialGeneration: number;
  readonly textureGeneration: number;
  readonly sceneResourceEpoch: number;
  readonly deviceEpoch: number;
}

export function surfaceBindingRevision(input: SurfaceBindingRevision): Readonly<SurfaceBindingRevision> {
  if (input.programKey.length === 0) throw new RangeError("Surface binding requires a program");
  for (const [name, value] of Object.entries(input).filter(([name]) => name !== "programKey")) {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
      throw new RangeError(`Surface binding ${name} must be a non-negative integer`);
    }
  }
  return Object.freeze({ ...input });
}

import { GPU_SHADING_PROGRAM_COUNT } from "../../gpu/GpuShadingProgramAbi.js";
import { gpuSurfaceProgramSpecialization, GPU_SURFACE_KERNEL_DEMAND_VALID_MASK } from "../../gpu/GpuSurfaceProgramSpecialization.js";
import type { SurfaceKernelProfile } from "../../shaders/surface_material_kernel.js";
import { GPU_TEXTURE_BANK_ALL_MASK } from "../../gpu/GpuTextureRefAbi.js";

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
  if ((kernel.outputDependencyMask & ~GPU_SURFACE_KERNEL_DEMAND_VALID_MASK) !== 0) {
    throw new RangeError("Surface kernel demand has reserved bits");
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

/** Semantic resource closure for the selected kernel, before physical bind-group lowering. */
export type SurfaceResourceRole =
  | "shading-work" | "shading-work-classes" | "meshlet-work" | "material-records"
  | "frame-view" | "radiance-output" | "motion-output"
  | "instance-records" | "geometry-metadata" | "vertex-payload" | "visibility-depth"
  | "virtual-product-metadata" | "virtual-product-banks"
  | "texture-routes" | "texture-banks" | "texture-samplers"
  | "direct-light-records" | "direct-light-cluster-lookup"
  | "direct-light-cluster-data" | "direct-light-cluster-params"
  | "physical-environment-sun" | "physical-environment-transmittance"
  | "physical-sky-irradiance" | "physical-sky-irradiance-sampler";

export interface SurfaceMaterialRequirements {
  readonly roles: readonly SurfaceResourceRole[];
  readonly textureBankMask: number;
  readonly triangleReconstruction: boolean;
  readonly directLighting: boolean;
}

/** Only material and consumer demand decide this set; publication revisions cannot change it. */
export function surfaceMaterialRequirements(
  closure: Readonly<SurfaceProgramClosure>
): Readonly<SurfaceMaterialRequirements> {
  surfaceProgramKey(closure);
  const s = gpuSurfaceProgramSpecialization(
    closure.kernel.programId, closure.kernel.outputDependencyMask
  );
  if (s.lit && closure.lighting !== "direct") {
    throw new RangeError("Lit Surface program requires direct-light evaluation");
  }
  const roles: SurfaceResourceRole[] = [
    "shading-work", "shading-work-classes", "meshlet-work", "material-records",
    "frame-view", "radiance-output", "motion-output"
  ];
  if (s.reconstructTriangle) {
    roles.push("instance-records", "geometry-metadata", "vertex-payload", "visibility-depth");
    if (closure.virtualGeometry) roles.push("virtual-product-metadata", "virtual-product-banks");
  }
  const textured = s.baseTexture !== "never" || s.ormTexture !== "never" ||
    s.normalTexture !== "never" || s.emissiveTexture !== "never" ||
    s.occlusionTexture !== "never";
  if (textured) {
    if (closure.kernel.textureBankMask === 0 ||
        (closure.kernel.textureBankMask & ~GPU_TEXTURE_BANK_ALL_MASK) !== 0) {
      throw new RangeError("Textured Surface program requires a texture bank");
    }
    roles.push("texture-routes", "texture-banks", "texture-samplers");
  } else if (closure.kernel.textureBankMask !== 0) {
    throw new RangeError("Texture banks have no Surface consumer");
  }
  if (s.lit && closure.lighting === "direct") {
    roles.push("direct-light-records", "direct-light-cluster-lookup",
      "direct-light-cluster-data", "direct-light-cluster-params",
      "physical-environment-sun", "physical-sky-irradiance", "physical-sky-irradiance-sampler",
      "physical-environment-transmittance",
      "motion-output");
  }
  return Object.freeze({
    roles: Object.freeze(roles),
    textureBankMask: closure.kernel.textureBankMask,
    triangleReconstruction: s.reconstructTriangle,
    directLighting: s.lit && closure.lighting === "direct"
  });
}

/** A publication is complete only if every demanded role resolves to a live resource. */
export function closeSurfaceBindings(
  closure: Readonly<SurfaceProgramClosure>,
  revision: SurfaceBindingRevision,
  resources: Readonly<Partial<Record<SurfaceResourceRole, object>>>
): Readonly<{ revision: Readonly<SurfaceBindingRevision>; resources: Readonly<Partial<Record<SurfaceResourceRole, object>>> }> {
  const programKey = surfaceProgramKey(closure);
  const identity = surfaceBindingRevision(revision);
  if (identity.programKey !== programKey) throw new Error("Surface binding program identity mismatch");
  const required = surfaceMaterialRequirements(closure).roles;
  for (const role of required) {
    if (resources[role] === undefined) throw new Error(`Surface binding missing ${role}`);
  }
  for (const role of Object.keys(resources) as SurfaceResourceRole[]) {
    if (!required.includes(role)) throw new Error(`Surface binding ${role} has no consumer`);
  }
  return Object.freeze({ revision: identity, resources: Object.freeze({ ...resources }) });
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

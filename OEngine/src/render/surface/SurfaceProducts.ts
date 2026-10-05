/** Logical values; none of these names promises a physical attachment. */
export const SURFACE_PRODUCT = Object.freeze({
  Radiance: "radiance",
  GeometricNormal: "geometric-normal",
  ShadingNormal: "shading-normal",
  PerceptualRoughness: "perceptual-roughness",
  IndirectVisibility: "indirect-visibility",
  MaterialIdentity: "material-identity",
} as const);

export type SurfaceProductKind = (typeof SURFACE_PRODUCT)[keyof typeof SURFACE_PRODUCT];
export type SurfaceProductContract = Readonly<{
  kind: SurfaceProductKind;
  resolution: "internal-full";
  coverage: "opaque-visibility-hit" | "full-internal";
  missing: "no-hit-or-explicit-error" | "neutral-one";
  space: string;
  units: string;
  precision: "floating-point" | "integer-exact";
  colorSpace: "linear-working-space" | "not-color";
  exposure: "pre-exposed" | "not-radiance";
  filter: "none" | "reconstruct-with-identity";
  temporalIdentity: "scene-object-material-geometry-generation" | "current-frame-only";
}>;

export const SURFACE_PRODUCT_CONTRACTS: Readonly<Record<SurfaceProductKind, SurfaceProductContract>> =
  Object.freeze({
    radiance: Object.freeze({
      kind: "radiance",
      resolution: "internal-full",
      coverage: "opaque-visibility-hit",
      missing: "no-hit-or-explicit-error",
      space: "scene-linear-pre-exposed",
      units: "relative-radiance",
      precision: "floating-point",
      colorSpace: "linear-working-space",
      exposure: "pre-exposed",
      filter: "reconstruct-with-identity",
      temporalIdentity: "scene-object-material-geometry-generation",
    }),
    "geometric-normal": Object.freeze({
      kind: "geometric-normal",
      resolution: "internal-full",
      coverage: "opaque-visibility-hit",
      missing: "no-hit-or-explicit-error",
      space: "world",
      units: "unit-vector",
      precision: "floating-point",
      colorSpace: "not-color",
      exposure: "not-radiance",
      filter: "none",
      temporalIdentity: "scene-object-material-geometry-generation",
    }),
    "shading-normal": Object.freeze({
      kind: "shading-normal",
      resolution: "internal-full",
      coverage: "opaque-visibility-hit",
      missing: "no-hit-or-explicit-error",
      space: "world",
      units: "unit-vector",
      precision: "floating-point",
      colorSpace: "not-color",
      exposure: "not-radiance",
      filter: "reconstruct-with-identity",
      temporalIdentity: "scene-object-material-geometry-generation",
    }),
    "perceptual-roughness": Object.freeze({
      kind: "perceptual-roughness",
      resolution: "internal-full",
      coverage: "opaque-visibility-hit",
      missing: "no-hit-or-explicit-error",
      space: "material-closure",
      units: "perceptual-[0,1]",
      precision: "floating-point",
      colorSpace: "not-color",
      exposure: "not-radiance",
      filter: "reconstruct-with-identity",
      temporalIdentity: "scene-object-material-geometry-generation",
    }),
    "indirect-visibility": Object.freeze({
      kind: "indirect-visibility",
      resolution: "internal-full",
      coverage: "full-internal",
      missing: "neutral-one",
      space: "screen-space",
      units: "visibility-[0,1]",
      precision: "floating-point",
      colorSpace: "not-color",
      exposure: "not-radiance",
      filter: "none",
      temporalIdentity: "current-frame-only",
    }),
    "material-identity": Object.freeze({
      kind: "material-identity",
      resolution: "internal-full",
      coverage: "opaque-visibility-hit",
      missing: "no-hit-or-explicit-error",
      space: "scene-publication",
      units: "stable-generation-key",
      precision: "integer-exact",
      colorSpace: "not-color",
      exposure: "not-radiance",
      filter: "none",
      temporalIdentity: "scene-object-material-geometry-generation",
    }),
  });

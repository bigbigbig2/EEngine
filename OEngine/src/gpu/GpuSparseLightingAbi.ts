/** Signal packet ABI. A pixel owns at most one packet with a three-bit lobe
 * mask; target references select either a current primary or previous sample.
 * The full pixel-capacity allocation is an exact bound, not a work estimate. */
export const SPARSE_LIGHTING_SIGNAL_COUNT = 3;
/** Three independently scheduled lobes plus diffuse environment irradiance.
 * The fourth plane shares diffuse references/age; albedo remains per target. */
export const SPARSE_LIGHTING_RADIANCE_LAYERS = 4;
/** Exact f32 position/signed depth plus two f32 octahedral normal pairs.
 * View vectors come from the authoritative current/previous camera. Roughness
 * stays in current fields and its independent change signature. */
export const SPARSE_LIGHTING_GUIDE_LAYERS = 2;
export const SPARSE_LIGHTING_SETTINGS_BYTES = 128;
export const SPARSE_LIGHTING_PACKET_BYTES = 8;
export const SPARSE_LIGHTING_REFERENCE_BYTES = 16;
export const SPARSE_LIGHTING_HISTORY_NAMES = Object.freeze([
  "lighting-diffuse", "lighting-specular", "lighting-coat"
] as const);

/** Initial explicit calibration policy; final continuous-image acceptance
 * determines its production quality budget. These are decision tolerances,
 * not a claimed radiance/AAA error bound. */
export const SPARSE_LIGHTING_POLICY = Object.freeze({
  spatialNormalCosine: 0.99996, spatialRelativePosition: 0.001, // local-plane residual / view depth
  temporalNormalCosine: 0.99999, temporalRelativePosition: 0.0005,
  specularMinimumRoughness: 0.25, specularViewCosine: 0.999995,
  maxAge: [8, 4, 2] as const
});

export interface SparseLightingProfile {
  readonly direct: boolean;
  readonly vsm: boolean;
  readonly environment: boolean;
  readonly ao: boolean;
  readonly product: boolean;
}
export function sparseLightingProfileKey(profile: SparseLightingProfile): string {
  return `${Number(profile.direct)}${Number(profile.vsm)}${Number(profile.environment)}${Number(profile.ao)}${Number(profile.product)}`;
}

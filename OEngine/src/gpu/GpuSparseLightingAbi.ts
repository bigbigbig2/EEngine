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

/**
 * Surface V3 lighting diagnostics.  These words are written by the single
 * packet dispatch and are intentionally independent from SurfaceWork's
 * classify/indirect counter block.
 */
export const SPARSE_LIGHTING_COUNTER = Object.freeze({
  diffusePackets: 0,
  specularPackets: 1,
  coatPackets: 2,
  iblPackets: 3,
  fullRateExceptions: 4,
  directEvaluations: 5,
  iblEvaluations: 6,
  aoRejects: 7,
  vsmRejects: 8,
  overflowFlags: 9,
  bytesWritten: 10,
  dispatchCount: 11,
  recordsConsidered: 12,
  invalidRecords: 13,
  diffuseDisabled: 14,
  specularDisabled: 15,
  coatDisabled: 16,
  iblDisabled: 17,
  shadowEvaluations: 18,
  environmentDisabled: 19
} as const);
export const SPARSE_LIGHTING_COUNTER_WORDS = 20;
export const SPARSE_LIGHTING_COUNTER_BYTES = SPARSE_LIGHTING_COUNTER_WORDS * 4;

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

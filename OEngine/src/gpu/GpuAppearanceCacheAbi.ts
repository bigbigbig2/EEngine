/** DependencySamplePages: bounded exact filtered-field cache. Every logical
 * address includes the complete input footprint; stored values need no second
 * filtering. A hash is only an index, never proof of identity. */
export const APPEARANCE_FIELD_NAMES = Object.freeze([
  "baseColor", "alpha", "metallic", "roughness", "occlusion", "emissive", "normalTS",
  "ior", "specularWeight", "specularColor", "coatWeight", "coatRoughness", "coatNormalTS",
  "normalTSValidity", "coatNormalTSValidity"
] as const);
export type AppearanceFieldName = typeof APPEARANCE_FIELD_NAMES[number];
export const APPEARANCE_FIELD_WIDTHS = Object.freeze([3, 1, 1, 1, 1, 3, 3, 1, 1, 3, 1, 1, 3, 1, 1]);
export const APPEARANCE_FIELD_COUNT = APPEARANCE_FIELD_NAMES.length;
/** Physical Surface publication packs vec3 fields with their scalar consumers.
 * Logical compiler outputs/versions retain independent identities. */
export const APPEARANCE_SURFACE_LAYER_COUNT = 6;
/** Exact stable Surface cache identity words. Hash is only the first index. */
export const APPEARANCE_SURFACE_CACHE_KEY_WORDS = 9;
/** High bit in surface publication identity.w marks fields that depend on
 * geometry, texture footprint, dynamic, view or nonlocal inputs. Such entries
 * must not be reused by the stable material cache until their full input
 * identity is published. The low bits retain the surface program index. */
export const SURFACE_PUBLICATION_IDENTITY_UNCACHEABLE = 0x80000000;
/** Six physical layers and one slot record for two independently versioned
 * validity outputs packed into the previously unused flags lane. */
export const APPEARANCE_PACKED_SLOT_RECORD_COUNT = APPEARANCE_SURFACE_LAYER_COUNT + 1;
export const APPEARANCE_SURFACE_CHANNELS: readonly (readonly [number, number])[] = Object.freeze([
  [0, 0], [0, 3], [5, 0], [2, 3], [1, 3], [1, 0], [2, 0],
  [5, 1], [3, 3], [3, 0], [5, 2], [4, 3], [4, 0], [5, 3], [5, 3]
]);
export const APPEARANCE_SURFACE_READ_WGSL = /* wgsl */ `
fn surface_field(fields: texture_2d_array<f32>, pixel: vec2i, field: u32) -> vec4f {
  switch field {
${APPEARANCE_SURFACE_CHANNELS.map(([layer, channel],field)=>
  `    case ${field}u: { let v=textureLoad(fields,pixel,${layer},0); return ${field>=13 ? `vec4f(f32((u32(v.w)>>${field-13}u)&1u),0.0,0.0,0.0)` : APPEARANCE_FIELD_WIDTHS[field]===3?"vec4f(v.xyz,0.0)":`vec4f(v[${channel}],0.0,0.0,0.0)`}; }`).join("\n")}
    default: { return vec4f(0.0); }
  }
}
`;
export const APPEARANCE_DEMAND_STRIDE = 16;
export const APPEARANCE_PAGE_EMPTY = 0xffffffff;
export const APPEARANCE_CACHE_WAYS = 4;
export const APPEARANCE_CACHE_PAGE_SAMPLES = 64;
export const APPEARANCE_CACHE_CONTROL_BYTES = 32;

export interface AppearanceCacheBudget {
  readonly pages: number;
  readonly maxDemandTasks: number;
  readonly maxBytes: number;
  readonly maxAge: number;
}
export const DEFAULT_APPEARANCE_CACHE_BUDGET: AppearanceCacheBudget = Object.freeze({
  pages: 1024, maxDemandTasks: 1_048_576, maxBytes: 128 * 1024 * 1024, maxAge: 120
});

/** Each group has its own stride, so constants and scalar fields do not pay
 * a default full closure/result representation. Metadata stays integer-exact. */
export function appearancePageLayout(inputVectors: number, width: number, pages: number) {
  if (!Number.isInteger(inputVectors) || inputVectors < 0 || inputVectors > 64 ||
      !Number.isInteger(width) || width < 1 || width > 4 ||
      !Number.isInteger(pages) || pages < 1 || (pages & (pages - 1)) !== 0) {
    throw new RangeError("Invalid Appearance page shape");
  }
  const samples = pages * APPEARANCE_CACHE_PAGE_SAMPLES;
  const metadataWords = 8;
  const signatureWords = inputVectors * 4;
  const valueWord = metadataWords + signatureWords;
  const strideWords = valueWord + width;
  return Object.freeze({ samples, sets: samples / APPEARANCE_CACHE_WAYS,
    metadataWords, signatureWords, valueWord, strideWords, bytes: samples * strideWords * 4 });
}

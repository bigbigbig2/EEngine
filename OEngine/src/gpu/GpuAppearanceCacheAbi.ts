/** DependencySamplePages: bounded exact filtered-field cache. Every logical
 * address includes the complete input footprint; stored values need no second
 * filtering. A hash is only an index, never proof of identity. */
export const APPEARANCE_FIELD_NAMES = Object.freeze([
  "baseColor", "alpha", "metallic", "roughness", "occlusion", "emissive", "normalTS",
  "ior", "specularWeight", "specularColor", "coatWeight", "coatRoughness", "coatNormalTS"
] as const);
export type AppearanceFieldName = typeof APPEARANCE_FIELD_NAMES[number];
export const APPEARANCE_FIELD_WIDTHS = Object.freeze([3, 1, 1, 1, 1, 3, 3, 1, 1, 3, 1, 1, 3]);
export const APPEARANCE_FIELD_COUNT = APPEARANCE_FIELD_NAMES.length;
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

/** Independent compiled Appearance output names and widths. */
export const APPEARANCE_FIELD_NAMES = Object.freeze([
  "baseColor",
  "alpha",
  "metallic",
  "roughness",
  "occlusion",
  "emissive",
  "normalTS",
  "ior",
  "specularWeight",
  "specularColor",
  "coatWeight",
  "coatRoughness",
  "coatNormalTS",
  "normalTSValidity",
  "coatNormalTSValidity",
] as const);
export type AppearanceFieldName = (typeof APPEARANCE_FIELD_NAMES)[number];
export const APPEARANCE_FIELD_WIDTHS = Object.freeze([3, 1, 1, 1, 1, 3, 3, 1, 1, 3, 1, 1, 3, 1, 1]);
export const APPEARANCE_FIELD_COUNT = APPEARANCE_FIELD_NAMES.length;

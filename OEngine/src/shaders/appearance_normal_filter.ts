import { APPEARANCE_NORMAL_MIN_MOMENT_SQUARED } from "../material/AppearanceNormalFilter.js";

/** Baseline f32, no implicit gradients/barriers/atomics. Input is already filtered r-form. */
export const APPEARANCE_NORMAL_FILTER_WGSL = /* wgsl */ `
struct AppearanceFilteredNormal {
  normal: vec3f,
  roughness: f32,
  direction_valid: u32,
}
fn appearance_decode_normal_moment(moment: vec3f) -> AppearanceFilteredNormal {
  let raw = dot(moment, moment);
  if raw <= ${APPEARANCE_NORMAL_MIN_MOMENT_SQUARED} {
    return AppearanceFilteredNormal(vec3f(0.0, 0.0, 1.0), 1.0, 0u);
  }
  let r2 = min(raw, 1.0);
  let inv_lambda = inverseSqrt(r2) * (1.0 - r2) / (3.0 - r2);
  let alpha = sqrt(min(2.0 * inv_lambda, 1.0));
  return AppearanceFilteredNormal(moment * inverseSqrt(raw), sqrt(alpha), 1u);
}
`;

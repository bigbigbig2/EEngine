/**
 * Bent-normal specular ambient occlusion from Filament's cone/cap model.
 *
 * Source:
 * https://github.com/google/filament/blob/d45158c6f175726a33b1236858fa3948c5d8dbb5/shaders/src/surface_ambient_occlusion.fs
 * License: Apache-2.0. See docs/porting/shading.md for the adoption ledger.
 */

export const FILAMENT_SPECULAR_AO_REVISION =
  "d45158c6f175726a33b1236858fa3948c5d8dbb5" as const;

export const SPECULAR_AMBIENT_OCCLUSION_WGSL = /* wgsl */ `
fn oengine_spherical_caps_intersection(
  cos_cap_1: f32,
  cos_cap_2: f32,
  cos_distance: f32
) -> f32 {
  let radius_1 = acos(clamp(cos_cap_1, -1.0, 1.0));
  let radius_2 = acos(clamp(cos_cap_2, -1.0, 1.0));
  let distance = acos(clamp(cos_distance, -1.0, 1.0));
  if (min(radius_1, radius_2) <= max(radius_1, radius_2) - distance) {
    return 1.0 - max(cos_cap_1, cos_cap_2);
  }
  if (radius_1 + radius_2 <= distance) {
    return 0.0;
  }
  let delta = abs(radius_1 - radius_2);
  let overlap = 1.0 - clamp(
    (distance - delta) / max(radius_1 + radius_2 - delta, 1e-4),
    0.0,
    1.0
  );
  let area = overlap * overlap * (-2.0 * overlap + 3.0);
  return area * (1.0 - max(cos_cap_1, cos_cap_2));
}

fn oengine_specular_ao_cones(
  reflection_direction: vec3f,
  bent_normal: vec3f,
  visibility: f32,
  perceptual_roughness: f32
) -> f32 {
  let clamped_visibility = clamp(visibility, 0.0, 1.0);
  let roughness = clamp(perceptual_roughness, 0.0, 1.0);
  let cos_visibility_aperture = sqrt(max(0.0, 1.0 - clamped_visibility));
  // exp2(-log2(10) * roughness^2) == pow(0.1, roughness^2).
  let cos_specular_aperture = exp2(-3.321928 * roughness * roughness);
  let cap_area = oengine_spherical_caps_intersection(
    cos_visibility_aperture,
    cos_specular_aperture,
    dot(normalize(bent_normal), normalize(reflection_direction))
  );
  let cone_visibility = clamp(
    cap_area / max(1.0 - cos_specular_aperture, 1e-4),
    0.0,
    1.0
  );
  // Do not erase sharp reflections: the cone approximation is intentionally
  // faded in only through perceptual roughness 0.1..0.3.
  return mix(1.0, cone_visibility, smoothstep(0.01, 0.09, roughness));
}
`;

// Rejected Shadow Projection V2 candidate, frozen 2026-10-11.
// Test-only: no production import, runtime switch, or adoption claim.
/** Four horizontal receiver bytes in one core r32uint texel. Low five bits
 * count visible taps; bits 5..6 store axis-1. Neutral is one tap, one visible.
 * This is an exact count product, not quantized unorm visibility. */
export const VSM_SHADOW_VISIBILITY_WGSL = /* wgsl */ `
@group(1) @binding(8) var<uniform> shadow_visibility_mode: vec4u;
@group(1) @binding(10) var directional_shadow_visibility: texture_2d<u32>;

fn directional_shadow_byte(pixel: vec2u) -> u32 {
  let extent = textureDimensions(directional_shadow_visibility);
  let address = min(vec2u(pixel.x / 4u, pixel.y), extent - vec2u(1u));
  let word = textureLoad(directional_shadow_visibility, vec2i(address), 0).r;
  return (word >> ((pixel.x % 4u) * 8u)) & 255u;
}

fn directional_shadow_visibility_at(pixel: vec2u) -> f32 {
  let value = directional_shadow_byte(pixel);
  let axis = 1u + ((value >> 5u) & 3u);
  return f32(value & 31u) / f32(axis * axis);
}

fn directional_shadow_debug_at(pixel: vec2u) -> vec3f {
  let value = directional_shadow_byte(pixel);
  if (value == 254u) {
    return vec3f(0.0, 0.6, 0.6);
  }
  if (value == 255u) {
    return vec3f(1.0, 0.0, 1.0);
  }
  if (shadow_visibility_mode.x == 2u) {
    let colors = array<vec3f, 6>(vec3f(0.9, 0.1, 0.1), vec3f(1.0, 0.55, 0.0),
      vec3f(0.9, 0.85, 0.0), vec3f(0.05, 0.8, 0.15), vec3f(0.0, 0.5, 1.0), vec3f(0.65, 0.1, 1.0));
    return colors[min(value, 5u)];
  }
  if (shadow_visibility_mode.x == 3u) {
    switch value {
      case 0u: { return vec3f(0.05, 0.85, 0.15); }
      case 1u: { return vec3f(0.1, 0.3, 1.0); }
      case 2u: { return vec3f(1.0, 0.0, 1.0); }
      case 3u: { return vec3f(1.0, 0.05, 0.0); }
      case 4u: { return vec3f(1.0, 0.8, 0.0); }
      default: { return vec3f(0.25); }
    }
  }
  return vec3f(directional_shadow_visibility_at(pixel));
}
`;

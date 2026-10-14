import { SSSR_COMMON_WGSL } from "./sssr_common.js";

export const SSSR_DENOISER_COMMON_WGSL = /* wgsl */ `
${SSSR_COMMON_WGSL}
@group(1) @binding(0) var<storage, read> tiles: array<u32>;
@group(1) @binding(1) var<storage, read> counts: array<u32>;
@group(1) @binding(2) var signal: texture_2d<f32>;
@group(1) @binding(3) var statistics: texture_2d<f32>;
@group(1) @binding(4) var history_signal: texture_2d<f32>;
@group(1) @binding(5) var history_statistics: texture_2d<f32>;
@group(1) @binding(6) var history_normal: texture_2d_array<f32>;
@group(1) @binding(7) var history_depth: texture_2d<f32>;
@group(1) @binding(8) var average_signal: texture_2d<f32>;
@group(1) @binding(9) var ray_length: texture_2d<f32>;
@group(1) @binding(10) var temporal_seed: texture_2d<f32>;
@group(1) @binding(11) var temporal_response: texture_2d<f32>;
@group(1) @binding(12) var identity: texture_2d<u32>;
@group(1) @binding(13) var previous_identity: texture_2d<u32>;
@group(1) @binding(14) var reprojected_signal: texture_2d<f32>;
@group(1) @binding(15) var<storage, read_write> debug_values: array<f32>;
@group(1) @binding(16) var linear_sampler: sampler;
@group(1) @binding(17) var output_signal: texture_storage_2d<rgba16float, write>;
@group(1) @binding(18) var output_statistics: texture_storage_2d<rg16float, write>;
@group(1) @binding(19) var output_average: texture_storage_2d<rgba16float, write>;
@group(1) @binding(20) var output_variance: texture_storage_2d<r16float, write>;

// Source 16x16 halo, four 8x8 loads. F32 shared deliberately avoids the
// source's half-packed HDR reduction overflow; storage remains RGBA16F Rec2020.
var<workgroup> shared_radiance: array<vec4f, 256>;
fn sssr_shared_index(pixel: vec2i) -> u32 {
  return u32(pixel.y * 16 + pixel.x);
}
fn sssr_load_signal(pixel: vec2i) -> vec3f {
  return sssr_to709(textureLoad(signal, sssr_clamp(pixel), 0).rgb);
}
fn sssr_load_halo(tile: vec2u, local: vec2u) {
  for (var part = 0u; part < 4u; part++) {
    let position = vec2i(local + vec2u((part & 1u) * 8u, (part >> 1u) * 8u));
    shared_radiance[sssr_shared_index(position)] = vec4f(
      sssr_load_signal(vec2i(tile) + position - vec2i(4)), 0.0);
  }
}
struct SssrMoments {
  mean: vec3f,
  variance: vec3f,
}
fn sssr_local_moments(center: vec2i) -> SssrMoments {
  var mean = vec3f(0.0);
  var variance = vec3f(0.0);
  var total_weight = 0.0;
  for (var y = -4; y <= 4; y++) {
    for (var x = -4; x <= 4; x++) {
      let weight = exp(-3.0 * f32(x * x) / 25.0) * exp(-3.0 * f32(y * y) / 25.0);
      let radiance = shared_radiance[sssr_shared_index(center + vec2i(x, y))].xyz;
      total_weight += weight;
      mean += radiance * weight;
      variance += radiance * radiance * weight;
    }
  }
  mean /= total_weight;
  variance = abs(variance / total_weight - mean * mean);
  return SssrMoments(mean, variance);
}
fn sssr_average(pixel: vec2i) -> vec3f {
  let padded = vec2f((frame.dimensions.xy + 7u) / 8u * 8u);
  let uv = (vec2f(pixel) + vec2f(0.5)) / padded;
  return sssr_to709(textureSampleLevel(average_signal, linear_sampler, uv, 0.0).rgb);
}
// Playdead, Copyright (c) 2015, MIT. Full notice alongside AMD notice.
// ffx_denoiser_reflections_common.h::FFX_DNSR_Reflections_ClipAABB.
fn sssr_clip_aabb(minimum: vec3f, maximum: vec3f, value: vec3f) -> vec3f {
  let center = 0.5 * (maximum + minimum);
  let extent = 0.5 * (maximum - minimum) + vec3f(0.001 * current_exposure[0]);
  let vector = value - center;
  let unit = abs(vector / extent);
  let largest = max(max(unit.x, unit.y), unit.z);
  if (largest > 1.0) {
    return center + vector / largest;
  }
  return value;
}
`;

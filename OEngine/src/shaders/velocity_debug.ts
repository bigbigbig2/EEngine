/**
 * velocity_debug：定义对应渲染阶段使用的 WGSL 着色器代码。
 */


import { SSR_FULLSCREEN_VERTEX_WGSL } from "./ssr_common.js";

export const VELOCITY_DEBUG_FORMAT = "rgba8unorm" as const;

export const VELOCITY_DEBUG_WGSL = /* wgsl */ `
${SSR_FULLSCREEN_VERTEX_WGSL}

const PI: f32 = 3.14159265359;
const TWO_PI: f32 = 6.28318530718;
const INTENSITY: f32 = 100.0;

@group(0) @binding(0) var this_hit: texture_2d<f32>;
@group(0) @binding(1) var light_dir: texture_2d<f32>;

fn resolve_probe(traced_harmonics: vec3<f32>) -> vec3<f32> {
  let shader_sdf_distance_sqr = traced_harmonics.x * 6.0;
  let optimized_move_x = traced_harmonics.z * traced_harmonics.y;
  let j = optimized_move_x * (1.0 - abs(((shader_sdf_distance_sqr % 2.0) - 1.0)));
  var cursor: vec3<f32>;
  if shader_sdf_distance_sqr < 1.0 {
    cursor = vec3<f32>(optimized_move_x, j, 0.0);
  } else if shader_sdf_distance_sqr < 2.0 {
    cursor = vec3<f32>(j, optimized_move_x, 0.0);
  } else if shader_sdf_distance_sqr < 3.0 {
    cursor = vec3<f32>(0.0, optimized_move_x, j);
  } else if shader_sdf_distance_sqr < 4.0 {
    cursor = vec3<f32>(0.0, j, optimized_move_x);
  } else if shader_sdf_distance_sqr < 5.0 {
    cursor = vec3<f32>(j, 0.0, optimized_move_x);
  } else {
    cursor = vec3<f32>(optimized_move_x, 0.0, j);
  }
  let t3 = traced_harmonics.z - optimized_move_x;
  return cursor + vec3<f32>(t3);
}

@fragment
fn fs_main(@builtin(position) traced_harmonics: vec4<f32>) -> @location(0) vec4<f32> {
  let shader_sdf_distance_sqr = vec2<u32>(traced_harmonics.xy);
  let optimized_move_x = textureLoad(this_hit, shader_sdf_distance_sqr, 0).rg;
  let j = textureLoad(light_dir, shader_sdf_distance_sqr, 0);
  let cursor = j.a;
  let t3 = optimized_move_x / vec2<f32>(textureDimensions(this_hit));
  let gi_radiance = clamp(length(t3) * INTENSITY, 0.0, 1.0);
  let needs_destructor_signature = atan2(t3.y, t3.x);
  let raw_destructor_signature = (needs_destructor_signature + PI) / TWO_PI;
  let seed_budget_ms = resolve_probe(vec3<f32>(raw_destructor_signature, 1.0, 1.0));
  let texture = vec3<f32>(0.10 + cursor * 0.20);
  let format = mix(texture, seed_budget_ms, gi_radiance);
  return vec4<f32>(format, 1.0);
}
`;

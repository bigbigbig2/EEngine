/**
 * motion_blur：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { SSR_FULLSCREEN_VERTEX_WGSL, SSR_MATH_WGSL } from "./ssr_common.js";

export const MOTION_BLUR_TILE_FORMAT = "rg16float" as const;
export const MOTION_BLUR_FORMAT = "rgba16float" as const;

export const MOTION_BLUR_TILE_MAX_WGSL = /* wgsl */ `
${SSR_FULLSCREEN_VERTEX_WGSL}
@group(0) @binding(0) var header: texture_2d<f32>;
const TILE_SIZE: u32 = 16u;

@fragment
fn fs_main(@builtin(position) coord: vec4f) -> @location(0) vec2f {
  let tile = vec2u(coord.xy);
  let origin = tile * TILE_SIZE;
  let dimensions = textureDimensions(header);
  var maximum = vec2f(0.0);
  var maximum_length = 0.0;
  for (var y = 0u; y < TILE_SIZE; y++) {
    for (var x = 0u; x < TILE_SIZE; x++) {
      let position = origin + vec2u(x, y);
      if (any(position >= dimensions)) { continue; }
      let velocity = textureLoad(header, position, 0).rg;
      let length_squared = dot(velocity, velocity);
      if (length_squared > maximum_length) {
        maximum = velocity;
        maximum_length = length_squared;
      }
    }
  }
  return maximum;
}
`;

export const MOTION_BLUR_NEIGHBOR_MAX_WGSL = /* wgsl */ `
${SSR_FULLSCREEN_VERTEX_WGSL}
@group(0) @binding(0) var path: texture_2d<f32>;

@fragment
fn fs_main(@builtin(position) coord: vec4f) -> @location(0) vec2f {
  let position = vec2i(coord.xy);
  let dimensions = vec2i(textureDimensions(path));
  var maximum = vec2f(0.0);
  var maximum_length = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let sample_position = position + vec2i(x, y);
      if (any(sample_position < vec2i(0)) || any(sample_position >= dimensions)) { continue; }
      let velocity = textureLoad(path, sample_position, 0).rg;
      let length_squared = dot(velocity, velocity);
      if (length_squared > maximum_length) {
        maximum = velocity;
        maximum_length = length_squared;
      }
    }
  }
  return maximum;
}
`;

export const MOTION_BLUR_RESOLVE_WGSL = /* wgsl */ `
${SSR_FULLSCREEN_VERTEX_WGSL}
${SSR_MATH_WGSL}
struct MotionBlurStrength { value: f32 };
@group(0) @binding(0) var tv_y: texture_2d<f32>;
@group(0) @binding(1) var header: texture_2d<f32>;
@group(0) @binding(2) var current_projection_matrix: texture_2d<f32>;
@group(0) @binding(3) var gr_bucket: texture_depth_2d;
@group(0) @binding(4) var<uniform> uStrength: MotionBlurStrength;

const TILE_SIZE: f32 = 16.0;
const SAMPLE_COUNT: u32 = 16u;
const HALF_VELOCITY_CUTOFF: f32 = 0.5;
const MB_SOFT_Z_EXTENT: f32 = 0.01;

fn mb_cone(distance: f32, velocity_length: f32) -> f32 {
  return saturate(1.0 - distance / max(velocity_length, 1e-4));
}

fn mb_cylinder(distance: f32, velocity_length: f32) -> f32 {
  return 1.0 - smoothstep(0.95 * velocity_length, 1.05 * velocity_length, distance);
}

fn mb_soft_depth_compare(a: f32, b: f32) -> f32 {
  return saturate(1.0 - (a - b) / MB_SOFT_Z_EXTENT);
}

fn mb_igr_noise(pixel: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(pixel, vec2f(0.06711056, 0.00583715))));
}

@fragment
fn fs_main(@builtin(position) coord: vec4f) -> @location(0) vec4f {
  let pixel_i = vec2i(coord.xy);
  let pixel_f = coord.xy;
  let center_color = textureLoad(tv_y, pixel_i, 0);
  let tile = vec2i(pixel_f / TILE_SIZE);
  let neighbor_velocity = textureLoad(current_projection_matrix, tile, 0).rg * uStrength.value;
  let neighbor_length = length(neighbor_velocity);
  if (neighbor_length < HALF_VELOCITY_CUTOFF) { return center_color; }
  let self_velocity = textureLoad(header, pixel_i, 0).rg * uStrength.value;
  let self_length = length(self_velocity);
  let self_depth = textureLoad(gr_bucket, pixel_i, 0);
  let jitter = mb_igr_noise(pixel_f) - 0.5;
  var accumulated = center_color;
  var total_weight = 1.0;
  for (var index = 0u; index < SAMPLE_COUNT; index++) {
    let t = (f32(index) + jitter + 0.5) / f32(SAMPLE_COUNT) * 2.0 - 1.0;
    if (abs(t) < 1e-6) { continue; }
    let offset = t * neighbor_velocity;
    let sample_position = vec2i(pixel_f + offset);
    let dimensions = vec2i(textureDimensions(tv_y));
    if (any(sample_position < vec2i(0)) || any(sample_position >= dimensions)) { continue; }
    let tap_velocity = textureLoad(header, sample_position, 0).rg * uStrength.value;
    let tap_length = length(tap_velocity);
    let tap_depth = textureLoad(gr_bucket, sample_position, 0);
    let tap_color = textureLoad(tv_y, sample_position, 0);
    let distance = length(offset);
    let foreground = mb_soft_depth_compare(tap_depth, self_depth);
    let background = mb_soft_depth_compare(self_depth, tap_depth);
    let tap_covers_center = foreground * mb_cone(distance, tap_length);
    let center_covers_tap = background * mb_cone(distance, self_length);
    let both_on_trail = 2.0 * mb_cylinder(distance, tap_length) * mb_cylinder(distance, self_length);
    let weight = max(max(tap_covers_center, center_covers_tap), both_on_trail);
    accumulated += weight * tap_color;
    total_weight += weight;
  }
  return accumulated / total_weight;
}
`;

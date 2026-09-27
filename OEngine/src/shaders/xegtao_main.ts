/**
 * Scalar XeGTAO MainPass port from GameTechDev/XeGTAO
 * a5b1686c7ea37788eeb3576b5be47f7c03db532c, MIT.
 * Source: XeGTAO.hlsli::XeGTAO_MainPass and vaGTAO.hlsl::SpatioTemporalNoise.
 * 8x8 compute, five point-loaded FP32 depth levels, no atomics or barriers.
 */
import { XE_GTAO_PREP_UNIFORM_WGSL } from "../render/ao/XeGtaoPreparationAbi.js";
import { XE_GTAO_EDGES_WGSL } from "./xegtao_preparation.js";

export type XeGtaoScalarQuality = "medium" | "high";

/** Fixed source quality profiles: Medium 2x2 per side, High 3x3 per side. */
export function xeGtaoScalarMainWgsl(quality: XeGtaoScalarQuality): string {
  const slices = quality === "high" ? 3 : 2;
  const steps = quality === "high" ? 3 : 2;
  return /* wgsl */ `
${XE_GTAO_PREP_UNIFORM_WGSL}
${XE_GTAO_EDGES_WGSL}
const XE_PI: f32 = 3.141592653589793;
const XE_HALF_PI: f32 = 1.5707963267948966;
const XE_SLICES: u32 = ${slices}u;
const XE_STEPS: u32 = ${steps}u;
@group(0) @binding(1) var raw_depth: texture_depth_2d;
@group(0) @binding(2) var view_normals: texture_2d<u32>;
@group(0) @binding(3) var depth_mip0: texture_2d<f32>;
@group(0) @binding(4) var depth_mip1: texture_2d<f32>;
@group(0) @binding(5) var depth_mip2: texture_2d<f32>;
@group(0) @binding(6) var depth_mip3: texture_2d<f32>;
@group(0) @binding(7) var depth_mip4: texture_2d<f32>;
@group(0) @binding(8) var hilbert_lut: texture_2d<u32>;
@group(0) @binding(9) var out_raw_ao: texture_storage_2d<r8unorm, write>;
@group(0) @binding(10) var out_edges: texture_storage_2d<r8unorm, write>;

fn xe_normal_unpack(packed: u32) -> vec3f {
  let decoded = vec3f(f32(packed & 2047u) / 2047.0,
    f32((packed >> 11u) & 2047u) / 2047.0,
    f32((packed >> 22u) & 1023u) / 1023.0);
  return normalize(decoded * 2.0 - vec3f(1.0));
}
fn xe_pack_edges(edges: vec4f) -> u32 {
  let q = vec4u(round(clamp(edges, vec4f(0.0), vec4f(1.0)) * 2.9));
  return (q.x << 6u) | (q.y << 4u) | (q.z << 2u) | q.w;
}
fn xe_fast_sqrt(value: f32) -> f32 {
  return bitcast<f32>(0x1fbd1df5u + (bitcast<u32>(value) >> 1u));
}
fn xe_fast_acos(value: f32) -> f32 {
  let x = abs(clamp(value, -1.0, 1.0));
  let estimate = (-0.156583 * x + 1.570796) * xe_fast_sqrt(1.0 - x);
  return select(3.141593 - estimate, estimate, value >= 0.0);
}
fn xe_noise(pixel: vec2u) -> vec2f {
  let index = textureLoad(hilbert_lut, vec2i(pixel & vec2u(63u)), 0).x +
    288u * (u32(xe.effect.w) % 64u);
  return fract(vec2f(0.5) + f32(index) *
    vec2f(0.7548776662466928, 0.5698402909980533));
}
fn xe_logical_size(mip: u32) -> vec2u {
  let divisor = 1u << mip;
  return max(vec2u(1u), (vec2u(xe.viewport.xy) + vec2u(divisor - 1u)) / divisor);
}
fn xe_depth_at(coord: vec2i, mip: u32) -> f32 {
  let hi = vec2i(xe_logical_size(mip)) - vec2i(1);
  let at = clamp(coord, vec2i(0), hi);
  switch (mip) {
    case 0u: { return textureLoad(depth_mip0, at, 0).x; }
    case 1u: { return textureLoad(depth_mip1, at, 0).x; }
    case 2u: { return textureLoad(depth_mip2, at, 0).x; }
    case 3u: { return textureLoad(depth_mip3, at, 0).x; }
    default: { return textureLoad(depth_mip4, at, 0).x; }
  }
}
fn xe_depth_sample(uv: vec2f, mip: u32) -> f32 {
  let at = vec2i(floor(uv * vec2f(xe_logical_size(mip))));
  return xe_depth_at(at, mip);
}
fn xe_raw_output(visibility: f32) -> f32 {
  return floor(clamp(visibility / 1.5, 0.0, 1.0) * 255.0 + 0.5) / 255.0;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let pixel = id.xy;
  if (any(pixel >= vec2u(xe.viewport.xy))) { return; }
  let at = vec2i(pixel);
  if (textureLoad(raw_depth, at, 0) <= 0.0) {
    textureStore(out_raw_ao, at, vec4f(xe_raw_output(1.0), 0.0, 0.0, 0.0));
    textureStore(out_edges, at, vec4f(1.0, 0.0, 0.0, 0.0));
    return;
  }
  let center_depth = xe_depth_at(at, 0u);
  let left_depth = xe_depth_at(at + vec2i(-1, 0), 0u);
  let right_depth = xe_depth_at(at + vec2i(1, 0), 0u);
  let top_depth = xe_depth_at(at + vec2i(0, -1), 0u);
  let bottom_depth = xe_depth_at(at + vec2i(0, 1), 0u);
  let edges = xe_edges(center_depth, left_depth, right_depth, top_depth, bottom_depth);
  textureStore(out_edges, at, vec4f(f32(xe_pack_edges(edges)) / 255.0, 0.0, 0.0, 0.0));

  // XeGTAO_FP32_DEPTHS: the selected working depth format is r32float.
  let view_z = center_depth * 0.99999;
  let uv = (vec2f(pixel) + vec2f(0.5)) * xe.viewport.zw;
  let center = xe_view_position(uv, view_z);
  let view_vec = normalize(-center);
  let normal = xe_normal_unpack(textureLoad(view_normals, at, 0).x);
  let radius = xe.effect.x * xe.effect.z;
  let falloff_range = xe.effect.y * radius;
  let falloff_from = radius * (1.0 - xe.effect.y);
  let falloff_mul = -1.0 / falloff_range;
  let falloff_add = falloff_from / falloff_range + 1.0;
  let pixel_size_at_z = view_z * xe.ndc_to_view.x * xe.viewport.z;
  let screen_radius = radius / pixel_size_at_z;
  let min_s = 1.3 / screen_radius;
  let noise = xe_noise(pixel);
  var visibility = clamp((10.0 - screen_radius) / 100.0, 0.0, 1.0) * 0.5;

  for (var slice = 0u; slice < XE_SLICES; slice++) {
    let phi = (f32(slice) + noise.x) / f32(XE_SLICES) * XE_PI;
    let direction = vec3f(cos(phi), sin(phi), 0.0);
    let omega = vec2f(direction.x, -direction.y) * screen_radius;
    let ortho = direction - dot(direction, view_vec) * view_vec;
    let axis = normalize(cross(ortho, view_vec));
    let projected = normal - axis * dot(normal, axis);
    let sign_norm = sign(dot(ortho, projected));
    var projected_length = length(projected);
    let cos_norm = clamp(dot(projected, view_vec) / max(projected_length, 1.0e-20), 0.0, 1.0);
    let n = sign_norm * xe_fast_acos(cos_norm);
    let low0 = cos(n + XE_HALF_PI);
    let low1 = cos(n - XE_HALF_PI);
    var horizon0 = low0;
    var horizon1 = low1;

    for (var step = 0u; step < XE_STEPS; step++) {
      let step_base = f32(slice + step * XE_STEPS) * 0.6180339887498948;
      let step_noise = fract(noise.y + step_base);
      let s = pow((f32(step) + step_noise) / f32(XE_STEPS), xe.main.x) + min_s;
      let offset_px = s * omega;
      let mip_level = clamp(log2(max(length(offset_px), 1.0e-20)) - xe.main.w, 0.0, 5.0);
      let mip = min(4u, u32(floor(mip_level + 0.5)));
      let offset_uv = round(offset_px) * xe.viewport.zw;
      let uv0 = uv + offset_uv;
      let uv1 = uv - offset_uv;
      let sample0 = xe_view_position(uv0, xe_depth_sample(uv0, mip));
      let sample1 = xe_view_position(uv1, xe_depth_sample(uv1, mip));
      let delta0 = sample0 - center;
      let delta1 = sample1 - center;
      let distance0 = max(length(delta0), 1.0e-20);
      let distance1 = max(length(delta1), 1.0e-20);
      let horizon_vec0 = delta0 / distance0;
      let horizon_vec1 = delta1 / distance1;
      let falloff_dist0 = select(distance0,
        length(vec3f(delta0.xy, delta0.z * (1.0 + xe.main.y))), xe.main.y > 0.0);
      let falloff_dist1 = select(distance1,
        length(vec3f(delta1.xy, delta1.z * (1.0 + xe.main.y))), xe.main.y > 0.0);
      let weight0 = clamp(falloff_dist0 * falloff_mul + falloff_add, 0.0, 1.0);
      let weight1 = clamp(falloff_dist1 * falloff_mul + falloff_add, 0.0, 1.0);
      let sample_cos0 = mix(low0, dot(horizon_vec0, view_vec), weight0);
      let sample_cos1 = mix(low1, dot(horizon_vec1, view_vec), weight1);
      horizon0 = max(horizon0, sample_cos0);
      horizon1 = max(horizon1, sample_cos1);
    }
    projected_length = mix(projected_length, 1.0, 0.05);
    let h0 = -xe_fast_acos(horizon1);
    let h1 = xe_fast_acos(horizon0);
    let arc0 = (cos_norm + 2.0 * h0 * sin(n) - cos(2.0 * h0 - n)) * 0.25;
    let arc1 = (cos_norm + 2.0 * h1 * sin(n) - cos(2.0 * h1 - n)) * 0.25;
    visibility += projected_length * (arc0 + arc1);
  }
  visibility /= f32(XE_SLICES);
  visibility = pow(max(visibility, 0.0), xe.main.z);
  visibility = max(0.03, visibility);
  textureStore(out_raw_ao, at, vec4f(xe_raw_output(visibility), 0.0, 0.0, 0.0));
}
`;
}

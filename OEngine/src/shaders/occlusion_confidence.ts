/**
 * occlusion_confidence：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { LPV_CAMERA_TYPE } from "./lpv_indirect_diffuse.js";

export const OCCLUSION_CONFIDENCE_FORMAT = "r8unorm" as const;

export const OCCLUSION_CONFIDENCE_WGSL = /* wgsl */ `
${LPV_CAMERA_TYPE.wgsl_declaration}

@group(0) @binding(0) var collection: texture_2d<f32>;
@group(0) @binding(1) var group_id: texture_2d<f32>;
@group(0) @binding(2) var r_max_texel_depth: texture_2d<f32>;
@group(0) @binding(3) var<uniform> camera_current: CommandEncoder;
@group(0) @binding(4) var<uniform> camera_previous: CommandEncoder;

fn saturate(value: f32) -> f32 {
  return clamp(value, 0.0, 1.0);
}

fn uv_to_ndc(uv: vec2f) -> vec2f {
  return fma(uv, vec2f(2.0, -2.0), vec2f(-1.0, 1.0));
}

fn texel_coordinate_to_uv(position: vec2f, resolution: vec2u) -> vec2f {
  return (position + 0.5) / vec2f(resolution);
}

fn get_bilinear_weights(fraction: vec2f) -> vec4f {
  let inverse_x = 1.0 - fraction.x;
  let inverse_y = 1.0 - fraction.y;
  return vec4f(
    inverse_x * inverse_y,
    fraction.x * inverse_y,
    inverse_x * fraction.y,
    fraction.x * fraction.y
  );
}

fn in_bounds(position: vec2i, resolution: vec2i) -> bool {
  return all(position >= vec2i(0)) && all(position < resolution);
}

fn get_view_space_depth(depth: f32, camera: CommandEncoder) -> f32 {
  let conversion = camera.device_depth_to_view_space;
  return conversion.y / (depth + conversion.x);
}

fn get_view_space_position_uvz(
  uv: vec2f,
  view_depth: f32,
  camera: CommandEncoder
) -> vec3f {
  let ndc = uv_to_ndc(uv);
  let conversion = camera.device_depth_to_view_space;
  return vec3f(
    conversion.z * ndc.x * view_depth,
    conversion.w * ndc.y * view_depth,
    view_depth
  );
}

fn get_view_space_position_uv(
  uv: vec2f,
  device_depth: f32,
  camera: CommandEncoder
) -> vec3f {
  return get_view_space_position_uvz(
    uv,
    get_view_space_depth(device_depth, camera),
    camera
  );
}

fn get_view_space_position(
  texel: vec2f,
  resolution: vec2i,
  device_depth: f32,
  camera: CommandEncoder
) -> vec3f {
  let uv = texel_coordinate_to_uv(texel, vec2u(resolution));
  return get_view_space_position_uv(uv, device_depth, camera);
}

fn four_depth_samples(
  source: texture_2d<f32>,
  position: vec2f,
  component: u32,
  mip_level: u32
) -> vec4f {
  let maximum = textureDimensions(source, mip_level) - 1u;
  let clamped = clamp(position, vec2f(0.0), vec2f(maximum));
  let p00 = vec2u(clamped);
  let p01 = vec2u(p00.x, min(maximum.y, p00.y + 1u));
  let p10 = vec2u(min(maximum.x, p00.x + 1u), p00.y);
  let p11 = vec2u(p10.x, p01.y);
  return vec4f(
    textureLoad(source, p01, mip_level)[component],
    textureLoad(source, p11, mip_level)[component],
    textureLoad(source, p10, mip_level)[component],
    textureLoad(source, p00, mip_level)[component]
  );
}

fn minimum_previous_depth(source: texture_2d<f32>, position: vec2f) -> f32 {
  let samples = four_depth_samples(source, position, 0u, 0u);
  return min(min(samples.x, samples.y), min(samples.z, samples.w));
}

fn reprojected_depth_confidence(
  reprojected_pixel: vec2f,
  current_device_depth: f32,
  resolution: vec2i
) -> f32 {
  let current_view_depth = get_view_space_depth(current_device_depth, camera_current);
  let fraction = fract(reprojected_pixel + 0.5);
  let base = vec2i(floor(reprojected_pixel - 0.5));
  let weights = get_bilinear_weights(fraction);
  const offsets = array<vec2i, 4>(
    vec2i(0, 0), vec2i(1, 0), vec2i(0, 1), vec2i(1, 1)
  );
  const weight_threshold = 0.01;
  var confidence_sum = 0.0;
  var weight_sum = 0.0;

  for (var index = 0; index < 4; index++) {
    let sample_pixel = base + offsets[index];
    if (!in_bounds(sample_pixel, resolution)) {
      continue;
    }
    let weight = weights[index];
    if (weight <= weight_threshold) {
      continue;
    }
    let previous_device_depth = minimum_previous_depth(
      group_id,
      reprojected_pixel + vec2f(offsets[index]) - 0.5
    );
    let previous_view_depth = get_view_space_depth(
      previous_device_depth,
      camera_previous
    );
    let depth_difference = current_view_depth - previous_view_depth;

    // 必须保持“仅在正差值时进入”的分支，不能反写成
    // depth_difference <= 0.0 后 continue。背景深度为 0 时，两帧的
    // view depth 都是 +inf，差值会成为 NaN；WGSL 对 NaN 的 > 与 <=
    // 都返回 false。当前分支会跳过该样本并最终返回 1，而反写分支会让
    // NaN 进入后续计算，写入 r8unorm 后变成 0，形成大面积错误遮蔽。
    if (depth_difference > 0.0) {
      let conservative_depth = min(previous_device_depth, current_device_depth);
      let resolution_f = vec2f(resolution);
      let center_position = get_view_space_position(
        resolution_f * 0.5,
        resolution,
        conservative_depth,
        camera_current
      );
      let corner_position = get_view_space_position(
        vec2f(0.0),
        resolution,
        conservative_depth,
        camera_current
      );
      let resolution_length = length(resolution_f);
      let maximum_view_depth = max(current_view_depth, previous_view_depth);
      const scale = 1.37e-05;
      let projection_ratio = length(corner_position) / length(center_position);
      let tolerance = scale * projection_ratio * resolution_length * maximum_view_depth;
      let normalized_resolution = saturate(
        resolution_length / length(vec2f(1920.0, 1080.0))
      );
      let exponent = mix(1.0, 3.0, normalized_resolution);
      confidence_sum += pow(saturate(tolerance / depth_difference), exponent) * weight;
      weight_sum += weight;
    }
  }

  if (weight_sum > 0.0) {
    return saturate(confidence_sum / weight_sum);
  }
  return 1.0;
}

fn closest_depth_3x3(
  source: texture_2d<f32>,
  pixel: vec2i,
  resolution: vec2i,
  selected_pixel: ptr<function, vec2i>
) -> f32 {
  const offsets = array<vec2i, 9>(
    vec2i( 0,  0), vec2i( 1,  0), vec2i( 0,  1),
    vec2i( 0, -1), vec2i(-1,  0), vec2i(-1,  1),
    vec2i( 1,  1), vec2i(-1, -1), vec2i( 1, -1)
  );
  var depths: array<f32, 9>;
  for (var index = 0; index < 9; index++) {
    depths[index] = textureLoad(source, pixel + offsets[index], 0).r;
  }
  *selected_pixel = pixel;
  var selected_depth = depths[0];
  for (var index = 1; index < 9; index++) {
    let candidate_pixel = pixel + offsets[index];
    if (in_bounds(candidate_pixel, resolution) && depths[index] > selected_depth) {
      *selected_pixel = candidate_pixel;
      selected_depth = depths[index];
    }
  }
  return selected_depth;
}

const FULLSCREEN_POSITIONS = array<vec2f, 3>(
  vec2f(-1.0, -1.0),
  vec2f( 3.0, -1.0),
  vec2f(-1.0,  3.0)
);

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4f {
  return vec4f(FULLSCREEN_POSITIONS[vertex_index], 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) f32 {
  let resolution = vec2i(textureDimensions(collection));
  let pixel = vec2i(position.xy);
  var closest_pixel: vec2i;
  let closest_depth = closest_depth_3x3(
    collection,
    pixel,
    resolution,
    &closest_pixel
  );
  let velocity = textureLoad(r_max_texel_depth, closest_pixel, 0).rg;
  let reprojected_pixel = position.xy - velocity;
  return saturate(reprojected_depth_confidence(
    reprojected_pixel,
    closest_depth,
    resolution
  ));
}
`;

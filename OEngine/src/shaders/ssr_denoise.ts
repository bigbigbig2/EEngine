/**
 * ssr_denoise：定义对应渲染阶段使用的 WGSL 着色器代码。
 */


import {
  SSR_CAMERA_WGSL,
  SSR_COLOR_HISTORY_WGSL,
  SSR_FULLSCREEN_VERTEX_WGSL,
  SSR_MATH_WGSL
} from "./ssr_common.js";

export const SSR_DENOISE_FORMAT = "rgba16float" as const;

export const SSR_SPATIAL_WGSL = /* wgsl */ `
${SSR_FULLSCREEN_VERTEX_WGSL}
${SSR_MATH_WGSL}
struct SpatialSettings { step_size: i32 };
@group(0) @binding(0) var this_hit: texture_2d<f32>;
@group(0) @binding(1) var gr_bucket: texture_2d<f32>;
@group(0) @binding(2) var ray_ws: texture_2d<u32>;
@group(0) @binding(3) var<uniform> settings: SpatialSettings;

fn convert_specular(position: vec2i, source: texture_2d<f32>, channel: i32) -> f32 {
  const weights = array<f32, 3>(0.25, 0.125, 0.0625);
  let maximum = vec2i(textureDimensions(source)) - vec2i(1);
  var result = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let sample_position = clamp(position + vec2i(x, y), vec2i(0), maximum);
      result += textureLoad(source, sample_position, 0)[channel] * weights[abs(x) + abs(y)];
    }
  }
  return result;
}

fn depth_weight(center: f32, neighbor: f32) -> f32 {
  return exp(-abs(center - neighbor) * center * 4.0);
}

fn normal_weight(center: vec3f, neighbor: vec3f) -> f32 {
  return pow(max(dot(center, neighbor), 0.0), 512.0);
}

fn relative_difference(center: f32, neighbor: f32, scale: f32) -> f32 {
  return abs(center - neighbor) / scale;
}

@fragment
fn fs_main(@builtin(position) coord: vec4f) -> @location(0) vec4f {
  let position = vec2i(coord.xy);
  let dimensions = vec2i(textureDimensions(this_hit));
  const kernel = array<f32, 3>(1.0, 2.0 / 3.0, 1.0 / 6.0);
  let center = textureLoad(this_hit, position, 0);
  let center_luminance = rgb_to_luminance(center.rgb);
  let variance = max(0.0, convert_specular(position, this_hit, 3));
  let center_normal = decode_g_buffer_normal(textureLoad(ray_ws, position, 0).xy);
  let center_depth = textureLoad(gr_bucket, position, 0).r;
  const offsets = array<vec2i, 8>(
    vec2i(-1, -1), vec2i(0, -1), vec2i(1, -1), vec2i(-1, 0),
    vec2i(1, 0), vec2i(-1, 1), vec2i(0, 1), vec2i(1, 1)
  );
  var weight_sum = 1.0;
  var accumulated = center;
  let phi_visibility = max(0.001, sqrt(variance) * 10.0);
  for (var index = 0; index < 8; index++) {
    let offset = offsets[index];
    let sample_position = position + offset * settings.step_size;
    if (any(sample_position < vec2i(0)) || any(sample_position >= dimensions)) { continue; }
    let sample_value = textureLoad(this_hit, sample_position, 0);
    let sample_normal = decode_g_buffer_normal(textureLoad(ray_ws, sample_position, 0).xy);
    let sample_depth = textureLoad(gr_bucket, sample_position, 0).r;
    var weight = normal_weight(center_normal, sample_normal);
    weight *= depth_weight(center_depth, sample_depth);
    weight *= exp(-relative_difference(center_luminance, rgb_to_luminance(sample_value.rgb), phi_visibility));
    weight *= kernel[abs(offset.x)] * kernel[abs(offset.y)];
    weight_sum += weight;
    accumulated += vec4f(vec3f(weight), weight * weight) * sample_value;
  }
  return accumulated / vec4f(vec3f(weight_sum), weight_sum * weight_sum);
}
`;

export const SSR_TEMPORAL_WGSL = /* wgsl */ `
${SSR_CAMERA_WGSL}
${SSR_FULLSCREEN_VERTEX_WGSL}
${SSR_MATH_WGSL}
${SSR_COLOR_HISTORY_WGSL}
struct SsrTemporalSettings { history_valid: u32 };
@group(0) @binding(0) var this_hit: texture_2d<f32>;
@group(0) @binding(1) var header: texture_2d<f32>;
@group(0) @binding(2) var top: texture_2d<f32>;
@group(0) @binding(3) var mean: texture_2d<f32>;
@group(0) @binding(4) var segment_height: sampler;
@group(0) @binding(5) var<uniform> camera_current: CommandEncoder;
@group(0) @binding(6) var<uniform> camera_previous: CommandEncoder;
@group(0) @binding(7) var<uniform> settings: SsrTemporalSettings;

fn velocity_confidence(velocity: vec2f) -> f32 {
  return saturate(1.0 - length(velocity) / 128.0);
}

fn history_response(confidence: f32) -> f32 {
  return mix(0.75, 2.0, confidence * confidence);
}

fn reciprocal_one_plus(value: f32) -> f32 {
  return 1.0 / (1.0 + value);
}

fn sphere_sample_direction(
  source: texture_2d<f32>,
  center: vec4f,
  position: vec2i,
  scale: f32,
  minimum: ptr<function, vec3f>,
  maximum: ptr<function, vec3f>
) {
  const offsets = array<vec2i, 8>(
    vec2i(-1, -1), vec2i(0, -1), vec2i(1, -1), vec2i(-1, 0),
    vec2i(1, 0), vec2i(-1, 1), vec2i(0, 1), vec2i(1, 1)
  );
  var sum = center.rgb;
  var sum_squared = sum * sum;
  var alpha_sum = center.a;
  let maximum_position = vec2i(textureDimensions(source)) - vec2i(1);
  for (var index = 0; index < 8; index++) {
    let sample_position = clamp(position + offsets[index], vec2i(0), maximum_position);
    let sample_value = textureLoad(source, sample_position, 0);
    let encoded = taa_encode_color(sample_value.rgb);
    sum += encoded;
    sum_squared += encoded * encoded;
    alpha_sum += sample_value.a;
  }
  let mean = sum / 9.0;
  let deviation = sqrt(abs(sum_squared / 9.0 - mean * mean));
  let extent = vec3f(1.0, 1.4, 1.2) * scale * (1.0 + sqrt(alpha_sum / 9.0));
  *minimum = mean - deviation * extent;
  *maximum = mean + deviation * extent;
}

@fragment
fn fs_main(@builtin(position) coord: vec4f) -> @location(0) vec4f {
  let position = vec2i(coord.xy);
  // 绑定布局保留两份相机数据；当前路径使用运动矢量重投影，不直接读取它们。
  if (coord.x < 0.0) {
    _ = camera_current.device_depth_to_view_space.x;
    _ = camera_previous.device_depth_to_view_space.x;
  }
  let confidence = textureLoad(top, position, 0).r;
  let current = textureLoad(this_hit, position, 0);
  if (settings.history_valid == 0u) { return current; }
  if (confidence <= 0.001) { return current; }
  let velocity = taa_get_velocity(header, position);
  let history_position = coord.xy - velocity;
  let history_uv = history_position / vec2f(textureDimensions(mean));
  let history = max(vec4f(0.0), add_per_probe_roughness(mean, segment_height, history_uv));
  let encoded_current = taa_encode_color(current.rgb);
  let encoded_history = taa_encode_color(history.rgb);
  let velocity_weight = velocity_confidence(velocity);
  let clip_scale = history_response(velocity_weight) * 2.0;
  var minimum: vec3f;
  var maximum: vec3f;
  sphere_sample_direction(this_hit, vec4f(encoded_current, current.a), position, clip_scale, &minimum, &maximum);
  let clipped_history = pack_field(encoded_history, encoded_current, minimum, maximum);
  var current_weight = mix(1.0, 0.05, confidence * velocity_weight);
  current_weight *= mix(0.2, 1.0, pow2(saturate(features(encoded_current, clipped_history, minimum, maximum))));
  var history_weight = 1.0 - current_weight;
  current_weight *= reciprocal_one_plus(current.a);
  history_weight *= reciprocal_one_plus(history.a);
  let normalization = 1.0 / (current_weight + history_weight);
  current_weight *= normalization;
  history_weight *= normalization;
  return vec4f(
    taa_decode_color(mix(encoded_current, clipped_history, history_weight)),
    mix(current.a, history.a, history_weight)
  );
}
`;

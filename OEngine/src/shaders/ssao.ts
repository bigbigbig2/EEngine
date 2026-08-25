/**
 * ssao：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { LPV_CAMERA_TYPE } from "./lpv_indirect_diffuse.js";

export const SSAO_VISIBILITY_FORMAT = "rg16float" as const;
export const SSAO_BENT_NORMAL_FORMAT = "rg16uint" as const;
export const SSAO_ALBEDO_AO_FORMAT = "rgba8unorm" as const;

const FULLSCREEN_VERTEX_WGSL = /* wgsl */ `
const FULLSCREEN_POSITIONS = array<vec2f, 3>(
  vec2f(-1.0, -1.0),
  vec2f( 3.0, -1.0),
  vec2f(-1.0,  3.0)
);

struct FullscreenVertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> FullscreenVertexOutput {
  let ndc = FULLSCREEN_POSITIONS[vertex_index];
  var output: FullscreenVertexOutput;
  output.position = vec4f(ndc, 0.0, 1.0);
  output.uv = fma(ndc, vec2f(0.5, -0.5), vec2f(0.5));
  return output;
}
`;

export const SSAO_RAW_WGSL = /* wgsl */ `
${LPV_CAMERA_TYPE.wgsl_declaration}

struct SsaoRawSettings {
  frame_index: u32,
};

@group(0) @binding(0) var gr_bucket: texture_2d<f32>;
@group(0) @binding(1) var ray_ws: texture_2d<u32>;
@group(0) @binding(2) var q: texture_2d<u32>;
@group(0) @binding(3) var<uniform> camera: CommandEncoder;
@group(0) @binding(4) var<uniform> settings: SsaoRawSettings;

fn saturate(value: f32) -> f32 {
  return clamp(value, 0.0, 1.0);
}

fn saturate2(value: vec2f) -> vec2f {
  return clamp(value, vec2f(0.0), vec2f(1.0));
}

fn store_uint4(value: vec2f) -> vec2f {
  return select(vec2f(1.0), vec2f(-1.0), value < vec2f(0.0));
}

fn uv_octahedral_unit_encode(direction: vec3f) -> vec2f {
  let denominator = abs(direction.x) + abs(direction.y) + abs(direction.z);
  var projected = direction.xy / denominator;
  if (direction.z < 0.0) {
    projected = (1.0 - abs(projected.yx)) * store_uint4(projected);
  }
  return 0.5 + 0.5 * projected;
}

fn uv_octahedral_unit_decode(encoded: vec2f) -> vec3f {
  let projected = fma(encoded, vec2f(2.0), vec2f(-1.0));
  var direction = vec3f(
    projected,
    1.0 - abs(projected.x) - abs(projected.y)
  );
  let correction = max(-direction.z, 0.0);
  direction.x += select(correction, -correction, direction.x > 0.0);
  direction.y += select(correction, -correction, direction.y > 0.0);
  return normalize(direction);
}

fn decode_g_buffer_normal(encoded: vec2u) -> vec3f {
  return uv_octahedral_unit_decode(vec2f(encoded) * (1.0 / 65535.0));
}

fn encode_g_buffer_normal(direction: vec3f) -> vec2u {
  return vec2u(uv_octahedral_unit_encode(direction) * 65535.0);
}

fn uv_to_ndc(uv: vec2f) -> vec2f {
  return fma(uv, vec2f(2.0, -2.0), vec2f(-1.0, 1.0));
}

fn project_position_from_depth(uv: vec2f, depth: f32, inverse: mat4x4f) -> vec3f {
  let projected = inverse * vec4f(uv_to_ndc(uv), depth, 1.0);
  return projected.xyz / projected.w;
}

fn get_view_space_depth(depth: f32, packed_camera: CommandEncoder) -> f32 {
  let conversion = packed_camera.device_depth_to_view_space;
  return conversion.y / (depth + conversion.x);
}

fn mat4_extract_position(matrix: mat4x4f) -> vec3f {
  return matrix[3].xyz;
}

fn v3_matrix4_rotate(direction: vec3f, matrix: mat4x4f) -> vec3f {
  return normalize(
    matrix[0].xyz * direction.x +
    matrix[1].xyz * direction.y +
    matrix[2].xyz * direction.z
  );
}

fn uv_to_texel_coordinate(uv: vec2f, resolution: vec2u) -> vec2f {
  return fma(uv, vec2f(resolution), vec2f(-0.5));
}

fn texture_sample_nearest_uv(
  source: texture_2d<f32>,
  uv: vec2f,
  mip_level: u32
) -> vec4f {
  let resolution = textureDimensions(source, mip_level);
  let coordinate = vec2u(round(uv_to_texel_coordinate(saturate2(uv), resolution)));
  return textureLoad(source, coordinate, mip_level);
}

fn convert_specular_ao(value: u32) -> vec2f {
  return fract(fma(
    vec2f(f32(value)),
    vec2f(0.245122333753, 0.430159709002),
    vec2f(0.5)
  ));
}

fn spatio_temporal_noise_r2_64(pixel: vec2u, frame_index: u32) -> vec2f {
  let wrapped = pixel & vec2u(63u);
  var value = textureLoad(q, wrapped, 0).r;
  value += 288u * (frame_index & 63u);
  return convert_specular_ao(value);
}

const PI: f32 = 3.1415926535897932384626433832795;
const PI_HALF: f32 = 1.5707963267948966192313216916398;

fn fast_acos(value: f32) -> f32 {
  let magnitude = abs(value);
  var result = -0.156583 * magnitude + PI_HALF;
  result *= sqrt(1.0 - magnitude);
  return select(PI - result, result, value >= 0.0);
}

fn integrate_bent_normal(
  horizon_cos_1: f32,
  horizon_cos_0: f32,
  normal_cos: f32,
  normal_sin: f32
) -> vec2f {
  let negative_sin_1 = -sqrt(saturate(1.0 - horizon_cos_1 * horizon_cos_1));
  let positive_sin_0 = sqrt(saturate(1.0 - horizon_cos_0 * horizon_cos_0));
  let integral_sin = (
    negative_sin_1 * negative_sin_1 * negative_sin_1 +
    positive_sin_0 * positive_sin_0 * positive_sin_0
  ) * 0.33333333;
  let integral_cos = (
    horizon_cos_1 * horizon_cos_1 * horizon_cos_1 +
    horizon_cos_0 * horizon_cos_0 * horizon_cos_0
  ) * 0.33333333;
  let horizon_sum = horizon_cos_1 + horizon_cos_0;
  let tangent = integral_sin * normal_cos +
    (integral_cos - horizon_sum + 1.33333333) * normal_sin;
  let view = (0.66666667 - integral_cos) * normal_cos + integral_sin * normal_sin;
  return vec2f(tangent, view);
}

${FULLSCREEN_VERTEX_WGSL}

const SCALE: f32 = 1.0;
const SAMPLE_DISTRIBUTION_POWER: f32 = 2.0;
const SLICE_COUNT: i32 = 2;
const STEPS: i32 = 4;

struct SsaoRawOutput {
  @location(0) visibility: vec2f,
  @location(1) bent_normal: vec2u,
};

@fragment
fn fs_main(
  @builtin(position) coord: vec4f,
  @location(0) uv: vec2f
) -> SsaoRawOutput {
  const falloff_range = 0.615;
  const falloff_from = 1.0 - 0.615;
  const falloff_mul = -1.0 / falloff_range;
  const falloff_add = falloff_from / falloff_range + 1.0;

  let pixel = vec2u(coord.xy);
  let viewport_size = textureDimensions(gr_bucket);
  let pixel_size = 1.0 / vec2f(viewport_size);
  let device_depth = textureLoad(gr_bucket, pixel, 0).r;
  var viewspace_z = get_view_space_depth(device_depth, camera);
  viewspace_z *= 0.99999;

  let position_ws = project_position_from_depth(
    uv,
    device_depth,
    camera.view_projection_matrix_inverse
  );
  let view_position_ws = mat4_extract_position(camera.view_matrix_inverse);
  let view_direction_ws = normalize(view_position_ws - position_ws);
  let view_normal_ws = decode_g_buffer_normal(textureLoad(ray_ws, pixel, 0).xy);
  let noise = spatio_temporal_noise_r2_64(pixel, settings.frame_index);
  let noise_sample = noise.x;
  let noise_slice = noise.y;

  const pixel_too_close_threshold = 1.3;
  let ndc_to_view_mul_x_pixel_size =
    2.0 * camera.device_depth_to_view_space.z * pixel_size.x;
  let pixel_viewspace_size_at_center_z = viewspace_z * ndc_to_view_mul_x_pixel_size;
  let screenspace_radius = abs(1.0 / pixel_viewspace_size_at_center_z);
  let min_s = pixel_too_close_threshold / screenspace_radius;
  const inv_slice_count = 1.0 / f32(SLICE_COUNT);

  var visibility = 0.0;
  var bent_normal: vec3f;
  for (var slice = 0; slice < SLICE_COUNT; slice++) {
    let slice_k = (f32(slice) + noise_slice) * inv_slice_count;
    let phi = slice_k * PI;
    let cos_phi = cos(phi);
    let sin_phi = sin(phi);
    let omega = vec2f(cos_phi, -sin_phi) * screenspace_radius;
    let slice_view_dir = vec3f(cos_phi, sin_phi, 0.0);
    let slice_world_dir = v3_matrix4_rotate(slice_view_dir, camera.view_matrix_inverse);
    let ortho_world_dir = fma(
      vec3f(-dot(slice_world_dir, view_direction_ws)),
      view_direction_ws,
      slice_world_dir
    );
    let axis = normalize(cross(ortho_world_dir, view_direction_ws));
    let projected_normal = fma(
      -axis,
      vec3f(dot(view_normal_ws, axis)),
      view_normal_ws
    );
    let normal_sign = sign(dot(ortho_world_dir, projected_normal));
    let projected_normal_length = length(projected_normal);
    let normal_cos = saturate(
      dot(projected_normal, view_direction_ws) / projected_normal_length
    );
    let normal_angle = normal_sign * fast_acos(normal_cos);
    let low_horizon_cos_0 = cos(normal_angle + PI_HALF);
    let low_horizon_cos_1 = -low_horizon_cos_0;
    var horizon_cos_0 = low_horizon_cos_0;
    var horizon_cos_1 = low_horizon_cos_1;
    const inv_steps = 1.0 / f32(STEPS);

    for (var step_index = 0; step_index < STEPS; step_index++) {
      let step_base_noise = f32(slice + step_index * STEPS) * 0.6180339887498948482;
      let step_noise = fract(noise_sample + step_base_noise);
      var sample_fraction = (f32(step_index) + step_noise) * inv_steps;
      sample_fraction = pow(sample_fraction, SAMPLE_DISTRIBUTION_POWER);
      sample_fraction += min_s;
      var sample_offset = sample_fraction * omega;
      const mip_level = 0u;
      sample_offset = round(sample_offset) * pixel_size;

      let sample_uv_0 = uv + sample_offset;
      let sample_depth_0 = texture_sample_nearest_uv(
        gr_bucket,
        sample_uv_0,
        mip_level
      ).x;
      let sample_position_0 = project_position_from_depth(
        sample_uv_0,
        sample_depth_0,
        camera.view_projection_matrix_inverse
      );
      let sample_uv_1 = uv - sample_offset;
      let sample_depth_1 = texture_sample_nearest_uv(
        gr_bucket,
        sample_uv_1,
        mip_level
      ).x;
      let sample_position_1 = project_position_from_depth(
        sample_uv_1,
        sample_depth_1,
        camera.view_projection_matrix_inverse
      );

      let sample_delta_0 = sample_position_0 - position_ws;
      let sample_delta_1 = sample_position_1 - position_ws;
      let sample_distance_0 = length(sample_delta_0);
      let sample_distance_1 = length(sample_delta_1);
      let horizon_vector_0 = sample_delta_0 / sample_distance_0;
      let horizon_vector_1 = sample_delta_1 / sample_distance_1;
      let weight_0 = saturate(fma(sample_distance_0, falloff_mul, falloff_add));
      let weight_1 = saturate(fma(sample_distance_1, falloff_mul, falloff_add));
      var sample_horizon_cos_0 = dot(horizon_vector_0, view_direction_ws);
      var sample_horizon_cos_1 = dot(horizon_vector_1, view_direction_ws);
      sample_horizon_cos_0 = mix(low_horizon_cos_0, sample_horizon_cos_0, weight_0);
      sample_horizon_cos_1 = mix(low_horizon_cos_1, sample_horizon_cos_1, weight_1);
      horizon_cos_0 = max(horizon_cos_0, sample_horizon_cos_0);
      horizon_cos_1 = max(horizon_cos_1, sample_horizon_cos_1);
    }

    let horizon_0 = -fast_acos(horizon_cos_1);
    let horizon_1 = fast_acos(horizon_cos_0);
    let normal_sin = sin(normal_angle);
    let normal_sin_2 = 2.0 * normal_sin;
    let arc_0 = (
      fma(horizon_0, normal_sin_2, normal_cos) -
      cos(fma(2.0, horizon_0, -normal_angle))
    ) * 0.25;
    let arc_1 = (
      fma(horizon_1, normal_sin_2, normal_cos) -
      cos(fma(2.0, horizon_1, -normal_angle))
    ) * 0.25;
    let visibility_projection_length = mix(projected_normal_length, 1.0, 0.05);
    visibility += visibility_projection_length * (arc_0 + arc_1);

    let slice_tangent_ws = normalize(ortho_world_dir);
    let local_bent = integrate_bent_normal(
      horizon_cos_1,
      horizon_cos_0,
      normal_cos,
      normal_sin
    );
    let slice_bent_normal =
      slice_tangent_ws * local_bent.x + view_direction_ws * local_bent.y;
    bent_normal = fma(
      slice_bent_normal,
      vec3f(projected_normal_length),
      bent_normal
    );
  }

  visibility *= inv_slice_count;
  visibility = pow(visibility, SCALE);
  visibility = max(0.03, visibility);
  bent_normal = normalize(bent_normal);

  var output: SsaoRawOutput;
  output.visibility = vec2f(visibility, visibility * visibility);
  output.bent_normal = encode_g_buffer_normal(bent_normal);
  return output;
}
`;

export const SSAO_SPATIAL_WGSL = /* wgsl */ `
struct SsaoSpatialSettings {
  step_size: i32,
};

@group(0) @binding(0) var this_hit: texture_2d<f32>;
@group(0) @binding(1) var gr_bucket: texture_2d<f32>;
@group(0) @binding(2) var ray_ws: texture_2d<u32>;
@group(1) @binding(0) var<uniform> settings: SsaoSpatialSettings;

fn saturate(value: f32) -> f32 {
  return clamp(value, 0.0, 1.0);
}

fn uv_octahedral_unit_decode(encoded: vec2f) -> vec3f {
  let projected = fma(encoded, vec2f(2.0), vec2f(-1.0));
  var direction = vec3f(projected, 1.0 - abs(projected.x) - abs(projected.y));
  let correction = max(-direction.z, 0.0);
  direction.x += select(correction, -correction, direction.x > 0.0);
  direction.y += select(correction, -correction, direction.y > 0.0);
  return normalize(direction);
}

fn decode_g_buffer_normal(encoded: vec2u) -> vec3f {
  return uv_octahedral_unit_decode(vec2f(encoded) * (1.0 / 65535.0));
}

fn visibility_variance(pixel: vec2i) -> f32 {
  let kernel = array<f32, 3>(0.25, 0.125, 0.0625);
  var moments = vec2f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let weight = kernel[abs(x) + abs(y)];
      moments += textureLoad(this_hit, pixel + vec2i(x, y), 0).rg * weight;
    }
  }
  return max(moments.y - moments.x * moments.x, 0.0);
}

fn normal_edge_stopping_weight(a: vec3f, b: vec3f, power: f32) -> f32 {
  return pow(saturate(dot(a, b)), power);
}

fn relative_difference(a: f32, b: f32, sigma: f32) -> f32 {
  return abs(a - b) / sigma;
}

fn sample_weight(
  center_visibility: f32,
  sample_visibility: f32,
  phi_visibility: f32,
  center_normal: vec3f,
  sample_normal: vec3f,
  phi_normal: f32,
  center_depth: f32,
  sample_depth: f32,
  sigma_depth: f32
) -> f32 {
  let visibility_term = abs(center_visibility - sample_visibility) / phi_visibility;
  let normal_term = normal_edge_stopping_weight(center_normal, sample_normal, phi_normal);
  let depth_term = relative_difference(center_depth, sample_depth, sigma_depth);
  return exp(-(depth_term + visibility_term)) * normal_term;
}

${FULLSCREEN_VERTEX_WGSL}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec2f {
  const phi_visibility_base = 4.0;
  const phi_normal = 128.0;
  const sigma_depth = 1.0;
  const epsilon = 1e-10;
  const kernel = array<f32, 3>(1.0, 2.0 / 3.0, 1.0 / 6.0);
  const offsets = array<vec2i, 8>(
    vec2i(-1, -1), vec2i( 0, -1), vec2i( 1, -1),
    vec2i(-1,  0),                  vec2i( 1,  0),
    vec2i(-1,  1), vec2i( 0,  1), vec2i( 1,  1)
  );

  let pixel = vec2i(position.xy);
  let dimensions = vec2i(textureDimensions(this_hit));
  let center = textureLoad(this_hit, pixel, 0).rg;
  let variance = visibility_variance(pixel);
  let standard_deviation = sqrt(max(0.0, epsilon + variance));
  let visibility_phi = phi_visibility_base * standard_deviation;
  let center_normal = decode_g_buffer_normal(textureLoad(ray_ws, pixel, 0).xy);
  let center_depth = textureLoad(gr_bucket, pixel, 0).r;

  var total_weight = 1.0;
  var filtered = center;
  for (var sample_index = 0; sample_index < 8; sample_index++) {
    let offset = offsets[sample_index];
    let sample_pixel = pixel + offset * settings.step_size;
    if (any(sample_pixel < vec2i(0)) || any(sample_pixel >= dimensions)) {
      continue;
    }
    let kernel_weight = kernel[abs(offset.x)] * kernel[abs(offset.y)];
    let sample_value = textureLoad(this_hit, sample_pixel, 0).rg;
    let sample_normal = decode_g_buffer_normal(textureLoad(ray_ws, sample_pixel, 0).xy);
    let sample_depth = textureLoad(gr_bucket, sample_pixel, 0).r;
    let edge_weight = sample_weight(
      center_depth,
      sample_depth,
      sigma_depth,
      center_normal,
      sample_normal,
      phi_normal,
      center.r,
      sample_value.r,
      visibility_phi
    );
    let weight = edge_weight * kernel_weight;
    total_weight += weight;
    filtered += weight * sample_value;
  }
  return filtered / total_weight;
}
`;

export const SSAO_TEMPORAL_WGSL = /* wgsl */ `
@group(0) @binding(0) var this_hit: texture_2d<f32>;
@group(0) @binding(1) var header: texture_2d<f32>;
@group(0) @binding(2) var top: texture_2d<f32>;
@group(0) @binding(3) var mean: texture_2d<f32>;
@group(0) @binding(4) var segment_height: sampler;

fn velocity_with_largest_magnitude(source: texture_2d<f32>, pixel: vec2i) -> vec2f {
  const offsets = array<vec2i, 8>(
    vec2i(-1, -1), vec2i( 0, -1), vec2i( 1, -1),
    vec2i(-1,  0),                  vec2i( 1,  0),
    vec2i(-1,  1), vec2i( 0,  1), vec2i( 1,  1)
  );
  var velocity = textureLoad(source, pixel, 0).rg;
  var magnitude_squared = dot(velocity, velocity);
  for (var index = 0; index < 8; index++) {
    let candidate = textureLoad(source, pixel + offsets[index], 0).rg;
    let candidate_magnitude_squared = dot(candidate, candidate);
    if (candidate_magnitude_squared > magnitude_squared) {
      velocity = candidate;
      magnitude_squared = candidate_magnitude_squared;
    }
  }
  return velocity;
}

fn cubic_history_sample(source: texture_2d<f32>, uv: vec2f) -> vec4f {
  let dimensions = vec2f(textureDimensions(source, 0).xy);
  let texture_scale = vec4f(1.0 / dimensions.xy, dimensions.xy);
  let sample_position = texture_scale.zw * uv;
  let center = floor(sample_position - 0.5) + 0.5;
  let fraction = sample_position - center;
  let fraction_squared = fraction * fraction;
  let fraction_cubed = fraction * fraction_squared;
  const tension = 0.5;
  let w0 = -tension * fraction_cubed + 2.0 * tension * fraction_squared - tension * fraction;
  let w1 = (2.0 - tension) * fraction_cubed - (3.0 - tension) * fraction_squared + 1.0;
  let w2 = -(2.0 - tension) * fraction_cubed + (3.0 - 2.0 * tension) * fraction_squared + tension * fraction;
  let w3 = tension * fraction_cubed - tension * fraction_squared;
  let w12 = w1 + w2;
  let middle = texture_scale.xy * (center + w2 / w12);
  let center_sample = textureSampleLevel(source, segment_height, middle, 0.0);
  let negative = texture_scale.xy * (center - 1.0);
  let positive = texture_scale.xy * (center + 2.0);
  let weight_negative_middle = w12.x * w0.y;
  let weight_middle_negative = w0.x * w12.y;
  let weight_middle_middle = w12.x * w12.y;
  let weight_positive_middle = w3.x * w12.y;
  let weight_middle_positive = w12.x * w3.y;
  let result =
    textureSampleLevel(source, segment_height, vec2f(middle.x, negative.y), 0.0) * weight_negative_middle +
    textureSampleLevel(source, segment_height, vec2f(negative.x, middle.y), 0.0) * weight_middle_negative +
    center_sample * weight_middle_middle +
    textureSampleLevel(source, segment_height, vec2f(positive.x, middle.y), 0.0) * weight_positive_middle +
    textureSampleLevel(source, segment_height, vec2f(middle.x, positive.y), 0.0) * weight_middle_positive;
  return result / (weight_negative_middle + weight_middle_negative + weight_middle_middle + weight_positive_middle + weight_middle_positive);
}

fn neighborhood_moments(center: vec2f, pixel: vec2i) -> vec2f {
  const offsets = array<vec2i, 8>(
    vec2i(-1, -1), vec2i( 0, -1), vec2i( 1, -1),
    vec2i(-1,  0),                  vec2i( 1,  0),
    vec2i(-1,  1), vec2i( 0,  1), vec2i( 1,  1)
  );
  const inverse_sample_count = 1.0 / 9.0;
  var moments = vec2f(center.x, center.x * center.x);
  for (var index = 0; index < 8; index++) {
    let sample_value = textureLoad(this_hit, pixel + offsets[index], 0).rg;
    moments += vec2f(sample_value.x, sample_value.x * sample_value.x);
  }
  return moments * inverse_sample_count;
}

${FULLSCREEN_VERTEX_WGSL}

@fragment
fn fs_main(
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
) -> @location(0) vec2f {
  let pixel = vec2i(position.xy);
  let dimensions = textureDimensions(this_hit);
  let confidence = textureLoad(top, pixel, 0).r;
  let current = textureLoad(this_hit, pixel, 0).rg;
  let velocity = velocity_with_largest_magnitude(header, pixel);
  const velocity_limit = 128.0;
  let velocity_confidence = saturate(1.0 - length(velocity) / velocity_limit);
  let history_pixel = position.xy - velocity;
  const deviation_min = 0.5;
  const deviation_max = 1.2;
  let deviation_scale = mix(
    deviation_min,
    deviation_max,
    velocity_confidence * velocity_confidence
  );
  let history_valid = all(history_pixel >= vec2f(0.0)) &&
    all(history_pixel < vec2f(dimensions));
  let history_weight = velocity_confidence * confidence * select(0.0, 1.0, history_valid);
  var output: vec2f;
  if (history_weight <= 0.001) {
    output = current;
  } else {
    let history_uv = history_pixel / vec2f(textureDimensions(mean));
    let history_sample = cubic_history_sample(mean, history_uv).rg;
    let local_moments = neighborhood_moments(current, pixel);
    let standard_deviation = sqrt(max(local_moments.y - local_moments.x * local_moments.x, 0.0)) * deviation_scale;
    let lower = local_moments.x - standard_deviation;
    let upper = local_moments.x + standard_deviation;
    let clamped_history = clamp(history_sample.x, lower, upper);
    let history_variance = max(history_sample.y - history_sample.x * history_sample.x, 0.0);
    let clamped_second_moment = clamped_history * clamped_history + history_variance;
    const history_blend = 0.95;
    let blend = history_blend * confidence;
    output = mix(current, vec2f(clamped_history, clamped_second_moment), blend);
  }
  return output;
}
`;

export const SSAO_COMPOSITE_WGSL = /* wgsl */ `
@group(0) @binding(0) var this_hit: texture_2d<f32>;

${FULLSCREEN_VERTEX_WGSL}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let visibility = textureLoad(this_hit, vec2u(position.xy), 0).r;
  return vec4f(1.0, 1.0, 1.0, visibility);
}
`;

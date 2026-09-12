/**
 * Traceable local WebGPU port of the GTAO core in three.js r186:
 * https://github.com/mrdoob/three.js/blob/148ef33ecb6d2502ff796d4554abd1549c95d519/examples/jsm/tsl/display/GTAONode.js
 *
 * Upstream license: MIT. OEngine retains the horizon integration, sample
 * distribution, thickness and falloff invariants while replacing TSL,
 * renderer ownership and TRAA with WGSL, FrameGraph and the shared history
 * contract. See docs/porting/shading.md (SHADE-AO) for the complete ledger.
 */

import { PACKED_CAMERA_TYPE } from "./packed_camera.js";
import { GPU_SHADING_SURFACE_NORMAL_WGSL } from "../gpu/GpuComputeMaterialAbi.js";

export const GTAO_MOMENTS_FORMAT = "rgba16float" as const;
export const GTAO_FINAL_VISIBILITY_FORMAT = "r8unorm" as const;
export const GTAO_BENT_NORMAL_FORMAT = "rg16uint" as const;
export const GTAO_LINEAR_DEPTH_FORMAT = "r32float" as const;
export const GTAO_MOMENTS_BYTES_PER_PIXEL = 8;
export const GTAO_FINAL_VISIBILITY_BYTES_PER_PIXEL = 1;
export const GTAO_BENT_NORMAL_BYTES_PER_PIXEL = 4;
export const THREE_GTAO_REVISION = "148ef33ecb6d2502ff796d4554abd1549c95d519" as const;

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

export const THREE_GTAO_RAW_WGSL = /* wgsl */ `
${PACKED_CAMERA_TYPE.wgsl_declaration}
${GPU_SHADING_SURFACE_NORMAL_WGSL}

struct GtaoRawSettings {
  frame_index: u32,
  slice_count: u32,
  step_count: u32,
  radius_world: f32,
  thickness_world: f32,
  temporal_filtering: u32,
};

@group(0) @binding(0) var gr_bucket: texture_depth_2d;
@group(0) @binding(1) var ray_ws: texture_2d<u32>;
@group(0) @binding(2) var<uniform> camera: CommandEncoder;
@group(0) @binding(3) var<uniform> settings: GtaoRawSettings;
@group(0) @binding(4) var linear_depth_mip: texture_2d<f32>;

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
  return uv_octahedral_unit_decode(vec2f(encoded) * (1.0 / OENGINE_SURFACE_NORMAL_MAX_VALUE));
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

fn sample_device_depth(uv: vec2f) -> f32 {
  let dimensions = textureDimensions(gr_bucket);
  let coordinate = min(
    vec2u(saturate2(uv) * vec2f(dimensions)),
    dimensions - vec2u(1u)
  );
  return textureLoad(gr_bucket, vec2i(coordinate), 0);
}

fn screen_position_from_clip(clip: vec4f) -> vec2f {
  let ndc = clip.xy / max(abs(clip.w), 1e-6);
  return fma(ndc, vec2f(0.5, -0.5), vec2f(0.5));
}

fn center_reverse_z_depth(raw_pixel: vec2u, raw_size: vec2u, full_size: vec2u) -> f32 {
  let base = min(
    vec2u((vec2f(raw_pixel) / vec2f(raw_size)) * vec2f(full_size)),
    full_size - vec2u(1u)
  );
  if (all(raw_size == full_size)) {
    return textureLoad(gr_bucket, base, 0);
  }
  // Equivalent intent to the upstream center-depth gather: select the
  // foreground sample for a downscaled pixel and avoid silhouette banding.
  let p10 = min(base + vec2u(1u, 0u), full_size - vec2u(1u));
  let p01 = min(base + vec2u(0u, 1u), full_size - vec2u(1u));
  let p11 = min(base + vec2u(1u, 1u), full_size - vec2u(1u));
  return max(
    max(textureLoad(gr_bucket, base, 0), textureLoad(gr_bucket, p10, 0)),
    max(textureLoad(gr_bucket, p01, 0), textureLoad(gr_bucket, p11, 0))
  );
}

fn three_rand(uv: vec2f) -> f32 {
  let sn = (dot(uv, vec2f(12.9898, 78.233)) % 3.141592653589793);
  return fract(sin(sn) * 43758.5453);
}

fn interleaved_gradient_noise(pixel: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(pixel, vec2f(0.06711056, 0.00583715))));
}

fn magic_square_noise(pixel: vec2u) -> vec2f {
  // Three.js r186 generateMagicSquareNoise(5), stored inline to avoid a
  // second runtime-owned noise texture. The values retain the same 5x5 wrap
  // and angular distribution.
  const magic = array<u32, 25>(
    9u, 3u, 22u, 16u, 15u,
    2u, 21u, 20u, 14u, 8u,
    25u, 19u, 13u, 7u, 1u,
    18u, 12u, 6u, 5u, 24u,
    11u, 10u, 4u, 23u, 17u
  );
  let wrapped = pixel % vec2u(5u);
  let index = wrapped.y * 5u + wrapped.x;
  let angle = 2.0 * PI * f32(magic[index]) / 25.0;
  return vec2f(cos(angle), sin(angle));
}

fn temporal_rotation(frame_index: u32, enabled: bool) -> f32 {
  const rotations = array<f32, 6>(60.0, 300.0, 180.0, 240.0, 120.0, 0.0);
  return select(0.0, rotations[frame_index % 6u] / 360.0, enabled);
}

fn temporal_offset(frame_index: u32, enabled: bool) -> f32 {
  const offsets = array<f32, 4>(0.0, 0.5, 0.25, 0.75);
  return select(1.0, offsets[frame_index % 4u], enabled);
}

const PI: f32 = 3.1415926535897932384626433832795;

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
struct GtaoRawOutput {
  @location(0) moments_and_bent_normal: vec4f,
};

@fragment
fn fs_main(
  @builtin(position) coord: vec4f,
  @location(0) uv: vec2f
) -> GtaoRawOutput {
  let radius_world = max(settings.radius_world, 0.001);
  let inverse_radius = 1.0 / radius_world;
  let thickness_world = max(settings.thickness_world, 0.001);

  let output_pixel = vec2u(coord.xy);
  let output_size = textureDimensions(linear_depth_mip);
  let viewport_size = textureDimensions(gr_bucket);
  let sample_uv = (vec2f(output_pixel) + 0.5) / vec2f(output_size);
  let pixel = min(vec2u(sample_uv * vec2f(viewport_size)), viewport_size - vec2u(1u));
  let device_depth = center_reverse_z_depth(output_pixel, output_size, viewport_size);
  if (device_depth <= 0.0) {
    var background: GtaoRawOutput;
    let encoded_normal = vec2f(textureLoad(ray_ws, pixel, 0).xy) /
      OENGINE_SURFACE_NORMAL_MAX_VALUE;
    background.moments_and_bent_normal = vec4f(1.0, 1.0, encoded_normal);
    return background;
  }
  let position_ws = project_position_from_depth(
    sample_uv,
    device_depth,
    camera.view_projection_matrix_inverse
  );
  let view_position_ws = mat4_extract_position(camera.view_matrix_inverse);
  let view_direction_ws = normalize(view_position_ws - position_ws);
  let view_normal_ws = decode_g_buffer_normal(textureLoad(ray_ws, pixel, 0).xy);
  let temporal_enabled = settings.temporal_filtering != 0u;
  let temporal_direction = temporal_rotation(settings.frame_index, temporal_enabled);
  let temporal_sample_offset = temporal_offset(settings.frame_index, temporal_enabled);
  let noise_direction = magic_square_noise(output_pixel);
  let noise_angle = atan2(noise_direction.y, noise_direction.x);
  let noise_jitter_index = temporal_direction * 0.02;
  let step_jitter = interleaved_gradient_noise(coord.xy + temporal_sample_offset) +
    three_rand((sample_uv + noise_jitter_index) * 2.0 - 1.0);
  let clip_position = camera.view_projection_matrix * vec4f(position_ws, 1.0);
  let slice_count = clamp(i32(settings.slice_count), 1, 5);
  let step_count = clamp(i32(settings.step_count), 1, 8);
  let inv_slice_count = 1.0 / f32(slice_count);

  var visibility = 0.0;
  var bent_normal = vec3f(0.0);
  for (var slice = 0; slice < slice_count; slice++) {
    let phi = f32(slice) * inv_slice_count * PI + temporal_direction + noise_angle;
    let cos_phi = cos(phi);
    let sin_phi = sin(phi);
    let slice_view_dir = vec3f(cos_phi, sin_phi, 0.0);
    let slice_world_dir = v3_matrix4_rotate(slice_view_dir, camera.view_matrix_inverse);
    let slice_bitangent_raw = cross(slice_world_dir, view_direction_ws);
    let slice_bitangent = slice_bitangent_raw / max(length(slice_bitangent_raw), 1e-6);
    let slice_tangent = cross(slice_bitangent, view_direction_ws);
    let projected_normal_raw = view_normal_ws -
      slice_bitangent * dot(view_normal_ws, slice_bitangent);
    let projected_normal_length = length(projected_normal_raw);
    let projected_normal = projected_normal_raw / max(projected_normal_length, 1e-4);
    let normal_sin = dot(projected_normal, slice_tangent);
    let normal_cos = clamp(dot(projected_normal, view_direction_ws), 0.0, 1.0);
    let normal_sign = select(-1.0, 1.0, normal_sin >= 0.0);
    let normal_angle = normal_sign * acos(normal_cos);
    let tangent_to_normal = cross(projected_normal, slice_bitangent);
    let cosine_horizon = dot(view_direction_ws, tangent_to_normal);
    var horizon_cos_0 = cosine_horizon;
    var horizon_cos_1 = -cosine_horizon;
    let clip_direction_radius = camera.view_projection_matrix *
      vec4f(slice_world_dir * radius_world, 0.0);
    let inv_steps = 1.0 / f32(step_count);

    for (var step_index = 0; step_index < step_count; step_index++) {
      // Three.js r186 quadratic ray stepping concentrates work in the
      // near-field while its stochastic phase decorrelates frames.
      let step_t = (f32(step_index) + 1.0 + step_jitter) * inv_steps;
      let sample_distance_fraction = step_t * step_t;
      let clip_offset = clip_direction_radius * sample_distance_fraction;
      let positive_uv = screen_position_from_clip(clip_position + clip_offset);
      let negative_uv = screen_position_from_clip(clip_position - clip_offset);
      let positive_valid_uv = all(positive_uv >= vec2f(0.0)) && all(positive_uv <= vec2f(1.0));
      let negative_valid_uv = all(negative_uv >= vec2f(0.0)) && all(negative_uv <= vec2f(1.0));
      // The pinned GTAONode samples the exact depth texel at every horizon
      // location. A conservative HZB-nearest sample expands foreground
      // occluders over the entire footprint and creates broad dark bands.
      let positive_depth = select(0.0, sample_device_depth(positive_uv), positive_valid_uv);
      let negative_depth = select(0.0, sample_device_depth(negative_uv), negative_valid_uv);
      let positive_position = project_position_from_depth(
        positive_uv,
        select(device_depth, positive_depth, positive_depth > 0.0),
        camera.view_projection_matrix_inverse
      );
      let negative_position = project_position_from_depth(
        negative_uv,
        select(device_depth, negative_depth, negative_depth > 0.0),
        camera.view_projection_matrix_inverse
      );
      let positive_delta = positive_position - position_ws;
      let negative_delta = negative_position - position_ws;
      let positive_length = length(positive_delta);
      let negative_length = length(negative_delta);
      let positive_view_delta = camera.view_matrix * vec4f(positive_delta, 0.0);
      let negative_view_delta = camera.view_matrix * vec4f(negative_delta, 0.0);
      let positive_horizon = dot(view_direction_ws, positive_delta) /
        max(positive_length, 1e-4);
      let negative_horizon = dot(view_direction_ws, negative_delta) /
        max(negative_length, 1e-4);
      let positive_falloff = min(positive_length * inverse_radius, 1.0);
      let negative_falloff = min(negative_length * inverse_radius, 1.0);
      if (positive_depth > 0.0 && positive_length > 1e-4 &&
          abs(positive_view_delta.z) < thickness_world) {
        horizon_cos_0 = mix(
          max(horizon_cos_0, positive_horizon),
          horizon_cos_0,
          positive_falloff * positive_falloff
        );
      }
      if (negative_depth > 0.0 && negative_length > 1e-4 &&
          abs(negative_view_delta.z) < thickness_world) {
        horizon_cos_1 = mix(
          max(horizon_cos_1, negative_horizon),
          horizon_cos_1,
          negative_falloff * negative_falloff
        );
      }
    }

    // Activision GTAO Eq. 7, with the horizon side mapping used by the
    // pinned Three.js implementation.
    let horizon_positive = acos(clamp(horizon_cos_1, -1.0, 1.0));
    let horizon_negative = -acos(clamp(horizon_cos_0, -1.0, 1.0));
    let term_positive = -cos(2.0 * horizon_positive - normal_angle) +
      normal_cos + 2.0 * horizon_positive * normal_sin;
    let term_negative = -cos(2.0 * horizon_negative - normal_angle) +
      normal_cos + 2.0 * horizon_negative * normal_sin;
    visibility += projected_normal_length *
      (term_positive + term_negative) * 0.25;

    let local_bent = integrate_bent_normal(
      horizon_cos_1,
      horizon_cos_0,
      normal_cos,
      normal_sin
    );
    let slice_bent_normal =
      slice_tangent * local_bent.x + view_direction_ws * local_bent.y;
    bent_normal = fma(
      slice_bent_normal,
      vec3f(projected_normal_length),
      bent_normal
    );
  }

  visibility = clamp(visibility * inv_slice_count, 0.0, 1.0);
  visibility = pow(visibility, SCALE);
  bent_normal = select(view_normal_ws, normalize(bent_normal), length(bent_normal) > 1e-6);

  var output: GtaoRawOutput;
  output.moments_and_bent_normal = vec4f(
    visibility,
    visibility * visibility,
    uv_octahedral_unit_encode(bent_normal)
  );
  return output;
}
`;

export const GTAO_SPATIAL_WGSL = /* wgsl */ `
${GPU_SHADING_SURFACE_NORMAL_WGSL}
struct GtaoSpatialSettings {
  step_size: i32,
};

@group(0) @binding(0) var this_hit: texture_2d<f32>;
@group(0) @binding(1) var gr_bucket: texture_2d<f32>;
@group(0) @binding(2) var ray_ws: texture_2d<u32>;
@group(1) @binding(0) var<uniform> settings: GtaoSpatialSettings;

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
  return uv_octahedral_unit_decode(vec2f(encoded) * (1.0 / OENGINE_SURFACE_NORMAL_MAX_VALUE));
}

fn encode_filtered_bent_normal(direction: vec3f) -> vec2f {
  let denominator = abs(direction.x) + abs(direction.y) + abs(direction.z);
  var projected = direction.xy / max(denominator, 1e-6);
  if (direction.z < 0.0) {
    projected = (1.0 - abs(projected.yx)) *
      select(vec2f(-1.0), vec2f(1.0), projected >= vec2f(0.0));
  }
  return clamp(0.5 + 0.5 * projected, vec2f(0.0), vec2f(1.0));
}

fn visibility_variance(pixel: vec2i, dimensions: vec2i) -> f32 {
  let kernel = array<f32, 3>(0.25, 0.125, 0.0625);
  var moments = vec2f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let weight = kernel[abs(x) + abs(y)];
      let sample_pixel = clamp(pixel + vec2i(x, y), vec2i(0), dimensions - vec2i(1));
      moments += textureLoad(this_hit, sample_pixel, 0).rg * weight;
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

fn source_pixel(ao_pixel: vec2i, ao_dimensions: vec2i, source_dimensions: vec2i) -> vec2i {
  let uv = (vec2f(ao_pixel) + 0.5) / vec2f(ao_dimensions);
  return min(vec2i(uv * vec2f(source_dimensions)), source_dimensions - vec2i(1));
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
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
  let source_dimensions = vec2i(textureDimensions(gr_bucket));
  let center_source_pixel = source_pixel(pixel, dimensions, source_dimensions);
  let center = textureLoad(this_hit, pixel, 0);
  let variance = visibility_variance(pixel, dimensions);
  let standard_deviation = sqrt(max(0.0, epsilon + variance));
  let visibility_phi = phi_visibility_base * standard_deviation;
  let center_normal = decode_g_buffer_normal(textureLoad(ray_ws, center_source_pixel, 0).xy);
  let center_depth = textureLoad(gr_bucket, pixel, 0).r;

  var total_weight = 1.0;
  var filtered_moments = center.rg;
  var filtered_bent = uv_octahedral_unit_decode(center.ba);
  for (var sample_index = 0; sample_index < 8; sample_index++) {
    let offset = offsets[sample_index];
    let sample_pixel = pixel + offset * settings.step_size;
    if (any(sample_pixel < vec2i(0)) || any(sample_pixel >= dimensions)) {
      continue;
    }
    let kernel_weight = kernel[abs(offset.x)] * kernel[abs(offset.y)];
    let sample_value = textureLoad(this_hit, sample_pixel, 0);
    let sample_source_pixel = source_pixel(sample_pixel, dimensions, source_dimensions);
    let sample_normal = decode_g_buffer_normal(textureLoad(ray_ws, sample_source_pixel, 0).xy);
    let sample_depth = textureLoad(gr_bucket, sample_pixel, 0).r;
    let edge_weight = sample_weight(
      center.r,
      sample_value.r,
      max(visibility_phi, epsilon),
      center_normal,
      sample_normal,
      phi_normal,
      center_depth,
      sample_depth,
      sigma_depth
    );
    let weight = edge_weight * kernel_weight;
    total_weight += weight;
    filtered_moments += weight * sample_value.rg;
    filtered_bent += weight * uv_octahedral_unit_decode(sample_value.ba);
  }
  let moments = filtered_moments / total_weight;
  let bent = select(center_normal, normalize(filtered_bent), length(filtered_bent) > 1e-5);
  return vec4f(moments, encode_filtered_bent_normal(bent));
}
`;

export const GTAO_TEMPORAL_WGSL = /* wgsl */ `
${GPU_SHADING_SURFACE_NORMAL_WGSL}
struct GtaoTemporalSettings {
  history_valid: u32,
  history_blend: f32,
};

@group(0) @binding(0) var this_hit: texture_2d<f32>;
@group(0) @binding(1) var header: texture_2d<f32>;
@group(0) @binding(2) var top: texture_2d<f32>;
@group(0) @binding(3) var mean: texture_2d<f32>;
@group(0) @binding(4) var segment_height: sampler;
@group(0) @binding(5) var<uniform> settings: GtaoTemporalSettings;
@group(0) @binding(6) var surface_validity: texture_2d<f32>;

fn velocity_with_largest_magnitude(source: texture_2d<f32>, pixel: vec2i) -> vec2f {
  const offsets = array<vec2i, 8>(
    vec2i(-1, -1), vec2i( 0, -1), vec2i( 1, -1),
    vec2i(-1,  0),                  vec2i( 1,  0),
    vec2i(-1,  1), vec2i( 0,  1), vec2i( 1,  1)
  );
  let dimensions = vec2i(textureDimensions(source));
  var velocity = textureLoad(source, clamp(pixel, vec2i(0), dimensions - vec2i(1)), 0).rg;
  var magnitude_squared = dot(velocity, velocity);
  for (var index = 0; index < 8; index++) {
    let sample_pixel = clamp(pixel + offsets[index], vec2i(0), dimensions - vec2i(1));
    let candidate = textureLoad(source, sample_pixel, 0).rg;
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

fn neighborhood_moments(center: vec2f, pixel: vec2i, dimensions: vec2i) -> vec2f {
  const offsets = array<vec2i, 8>(
    vec2i(-1, -1), vec2i( 0, -1), vec2i( 1, -1),
    vec2i(-1,  0),                  vec2i( 1,  0),
    vec2i(-1,  1), vec2i( 0,  1), vec2i( 1,  1)
  );
  const inverse_sample_count = 1.0 / 9.0;
  var moments = vec2f(center.x, center.x * center.x);
  for (var index = 0; index < 8; index++) {
    let sample_pixel = clamp(pixel + offsets[index], vec2i(0), dimensions - vec2i(1));
    let sample_value = textureLoad(this_hit, sample_pixel, 0).rg;
    moments += vec2f(sample_value.x, sample_value.x * sample_value.x);
  }
  return moments * inverse_sample_count;
}

fn oct_decode(encoded: vec2f) -> vec3f {
  let projected = encoded * 2.0 - 1.0;
  var direction = vec3f(projected, 1.0 - abs(projected.x) - abs(projected.y));
  let correction = max(-direction.z, 0.0);
  direction.x += select(correction, -correction, direction.x > 0.0);
  direction.y += select(correction, -correction, direction.y > 0.0);
  return normalize(direction);
}

fn oct_encode(direction: vec3f) -> vec2f {
  let denominator = abs(direction.x) + abs(direction.y) + abs(direction.z);
  var projected = direction.xy / max(denominator, 1e-6);
  if (direction.z < 0.0) {
    projected = (1.0 - abs(projected.yx)) *
      select(vec2f(-1.0), vec2f(1.0), projected >= vec2f(0.0));
  }
  return clamp(projected * 0.5 + 0.5, vec2f(0.0), vec2f(1.0));
}

${FULLSCREEN_VERTEX_WGSL}

@fragment
fn fs_main(
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
) -> @location(0) vec4f {
  let pixel = vec2i(position.xy);
  let dimensions = textureDimensions(this_hit);
  let full_dimensions = textureDimensions(header);
  let full_pixel = min(
    vec2i((position.xy / vec2f(dimensions)) * vec2f(full_dimensions)),
    vec2i(full_dimensions) - vec2i(1)
  );
  let confidence = textureLoad(top, full_pixel, 0).r;
  let validity = textureLoad(surface_validity, full_pixel, 0).rg;
  let current = textureLoad(this_hit, pixel, 0);
  let velocity_full = velocity_with_largest_magnitude(header, full_pixel);
  let velocity = velocity_full * vec2f(dimensions) / vec2f(full_dimensions);
  const velocity_limit = 128.0;
  let velocity_confidence = clamp(1.0 - length(velocity) / velocity_limit, 0.0, 1.0);
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
  let validity_weight = select(0.0, 1.0, validity.g >= 0.5 && validity.r < 0.5);
  let history_weight = velocity_confidence * confidence * validity_weight *
    select(0.0, 1.0, history_valid && settings.history_valid != 0u);
  var output: vec4f;
  if (history_weight <= 0.001) {
    output = current;
  } else {
    let history_uv = history_pixel / vec2f(textureDimensions(mean));
    let history_sample = cubic_history_sample(mean, history_uv);
    let local_moments = neighborhood_moments(current.rg, pixel, vec2i(dimensions));
    let standard_deviation = sqrt(max(local_moments.y - local_moments.x * local_moments.x, 0.0)) * deviation_scale;
    let lower = local_moments.x - standard_deviation;
    let upper = local_moments.x + standard_deviation;
    let clamped_history = clamp(history_sample.x, lower, upper);
    let history_variance = max(history_sample.y - history_sample.x * history_sample.x, 0.0);
    let clamped_second_moment = clamped_history * clamped_history + history_variance;
    let blend = clamp(settings.history_blend, 0.0, 0.99) * history_weight;
    let filtered_moments = mix(
      current.rg,
      vec2f(clamped_history, clamped_second_moment),
      blend
    );
    let current_bent = oct_decode(current.ba);
    var history_bent = oct_decode(clamp(history_sample.ba, vec2f(0.0), vec2f(1.0)));
    history_bent = select(-history_bent, history_bent, dot(current_bent, history_bent) >= 0.0);
    let filtered_bent_sum = mix(current_bent, history_bent, blend);
    let filtered_bent = select(
      current_bent,
      normalize(filtered_bent_sum),
      length(filtered_bent_sum) > 1e-5
    );
    output = vec4f(filtered_moments, oct_encode(filtered_bent));
  }
  return output;
}
`;

export const GTAO_LINEAR_DEPTH_WGSL = /* wgsl */ `
${PACKED_CAMERA_TYPE.wgsl_declaration}

@group(0) @binding(0) var device_depth_source: texture_depth_2d;
@group(0) @binding(1) var<uniform> camera: CommandEncoder;

fn view_space_depth(depth: f32) -> f32 {
  let conversion = camera.device_depth_to_view_space;
  return select(0.0, abs(conversion.y / (depth + conversion.x)), depth > 0.0);
}

${FULLSCREEN_VERTEX_WGSL}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) f32 {
  let dimensions = textureDimensions(device_depth_source);
  let pixel = min(vec2u(uv * vec2f(dimensions)), dimensions - vec2u(1u));
  return view_space_depth(textureLoad(device_depth_source, pixel, 0));
}
`;

export const GTAO_JOINT_BILATERAL_RESOLVE_WGSL = /* wgsl */ `
${PACKED_CAMERA_TYPE.wgsl_declaration}
${GPU_SHADING_SURFACE_NORMAL_WGSL}

struct ResolveSettings {
  intensity: f32,
  _padding: vec3f,
};

@group(0) @binding(0) var visibility_source: texture_2d<f32>;
@group(0) @binding(1) var linear_depth_source: texture_2d<f32>;
@group(0) @binding(2) var device_depth_source: texture_depth_2d;
@group(0) @binding(3) var normal_source: texture_2d<u32>;
@group(0) @binding(4) var<uniform> camera: CommandEncoder;
@group(0) @binding(5) var<uniform> settings: ResolveSettings;

fn oct_decode(encoded: vec2f) -> vec3f {
  let projected = encoded * 2.0 - 1.0;
  var direction = vec3f(projected, 1.0 - abs(projected.x) - abs(projected.y));
  let correction = max(-direction.z, 0.0);
  direction.x += select(correction, -correction, direction.x > 0.0);
  direction.y += select(correction, -correction, direction.y > 0.0);
  return normalize(direction);
}

fn surface_oct_decode(encoded: vec2u) -> vec3f {
  let projected = vec2f(encoded) * (2.0 / OENGINE_SURFACE_NORMAL_MAX_VALUE) - vec2f(1.0);
  var direction = vec3f(projected, 1.0 - abs(projected.x) - abs(projected.y));
  let correction = max(-direction.z, 0.0);
  direction.x += select(correction, -correction, direction.x > 0.0);
  direction.y += select(correction, -correction, direction.y > 0.0);
  return normalize(direction);
}

fn oct_encode(direction: vec3f) -> vec2u {
  let denominator = abs(direction.x) + abs(direction.y) + abs(direction.z);
  var projected = direction.xy / max(denominator, 1e-6);
  if (direction.z < 0.0) {
    projected = (1.0 - abs(projected.yx)) * select(vec2f(-1.0), vec2f(1.0), projected >= vec2f(0.0));
  }
  return vec2u(clamp(0.5 + 0.5 * projected, vec2f(0.0), vec2f(1.0)) * 65535.0);
}

fn view_space_depth(depth: f32) -> f32 {
  let conversion = camera.device_depth_to_view_space;
  return select(0.0, abs(conversion.y / (depth + conversion.x)), depth > 0.0);
}

fn full_source_pixel(low_pixel: vec2i, low_dimensions: vec2i, full_dimensions: vec2i) -> vec2i {
  let uv = (vec2f(low_pixel) + 0.5) / vec2f(low_dimensions);
  return min(vec2i(uv * vec2f(full_dimensions)), full_dimensions - vec2i(1));
}

${FULLSCREEN_VERTEX_WGSL}

struct ResolveOutput {
  @location(0) visibility: f32,
  @location(1) bent_normal: vec2u,
};

@fragment
fn fs_main(
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f
) -> ResolveOutput {
  let full_dimensions = vec2i(textureDimensions(device_depth_source));
  let low_dimensions = vec2i(textureDimensions(visibility_source));
  let full_pixel = clamp(vec2i(position.xy), vec2i(0), full_dimensions - vec2i(1));
  let device_depth = textureLoad(device_depth_source, full_pixel, 0);
  let center_depth = view_space_depth(device_depth);
  let center_normal = surface_oct_decode(textureLoad(normal_source, full_pixel, 0).xy);
  let low_position = uv * vec2f(low_dimensions) - 0.5;
  let low_base = vec2i(floor(low_position));

  var visibility_sum = vec2f(0.0);
  var bent_sum = vec3f(0.0);
  var total_weight = 0.0;
  for (var y = 0; y <= 1; y++) {
    for (var x = 0; x <= 1; x++) {
      let candidate = clamp(low_base + vec2i(x, y), vec2i(0), low_dimensions - vec2i(1));
      let source_pixel = full_source_pixel(candidate, low_dimensions, full_dimensions);
      let sample_depth = textureLoad(linear_depth_source, candidate, 0).r;
      let sample_normal = surface_oct_decode(textureLoad(normal_source, source_pixel, 0).xy);
      let depth_sigma = max(0.01, center_depth * 0.02);
      let depth_weight = exp(-abs(sample_depth - center_depth) / depth_sigma);
      let normal_weight = pow(max(dot(center_normal, sample_normal), 0.0), 32.0);
      let fractional = abs(vec2f(candidate) - low_position);
      let bilinear_weight = max(0.0, 1.0 - fractional.x) * max(0.0, 1.0 - fractional.y);
      let weight = max(1e-5, depth_weight * normal_weight * bilinear_weight);
      let gtao_sample = textureLoad(visibility_source, candidate, 0);
      visibility_sum += gtao_sample.rg * weight;
      bent_sum += oct_decode(gtao_sample.ba) * weight;
      total_weight += weight;
    }
  }
  let resolved = visibility_sum / max(total_weight, 1e-5);
  let visibility = clamp(mix(1.0, resolved.x, clamp(settings.intensity, 0.0, 4.0)), 0.0, 1.0);
  let bent = select(center_normal, normalize(bent_sum), length(bent_sum) > 1e-5);
  var output: ResolveOutput;
  output.visibility = visibility;
  output.bent_normal = oct_encode(bent);
  return output;
}
`;

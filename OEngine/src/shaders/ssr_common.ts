/**
 * ssr_common：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { LPV_CAMERA_TYPE } from "./lpv_indirect_diffuse.js";

export const SSR_CAMERA_WGSL = LPV_CAMERA_TYPE.wgsl_declaration;

export const SSR_FULLSCREEN_VERTEX_WGSL = /* wgsl */ `
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

export const SSR_MATH_WGSL = /* wgsl */ `
const PI: f32 = 3.1415926535897932384626433832795;
const RECIPROCAL_PI: f32 = 0.31830988618379067153776752674503;
const EPSILON: f32 = 1e-6;
const F32_MAX: f32 = 3.402823466e+38;

fn saturate(value: f32) -> f32 {
  return clamp(value, 0.0, 1.0);
}

fn pow2(value: f32) -> f32 {
  return value * value;
}

fn rgb_to_luminance(color: vec3f) -> f32 {
  return dot(color, vec3f(0.212639005871510, 0.715168678767756, 0.072192315360734));
}

fn uv_to_ndc(uv: vec2f) -> vec2f {
  return fma(uv, vec2f(2.0, -2.0), vec2f(-1.0, 1.0));
}

fn ndc_to_uv(ndc: vec2f) -> vec2f {
  return fma(ndc, vec2f(0.5, -0.5), vec2f(0.5));
}

fn texel_coordinate_to_uv(position: vec2f, resolution: vec2u) -> vec2f {
  return (position + 0.5) / vec2f(resolution);
}

fn uv_to_texel_coordinate(uv: vec2f, resolution: vec2u) -> vec2f {
  return fma(uv, vec2f(resolution), vec2f(-0.5));
}

fn project_position_from_depth(uv: vec2f, depth: f32, inverse: mat4x4f) -> vec3f {
  let projected = inverse * vec4f(uv_to_ndc(uv), depth, 1.0);
  return projected.xyz / projected.w;
}

fn mat4_extract_position(matrix: mat4x4f) -> vec3f {
  return matrix[3].xyz;
}

fn v3_matrix4_project(position: vec3f, matrix: mat4x4f) -> vec3f {
  let projected = matrix * vec4f(position, 1.0);
  return projected.xyz / projected.w;
}

fn uv_octahedral_unit_decode(encoded: vec2f) -> vec3f {
  let projected = fma(encoded, vec2f(2.0), vec2f(-1.0));
  var direction = vec3f(projected, 1.0 - abs(projected.x) - abs(projected.y));
  let correction = max(-direction.z, 0.0);
  direction.x += select(correction, -correction, direction.x >= 0.0);
  direction.y += select(correction, -correction, direction.y >= 0.0);
  return normalize(direction);
}

fn decode_g_buffer_normal(encoded: vec2u) -> vec3f {
  return uv_octahedral_unit_decode(vec2f(encoded) * (1.0 / 65535.0));
}

fn decode_g_buffer_metalness(pbr: vec4f) -> f32 {
  return pbr.x;
}

fn decode_g_buffer_roughness(pbr: vec4f) -> f32 {
  return pbr.y;
}

fn metalness_to_specular_color(metalness: f32, albedo: vec3f) -> vec3f {
  return mix(vec3f(0.04), albedo, metalness);
}

fn is_background(depth: f32) -> bool {
  return depth < 1e-7;
}

fn build_orthonormal_matrix_n(normal: vec3f) -> mat3x3f {
  var tangent: vec3f;
  var bitangent: vec3f;
  if (normal.z < 0.0) {
    let inverse = 1.0 / (1.0 - normal.z);
    let xy = normal.x * normal.y * inverse;
    tangent = vec3f(1.0 - normal.x * normal.x * inverse, -xy, normal.x);
    bitangent = vec3f(xy, normal.y * normal.y * inverse - 1.0, -normal.y);
  } else {
    let inverse = 1.0 / (1.0 + normal.z);
    let xy = -normal.x * normal.y * inverse;
    tangent = vec3f(1.0 - normal.x * normal.x * inverse, xy, -normal.x);
    bitangent = vec3f(xy, 1.0 - normal.y * normal.y * inverse, -normal.y);
  }
  return mat3x3f(tangent, bitangent, normal);
}

fn rotate_left(value: u32, count: u32) -> u32 {
  return (value << count) | (value >> (32u - count));
}

fn hash_finalize(value_in: u32) -> u32 {
  var value = value_in;
  value ^= value >> 16u;
  value *= 0x85ebca6bu;
  value ^= value >> 13u;
  value *= 0xc2b2ae35u;
  value ^= value >> 16u;
  return value;
}

fn resolve_trigonometric_moments(value: vec3u) -> u32 {
  const c1 = 0xcc9e2d51u;
  const c2 = 0x1b873593u;
  var hash = 0u;
  var item = value.x * c1;
  item = rotate_left(item, 15u) * c2;
  hash = rotate_left(hash ^ item, 13u) * 5u + 0xe6546b64u;
  item = value.y * c1;
  item = rotate_left(item, 15u) * c2;
  hash = rotate_left(hash ^ item, 13u) * 5u + 0xe6546b64u;
  item = value.z * c1;
  item = rotate_left(item, 15u) * c2;
  hash = rotate_left(hash ^ item, 13u) * 5u + 0xe6546b64u;
  return hash_finalize(hash ^ 12u);
}

fn D_GGX(alpha_squared: f32, no_h_squared: f32) -> f32 {
  let denominator = no_h_squared * (alpha_squared - 1.0) + 1.0;
  return alpha_squared / (PI * denominator * denominator);
}

fn V_GGX_SmithCorrelated(alpha: f32, no_l: f32, no_v: f32) -> f32 {
  let alpha_squared = alpha * alpha;
  let lambda_v = no_l * sqrt(fma(no_v * no_v, 1.0 - alpha_squared, alpha_squared));
  let lambda_l = no_v * sqrt(fma(no_l * no_l, 1.0 - alpha_squared, alpha_squared));
  return 0.5 / max(lambda_v + lambda_l, EPSILON);
}
`;

export const SSR_COLOR_HISTORY_WGSL = /* wgsl */ `
fn rgb_to_YCoCg(color: vec3f) -> vec3f {
  let half_green = color.g * 0.5;
  return vec3f(
    0.25 * color.r + half_green + 0.25 * color.b,
    0.5 * color.r - 0.5 * color.b,
    -0.25 * color.r + half_green - 0.25 * color.b
  );
}

fn construct_pass(color: vec3f) -> vec3f {
  return vec3f(color.x - color.z + color.y, color.x + color.z, color.x - color.z - color.y);
}

fn taa_decode_color(color: vec3f) -> vec3f {
  let linear = construct_pass(color);
  return linear / (1.0 - rgb_to_luminance(linear));
}

fn taa_encode_color(color: vec3f) -> vec3f {
  return rgb_to_YCoCg(color / (1.0 + rgb_to_luminance(color)));
}

fn sign_non_zero(value: vec3f) -> vec3f {
  return select(vec3f(1.0), vec3f(-1.0), value < vec3f(0.0));
}

fn max_v3(value: vec3f) -> f32 {
  return max(value.x, max(value.y, value.z));
}

fn bounding_box_y_co(center: vec3f, direction: vec3f, minimum: vec3f, maximum: vec3f) -> f32 {
  const epsilon = 1e-5;
  let signs = sign_non_zero(direction);
  let safe_direction = select(direction, signs * vec3f(epsilon), abs(direction) < vec3f(epsilon));
  let inverse = 1.0 / safe_direction;
  return max_v3(min((minimum - center) * inverse, (maximum - center) * inverse));
}

fn pack_field(center: vec3f, candidate_value: vec3f, minimum: vec3f, maximum: vec3f) -> vec3f {
  let direction = candidate_value - center;
  return center + direction * saturate(bounding_box_y_co(center, direction, minimum, maximum));
}

fn features(center: vec3f, candidate_value: vec3f, minimum: vec3f, maximum: vec3f) -> f32 {
  let direction = candidate_value - center;
  let extent = select(center - minimum, maximum - center, direction >= vec3f(0.0));
  return max_v3(abs(direction) / (extent + vec3f(1e-6)));
}

fn add_per_probe_roughness(source: texture_2d<f32>, source_sampler: sampler, uv: vec2f) -> vec4f {
  let size = vec2f(textureDimensions(source, 0));
  let texel = size * uv;
  let center = floor(texel - 0.5) + 0.5;
  let fraction = texel - center;
  let square = fraction * fraction;
  let cube = fraction * square;
  const tension = 0.5;
  let w0 = -tension * cube + 2.0 * tension * square - tension * fraction;
  let w1 = (2.0 - tension) * cube - (3.0 - tension) * square + 1.0;
  let w2 = -(2.0 - tension) * cube + (3.0 - 2.0 * tension) * square + tension * fraction;
  let w3 = tension * cube - tension * square;
  let sum12 = w1 + w2;
  let uv12 = (center + w2 / sum12) / size;
  let uv0 = (center - 1.0) / size;
  let uv3 = (center + 2.0) / size;
  let weight00 = sum12.x * w0.y;
  let weight10 = w0.x * sum12.y;
  let weight11 = sum12.x * sum12.y;
  let weight21 = w3.x * sum12.y;
  let weight12 = sum12.x * w3.y;
  return (
    textureSampleLevel(source, source_sampler, vec2f(uv12.x, uv0.y), 0.0) * weight00 +
    textureSampleLevel(source, source_sampler, vec2f(uv0.x, uv12.y), 0.0) * weight10 +
    textureSampleLevel(source, source_sampler, uv12, 0.0) * weight11 +
    textureSampleLevel(source, source_sampler, vec2f(uv3.x, uv12.y), 0.0) * weight21 +
    textureSampleLevel(source, source_sampler, vec2f(uv12.x, uv3.y), 0.0) * weight12
  ) / (weight00 + weight10 + weight11 + weight21 + weight12);
}

fn taa_get_velocity(source: texture_2d<f32>, position: vec2i) -> vec2f {
  const offsets = array<vec2i, 8>(
    vec2i(-1, -1), vec2i(0, -1), vec2i(1, -1), vec2i(-1, 0),
    vec2i(1, 0), vec2i(-1, 1), vec2i(0, 1), vec2i(1, 1)
  );
  var velocity = textureLoad(source, position, 0).rg;
  var magnitude = dot(velocity, velocity);
  for (var index = 0; index < 8; index++) {
    let candidate = textureLoad(source, position + offsets[index], 0).rg;
    let candidate_magnitude = dot(candidate, candidate);
    if (candidate_magnitude > magnitude) {
      velocity = candidate;
      magnitude = candidate_magnitude;
    }
  }
  return velocity;
}
`;

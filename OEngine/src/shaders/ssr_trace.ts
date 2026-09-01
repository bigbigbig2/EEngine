/**
 * ssr_trace：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import {
  SSR_CAMERA_WGSL,
  SSR_FULLSCREEN_VERTEX_WGSL,
  SSR_MATH_WGSL
} from "./ssr_common.js";

export const SSR_TRACE_FORMAT = "rg32uint" as const;

export const SSR_TRACE_WGSL = /* wgsl */ `
${SSR_CAMERA_WGSL}
${SSR_FULLSCREEN_VERTEX_WGSL}
${SSR_MATH_WGSL}

struct SsrTraceSettings {
  max_distance: f32,
  frame_index: u32,
  edge_fade: f32,
  max_steps: u32,
  depth_thickness: f32,
  roughness_thickness: f32,
  distance_thickness: f32,
  roughness_cutoff: f32,
};

struct SsrHit {
  position: vec2u,
  confidence: f32,
  iteration_count: u32,
  outcome: u32,
  distance_exceeded: bool,
  high_roughness: bool,
};

@group(0) @binding(0) var<uniform> settings: SsrTraceSettings;
@group(0) @binding(1) var<uniform> camera: CommandEncoder;
@group(0) @binding(2) var replacement: texture_3d<f32>;
@group(0) @binding(3) var gr_bucket: texture_2d<f32>;
@group(0) @binding(4) var encoder: texture_2d<f32>;
@group(0) @binding(5) var edge: texture_2d<f32>;
@group(0) @binding(6) var ray_ws: texture_2d<u32>;

fn stbn_sample_vec2(value: vec3u) -> vec2f {
  return textureLoad(replacement, value % vec3u(128u, 128u, 64u), 0).rg;
}

fn emit_write_code_array(sample_value: vec2f, direction: vec3f) -> vec3f {
  let phi = 2.0 * PI * sample_value.x;
  let z = fma(1.0 - sample_value.y, 1.0 + direction.z, -direction.z);
  let radius = sqrt(saturate(1.0 - z * z));
  return vec3f(radius * cos(phi), radius * sin(phi), z) + direction;
}

fn create_export_wrapper(direction: vec3f, scale_x: f32, scale_y: f32, y: f32, x: f32) -> vec3f {
  let stretched = normalize(vec3f(scale_x * direction.x, scale_y * direction.y, direction.z));
  let sampled = emit_write_code_array(vec2f(x, y), stretched);
  return normalize(vec3f(scale_x * sampled.x, scale_y * sampled.y, max(0.0, sampled.z)));
}

fn scatter_keys_wlt16(direction: vec3f, roughness: f32, x: f32, y: f32) -> vec3f {
  return create_export_wrapper(direction, roughness, roughness, x, y);
}

fn sample_reflection_vector(view_direction: vec3f, normal: vec3f, roughness: f32, sample_value: vec2f) -> vec3f {
  let basis = build_orthonormal_matrix_n(normal);
  let local_view = vec3f(dot(basis[0], view_direction), dot(basis[1], view_direction), dot(basis[2], view_direction));
  let micro_normal = scatter_keys_wlt16(local_view, roughness, sample_value.x, sample_value.y);
  let local_reflection = reflect(-local_view, micro_normal);
  return local_reflection * transpose(basis);
}

fn ffx_sssr_get_mip_resolution(resolution: vec2f, mip: i32) -> vec2f {
  return resolution * pow(0.5, f32(mip));
}

fn ffx_sssr_load_depth(position: vec2i, mip: i32) -> f32 {
  if (mip <= 0) { return textureLoad(gr_bucket, position, 0).x; }
  return textureLoad(encoder, position, mip - 1).y;
}

fn ffx_sssr_load_world_space_normal(position: vec2i) -> vec3f {
  return decode_g_buffer_normal(textureLoad(ray_ws, position, 0).xy);
}

fn graph_add_bundle(value: vec3f, inverse_projection: mat4x4f) -> vec3f {
  let projected = inverse_projection * vec4f(uv_to_ndc(value.xy), value.z, 1.0);
  return projected.xyz / projected.w;
}

fn ffx_sssr_screen_space_to_view_space(value: vec3f) -> vec3f {
  return graph_add_bundle(value, camera.projection_matrix_inverse);
}

fn copy_buffer_and_zero(value: vec3f, projection: mat4x4f) -> vec3f {
  let projected = projection * vec4f(value, 1.0);
  let ndc = projected.xyz / projected.w;
  return vec3f(ndc_to_uv(ndc.xy), ndc.z);
}

fn project_direction(origin: vec3f, direction: vec3f, screen_origin: vec3f, projection: mat4x4f) -> vec3f {
  return copy_buffer_and_zero(origin + direction, projection) - screen_origin;
}

fn clip_bounding_box_y(
  origin: vec3f,
  direction: vec3f,
  inverse_direction: vec3f,
  mip_resolution: vec2f,
  inverse_resolution: vec2f,
  floor_offset: vec2f,
  uv_offset: vec2f,
  position: ptr<function, vec3f>,
  distance: ptr<function, f32>
) {
  let mip_position = mip_resolution * origin.xy;
  var boundary = floor(mip_position) + floor_offset;
  boundary = boundary * inverse_resolution + uv_offset;
  let distances = boundary * inverse_direction.xy - origin.xy * inverse_direction.xy;
  *distance = min(distances.x, distances.y);
  *position = origin + *distance * direction;
}

fn extend_error(
  origin: vec3f,
  direction: vec3f,
  inverse_direction: vec3f,
  mip_position: vec2f,
  inverse_resolution: vec2f,
  floor_offset: vec2f,
  uv_offset: vec2f,
  surface_depth: f32,
  position: ptr<function, vec3f>,
  distance: ptr<function, f32>
) -> bool {
  var boundary = floor(mip_position) + floor_offset;
  boundary = boundary * inverse_resolution + uv_offset;
  let boundary_position = vec3f(boundary, surface_depth);
  var distances = boundary_position * inverse_direction - origin * inverse_direction;
  distances.z = select(F32_MAX, distances.z, direction.z < 0.0);
  let minimum = min(min(distances.x, distances.y), distances.z);
  let crossed_depth = surface_depth < (*position).z;
  let crossed_cell = bitcast<u32>(minimum) != bitcast<u32>(distances.z) && crossed_depth;
  *distance = select(*distance, minimum, crossed_depth);
  *position = origin + *distance * direction;
  return crossed_cell;
}

fn ffx_sssr_hierarchical_raymarch(
  origin: vec3f,
  direction: vec3f,
  screen_size: vec2f,
  most_detailed_mip: i32,
  max_iterations: u32,
  valid_hit: ptr<function, bool>,
  iteration_count: ptr<function, u32>
) -> vec3f {
  let inverse_direction = select(vec3f(F32_MAX), 1.0 / direction, abs(direction) > vec3f(1e-12));
  var mip = most_detailed_mip;
  var mip_resolution = ffx_sssr_get_mip_resolution(screen_size, mip);
  var inverse_resolution = 1.0 / mip_resolution;
  var uv_offset = 0.005 * exp2(f32(most_detailed_mip)) / screen_size;
  uv_offset = select(uv_offset, -uv_offset, direction.xy < vec2f(0.0));
  let floor_offset = select(vec2f(1.0), vec2f(0.0), direction.xy < vec2f(0.0));
  var distance: f32;
  var position: vec3f;
  clip_bounding_box_y(origin, direction, inverse_direction, mip_resolution, inverse_resolution, floor_offset, uv_offset, &position, &distance);
  var iterations = 0u;
  for (; iterations < max_iterations && mip >= most_detailed_mip; iterations++) {
    if (any(position.xy > vec2f(1.0)) || any(position.xy < vec2f(0.0))) { break; }
    if (is_background(position.z)) { break; }
    let mip_position = mip_resolution * position.xy;
    let surface_depth = ffx_sssr_load_depth(vec2i(mip_position), mip);
    let crossed_cell = extend_error(
      origin, direction, inverse_direction, mip_position, inverse_resolution,
      floor_offset, uv_offset, surface_depth, &position, &distance
    );
    mip += select(-1, 1, crossed_cell);
    mip_resolution *= select(2.0, 0.5, crossed_cell);
    inverse_resolution *= select(0.5, 2.0, crossed_cell);
  }
  *iteration_count = iterations;
  *valid_hit = mip <= most_detailed_mip && iterations > 0u;
  return position;
}

fn packed_bvh_from_json(hit: vec3f, surface_depth: f32, thickness: f32) -> f32 {
  let surface = ffx_sssr_screen_space_to_view_space(vec3f(hit.xy, surface_depth));
  let ray = ffx_sssr_screen_space_to_view_space(hit);
  var confidence = 1.0 - smoothstep(0.0, thickness, length(surface - ray));
  return confidence * confidence;
}

fn get_map(hit: vec3f, origin_uv: vec2f, ray_direction: vec3f, screen_size: vec2f, thickness: f32) -> f32 {
  if (any(hit.xy < vec2f(0.0)) || any(hit.xy > vec2f(1.0))) { return 0.0; }
  if (all(abs(hit.xy - origin_uv) * screen_size < vec2f(2.0))) { return 0.0; }
  let hit_position = vec2i(screen_size * hit.xy);
  let surface_depth = ffx_sssr_load_depth(hit_position, 0);
  if (is_background(surface_depth)) { return 0.0; }
  let hit_normal = ffx_sssr_load_world_space_normal(hit_position);
  let hit_normal_view = (camera.view_matrix * vec4f(hit_normal, 0.0)).xyz;
  let facing = dot(hit_normal_view, -ray_direction);
  if (facing <= 1e-5) { return 0.0; }
  return packed_bvh_from_json(hit, surface_depth, thickness * facing);
}

fn find_strip_next(uv: vec2f, screen_size: vec2f) -> f32 {
  if (settings.edge_fade <= 0.0) { return 1.0; }
  let fade = settings.edge_fade * vec2f(screen_size.y / screen_size.x, 1.0);
  let edge = smoothstep(vec2f(0.0), fade, uv) * (1.0 - smoothstep(vec2f(1.0) - fade, vec2f(1.0), uv));
  return edge.x * edge.y;
}

fn ffx_sssr_validate_hit(hit: vec3f, origin_uv: vec2f, ray_direction: vec3f, screen_size: vec2f, thickness: f32) -> f32 {
  return get_map(hit, origin_uv, ray_direction, screen_size, thickness) * find_strip_next(origin_uv, screen_size);
}

fn ssr_hit_pack(hit: SsrHit) -> vec2u {
  let diagnostics =
    (min(hit.iteration_count, 255u) << 8u) |
    ((hit.outcome & 0xffu) << 16u) |
    (select(0u, 1u << 24u, hit.distance_exceeded)) |
    (select(0u, 1u << 25u, hit.high_roughness));
  return vec2u(
    (hit.position.x & 0xffffu) | (hit.position.y << 16u),
    u32(round(saturate(hit.confidence) * 255.0)) | diagnostics
  );
}

fn ssr_diagnostic_result(
  outcome: u32,
  iteration_count: u32,
  high_roughness: bool
) -> vec2u {
  var result: SsrHit;
  result.position = vec2u(0u);
  result.confidence = 0.0;
  result.iteration_count = iteration_count;
  result.outcome = outcome;
  result.distance_exceeded = false;
  result.high_roughness = high_roughness;
  return ssr_hit_pack(result);
}

@fragment
fn fs_main(
  @builtin(position) coord: vec4f,
  @location(0) uv: vec2f
) -> @location(0) vec2u {
  const g_most_detailed_mip = 0;
  let pixel = vec2u(coord.xy);
  let roughness = decode_g_buffer_roughness(textureLoad(edge, pixel, 0));
  let screen_size = textureDimensions(gr_bucket, 0);
  var sample_uv = stbn_sample_vec2(vec3u(pixel, settings.frame_index));
  sample_uv.x *= 0.8;
  let is_mirror = roughness < 0.0001;
  let most_detailed_mip = select(g_most_detailed_mip, 0, is_mirror);
  let mip_resolution = ffx_sssr_get_mip_resolution(vec2f(screen_size), most_detailed_mip);
  let depth = ffx_sssr_load_depth(vec2i(uv * mip_resolution), most_detailed_mip);
  let high_roughness = roughness > settings.roughness_cutoff;
  if (is_background(depth)) { return ssr_diagnostic_result(0u, 0u, high_roughness); }
  if (high_roughness) { return ssr_diagnostic_result(4u, 0u, true); }
  let screen_origin = vec3f(uv, depth);
  let view_origin = ffx_sssr_screen_space_to_view_space(screen_origin);
  let view_direction = normalize(view_origin);
  let world_normal = ffx_sssr_load_world_space_normal(vec2i(pixel));
  let view_normal = (camera.view_matrix * vec4f(world_normal, 0.0)).xyz;
  let reflected = sample_reflection_vector(-view_direction, view_normal, roughness, sample_uv);
  let screen_direction = project_direction(view_origin, reflected, screen_origin, camera.projection_matrix);
  var valid_hit: bool;
  var iterations: u32;
  let hit = ffx_sssr_hierarchical_raymarch(
    screen_origin, screen_direction, vec2f(screen_size), most_detailed_mip,
    settings.max_steps, &valid_hit, &iterations
  );
  if (!valid_hit || is_background(hit.z) || hit.z > 1.0) {
    return ssr_diagnostic_result(1u, iterations, high_roughness);
  }
  let view_hit = ffx_sssr_screen_space_to_view_space(hit);
  let ray = view_hit - view_origin;
  let ray_length = length(ray);
  let thickness = settings.depth_thickness +
    roughness * settings.roughness_thickness +
    ray_length * settings.distance_thickness;
  let confidence = ffx_sssr_validate_hit(hit, uv, normalize(ray), vec2f(screen_size), thickness);
  let distance_exceeded = ray_length > settings.max_distance;
  var encoded: SsrHit;
  encoded.confidence = select(confidence, 0.0, distance_exceeded);
  encoded.position = vec2u(hit.xy * vec2f(screen_size));
  encoded.iteration_count = iterations;
  encoded.outcome = select(select(2u, 3u, confidence > 0.0), 5u, distance_exceeded);
  encoded.distance_exceeded = distance_exceeded;
  encoded.high_roughness = high_roughness;
  return ssr_hit_pack(encoded);
}
`;

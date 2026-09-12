/**
 * Three.js r186-derived stochastic SSR hit shading.
 *
 * RGB stores receiver-resolved, pre-exposed specular; A stores dominant hit
 * ray length. Misses remain black so OEngine's later confidence replacement
 * keeps the Local Probe/IBL baseline authoritative.
 */

import {
  SSR_CAMERA_WGSL,
  SSR_FULLSCREEN_VERTEX_WGSL,
  SSR_MATH_WGSL
} from "./ssr_common.js";
import {
  SSR_STOCHASTIC_SAMPLE_WGSL,
  SSR_TRACE_SETTINGS_WGSL
} from "./ssr_stochastic_sample.js";

export const SSR_RESOLVE_FORMAT = "rgba16float" as const;

export const SSR_RESOLVE_WGSL = /* wgsl */ `
${SSR_CAMERA_WGSL}
${SSR_FULLSCREEN_VERTEX_WGSL}
${SSR_MATH_WGSL}
${SSR_TRACE_SETTINGS_WGSL}
${SSR_STOCHASTIC_SAMPLE_WGSL}

struct SsrHit { position: vec2u, confidence: f32 };

@group(0) @binding(0) var trace_source: texture_2d<u32>;
@group(0) @binding(1) var depth_source: texture_2d<f32>;
@group(0) @binding(2) var pbr_source: texture_2d<u32>;
@group(0) @binding(3) var normal_source: texture_2d<u32>;
@group(0) @binding(4) var color_pyramid: texture_2d<f32>;
@group(0) @binding(5) var albedo_ao_source: texture_2d<f32>;
@group(0) @binding(6) var linear_clamp: sampler;
@group(0) @binding(7) var<uniform> camera: CommandEncoder;
@group(0) @binding(8) var stochastic_noise: texture_3d<f32>;
@group(0) @binding(9) var<uniform> trace_settings: SsrTraceSettings;

fn unpack_hit(packed: vec2u) -> SsrHit {
  var hit: SsrHit;
  hit.position = vec2u(packed.x & 0xffffu, packed.x >> 16u);
  hit.confidence = f32(packed.y & 0xffu) / 255.0;
  return hit;
}

fn world_to_view_direction(direction: vec3f) -> vec3f {
  let matrix = camera.view_matrix;
  return normalize(mat3x3f(matrix[0].xyz, matrix[1].xyz, matrix[2].xyz) * direction);
}

fn view_position(position: vec2u) -> vec3f {
  let dimensions = textureDimensions(depth_source);
  let clamped = min(position, dimensions - vec2u(1u));
  let uv = texel_coordinate_to_uv(vec2f(clamped), dimensions);
  return project_position_from_depth(
    uv,
    textureLoad(depth_source, vec2i(clamped), 0).r,
    camera.projection_matrix_inverse
  );
}

fn specular_dominant_factor(no_v: f32, roughness: f32) -> f32 {
  let a = 0.298475 * log(39.4115 - 39.0029 * roughness);
  return saturate(pow(1.0 - no_v, 10.8649) * (1.0 - a) + a);
}

fn ray_mip_level(
  start: vec3f,
  hit: vec3f,
  hit_normal: vec3f,
  roughness: f32
) -> f32 {
  let ray = hit - start;
  let ray_length = max(length(ray), 1e-5);
  let ray_direction = ray / ray_length;
  let focal_length_px = f32(textureDimensions(color_pyramid, 0).y) /
    max(2.0 * camera.device_depth_to_view_space.w, 1e-5);
  let cone_diameter = ray_length * roughness * 0.7;
  let incidence = saturate(dot(-ray_direction, hit_normal));
  let footprint = cone_diameter * focal_length_px * incidence / max(abs(hit.z), 1e-5);
  let generated_last_mip = min(textureNumLevels(color_pyramid) - 1u, 4u);
  return clamp(log2(max(1.0, footprint)), 0.0, f32(generated_last_mip));
}

@fragment
fn fs_main(@builtin(position) coord: vec4f) -> @location(0) vec4f {
  let trace_pixel = vec2i(coord.xy);
  let hit = unpack_hit(textureLoad(trace_source, trace_pixel, 0).xy);
  if (hit.confidence <= 0.0) { return vec4f(0.0); }

  let trace_size = vec2f(textureDimensions(trace_source));
  let surface_size = textureDimensions(depth_source);
  let trace_uv = coord.xy / trace_size;
  let surface_pixel = min(
    vec2u(trace_uv * vec2f(surface_size)),
    surface_size - vec2u(1u)
  );
  let hit_pixel = min(hit.position, surface_size - vec2u(1u));
  let start = view_position(surface_pixel);
  let hit_position = view_position(hit_pixel);
  let ray = hit_position - start;
  let ray_length = length(ray);
  if (ray_length <= 1e-5) { return vec4f(0.0); }

  let normal = world_to_view_direction(
    decode_g_buffer_normal(textureLoad(normal_source, vec2i(surface_pixel), 0).xy)
  );
  let hit_normal = world_to_view_direction(
    decode_g_buffer_normal(textureLoad(normal_source, vec2i(hit_pixel), 0).xy)
  );
  let view_direction = normalize(-start);
  let pbr = textureLoad(pbr_source, vec2i(surface_pixel), 0);
  let roughness = decode_g_buffer_roughness(pbr);
  let metalness = decode_g_buffer_metalness(pbr);
  let albedo = max(textureLoad(albedo_ao_source, vec2i(surface_pixel), 0).rgb, vec3f(0.0));
  let hit_uv = texel_coordinate_to_uv(vec2f(hit_pixel), surface_size);
  let mip = ray_mip_level(start, hit_position, hit_normal, roughness);
  let incident = max(textureSampleLevel(color_pyramid, linear_clamp, hit_uv, mip).rgb, vec3f(0.0));
  let noise_coordinate = vec3u(vec2u(trace_pixel), trace_settings.frame_index);
  let sample_value = ssr_stbn_sample_vec4(
    textureLoad(
      stochastic_noise,
      noise_coordinate % vec3u(128u, 128u, 64u),
      0
    ).rg,
    noise_coordinate
  );
  let sampled_direction = ssr_sample_reflection_vector(
    view_direction,
    normal,
    roughness,
    sample_value,
    trace_settings.mirror_bias
  );
  let weight = stochastic_sample_weight(
    normal, view_direction, sampled_direction, roughness, metalness, albedo
  );
  let resolved = incident * weight;
  let dominant_length = ray_length * specular_dominant_factor(
    max(0.0, dot(normal, view_direction)), roughness
  );
  let finite = all(resolved == resolved) && all(abs(resolved) < vec3f(65504.0));
  return select(
    vec4f(0.0),
    vec4f(resolved, min(dominant_length, 65504.0)),
    finite
  );
}
`;

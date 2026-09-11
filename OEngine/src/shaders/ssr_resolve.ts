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

export const SSR_RESOLVE_FORMAT = "rgba16float" as const;

export const SSR_RESOLVE_WGSL = /* wgsl */ `
${SSR_CAMERA_WGSL}
${SSR_FULLSCREEN_VERTEX_WGSL}
${SSR_MATH_WGSL}

struct SsrHit { position: vec2u, confidence: f32 };

@group(0) @binding(0) var trace_source: texture_2d<u32>;
@group(0) @binding(1) var depth_source: texture_2d<f32>;
@group(0) @binding(2) var pbr_source: texture_2d<u32>;
@group(0) @binding(3) var normal_source: texture_2d<u32>;
@group(0) @binding(4) var color_pyramid: texture_2d<f32>;
@group(0) @binding(5) var albedo_ao_source: texture_2d<f32>;
@group(0) @binding(6) var linear_clamp: sampler;
@group(0) @binding(7) var<uniform> camera: CommandEncoder;

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

fn smith_g(ndotx: f32, alpha: f32) -> f32 {
  let alpha2 = alpha * alpha;
  let ndotx2 = ndotx * ndotx;
  return 2.0 * ndotx /
    max(ndotx + sqrt(alpha2 + (1.0 - alpha2) * ndotx2), 1e-6);
}

fn fresnel_schlick(f0: vec3f, theta: f32) -> vec3f {
  let one_minus = 1.0 - theta;
  let one_minus2 = one_minus * one_minus;
  let one_minus5 = one_minus2 * one_minus2 * one_minus;
  return f0 + (vec3f(1.0) - f0) * one_minus5;
}

// BRDF*cos/pdf invariant of Three.js r186 ggxReflectionSample. The trace
// sampled the bounded VNDF; resolve reconstructs the same terms from the hit
// direction so SSR and baseline are in the same receiver-resolved domain.
fn stochastic_sample_weight(
  normal: vec3f,
  view_direction: vec3f,
  ray_direction: vec3f,
  roughness: f32,
  metalness: f32,
  albedo: vec3f
) -> vec3f {
  let half_vector = normalize(view_direction + ray_direction);
  let no_v = max(0.0, dot(normal, view_direction));
  let no_l = max(0.0, dot(normal, ray_direction));
  let vo_h = max(0.0, dot(view_direction, half_vector));
  let alpha = max(roughness * roughness, 0.001);
  let f0 = mix(vec3f(0.04), albedo, metalness);
  let fresnel = fresnel_schlick(f0, vo_h);
  let geometry = smith_g(no_v, alpha) * smith_g(no_l, alpha);
  let sin_v2 = max(0.0, 1.0 - no_v * no_v);
  let cap_s = 1.0 + sqrt(sin_v2);
  let cap_s2 = cap_s * cap_s;
  let alpha2 = alpha * alpha;
  let cap_k = (1.0 - alpha2) * cap_s2 /
    max(cap_s2 + alpha2 * no_v * no_v, 1e-6);
  let stretched_length = sqrt(alpha2 * sin_v2 + no_v * no_v);
  return fresnel * geometry * (cap_k * no_v + stretched_length) /
    max(2.0 * no_v, 1e-4);
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
  let surface_pixel = min(
    vec2u((coord.xy + vec2f(0.5)) * vec2f(surface_size) / trace_size),
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
  let ray_direction = ray / ray_length;
  let pbr = textureLoad(pbr_source, vec2i(surface_pixel), 0);
  let roughness = decode_g_buffer_roughness(pbr);
  let metalness = decode_g_buffer_metalness(pbr);
  let albedo = max(textureLoad(albedo_ao_source, vec2i(surface_pixel), 0).rgb, vec3f(0.0));
  let hit_uv = texel_coordinate_to_uv(vec2f(hit_pixel), surface_size);
  let mip = ray_mip_level(start, hit_position, hit_normal, roughness);
  let incident = max(textureSampleLevel(color_pyramid, linear_clamp, hit_uv, mip).rgb, vec3f(0.0));
  let weight = stochastic_sample_weight(
    normal, view_direction, ray_direction, roughness, metalness, albedo
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

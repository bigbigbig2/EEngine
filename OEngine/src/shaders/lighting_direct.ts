/**
 * lighting_direct：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { CodeChunk } from "../core/WebGPUTypes.js";
import {
  DIRECTIONAL_LIGHT_DESCRIPTOR,
  LIGHT_DATABASE_READ_CHUNK,
  POINT_LIGHT_DESCRIPTOR,
  SHADOW_DIRECTIONAL_DESCRIPTOR,
  SHADOW_POINT_DESCRIPTOR,
  SHADOW_SPOT_DESCRIPTOR,
  SPOT_LIGHT_DESCRIPTOR
} from "../gpu/LightDatabase.js";
import { GPU_VIEW_TYPE } from "../render/ViewManager.js";
import { LPV_CAMERA_TYPE } from "./lpv_indirect_diffuse.js";
import { GBUFFER_ENCODE_WGSL } from "./gbuffer_encode.js";

export const LIGHTING_DIRECT_FORMAT = "rgba16float" as const;

const DIRECT_LIGHT_DATABASE_WGSL = CodeChunk.from("", [
  LIGHT_DATABASE_READ_CHUNK,
  SHADOW_POINT_DESCRIPTOR.chunk_read,
  SHADOW_SPOT_DESCRIPTOR.chunk_read,
  SHADOW_DIRECTIONAL_DESCRIPTOR.chunk_read
]).compile().text;

export const LIGHTING_DIRECT_WGSL = /* wgsl */ `
${GPU_VIEW_TYPE.wgsl_declaration}
${LPV_CAMERA_TYPE.wgsl_declaration}
${GBUFFER_ENCODE_WGSL}
${DIRECT_LIGHT_DATABASE_WGSL}

const PI: f32 = 3.1415926535897932384626433832795;
const RECIPROCAL_PI: f32 = 0.318309886183790671537767526745028724;
const EPSILON: f32 = 1e-6;

struct StandardMaterial {
  diffuse: vec3f,
  roughness: f32,
  occlusion: f32,
  specularF0: vec3f,
  specularF90: f32,
  emissive: vec3f,
  opacity: f32,
}

struct SurfaceGeometry {
  shading_normal: vec3f,
  geometric_normal: vec3f,
  position: vec3f,
  view_direction: vec3f,
}

struct ReflectedLight {
  diffuse: vec3f,
  specular: vec3f,
}

struct ClusterMetadata {
  counts: u32,
  offset: u32,
}

@group(0) @binding(0) var yz: texture_depth_2d;
@group(0) @binding(1) var light: texture_2d<f32>;
@group(0) @binding(2) var ag_x: texture_2d<u32>;
@group(0) @binding(3) var nzb: texture_2d<f32>;
@group(0) @binding(4) var input_texture: texture_2d<u32>;
@group(0) @binding(5) var segment_height: sampler;

@group(1) @binding(0) var<storage, read> node: array<u32>;
@group(1) @binding(1) var sec_radix_passes: texture_2d<f32>;
@group(1) @binding(2) var<uniform> cluster_parameters: vec3f;
@group(1) @binding(3) var<storage, read> cluster_lookup: array<ClusterMetadata>;
@group(1) @binding(4) var<storage, read> cluster_data: array<u32>;
@group(1) @binding(5) var pass_descriptor: texture_depth_2d;
@group(1) @binding(6) var u_int: sampler_comparison;

@group(2) @binding(0) var<uniform> view: PipelineCacheKey;
@group(2) @binding(1) var<uniform> camera: CommandEncoder;

var<private> rnd_state: u32 = 2891336453u;

fn saturate(value: f32) -> f32 { return clamp(value, 0.0, 1.0); }

fn random_hash3(value_in: vec3u) -> vec3u {
  var value = value_in * 1664525u + 1013904223u;
  value.x += value.y * value.z;
  value.y += value.z * value.x;
  value.z += value.x * value.y;
  value ^= value >> vec3u(16u);
  value.x += value.y * value.z;
  value.y += value.z * value.x;
  value.z += value.x * value.y;
  return value;
}

fn random_initialize(invocation: vec3u, seed: vec3u) {
  let value = random_hash3(invocation + seed * 37u);
  rnd_state = value.x ^ value.y ^ value.z;
}

fn random_u32() -> u32 {
  let state = rnd_state * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  rnd_state = (word >> 22u) ^ word;
  return rnd_state;
}

fn random_vec2() -> vec2f { return unpack2x16unorm(random_u32()); }

fn random_round_vec2(value: vec2f) -> vec2f {
  let offset = select(vec2f(0.0), vec2f(1.0), fract(value) > random_vec2());
  return floor(value) + offset;
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

fn mat4_extract_position(value: mat4x4f) -> vec3f { return value[3].xyz; }

fn metalness_to_specular_color(metalness: f32, albedo: vec3f) -> vec3f {
  return mix(vec3f(0.04), albedo, metalness);
}

fn read_gBuffer_material(i_coord: vec2u) -> StandardMaterial {
  let texel_pbr = textureLoad(light, i_coord, 0);
  let albedo_ao = textureLoad(nzb, i_coord, 0);
  let albedo = albedo_ao.rgb;
  let emissive = rgbe9995_decode(textureLoad(input_texture, i_coord, 0).r);
  let metalness = decode_g_buffer_metalness(texel_pbr);
  let roughness = decode_g_buffer_roughness(texel_pbr);
  var material: StandardMaterial;
  material.diffuse = albedo * (1.0 - metalness);
  material.occlusion = albedo_ao.a;
  material.roughness = max(roughness, 0.02);
  material.specularF0 = metalness_to_specular_color(metalness, albedo);
  material.specularF90 = 1.0;
  material.emissive = emissive;
  return material;
}

fn light_cluster_count_point(counts: u32) -> u32 { return counts & 0xffu; }
fn light_cluster_count_spot(counts: u32) -> u32 { return (counts >> 8u) & 0xffu; }

fn cluster_depth_to_z_slice(depth: f32, parameters: vec3f, limit: f32) -> f32 {
  let slice = max(0.0, log2(fma(depth, parameters.x, parameters.y)) * parameters.z);
  return min(slice, limit);
}

fn cluster_resolution_xy(screen: vec2u) -> vec2u {
  return (screen + vec2u(31u)) / vec2u(32u);
}

fn cluster_from_fragment_coord(coord: vec3f) -> vec3u {
  let z = cluster_depth_to_z_slice(coord.z, cluster_parameters, 23.0);
  let flipped_y = f32(view.height) - coord.y;
  return vec3u(u32(coord.x / 32.0), u32(flipped_y / 32.0), u32(z));
}

fn grid3d_to_index(position_value: vec3u, dimensions: vec2u) -> u32 {
  return position_value.x +
    (position_value.y + position_value.z * dimensions.y) * dimensions.x;
}

fn light_cluster_metadata_by_position(
  pixel: vec2f,
  view_depth: f32,
  screen: vec2u
) -> ClusterMetadata {
  let dimensions = cluster_resolution_xy(screen);
  return cluster_lookup[grid3d_to_index(
    cluster_from_fragment_coord(vec3f(pixel, view_depth)),
    dimensions
  )];
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

fn F_Hauber(f0: vec3f, f90: f32, cosine: f32) -> vec3f {
  let one_minus = 1.0 - cosine;
  let fourth = one_minus * one_minus * one_minus * one_minus;
  return mix(f0, vec3f(f90 - cosine), fourth);
}

fn BRDF_GGX(
  no_l: f32,
  no_v: f32,
  vo_h_squared: f32,
  no_h: f32,
  f0: vec3f,
  f90: f32,
  alpha: f32
) -> vec3f {
  return F_Hauber(f0, f90, no_h) *
    V_GGX_SmithCorrelated(alpha, no_l, no_v) *
    D_GGX(alpha * alpha, vo_h_squared);
}

fn oren_nayar_fujii_diffuse_dir_albedo(no_x: f32, roughness: f32, a: f32) -> f32 {
  let one_minus = 1.0 - no_x;
  let p0 = fma(one_minus, 0.0714429953, -0.332181442);
  let p1 = fma(one_minus, p0, 0.491881867);
  let p2 = fma(one_minus, p1, 0.0571085289);
  return a * fma(roughness, one_minus * p2, 1.0);
}

fn oren_nayar_fujii_diffuse_avg_albedo(roughness: f32, a: f32) -> f32 {
  return a * fma(0.0724882124569239, roughness, 1.0);
}

fn oren_nayar_compensated_diffuse(
  no_v: f32,
  no_l: f32,
  lo_v: f32,
  roughness: f32,
  color: vec3f
) -> vec3f {
  let a = 1.0 / fma(0.287793409210806, roughness, 1.0);
  let directional_v = oren_nayar_fujii_diffuse_dir_albedo(no_v, roughness, a);
  let directional_l = oren_nayar_fujii_diffuse_dir_albedo(no_l, roughness, a);
  let average = oren_nayar_fujii_diffuse_avg_albedo(roughness, a);
  let cross_term = lo_v - no_l * no_v;
  let corrected_cross = select(
    cross_term,
    cross_term / max(1e-7, max(no_l, no_v)),
    cross_term > 0.0
  );
  let single = color * a * fma(roughness, corrected_cross, 1.0);
  let color_squared = color * color;
  let multi_color = color_squared * average /
    (vec3f(1.0) - color * max(0.0, 1.0 - average));
  let multi = multi_color *
    max(1e-8, 1.0 - directional_v) *
    max(1e-8, 1.0 - directional_l) /
    max(1e-8, 1.0 - average);
  return single + multi;
}

fn get_bent_noh_squared(no_l: f32, no_v: f32, lo_v: f32, cot_radius: f32) -> f32 {
  let inv_length = inverseSqrt(1.0 + cot_radius * cot_radius);
  let t = 2.0 * no_l * no_v - lo_v;
  if (t >= inv_length) { return 1.0; }
  if (t <= -inv_length) {
    let sum = no_l + no_v;
    return saturate(sum * sum / max(2.0 + 2.0 * lo_v, 1e-6));
  }
  let scale = inv_length * cot_radius / sqrt(max(1.0 - t * t, 1e-6));
  var a = scale * (no_v - t * no_l);
  var b = scale * (2.0 * no_v * no_v - 1.0 - t * lo_v);
  let triple = sqrt(saturate(
    1.0 - no_l * no_l - no_v * no_v - lo_v * lo_v + 2.0 * no_l * no_v * lo_v
  ));
  let c = scale * triple;
  let d = scale * (2.0 * triple * no_v);
  let e = no_l * inv_length + no_v + a;
  let f = lo_v * inv_length + 1.0 + b;
  let g = c * f;
  let h = e * f;
  let i = d * e;
  let numerator = h * (0.25 * i - 0.5 * g);
  let denominator = g * g + i * (i - 2.0 * g) + e *
    ((no_l * inv_length + no_v) * f * f - h * (0.5 * (f + lo_v * inv_length) + 0.5));
  let rotation = 2.0 * numerator /
    (denominator * denominator + numerator * numerator + 1e-8);
  let cosine = rotation * denominator;
  let sine = 1.0 - rotation * numerator;
  a = sine * a + cosine * c;
  b = sine * b + cosine * d;
  let bent_no_l = no_l * inv_length + a;
  let bent_lo_v = lo_v * inv_length + b;
  let total = no_v + bent_no_l;
  return saturate(total * total / max(2.0 * bent_lo_v + 2.0, 1e-6));
}

fn re_direct_physical(
  incident: GpuPrimitiveTypeTable,
  geometry: SurfaceGeometry,
  material: StandardMaterial,
  reflected: ptr<function, ReflectedLight>
) {
  let n = geometry.shading_normal;
  let l = incident.direction;
  let v = geometry.view_direction;
  let h = normalize(l + v);
  let raw_no_l = dot(n, l);
  let no_l = saturate(raw_no_l);
  let no_v = saturate(dot(n, v));
  let vo_h = saturate(dot(v, h));
  let lo_v = saturate(dot(v, l));
  let roughness_squared = material.roughness * material.roughness;
  let radius = clamp(incident.radius, 0.0, 0.999);
  let radius_z = sqrt(1.0 - radius * radius);
  let cot_radius = radius / radius_z;
  let bent_no_h_squared = get_bent_noh_squared(no_l, no_v, lo_v, cot_radius);
  let alpha = saturate(roughness_squared + radius / 3.0);
  let normalization = (roughness_squared / alpha) * (roughness_squared / alpha);
  let bent_no_l = saturate((raw_no_l + radius) / (1.0 + radius));
  let radiance = bent_no_l * incident.color;
  let specular = BRDF_GGX(
    bent_no_l,
    no_v,
    bent_no_h_squared,
    vo_h,
    material.specularF0,
    material.specularF90,
    alpha
  );
  (*reflected).specular += radiance * specular * normalization;
  let diffuse = oren_nayar_compensated_diffuse(
    no_v,
    bent_no_l,
    lo_v,
    material.roughness,
    material.diffuse
  );
  (*reflected).diffuse += radiance * diffuse * RECIPROCAL_PI;
}

fn m4_projection_size(value: mat4x4f) -> vec2f {
  return vec2f(2.0 / length(value[0]), 2.0 / length(value[1]));
}

fn ndc_to_uv(value: vec2f) -> vec2f {
  return fma(value, vec2f(0.5, -0.5), vec2f(0.5));
}

fn uv_to_texel_coordinate(value: vec2f, dimensions: vec2u) -> vec2f {
  return fma(value, vec2f(dimensions), vec2f(-0.5));
}

fn get_shadow_offsets(normal: vec3f, direction: vec3f) -> vec2f {
  let cosine = saturate(dot(normal, direction));
  let sine = sqrt(1.0 - cosine * cosine);
  return vec2f(sine, min(2.0, sine / cosine));
}

fn correct_u_vs(value: vec4f, fraction_value: vec2f) -> f32 {
  let a = mix(value.x, value.y, fraction_value.x);
  let b = mix(value.z, value.w, fraction_value.x);
  return mix(a, b, fraction_value.y);
}

fn rgb_to_corners(texel: vec2f, texel_size: vec2f, depth: f32) -> f32 {
  let gathered = textureGatherCompare(pass_descriptor, u_int, texel * texel_size, depth);
  return correct_u_vs(gathered.wzxy, fract(texel + 0.5));
}

fn shadowmap_sample_5(texel: vec2f, texel_size: vec2f, depth: f32) -> f32 {
  var base = floor(texel + 0.5);
  let x = texel.x + 0.5 - base.x;
  let y = texel.y + 0.5 - base.y;
  base -= 0.5;
  let wx0 = 4.0 - 3.0 * x;
  let wx1 = 7.0;
  let wx2 = 1.0 + 3.0 * x;
  let ox0 = (3.0 - 2.0 * x) / wx0 - 2.0;
  let ox1 = (3.0 + x) / wx1;
  let ox2 = x / wx2 + 2.0;
  let wy0 = 4.0 - 3.0 * y;
  let wy1 = 7.0;
  let wy2 = 1.0 + 3.0 * y;
  let oy0 = (3.0 - 2.0 * y) / wy0 - 2.0;
  let oy1 = (3.0 + y) / wy1;
  let oy2 = y / wy2 + 2.0;
  var result = 0.0;
  result += wx0 * wy0 * rgb_to_corners(base + vec2f(ox0, oy0), texel_size, depth);
  result += wx1 * wy0 * rgb_to_corners(base + vec2f(ox1, oy0), texel_size, depth);
  result += wx2 * wy0 * rgb_to_corners(base + vec2f(ox2, oy0), texel_size, depth);
  result += wx0 * wy1 * rgb_to_corners(base + vec2f(ox0, oy1), texel_size, depth);
  result += wx1 * wy1 * rgb_to_corners(base + vec2f(ox1, oy1), texel_size, depth);
  result += wx2 * wy1 * rgb_to_corners(base + vec2f(ox2, oy1), texel_size, depth);
  result += wx0 * wy2 * rgb_to_corners(base + vec2f(ox0, oy2), texel_size, depth);
  result += wx1 * wy2 * rgb_to_corners(base + vec2f(ox1, oy2), texel_size, depth);
  result += wx2 * wy2 * rgb_to_corners(base + vec2f(ox2, oy2), texel_size, depth);
  return result / 144.0;
}

fn sample_shadowmap_atlas_for_light(
  projection_matrix: mat4x4f,
  position_ws: vec3f,
  surface_normal: vec3f,
  incident: GpuPrimitiveTypeTable,
  atlas_aabb: vec4f
) -> f32 {
  let projection_scale = m4_projection_size(projection_matrix);
  let world_pixel_size = max(projection_scale.x, projection_scale.y) / atlas_aabb.z;
  let offsets = get_shadow_offsets(surface_normal, incident.direction);
  let normal_offset = world_pixel_size * offsets.x * surface_normal * 0.5;
  let clip = projection_matrix * vec4f(position_ws + normal_offset, 1.0);
  let projected = clip.xyz / clip.w;
  let texel_size = 1.0 / vec2f(textureDimensions(pass_descriptor));
  let light_uvw = vec3f(ndc_to_uv(projected.xy), projected.z);
  let light_coords = uv_to_texel_coordinate(light_uvw.xy, vec2u(atlas_aabb.zw));
  let depth = light_uvw.z + 0.0001 * offsets.y;
  let sample_texel = clamp(light_coords, vec2f(2.5), atlas_aabb.zw - 2.5) + atlas_aabb.xy;
  return shadowmap_sample_5(sample_texel, texel_size, depth);
}

struct CascadeBlend { index_0: u32, index_1: u32, blend: f32, }

fn shadowmap_csm_compute_cascade_blended(
  position_ws: vec3f,
  view_direction_ws: vec3f,
  cascades: array<WgslJavaScriptCompiler, 3>
) -> CascadeBlend {
  for (var i = 0u; i < 3u; i++) {
    let cascade = cascades[i];
    var position = (cascade.projection * vec4f(position_ws, 1.0)).xyz;
    position.z = position.z * 2.0 - 1.0;
    let projection_bias = cascade.atlas.zw / (cascade.atlas.zw + vec2f(5.0));
    let extents = vec3f(projection_bias, 1.0);
    if (all(abs(position) < extents)) {
      var info = CascadeBlend(i, i, 0.0);
      if (i < 2u) {
        let next = cascades[i + 1u];
        var next_position = (next.projection * vec4f(position_ws, 1.0)).xyz;
        next_position.z = next_position.z * 2.0 - 1.0;
        let next_bias = next.atlas.zw / (next.atlas.zw + vec2f(5.0));
        let next_extents = vec3f(next_bias, 1.0);
        if (all(abs(next_position) < next_extents)) {
          let direction = normalize((cascade.projection * vec4f(-view_direction_ws, 0.0)).xyz);
          let inverse_direction = 1.0 / direction;
          let t1 = (-extents - position) * inverse_direction;
          let t2 = (extents - position) * inverse_direction;
          let minimum = min(t1, t2);
          let maximum = max(t1, t2);
          let enter = max(max(minimum.x, minimum.y), minimum.z);
          let exit = min(min(maximum.x, maximum.y), maximum.z);
          let remaining = exit / (exit - enter);
          if (remaining < 0.07) {
            info.blend = smoothstep(0.0, 1.0, 1.0 - remaining / 0.07);
            info.index_1 = i + 1u;
          }
        }
      }
      return info;
    }
  }
  return CascadeBlend(0xffffffffu, 0xffffffffu, 0.0);
}

fn shadowmap_sample_directional(
  database: ptr<storage, array<u32>>,
  shadow_id: u32,
  position_ws: vec3f,
  view_direction_ws: vec3f,
  surface_normal_ws: vec3f,
  incident: GpuPrimitiveTypeTable
) -> f32 {
  let cascades = ${SHADOW_DIRECTIONAL_DESCRIPTOR.marshalling_method_read}(database, shadow_id);
  let info = shadowmap_csm_compute_cascade_blended(position_ws, view_direction_ws, cascades);
  if (info.index_0 == 0xffffffffu) { return 1.0; }
  let first = cascades[info.index_0];
  let visibility_0 = sample_shadowmap_atlas_for_light(
    first.projection, position_ws, surface_normal_ws, incident, first.atlas
  );
  if (info.blend <= 0.0) { return visibility_0; }
  let second = cascades[info.index_1];
  let visibility_1 = sample_shadowmap_atlas_for_light(
    second.projection, position_ws, surface_normal_ws, incident, second.atlas
  );
  return mix(visibility_0, visibility_1, info.blend);
}

fn build_orthonormal_matrix_n(normal: vec3f) -> mat3x3f {
  var x: vec3f;
  var y: vec3f;
  if (normal.z < 0.0) {
    let a = 1.0 / (1.0 - normal.z);
    let b = normal.x * normal.y * a;
    x = vec3f(1.0 - normal.x * normal.x * a, -b, normal.x);
    y = vec3f(b, normal.y * normal.y * a - 1.0, -normal.y);
  } else {
    let a = 1.0 / (1.0 + normal.z);
    let b = -normal.x * normal.y * a;
    x = vec3f(1.0 - normal.x * normal.x * a, b, -normal.x);
    y = vec3f(b, 1.0 - normal.y * normal.y * a, -normal.y);
  }
  return mat3x3f(x, y, normal);
}

fn cone_sample_direction(direction: vec3f, aperture: f32, xi: vec2f) -> vec3f {
  let angle = xi.x * PI * 2.0;
  let radius = sqrt(xi.y);
  let x = radius * cos(angle) * aperture;
  let y = radius * sin(angle) * aperture;
  let basis = build_orthonormal_matrix_n(direction);
  return normalize(basis[2] + basis[0] * x + basis[1] * y);
}

fn contact_harden_pcf_kernel(occluders: f32, distance_sum: f32, light_depth: f32) -> f32 {
  let average = distance_sum / occluders;
  let weight = saturate(average / light_depth);
  var percentage = saturate(occluders / 8.0);
  percentage = 2.0 * percentage - 1.0;
  let sign_value = sign(percentage);
  percentage = 1.0 - sign_value * percentage;
  percentage = mix(percentage * percentage * percentage, percentage, weight);
  percentage = (1.0 - percentage) * sign_value;
  percentage = 0.5 * percentage + 0.5;
  return 1.0 - percentage;
}

fn max_penumbra_percentage(a: f32, b: f32) -> f32 {
  let maximum = max(a, b);
  let base = max(maximum, 0.5);
  return sqrt(base) / 0.7071067811865476 * 0.001953125;
}

fn shadowmap_sample_point(
  database: ptr<storage, array<u32>>,
  shadow_id: u32,
  position_ws: vec3f,
  surface_normal_ws: vec3f,
  light_position_ws: vec3f,
  light_max_distance: f32,
  light_radius: f32
) -> f32 {
  let atlas = ${SHADOW_POINT_DESCRIPTOR.marshalling_method_read}(database, shadow_id);
  let to_light_unbiased = light_position_ws - position_ws;
  let distance_unbiased = length(to_light_unbiased);
  let light_direction = to_light_unbiased / max(distance_unbiased, 1e-6);
  let world_pixel_size = 2.0 * distance_unbiased / max(atlas.z, 1.0);
  let offsets = get_shadow_offsets(surface_normal_ws, light_direction);
  let normal_offset = world_pixel_size * offsets.x * surface_normal_ws * 2.0;
  let to_surface = position_ws + normal_offset - light_position_ws;
  let distance_to_center = length(to_surface);
  let direction_to_surface = to_surface / max(distance_to_center, 1e-6);
  let face_size = vec2u(atlas.zw);
  let radial = distance_to_center / max(light_max_distance, 1e-6);
  let reference_depth = 1.0 - saturate(radial) + 0.0001 * offsets.y;
  let cone_aperture = 2.0 * max_penumbra_percentage(light_radius, light_radius);
  var occluders = 0.0;
  var distance_sum = 0.0;
  for (var tap = 0u; tap < 8u; tap++) {
    let perturbed = cone_sample_direction(direction_to_surface, cone_aperture, random_vec2());
    let local_texel = uv_to_texel_coordinate(uv_octahedral_unit_encode(perturbed), face_size);
    let rounded = random_round_vec2(local_texel);
    let sample_texel = vec2u(rounded) + vec2u(atlas.xy);
    let stored = textureLoad(pass_descriptor, sample_texel, 0);
    let distance_value = stored - reference_depth;
    let occluded = step(0.0, distance_value);
    occluders += occluded;
    distance_sum += distance_value * occluded;
  }
  return contact_harden_pcf_kernel(occluders, distance_sum, reference_depth);
}

fn shadowmap_sample_spot(
  database: ptr<storage, array<u32>>,
  shadow_id: u32,
  position_ws: vec3f,
  surface_normal_ws: vec3f,
  incident: GpuPrimitiveTypeTable
) -> f32 {
  let metadata = ${SHADOW_SPOT_DESCRIPTOR.marshalling_method_read}(database, shadow_id);
  return sample_shadowmap_atlas_for_light(
    metadata.projection, position_ws, surface_normal_ws, incident, metadata.atlas
  );
}

fn shadowmap_get_point_light_visibility(
  database: ptr<storage, array<u32>>,
  index: u32,
  position_ws: vec3f,
  normal_ws: vec3f
) -> f32 {
  let source = ${POINT_LIGHT_DESCRIPTOR.marshalling_method_read}(database, index);
  if ((source.flags & 1u) == 0u) { return 1.0; }
  if (dot(source.position - position_ws, normal_ws) < 0.0) { return 0.0; }
  return shadowmap_sample_point(
    database, source.shadow_id, position_ws, normal_ws,
    source.position, source.distance, source.radius
  );
}

fn shadowmap_get_spot_light_visibility(
  database: ptr<storage, array<u32>>,
  index: u32,
  position_ws: vec3f,
  normal_ws: vec3f
) -> f32 {
  let source = ${SPOT_LIGHT_DESCRIPTOR.marshalling_method_read}(database, index);
  if ((source.flags & 1u) == 0u) { return 1.0; }
  let incident = get_spot_light_info(source, position_ws);
  if (dot(incident.direction, normal_ws) < 0.0) { return 0.0; }
  return shadowmap_sample_spot(database, source.shadow_id, position_ws, normal_ws, incident);
}

fn shadowmap_get_directional_light_visibility(
  database: ptr<storage, array<u32>>,
  index: u32,
  position_ws: vec3f,
  view_direction_ws: vec3f,
  normal_ws: vec3f
) -> f32 {
  let source = ${DIRECTIONAL_LIGHT_DESCRIPTOR.marshalling_method_read}(database, index);
  if ((source.flags & 1u) == 0u) { return 1.0; }
  let incident = get_directional_light_info(source);
  if (dot(incident.direction, normal_ws) < 0.0) { return 0.0; }
  return shadowmap_sample_directional(
    database, source.shadow_id, position_ws, view_direction_ws, normal_ws, incident
  );
}

fn shade_standard_material_direct(
  material: StandardMaterial,
  geometry: SurfaceGeometry,
  pixel: vec2f,
  view_depth: f32
) -> vec3f {
  var reflected: ReflectedLight;
  var directional_mask = directional_lights_iteration_mask(&node);
  while (directional_mask != 0u) {
    let index = countTrailingZeros(directional_mask);
    directional_mask &= ~(1u << index);
    var incident = get_directional_light_info_by_index(&node, index);
    incident.color *= shadowmap_get_directional_light_visibility(
      &node, index, geometry.position, geometry.view_direction, geometry.shading_normal
    );
    re_direct_physical(incident, geometry, material, &reflected);
  }
  let metadata = light_cluster_metadata_by_position(
    pixel, view_depth, vec2u(view.width, view.height)
  );
  let point_count = light_cluster_count_point(metadata.counts);
  let spot_count = light_cluster_count_spot(metadata.counts);
  for (var i = 0u; i < point_count; i++) {
    let index = cluster_data[metadata.offset + i];
    var incident = get_point_light_info_by_index(&node, index, geometry.position);
    incident.color *= shadowmap_get_point_light_visibility(
      &node, index, geometry.position, geometry.shading_normal
    );
    if (all(incident.color == vec3f(0.0))) { continue; }
    re_direct_physical(incident, geometry, material, &reflected);
  }
  for (var i = 0u; i < spot_count; i++) {
    let index = cluster_data[metadata.offset + point_count + i];
    var incident = get_spot_light_info_by_index(&node, index, geometry.position);
    incident.color *= shadowmap_get_spot_light_visibility(
      &node, index, geometry.position, geometry.shading_normal
    );
    if (all(incident.color == vec3f(0.0))) { continue; }
    re_direct_physical(incident, geometry, material, &reflected);
  }
  return reflected.diffuse + reflected.specular + material.emissive;
}

const FULLSCREEN_POSITIONS = array<vec2f, 3>(
  vec2f(-1.0, -1.0),
  vec2f(3.0, -1.0),
  vec2f(-1.0, 3.0)
);

struct FullscreenVertex {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> FullscreenVertex {
  let position = FULLSCREEN_POSITIONS[vertex_index];
  var output: FullscreenVertex;
  output.position = vec4f(position, 0.0, 1.0);
  output.uv = fma(position, vec2f(0.5, -0.5), vec2f(0.5));
  return output;
}

@fragment
fn fs_main(input: FullscreenVertex) -> @location(0) vec4f {
  let i_coord = vec2u(input.position.xy);
  random_initialize(vec3u(i_coord, view.frame_index), vec3u(0xEE6B2807u, 7u, 0xD0974829u));
  let depth = textureLoad(yz, i_coord, 0);
  let view_depth = get_view_space_depth(depth, camera);
  let position_ws = project_position_from_depth(
    input.uv, depth, camera.view_projection_matrix_inverse
  );
  let camera_position = mat4_extract_position(camera.transform);
  let view_direction = normalize(camera_position - position_ws);
  let normal_sample = textureLoad(ag_x, i_coord, 0);
  let geometry = SurfaceGeometry(
    decode_g_buffer_normal(normal_sample.xy),
    decode_g_buffer_normal(normal_sample.zw),
    position_ws,
    view_direction
  );
  let material = read_gBuffer_material(i_coord);
  return vec4f(shade_standard_material_direct(
    material, geometry, input.position.xy, view_depth
  ), 1.0);
}
`;

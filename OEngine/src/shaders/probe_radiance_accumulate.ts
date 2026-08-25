/**
 * probe_radiance_accumulate：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { LIGHT_DATABASE_SAMPLE_WGSL } from "../gpu/LightDatabase.js";
import { LIGHT_PROBE_RECORD_WGSL } from "../gpu/LightProbeRecord.js";
import { RAY_QUERY_WGSL } from "./ray_query.js";

export const PROBE_RADIANCE_ACCUMULATE_SETTINGS_BYTES = 32;
export const PROBE_RADIANCE_ACCUMULATE_WORKGROUP_SIZE = 16;

export const PROBE_RADIANCE_ACCUMULATE_WGSL = /* wgsl */ `
${LIGHT_PROBE_RECORD_WGSL}

struct ProbeRadianceAccumulateSettings {
  probe_index_offset: u32,
  probe_update_count: u32,
  probe_resolution: u32,
  atlas_resolution: vec2u,
  probe_count: u32,
  random_seed: u32,
};

@group(0) @binding(0) var<uniform> settings: ProbeRadianceAccumulateSettings;
@group(0) @binding(1) var<storage, read> end: array<LightProbeData>;
@group(0) @binding(2) var<storage, read> node: array<u32>;

@group(1) @binding(0) var group_size: texture_2d<f32>;
@group(1) @binding(1) var position: texture_2d<u32>;
@group(1) @binding(2) var bias: texture_2d<f32>;
@group(1) @binding(3) var mesh: texture_2d<f32>;
@group(1) @binding(4) var child_size: texture_2d<f32>;
@group(1) @binding(5) var r: texture_2d<u32>;

@group(2) @binding(0) var<storage, read> scene_database: array<u32>;
@group(2) @binding(1) var<storage, read> tlas_data: array<u32>;
@group(2) @binding(2) var<storage, read> blas_addresses: array<u32>;
@group(2) @binding(3) var<storage, read> blas_nodes: array<u32>;
@group(2) @binding(4) var<storage, read> geometries: array<u32>;
@group(2) @binding(5) var<storage, read> meshlet_headers: array<u32>;
@group(2) @binding(6) var<storage, read> meshlet_data: array<u32>;

@group(3) @binding(0) var attenuation:
  texture_storage_2d<r32uint, read_write>;

fn saturate(value: f32) -> f32 {
  return clamp(value, 0.0, 1.0);
}

${LIGHT_DATABASE_SAMPLE_WGSL}
${RAY_QUERY_WGSL}

const PI: f32 = 3.1415926535897932384626433832795;
const RECIPROCAL_PI: f32 = 0.318309886183790671537767526745028724;
const EPSILON: f32 = 1e-6;

var<private> rnd_state: u32 = 2891336453u;

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

fn random() -> f32 {
  return bitcast<f32>(0x3f800000u | (random_u32() >> 9u)) - 1.0;
}

fn f32_array_as_vec3(value: array<f32, 3>) -> vec3f {
  return vec3f(value[0], value[1], value[2]);
}

fn grid2d_to_index(position_value: vec2u, width: u32) -> u32 {
  return position_value.y * width + position_value.x;
}

fn index_to_grid2d(index: u32, width: u32) -> vec2u {
  return vec2u(index % width, index / width);
}

fn sign_not_zero(value: vec2f) -> vec2f {
  return select(vec2f(-1.0), vec2f(1.0), value > vec2f(0.0));
}

fn uv_octahedral_unit_encode(direction: vec3f) -> vec2f {
  let projected = direction.xy /
    (abs(direction.x) + abs(direction.y) + abs(direction.z));
  let folded = (1.0 - abs(projected.yx)) * sign_not_zero(projected);
  return select(projected, folded, direction.z < 0.0) * 0.5 + 0.5;
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

fn uv_to_texel_coordinate(uv: vec2f, resolution: vec2u) -> vec2f {
  return fma(uv, vec2f(resolution), vec2f(-0.5));
}

fn max_v3(value: vec3f) -> f32 {
  return max(value.x, max(value.y, value.z));
}

fn rgbe9995_encode(color: vec3f) -> u32 {
  let maximum = bitcast<f32>(0x477F8000u);
  let minimum = bitcast<f32>(0x37800000u);
  let clamped = clamp(color, vec3f(0.0), vec3f(maximum));
  let largest = max(minimum, max_v3(clamped));
  let exponent = bitcast<f32>(
    (bitcast<u32>(largest) + 0x07804000u) & 0x7F800000u
  );
  let mantissa = bitcast<vec3u>(clamped + exponent);
  let packed_exponent = (bitcast<u32>(exponent) << 4u) + 0x10000000u;
  return packed_exponent |
    (mantissa.z << 18u) |
    (mantissa.y << 9u) |
    (mantissa.x & 0x1ffu);
}

fn rgbe9995_decode(packed: u32) -> vec3f {
  let fields = vec4f(
    (vec4u(packed) >> vec4u(0u, 9u, 18u, 27u)) &
      vec4u(0x1ffu, 0x1ffu, 0x1ffu, 0x1fu)
  );
  return fields.rgb * exp2(fields.a - 15.0 - 9.0);
}

fn metalness_to_specular_color(metalness: f32, albedo: vec3f) -> vec3f {
  return mix(vec3f(0.04), albedo, metalness);
}

fn D_GGX(alpha_squared: f32, no_h_squared: f32) -> f32 {
  let denominator = no_h_squared * (alpha_squared - 1.0) + 1.0;
  return alpha_squared / (PI * denominator * denominator);
}

fn V_GGX_SmithCorrelated(alpha: f32, no_v: f32, no_l: f32) -> f32 {
  let alpha_squared = alpha * alpha;
  let lambda_v = no_l * sqrt(fma(no_v * no_v, 1.0 - alpha_squared, alpha_squared));
  let lambda_l = no_v * sqrt(fma(no_l * no_l, 1.0 - alpha_squared, alpha_squared));
  return 0.5 / max(lambda_v + lambda_l, EPSILON);
}

fn F_Hauber(f0: vec3f, f90: f32, cosine: f32) -> vec3f {
  let one_minus_cosine = 1.0 - cosine;
  let fourth_power = one_minus_cosine * one_minus_cosine *
    one_minus_cosine * one_minus_cosine;
  return mix(f0, vec3f(f90 - cosine), fourth_power);
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
  let fresnel = F_Hauber(f0, f90, no_h);
  let visibility = V_GGX_SmithCorrelated(alpha, no_l, no_v);
  let distribution = D_GGX(alpha * alpha, vo_h_squared);
  return fresnel * visibility * distribution;
}

fn oren_nayar_fujii_diffuse_dir_albedo(
  no_x: f32,
  roughness: f32,
  coefficient_a: f32
) -> f32 {
  let one_minus = 1.0 - no_x;
  let p0 = fma(one_minus, 0.0714429953, -0.332181442);
  let p1 = fma(one_minus, p0, 0.491881867);
  let p2 = fma(one_minus, p1, 0.0571085289);
  return coefficient_a * fma(roughness, one_minus * p2, 1.0);
}

fn oren_nayar_fujii_diffuse_avg_albedo(
  roughness: f32,
  coefficient_a: f32
) -> f32 {
  return coefficient_a * fma(0.0724882124569239, roughness, 1.0);
}

fn oren_nayar_compensated_diffuse(
  no_v: f32,
  no_l: f32,
  lo_v: f32,
  roughness: f32,
  color: vec3f
) -> vec3f {
  let coefficient_a = 1.0 / fma(0.287793409210806, roughness, 1.0);
  let directional_v = oren_nayar_fujii_diffuse_dir_albedo(
    no_v,
    roughness,
    coefficient_a
  );
  let directional_l = oren_nayar_fujii_diffuse_dir_albedo(
    no_l,
    roughness,
    coefficient_a
  );
  let average = oren_nayar_fujii_diffuse_avg_albedo(
    roughness,
    coefficient_a
  );
  let cross_term = lo_v - no_l * no_v;
  let corrected_cross = select(
    cross_term,
    cross_term / max(1e-7, max(no_l, no_v)),
    cross_term > 0.0
  );
  let single = color * coefficient_a * fma(roughness, corrected_cross, 1.0);
  let color_squared = color * color;
  let multi_color = color_squared * average /
    (vec3f(1.0) - color * max(0.0, 1.0 - average));
  let multi = multi_color *
    max(1e-8, 1.0 - directional_v) *
    max(1e-8, 1.0 - directional_l) /
    max(1e-8, 1.0 - average);
  return single + multi;
}

fn rgb_to_luminance(color: vec3f) -> f32 {
  return dot(color, vec3f(
    0.212639005871510,
    0.715168678767756,
    0.072192315360734
  ));
}

fn rgb_to_ycocg(color: vec3f) -> vec3f {
  let half_green = color.g * 0.5;
  return vec3f(
    0.25 * color.r + half_green + 0.25 * color.b,
    0.5 * color.r - 0.5 * color.b,
    -0.25 * color.r + half_green - 0.25 * color.b
  );
}

fn ycocg_to_rgb(color: vec3f) -> vec3f {
  let y_minus_cg = color.x - color.z;
  return vec3f(
    y_minus_cg + color.y,
    color.x + color.z,
    y_minus_cg - color.y
  );
}

fn taa_encode_color(color: vec3f) -> vec3f {
  return rgb_to_ycocg(color / (1.0 + rgb_to_luminance(color)));
}

fn taa_decode_color(color: vec3f) -> vec3f {
  let rgb = ycocg_to_rgb(color);
  return rgb / (1.0 - rgb_to_luminance(rgb));
}

fn v2_bilinear_weight(value: vec2f) -> f32 {
  let fraction = abs(fract(value));
  let distance_to_edge = min(fraction, 1.0 - fraction) * 2.0;
  return max(0.0, (1.0 - distance_to_edge.x) * (1.0 - distance_to_edge.y));
}

fn lpv_shade_light_record(
  light: SampledLightRecord,
  surface_position: vec3f,
  shading_normal: vec3f,
  view_direction: vec3f,
  diffuse: vec3f,
  specular_f0: vec3f,
  specular_f90: f32,
  roughness: f32
) -> vec3f {
  if (dot(light.direction, shading_normal) <= 0.0) {
    return vec3f(0.0);
  }
  if (dot(light.emission, vec3f(1.0)) <= 0.0) {
    return vec3f(0.0);
  }

  var shadow_ray: RqRay;
  shadow_ray.origin = surface_position;
  shadow_ray.direction = light.direction;
  shadow_ray.tmax = light.distance;
  if (ray_query_occluded(shadow_ray)) {
    return vec3f(0.0);
  }

  let light_direction = light.direction;
  let half_direction = normalize(light_direction + view_direction);
  let no_v = dot(shading_normal, view_direction);
  let no_l = dot(shading_normal, light_direction);
  let vo_h = saturate(dot(view_direction, half_direction));
  let no_h = saturate(dot(shading_normal, half_direction));
  let lo_v = saturate(dot(light_direction, view_direction));
  let alpha = roughness * roughness;
  let diffuse_brdf = oren_nayar_compensated_diffuse(
    no_v,
    no_l,
    lo_v,
    roughness,
    diffuse
  );
  let specular_brdf = BRDF_GGX(
    no_l,
    no_v,
    vo_h * vo_h,
    no_h,
    specular_f0,
    specular_f90,
    alpha
  );
  let incident = light.emission * no_l;
  let fresnel = F_Hauber(specular_f0, specular_f90, no_h);
  let diffuse_light = incident * diffuse_brdf * (vec3f(1.0) - fresnel);
  let specular_light = incident * specular_brdf;
  return diffuse_light * RECIPROCAL_PI + specular_light;
}

@compute @workgroup_size(${PROBE_RADIANCE_ACCUMULATE_WORKGROUP_SIZE}, ${PROBE_RADIANCE_ACCUMULATE_WORKGROUP_SIZE}, 1)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let output_size = textureDimensions(group_size);
  let probes_per_row = output_size / vec2u(settings.probe_resolution);
  let pixel = global_id.xy;
  let probe_texel = pixel % settings.probe_resolution;
  let local_probe = grid2d_to_index(
    pixel / settings.probe_resolution,
    probes_per_row.x
  );
  if (local_probe >= settings.probe_update_count) {
    return;
  }

  let probe_index =
    (local_probe + settings.probe_index_offset) % settings.probe_count;
  random_initialize(
    vec3u(probe_texel, probe_index),
    vec3u(settings.random_seed)
  );

  let albedo = textureLoad(group_size, vec2i(pixel), 0).rgb;
  let position_local = textureLoad(child_size, vec2i(pixel), 0).rgb;
  let pbr = textureLoad(mesh, vec2i(pixel), 0);
  let metalness = pbr.x;
  let roughness = pbr.y;
  let emissive = rgbe9995_decode(textureLoad(position, vec2i(pixel), 0).r);
  let shading_normal = uv_octahedral_unit_decode(
    textureLoad(bias, vec2i(pixel), 0).xy
  );
  let diffuse = albedo * (1.0 - metalness);
  let specular_f0 = metalness_to_specular_color(metalness, albedo);
  let specular_f90 = 1.0;

  let probe = end[probe_index];
  let probe_position = f32_array_as_vec3(probe.position);
  let surface_position = probe_position + position_local;
  var probe_ray: RqRay;
  probe_ray.origin = probe_position;
  probe_ray.direction = normalize(position_local);
  probe_ray.tmax = length(position_local);
  let view_direction = -probe_ray.direction;

  var accumulated = emissive;
  let missed = pbr.w == 1.0;
  if (!missed) {
    for (var page = 0u; page < POINT_LIGHTS_PAGE_LIMIT; page++) {
      let page_address = point_lights_page_address(&node, page);
      if (page_address == ~0u) {
        continue;
      }
      for (
        var bitmap_word = 0u;
        bitmap_word < POINT_LIGHTS_OCCUPANCY_BITMAP_WORDS;
        bitmap_word++
      ) {
        var occupied = point_lights_page_bitmap_word(
          &node,
          page_address,
          bitmap_word
        );
        while (occupied != 0u) {
          let bit = countTrailingZeros(occupied);
          occupied &= ~(1u << bit);
          let light_index = point_lights_slot_to_index(
            page,
            bitmap_word * 32u + bit
          );
          let light = sample_point_light_record(
            &node,
            light_index,
            surface_position,
            vec2f(random(), random())
          );
          accumulated += lpv_shade_light_record(
            light,
            surface_position,
            shading_normal,
            view_direction,
            diffuse,
            specular_f0,
            specular_f90,
            roughness
          );
        }
      }
    }

    for (var page = 0u; page < SPOT_LIGHTS_PAGE_LIMIT; page++) {
      let page_address = spot_lights_page_address(&node, page);
      if (page_address == ~0u) {
        continue;
      }
      for (
        var bitmap_word = 0u;
        bitmap_word < SPOT_LIGHTS_OCCUPANCY_BITMAP_WORDS;
        bitmap_word++
      ) {
        var occupied = spot_lights_page_bitmap_word(
          &node,
          page_address,
          bitmap_word
        );
        while (occupied != 0u) {
          let bit = countTrailingZeros(occupied);
          occupied &= ~(1u << bit);
          let light_index = spot_lights_slot_to_index(
            page,
            bitmap_word * 32u + bit
          );
          let light = sample_spot_light_record(
            &node,
            light_index,
            surface_position,
            vec2f(random(), random())
          );
          accumulated += lpv_shade_light_record(
            light,
            surface_position,
            shading_normal,
            view_direction,
            diffuse,
            specular_f0,
            specular_f90,
            roughness
          );
        }
      }
    }

    var directional_mask = directional_lights_iteration_mask(&node);
    while (directional_mask != 0u) {
      let light_index = countTrailingZeros(directional_mask);
      directional_mask &= ~(1u << light_index);
      let light = sample_directional_light_record(
        &node,
        light_index,
        surface_position,
        vec2f(random(), random())
      );
      accumulated += lpv_shade_light_record(
        light,
        surface_position,
        shading_normal,
        view_direction,
        diffuse,
        specular_f0,
        specular_f90,
        roughness
      );
    }

    accumulated += rgbe9995_decode(textureLoad(r, vec2i(pixel), 0).r);
  }

  let octahedral = uv_octahedral_unit_encode(probe_ray.direction);
  let mip_coordinate = uv_to_texel_coordinate(
    octahedral,
    vec2u(settings.probe_resolution)
  );
  let atlas_patch = index_to_grid2d(probe_index, settings.atlas_resolution.x);
  let patch_origin = atlas_patch * (settings.probe_resolution + 2u) + vec2u(1u);
  let atlas_texel = probe_texel + patch_origin;
  let history = rgbe9995_decode(textureLoad(attenuation, vec2i(atlas_texel)).r);

  const history_factor = 0.95;
  let sample_weight = 1.0 / f32(probe.accumulated_samples);
  let temporal_weight = max(sample_weight, 1.0 - history_factor);
  let bilinear_weight = v2_bilinear_weight(mip_coordinate);
  let blend = max(sample_weight, temporal_weight * bilinear_weight);
  let filtered = taa_decode_color(mix(
    taa_encode_color(history),
    taa_encode_color(accumulated),
    blend
  ));
  let packed = rgbe9995_encode(filtered);
  textureStore(attenuation, vec2i(atlas_texel), vec4u(packed, 0u, 0u, 0u));
}
`;

/**
 * path_tracer：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { WGSL_f32, WGSL_u32, WGSL_vec2u } from "../core/WebGPUTypes.js";
import { StructType } from "../core/WgslStruct.js";
import { LIGHT_DATABASE_PATH_TRACING_WGSL } from "../gpu/LightDatabase.js";
import { LPV_CAMERA_TYPE } from "./lpv_indirect_diffuse.js";
import { RAY_QUERY_WGSL } from "./ray_query.js";

export const PATH_TRACER_SETTINGS_TYPE = StructType.from(
  {
    tile_offset: WGSL_vec2u,
    tile_size: WGSL_u32,
    random_seed: WGSL_u32,
    alpha: WGSL_f32
  },
  "AccumulatingPathTracerSettings"
).pack();

export const PATH_TRACER_HISTORY_FORMAT = "rgba32float" as const;
export const PATH_TRACER_OUTPUT_FORMAT = "rgba16float" as const;

export const PATH_TRACER_WGSL = /* wgsl */ `
${LPV_CAMERA_TYPE.wgsl_declaration}
${PATH_TRACER_SETTINGS_TYPE.wgsl_declaration}

const PI: f32 = 3.1415926535897932384626433832795;
const F32_MAX: f32 = 3.402823466e+38;
const EPSILON: f32 = 1e-6;
const RESIDENT_TEXTURE_TILE_SIZE: u32 = 64u;
const RESIDENT_TEXTURE_TILES_PER_AXIS: u32 = 32u;
const RESIDENT_TEXTURE_TILES_PER_LAYER: u32 = 1024u;

struct ResidentMaterial {
  texture_albedo: u32,
  texture_orm: u32,
  texture_normal: u32,
  texture_emissive: u32,
  color_albedo: vec4f,
  roughness_factor: f32,
  metallic_factor: f32,
  transmission_factor: f32,
  ior_factor: f32,
  emissive_factor: vec3f,
  padding: f32,
};

struct PathSurfaceData {
  albedo: vec3f,
  opacity: f32,
  roughness: f32,
  metalness: f32,
  transmission: f32,
  ior: f32,
  emissive: vec3f,
  normal_shading: vec3f,
  normal_geometric: vec3f,
};

struct PathShadingClosure {
  diffuse: vec3f,
  roughness: f32,
  occlusion: f32,
  specularF0: vec3f,
  specularF90: f32,
  emissive: vec3f,
  opacity: f32,
};

struct PathSurfacePoint {
  shading_normal: vec3f,
  geometric_normal: vec3f,
  position: vec3f,
  view_direction: vec3f,
};

struct PathOpacityHit {
  opacity: f32,
  geometric_normal: vec3f,
  position: vec3f,
};

struct SelectedLight {
  index: u32,
  pdf: f32,
  light_type: u32,
};

struct PathTraceResult {
  irradiance: vec3f,
  distance: f32,
  bounces: u32,
};

@group(0) @binding(0) var<storage, read> scene_database: array<u32>;
@group(0) @binding(1) var<storage, read> tlas_data: array<u32>;
@group(0) @binding(2) var<storage, read> blas_addresses: array<u32>;
@group(0) @binding(3) var<storage, read> blas_nodes: array<u32>;
@group(0) @binding(4) var<storage, read> geometries: array<u32>;
@group(0) @binding(5) var<storage, read> meshlet_headers: array<u32>;
@group(0) @binding(6) var<storage, read> meshlet_data: array<u32>;

@group(1) @binding(0) var<uniform> materials: array<ResidentMaterial, 1024>;
@group(1) @binding(1) var ray_height: texture_2d_array<f32>;

@group(2) @binding(0) var<storage, read> node: array<u32>;
@group(2) @binding(1) var sec_radix_passes: texture_2d<f32>;

@group(3) @binding(0) var<uniform> settings: AccumulatingPathTracerSettings;
@group(3) @binding(1) var<uniform> camera: CommandEncoder;
@group(3) @binding(2) var x1: texture_2d<f32>;
@group(3) @binding(3) var intensity: texture_storage_2d<rgba32float, write>;

fn saturate(value: f32) -> f32 {
  return clamp(value, 0.0, 1.0);
}

fn pow2(value: f32) -> f32 {
  return value * value;
}

fn pow4(value: f32) -> f32 {
  let squared = value * value;
  return squared * squared;
}

fn rgb_to_luminance(value: vec3f) -> f32 {
  return dot(value, vec3f(
    0.212639005871510,
    0.715168678767756,
    0.072192315360734
  ));
}

fn max_v3(value: vec3f) -> f32 {
  return max(value.x, max(value.y, value.z));
}

${RAY_QUERY_WGSL}
${LIGHT_DATABASE_PATH_TRACING_WGSL}

var<private> rnd_state: u32 = 2891336453u;

fn path_hash3(value: vec3u) -> vec3u {
  var result = value * 1664525u + 1013904223u;
  result.x += result.y * result.z;
  result.y += result.z * result.x;
  result.z += result.x * result.y;
  result ^= result >> vec3u(16u);
  result.x += result.y * result.z;
  result.y += result.z * result.x;
  result.z += result.x * result.y;
  return result;
}

fn random_initialize(invocation: vec3u, seed: vec3u) {
  let hashed = path_hash3(invocation + seed * 37u);
  rnd_state = hashed.x ^ hashed.y ^ hashed.z;
}

fn random_pcg(value: u32) -> u32 {
  let state = value * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn random_u32() -> u32 {
  rnd_state = random_pcg(rnd_state);
  return rnd_state;
}

fn random() -> f32 {
  return bitcast<f32>(0x3f800000u | (random_u32() >> 9u)) - 1.0;
}

fn random_vec2() -> vec2f {
  return unpack2x16unorm(random_u32());
}

fn random_vec3() -> vec3f {
  let bits = random_u32();
  return vec3f(
    f32(bits & 0x7ffu) / 2047.0,
    f32((bits >> 11u) & 0x7ffu) / 2047.0,
    f32((bits >> 22u) & 0x3ffu) / 1023.0
  );
}

fn random_round_vec2(value: vec2f) -> vec2f {
  let add = select(vec2f(0.0), vec2f(1.0), fract(value) > random_vec2());
  return floor(value) + add;
}

fn build_orthonormal_matrix_n(normal: vec3f) -> mat3x3f {
  var tangent: vec3f;
  var bitangent: vec3f;
  if (normal.z < 0.0) {
    let inverse = 1.0 / (1.0 - normal.z);
    let cross_term = normal.x * normal.y * inverse;
    tangent = vec3f(
      1.0 - normal.x * normal.x * inverse,
      -cross_term,
      normal.x
    );
    bitangent = vec3f(
      cross_term,
      normal.y * normal.y * inverse - 1.0,
      -normal.y
    );
  } else {
    let inverse = 1.0 / (1.0 + normal.z);
    let cross_term = -normal.x * normal.y * inverse;
    tangent = vec3f(
      1.0 - normal.x * normal.x * inverse,
      cross_term,
      -normal.x
    );
    bitangent = vec3f(
      cross_term,
      1.0 - normal.y * normal.y * inverse,
      -normal.y
    );
  }
  return mat3x3f(tangent, bitangent, normal);
}

fn build_orthonormal_matrix_nt(normal: vec3f, tangent: vec4f) -> mat3x3f {
  let tangent_orthogonal = normalize(tangent.xyz - normal * dot(normal, tangent.xyz));
  let bitangent = normalize(cross(normal, tangent_orthogonal) * tangent.w);
  return mat3x3f(tangent_orthogonal, bitangent, normal);
}

fn interpolate_attribute_2f32(a: vec2f, b: vec2f, c: vec2f, weights: vec3f) -> vec2f {
  return a * weights.x + b * weights.y + c * weights.z;
}

fn interpolate_attribute_3f32(a: vec3f, b: vec3f, c: vec3f, weights: vec3f) -> vec3f {
  return a * weights.x + b * weights.y + c * weights.z;
}

fn interpolate_attribute_4f32(a: vec4f, b: vec4f, c: vec4f, weights: vec3f) -> vec4f {
  return a * weights.x + b * weights.y + c * weights.z;
}

fn compute_triangle_face_normal(a: vec3f, b: vec3f, c: vec3f) -> vec3f {
  return normalize(cross(b - a, c - a));
}

fn project_position(value: vec3f, transform: mat4x4f) -> vec3f {
  let projected = transform * vec4f(value, 1.0);
  return projected.xyz / projected.w;
}

fn dielectric_specular_color(ior: f32, metalness: f32, albedo: vec3f) -> vec3f {
  let dielectric = (ior - 1.0) / (ior + 1.0);
  return mix(vec3f(dielectric * dielectric), albedo, metalness);
}

fn F_Hauber(f0: vec3f, f90: f32, cos_theta: f32) -> vec3f {
  let inverse = 1.0 - cos_theta;
  let inverse2 = inverse * inverse;
  let inverse4 = inverse2 * inverse2;
  return mix(f0, vec3f(f90 - cos_theta), inverse4);
}

fn D_GGX(noh_squared: f32, alpha_squared: f32) -> f32 {
  let denominator = alpha_squared * (noh_squared - 1.0) + 1.0;
  return alpha_squared / (PI * denominator * denominator);
}

fn V_GGX_SmithCorrelated(alpha: f32, nov: f32, nol: f32) -> f32 {
  let alpha_squared = pow2(alpha);
  let gv = nov * sqrt(fma(pow2(nol), 1.0 - alpha_squared, alpha_squared));
  let gl = nol * sqrt(fma(pow2(nov), 1.0 - alpha_squared, alpha_squared));
  return 0.5 / max(gv + gl, EPSILON);
}

fn BRDF_GGX(
  nol: f32,
  nov: f32,
  noh_squared: f32,
  voh: f32,
  f0: vec3f,
  f90: f32,
  alpha: f32
) -> vec3f {
  let fresnel = F_Hauber(f0, f90, voh);
  let visibility = V_GGX_SmithCorrelated(alpha, nol, nov);
  let distribution = D_GGX(noh_squared, alpha);
  return fresnel * visibility * distribution;
}

fn oren_nayar_fujii_diffuse_dir_albedo(no: f32, roughness: f32, a: f32) -> f32 {
  let one_minus_no = 1.0 - no;
  let c0 = fma(one_minus_no, 0.0714429953, -0.332181442);
  let c1 = fma(one_minus_no, c0, 0.491881867);
  let c2 = fma(one_minus_no, c1, 0.0571085289);
  return a * fma(roughness, one_minus_no * c2, 1.0);
}

fn oren_nayar_fujii_diffuse_avg_albedo(roughness: f32, a: f32) -> f32 {
  return a * fma(0.07248821245692394, roughness, 1.0);
}

fn oren_nayar_compensated_diffuse(
  nov: f32,
  nol: f32,
  lov: f32,
  roughness: f32,
  color: vec3f
) -> vec3f {
  let a = 1.0 / fma(0.2877934092108062, roughness, 1.0);
  let dir_albedo_v = oren_nayar_fujii_diffuse_dir_albedo(nov, roughness, a);
  let dir_albedo_l = oren_nayar_fujii_diffuse_dir_albedo(nol, roughness, a);
  let avg_albedo = oren_nayar_fujii_diffuse_avg_albedo(roughness, a);
  let s = lov - nol * nov;
  let stinv = select(s, s / max(1e-7, max(nol, nov)), s > 0.0);
  let single_scatter = color * a * fma(roughness, stinv, 1.0);
  let color2 = color * color;
  let multi_color = color2 * avg_albedo /
    (vec3f(1.0) - color * max(0.0, 1.0 - avg_albedo));
  let multi_scatter = multi_color *
    max(1e-8, 1.0 - dir_albedo_v) *
    max(1e-8, 1.0 - dir_albedo_l) /
    max(1e-8, 1.0 - avg_albedo);
  return single_scatter + multi_scatter;
}

fn coordinate_wrap_repeat(value: f32, size: f32) -> f32 {
  return fract(value / size) * size;
}

fn indirect_sample_texture(id: u32, uv: vec2f) -> vec4f {
  let layer = id / RESIDENT_TEXTURE_TILES_PER_LAYER;
  let in_layer = id - layer * RESIDENT_TEXTURE_TILES_PER_LAYER;
  let slot_y = in_layer / RESIDENT_TEXTURE_TILES_PER_AXIS;
  let slot_x = in_layer % RESIDENT_TEXTURE_TILES_PER_AXIS;
  let texture_texel = uv * f32(RESIDENT_TEXTURE_TILE_SIZE) - 0.5;
  let rounded = random_round_vec2(texture_texel);
  let wrapped = vec2f(
    coordinate_wrap_repeat(rounded.x, f32(RESIDENT_TEXTURE_TILE_SIZE)),
    coordinate_wrap_repeat(rounded.y, f32(RESIDENT_TEXTURE_TILE_SIZE))
  );
  let pixel = vec2u(slot_x, slot_y) * RESIDENT_TEXTURE_TILE_SIZE + vec2u(wrapped);
  return textureLoad(ray_height, vec2i(pixel), i32(layer), 0);
}

fn material_triangle(hit: RqHit) -> MeshletTri {
  return rq_geometry_triangle(hit.geometry, hit.triangle);
}

fn sample_material_alpha(
  material: ResidentMaterial,
  triangle: MeshletTri,
  weights: vec3f,
  instance_transform: mat4x4f,
  ray_direction: vec3f
) -> PathOpacityHit {
  let uv = interpolate_attribute_2f32(triangle.uva, triangle.uvb, triangle.uvc, weights);
  let albedo_sample = indirect_sample_texture(material.texture_albedo, uv);
  let normal_matrix = mat3x3f(
    instance_transform[0].xyz,
    instance_transform[1].xyz,
    instance_transform[2].xyz
  );
  let local_face_normal = compute_triangle_face_normal(triangle.pa, triangle.pb, triangle.pc);
  let world_face_normal = normalize(normal_matrix * local_face_normal);
  let surface_alpha = albedo_sample.a * material.color_albedo.a;
  var opacity = surface_alpha;
  if (material.transmission_factor > 0.0) {
    let albedo = albedo_sample.rgb * material.color_albedo.rgb;
    let specular_f0 = dielectric_specular_color(
      material.ior_factor,
      material.metallic_factor,
      albedo
    );
    let nov = saturate(abs(dot(world_face_normal, ray_direction)));
    let fresnel = F_Hauber(specular_f0, 1.0, nov);
    opacity = mix(surface_alpha, max_v3(fresnel), material.transmission_factor);
  }
  let local_position = interpolate_attribute_3f32(
    triangle.pa,
    triangle.pb,
    triangle.pc,
    weights
  );
  var result: PathOpacityHit;
  result.opacity = opacity;
  result.position = project_position(local_position, instance_transform);
  result.geometric_normal = world_face_normal;
  return result;
}

fn sample_material_data(
  ray: RqRay,
  material: ResidentMaterial,
  triangle: MeshletTri,
  weights: vec3f,
  instance_transform: mat4x4f
) -> PathSurfaceData {
  let uv = interpolate_attribute_2f32(triangle.uva, triangle.uvb, triangle.uvc, weights);
  let vertex_color = interpolate_attribute_3f32(triangle.ca, triangle.cb, triangle.cc, weights);
  let albedo_sample = indirect_sample_texture(material.texture_albedo, uv);
  let orm_sample = indirect_sample_texture(material.texture_orm, uv);
  let local_normal = interpolate_attribute_3f32(triangle.na, triangle.nb, triangle.nc, weights);
  let local_tangent = interpolate_attribute_4f32(triangle.ta, triangle.tb, triangle.tc, weights);
  let normal_matrix = mat3x3f(
    instance_transform[0].xyz,
    instance_transform[1].xyz,
    instance_transform[2].xyz
  );
  let local_face_normal = compute_triangle_face_normal(triangle.pa, triangle.pb, triangle.pc);
  var normal_geometric = normalize(normal_matrix * local_face_normal);
  var normal_shading = normalize(normal_matrix * local_normal);
  var tangent = normalize(normal_matrix * local_tangent.xyz);
  if (dot(normal_geometric, ray.direction) > 0.0) {
    normal_geometric = -normal_geometric;
    normal_shading = -normal_shading;
    tangent = -tangent;
  }
  let tbn = build_orthonormal_matrix_nt(
    normal_shading,
    vec4f(tangent, local_tangent.w)
  );
  let normal_sample = indirect_sample_texture(material.texture_normal, uv).rgb * 2.0 - 1.0;
  let stochastic = 1.0 / 255.0;
  let albedo = max(vec3f(0.0), albedo_sample.rgb + (random_vec3() - 0.5) * stochastic);
  let emissive = max(
    vec3f(0.0),
    indirect_sample_texture(material.texture_emissive, uv).rgb +
      (random_vec3() - 0.5) * stochastic
  );
  var result: PathSurfaceData;
  result.opacity = albedo_sample.a * material.color_albedo.a;
  result.normal_shading = normalize(tbn * normal_sample);
  result.normal_geometric = normal_geometric;
  result.albedo = albedo * material.color_albedo.rgb * vertex_color;
  result.metalness = orm_sample.b * material.metallic_factor;
  result.roughness = saturate(orm_sample.g + (random() - 0.5) * stochastic) *
    material.roughness_factor;
  result.transmission = material.transmission_factor;
  result.ior = material.ior_factor;
  result.emissive = emissive * material.emissive_factor;
  return result;
}

fn shading_closure_from_material_data(
  material_data: PathSurfaceData,
  triangle: MeshletTri,
  weights: vec3f,
  instance_transform: mat4x4f,
  surface: ptr<function, PathSurfacePoint>,
  closure: ptr<function, PathShadingClosure>
) {
  let diffuse_weight = (1.0 - material_data.metalness) *
    (1.0 - material_data.transmission);
  (*closure).roughness = material_data.roughness;
  (*closure).diffuse = material_data.albedo * diffuse_weight;
  (*closure).opacity = material_data.opacity;
  (*closure).emissive = material_data.emissive;
  (*closure).specularF0 = dielectric_specular_color(
    material_data.ior,
    material_data.metalness,
    material_data.albedo
  );
  (*closure).specularF90 = 1.0;
  (*surface).shading_normal = material_data.normal_shading;
  (*surface).geometric_normal = material_data.normal_geometric;
  let local_position = interpolate_attribute_3f32(
    triangle.pa,
    triangle.pb,
    triangle.pc,
    weights
  );
  (*surface).position = project_position(local_position, instance_transform);
}

fn ray_hit_to_opacity(hit: RqHit, ray_direction: vec3f) -> PathOpacityHit {
  let mesh = scene_read_mesh(&scene_database, hit.instance);
  let scene_node = scene_read_node(&scene_database, mesh.node);
  let material = materials[mesh.material];
  let triangle = material_triangle(hit);
  let weights = vec3f(
    1.0 - hit.barycentrics.x - hit.barycentrics.y,
    hit.barycentrics.x,
    hit.barycentrics.y
  );
  return sample_material_alpha(
    material,
    triangle,
    weights,
    scene_node.global,
    ray_direction
  );
}

fn offset_ray(position: vec3f, normal: vec3f) -> vec3f {
  const origin = 1.0 / 32.0;
  const float_scale = 1.0 / 65536.0;
  const int_scale = 256.0;
  let integer_normal = vec3i(int_scale * normal);
  let integer_offset = bitcast<vec3f>(
    bitcast<vec3i>(position) + select(integer_normal, -integer_normal, position < vec3f(0.0))
  );
  let float_offset = fma(vec3f(float_scale), normal, position);
  return select(integer_offset, float_offset, abs(position) < vec3f(origin));
}

fn ray_shaded_query_occluded(ray: RqRay) -> bool {
  var remaining_layers: i32 = 32;
  var current_ray = ray;
  loop {
    let hit = ray_query_nearest(current_ray);
    if (hit.t <= 0.0) {
      return false;
    }
    let opacity_hit = ray_hit_to_opacity(hit, current_ray.direction);
    if (random() < opacity_hit.opacity) {
      return true;
    }
    let facing_normal = opacity_hit.geometric_normal * select(
      1.0,
      -1.0,
      dot(opacity_hit.geometric_normal, current_ray.direction) < 0.0
    );
    current_ray.origin = offset_ray(opacity_hit.position, facing_normal);
    continuing {
      remaining_layers -= 1;
      break if remaining_layers <= 0;
    }
  }
  return true;
}

fn sample_light_record(
  light_type: u32,
  index: u32,
  position: vec3f,
  random_value: vec2f
) -> SampledLightRecord {
  var result: SampledLightRecord;
  if (light_type == 0u) {
    result = sample_point_light_record(&node, index, position, random_value);
  } else if (light_type == 1u) {
    result = sample_spot_light_record(&node, index, position, random_value);
  } else if (light_type == 2u) {
    result = sample_directional_light_record(&node, index, position, random_value);
  }
  return result;
}

fn select_light_importance(position: vec3f, normal: vec3f, random_value: f32) -> SelectedLight {
  var selected: SelectedLight;
  selected.index = 0u;
  selected.pdf = 0.0;
  selected.light_type = 0u;
  var total = 0.0;

  for (var page = 0u; page < POINT_LIGHTS_PAGE_LIMIT; page++) {
    let address = point_lights_page_address(&node, page);
    if (address == ~0u) { continue; }
    for (var word = 0u; word < POINT_LIGHTS_OCCUPANCY_BITMAP_WORDS; word++) {
      var mask = point_lights_page_bitmap_word(&node, address, word);
      while (mask != 0u) {
        let bit = countTrailingZeros(mask);
        mask &= ~(1u << bit);
        let index = point_lights_slot_to_index(page, word * 32u + bit);
        total += path_light_importance_point(&node, index, position, normal);
      }
    }
  }
  for (var page = 0u; page < SPOT_LIGHTS_PAGE_LIMIT; page++) {
    let address = spot_lights_page_address(&node, page);
    if (address == ~0u) { continue; }
    for (var word = 0u; word < SPOT_LIGHTS_OCCUPANCY_BITMAP_WORDS; word++) {
      var mask = spot_lights_page_bitmap_word(&node, address, word);
      while (mask != 0u) {
        let bit = countTrailingZeros(mask);
        mask &= ~(1u << bit);
        let index = spot_lights_slot_to_index(page, word * 32u + bit);
        total += path_light_importance_spot(&node, index, position, normal);
      }
    }
  }
  var directional_mask = directional_lights_iteration_mask(&node);
  while (directional_mask != 0u) {
    let index = countTrailingZeros(directional_mask);
    directional_mask &= ~(1u << index);
    total += path_light_importance_directional(&node, index, position, normal);
  }
  if (total <= 0.0) {
    return selected;
  }

  let target = random_value * total;
  var accumulated = 0.0;
  var fallback_index = 0u;
  var fallback_type = 0u;
  var fallback_importance = 0.0;

  for (var page = 0u; page < POINT_LIGHTS_PAGE_LIMIT; page++) {
    let address = point_lights_page_address(&node, page);
    if (address == ~0u) { continue; }
    for (var word = 0u; word < POINT_LIGHTS_OCCUPANCY_BITMAP_WORDS; word++) {
      var mask = point_lights_page_bitmap_word(&node, address, word);
      while (mask != 0u) {
        let bit = countTrailingZeros(mask);
        mask &= ~(1u << bit);
        let index = point_lights_slot_to_index(page, word * 32u + bit);
        let importance = path_light_importance_point(&node, index, position, normal);
        if (importance > 0.0) {
          fallback_index = index;
          fallback_type = 0u;
          fallback_importance = importance;
        }
        accumulated += importance;
        if (accumulated >= target && importance > 0.0) {
          selected.index = index;
          selected.light_type = 0u;
          selected.pdf = importance / total;
          return selected;
        }
      }
    }
  }
  for (var page = 0u; page < SPOT_LIGHTS_PAGE_LIMIT; page++) {
    let address = spot_lights_page_address(&node, page);
    if (address == ~0u) { continue; }
    for (var word = 0u; word < SPOT_LIGHTS_OCCUPANCY_BITMAP_WORDS; word++) {
      var mask = spot_lights_page_bitmap_word(&node, address, word);
      while (mask != 0u) {
        let bit = countTrailingZeros(mask);
        mask &= ~(1u << bit);
        let index = spot_lights_slot_to_index(page, word * 32u + bit);
        let importance = path_light_importance_spot(&node, index, position, normal);
        if (importance > 0.0) {
          fallback_index = index;
          fallback_type = 1u;
          fallback_importance = importance;
        }
        accumulated += importance;
        if (accumulated >= target && importance > 0.0) {
          selected.index = index;
          selected.light_type = 1u;
          selected.pdf = importance / total;
          return selected;
        }
      }
    }
  }
  directional_mask = directional_lights_iteration_mask(&node);
  while (directional_mask != 0u) {
    let index = countTrailingZeros(directional_mask);
    directional_mask &= ~(1u << index);
    let importance = path_light_importance_directional(&node, index, position, normal);
    if (importance > 0.0) {
      fallback_index = index;
      fallback_type = 2u;
      fallback_importance = importance;
    }
    accumulated += importance;
    if (accumulated >= target && importance > 0.0) {
      selected.index = index;
      selected.light_type = 2u;
      selected.pdf = importance / total;
      return selected;
    }
  }
  selected.index = fallback_index;
  selected.light_type = fallback_type;
  selected.pdf = fallback_importance / total;
  return selected;
}

fn shadow_terminator_term(light_direction: vec3f, geometric_normal: vec3f, shading_normal: vec3f) -> f32 {
  let angle = 0.05;
  let denominator = mix(
    sin(angle + 0.1),
    sin(angle),
    dot(shading_normal, geometric_normal)
  );
  let ratio = max(0.0, min(1.0, dot(geometric_normal, light_direction) / denominator));
  return smoothstep(0.0, 1.0, ratio);
}

fn uv_octahedral_unit_encode(direction: vec3f) -> vec2f {
  var projected = direction.xy /
    (abs(direction.x) + abs(direction.y) + abs(direction.z));
  if (direction.z < 0.0) {
    projected = (1.0 - abs(projected.yx)) *
      select(vec2f(1.0), vec2f(-1.0), projected < vec2f(0.0));
  }
  return projected * 0.5 + 0.5;
}

fn texture_octahedral_wrap_texel_coordinates(value: vec2i, size: i32) -> vec2u {
  let wrapped = ((value % size) + size) % size;
  let crossing_x = abs(value.x / size) + i32(value.x < 0);
  let crossing_y = abs(value.y / size) + i32(value.y < 0);
  let mirrored = ((crossing_x ^ crossing_y) & 1) != 0;
  return select(
    vec2u(wrapped),
    vec2u(size - (wrapped + vec2i(1))),
    mirrored
  );
}

fn texture_octahedral_sample_bilinear(texture: texture_2d<f32>, direction: vec3f) -> vec4f {
  let dimensions = textureDimensions(texture, 0);
  let size = dimensions.x;
  let uv = uv_octahedral_unit_encode(direction);
  let texel = fma(uv, vec2f(size), vec2f(-0.5));
  let fraction = fract(texel);
  let base = vec2i(floor(texel));
  let p00 = texture_octahedral_wrap_texel_coordinates(base, i32(size));
  let p10 = texture_octahedral_wrap_texel_coordinates(base + vec2i(1, 0), i32(size));
  let p01 = texture_octahedral_wrap_texel_coordinates(base + vec2i(0, 1), i32(size));
  let p11 = texture_octahedral_wrap_texel_coordinates(base + vec2i(1, 1), i32(size));
  let c00 = textureLoad(texture, vec2i(p00), 0);
  let c10 = textureLoad(texture, vec2i(p10), 0);
  let c01 = textureLoad(texture, vec2i(p01), 0);
  let c11 = textureLoad(texture, vec2i(p11), 0);
  let weights = vec4f(
    (1.0 - fraction.x) * (1.0 - fraction.y),
    fraction.x * (1.0 - fraction.y),
    (1.0 - fraction.x) * fraction.y,
    fraction.x * fraction.y
  );
  return c00 * weights.x + c10 * weights.y + c01 * weights.z + c11 * weights.w;
}

fn sample_environment_color(direction: vec3f) -> vec3f {
  return texture_octahedral_sample_bilinear(sec_radix_passes, direction).rgb;
}

fn disk_to_square_concentric(value: vec2f) -> vec2f {
  let offset = 2.0 * value - vec2f(1.0);
  if (offset.x == 0.0 && offset.y == 0.0) {
    return vec2f(0.0);
  }
  var radius: f32;
  var theta: f32;
  if (abs(offset.x) > abs(offset.y)) {
    radius = offset.x;
    theta = (PI / 4.0) * (offset.y / offset.x);
  } else {
    radius = offset.y;
    theta = PI / 2.0 - (PI / 4.0) * (offset.x / offset.y);
  }
  return radius * vec2f(cos(theta), sin(theta));
}

fn get_cosine_weighted_sample(value: vec2f, normal: vec3f) -> vec3f {
  let disk = disk_to_square_concentric(value);
  let local = vec3f(disk, sqrt(max(0.0, 1.0 - dot(disk, disk))));
  return normalize(build_orthonormal_matrix_n(normal) * local);
}

fn visible_normal_sample(
  view: vec3f,
  alpha_x: f32,
  alpha_y: f32,
  random_y: f32,
  random_x: f32
) -> vec3f {
  let stretched = normalize(vec3f(alpha_x * view.x, alpha_y * view.y, view.z));
  let phi = 2.0 * PI * random_x;
  let z = fma(1.0 - random_y, 1.0 + stretched.z, -stretched.z);
  let radius = sqrt(saturate(1.0 - z * z));
  let cap = vec3f(radius * cos(phi), radius * sin(phi), z) + stretched;
  return normalize(vec3f(alpha_x * cap.x, alpha_y * cap.y, max(0.0, cap.z)));
}

fn sample_reflection_vector(view: vec3f, normal: vec3f, roughness: f32, value: vec2f) -> vec3f {
  let basis = build_orthonormal_matrix_n(normal);
  let local_view = vec3f(dot(basis[0], view), dot(basis[1], view), dot(basis[2], view));
  let micro_normal = visible_normal_sample(local_view, roughness, roughness, value.x, value.y);
  let local_reflection = reflect(-local_view, micro_normal);
  return local_reflection * transpose(basis);
}

fn russian_roulette(
  bounce: u32,
  bounce_limit: u32,
  throughput: ptr<function, vec3f>
) -> bool {
  if (bounce == bounce_limit - 1u) {
    return true;
  }
  if (bounce == 0u) {
    return false;
  }
  let probability = saturate(max_v3(*throughput));
  if (random() > probability) {
    return true;
  }
  *throughput /= probability;
  return false;
}

fn render_trace_path(ray: RqRay, bounce_limit: u32) -> PathTraceResult {
  var result: PathTraceResult;
  result.distance = -1.0;
  var radiance = vec3f(0.0);
  var throughput = vec3f(1.0);
  var current_ray = ray;
  var bounce = 0u;
  const environment_luminance_limit = 10.0;

  for (; bounce < bounce_limit; bounce++) {
    let hit = ray_query_nearest(current_ray);
    if (bounce == 0u) {
      result.distance = hit.t;
    }
    if (hit.t <= 0.0) {
      var environment = sample_environment_color(current_ray.direction);
      let luminance = rgb_to_luminance(environment);
      if (luminance > environment_luminance_limit) {
        environment *= environment_luminance_limit / luminance;
      }
      radiance += throughput * environment;
      break;
    }

    let mesh = scene_read_mesh(&scene_database, hit.instance);
    let scene_node = scene_read_node(&scene_database, mesh.node);
    let material = materials[mesh.material];
    let triangle = material_triangle(hit);
    let weights = vec3f(
      1.0 - hit.barycentrics.x - hit.barycentrics.y,
      hit.barycentrics.x,
      hit.barycentrics.y
    );
    var closure: PathShadingClosure;
    var surface: PathSurfacePoint;
    let material_data = sample_material_data(
      current_ray,
      material,
      triangle,
      weights,
      scene_node.global
    );
    shading_closure_from_material_data(
      material_data,
      triangle,
      weights,
      scene_node.global,
      &surface,
      &closure
    );

    let hit_position = surface.position;
    if (closure.opacity < 1.0 && random() > closure.opacity) {
      let side = dot(surface.geometric_normal, current_ray.direction);
      let normal = surface.geometric_normal * select(-1.0, 1.0, side > 0.0);
      current_ray.origin = offset_ray(hit_position, normal);
      continue;
    }

    let throughput_before_bounce = throughput;
    radiance += throughput_before_bounce * closure.emissive;
    let incoming_direction = current_ray.direction;
    current_ray.origin = offset_ray(hit_position, surface.geometric_normal);
    let normal = surface.shading_normal;
    let roughness = closure.roughness;
    let view_direction = -incoming_direction;
    let nov = saturate(dot(normal, view_direction));
    let alpha = roughness * roughness;

    let selected_light = select_light_importance(hit_position, normal, random());
    if (selected_light.pdf > 0.0) {
      let sampled_light = sample_light_record(
        selected_light.light_type,
        selected_light.index,
        hit_position,
        vec2f(random(), random())
      );
      let light_direction = sampled_light.direction;
      let nol_signed = dot(normal, light_direction);
      if (nol_signed > 0.0) {
        var shadow_ray: RqRay;
        shadow_ray.origin = current_ray.origin;
        shadow_ray.direction = light_direction;
        shadow_ray.tmax = sampled_light.distance;
        if (!ray_shaded_query_occluded(shadow_ray)) {
          let half_vector = normalize(light_direction + view_direction);
          let noh = saturate(dot(normal, half_vector));
          let voh = saturate(dot(view_direction, half_vector));
          let lov = saturate(dot(light_direction, view_direction));
          let inverse_pdf = 1.0 / (selected_light.pdf * sampled_light.pdf);
          let incident = sampled_light.emission * nol_signed * inverse_pdf;
          let diffuse = oren_nayar_compensated_diffuse(
            nov,
            nol_signed,
            lov,
            roughness,
            closure.diffuse
          );
          let specular = BRDF_GGX(
            nol_signed,
            nov,
            noh * noh,
            voh,
            closure.specularF0,
            closure.specularF90,
            alpha
          );
          let terminator = shadow_terminator_term(
            light_direction,
            surface.geometric_normal,
            surface.shading_normal
          );
          radiance += throughput_before_bounce * (diffuse + specular) * incident * terminator;
        }
      }
    }

    let fresnel_view = F_Hauber(closure.specularF0, closure.specularF90, nov);
    let specular_luminance = rgb_to_luminance(fresnel_view);
    let diffuse_luminance = rgb_to_luminance(closure.diffuse);
    let transmission = material_data.transmission;
    let diffuse_transmission = diffuse_luminance + transmission;
    let specular_probability = clamp(
      specular_luminance / max(1e-5, specular_luminance + diffuse_transmission),
      0.02,
      0.99
    );
    let random_pair = vec2f(random(), random());
    var next_direction: vec3f;
    var path_weight: vec3f;
    var transmitted = false;
    if (random() < specular_probability) {
      next_direction = sample_reflection_vector(
        view_direction,
        normal,
        roughness,
        random_pair
      );
      let nol = saturate(dot(normal, next_direction));
      let half_vector = normalize(next_direction + view_direction);
      let voh = saturate(dot(view_direction, half_vector));
      let fresnel = F_Hauber(closure.specularF0, closure.specularF90, voh);
      let alpha_squared = alpha * alpha;
      let a = nol * sqrt(fma(nov * nov, 1.0 - alpha_squared, alpha_squared));
      let b = nov * sqrt(fma(nol * nol, 1.0 - alpha_squared, alpha_squared));
      path_weight = fresnel * (a / (a + b)) / specular_probability;
    } else {
      let non_specular_probability = 1.0 - specular_probability;
      let transmission_probability = clamp(
        transmission / max(1e-5, diffuse_transmission),
        0.0,
        1.0
      );
      if (random() < transmission_probability) {
        transmitted = true;
        next_direction = incoming_direction;
        path_weight = (vec3f(1.0) - fresnel_view) /
          (non_specular_probability * transmission_probability);
        let side = dot(surface.geometric_normal, incoming_direction);
        let offset_normal = surface.geometric_normal * select(-1.0, 1.0, side > 0.0);
        current_ray.origin = offset_ray(hit_position, offset_normal);
      } else {
        let diffuse_probability = 1.0 - transmission_probability;
        next_direction = get_cosine_weighted_sample(random_pair, normal);
        path_weight = closure.diffuse /
          (non_specular_probability * diffuse_probability);
      }
    }
    current_ray.direction = next_direction;
    if (!transmitted) {
      path_weight *= shadow_terminator_term(
        next_direction,
        surface.geometric_normal,
        surface.shading_normal
      );
    }
    throughput *= path_weight;
    current_ray.tmax = F32_MAX;
    if (russian_roulette(bounce, bounce_limit, &throughput)) {
      break;
    }
  }

  result.bounces = bounce;
  result.irradiance = max(vec3f(0.0), radiance);
  return result;
}

fn uv_to_ndc(uv: vec2f) -> vec2f {
  return fma(uv, vec2f(2.0, -2.0), vec2f(-1.0, 1.0));
}

fn camera_ray_from_uv(uv: vec2f, camera_value: CommandEncoder) -> RqRay {
  var ray: RqRay;
  ray.tmax = F32_MAX;
  ray.origin = camera_value.transform[3].xyz;
  let ndc = uv_to_ndc(uv);
  let world = project_position(
    vec3f(ndc, 0.5),
    camera_value.view_projection_matrix_inverse
  );
  ray.direction = normalize(world - ray.origin);
  return ray;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
  let tile_position = invocation.xy;
  if (any(tile_position >= vec2u(settings.tile_size))) {
    return;
  }
  let pixel = tile_position + settings.tile_offset;
  let dimensions = textureDimensions(intensity);
  if (any(pixel >= dimensions)) {
    return;
  }
  random_initialize(invocation, vec3u(settings.random_seed));
  const bounce_limit = 3u;
  let inverse_dimensions = 1.0 / vec2f(dimensions);
  let uv = vec2f(pixel) * inverse_dimensions;
  let jitter = vec2f(random(), random()) * inverse_dimensions;
  var ray = camera_ray_from_uv(uv + jitter, camera);
  ray.tmax = F32_MAX;
  let sample = render_trace_path(ray, bounce_limit).irradiance;
  let history = textureLoad(x1, vec2i(pixel), 0);
  let history_valid = all(history.rgb == history.rgb) &&
    all(abs(history.rgb) < vec3f(F32_MAX));
  let previous = select(vec3f(0.0), history.rgb, history_valid);
  let sample_valid = all(sample == sample) && all(abs(sample) < vec3f(F32_MAX));
  let current = select(previous, sample, sample_valid);
  textureStore(intensity, pixel, vec4f(mix(previous, current, settings.alpha), 1.0));
}
`;

export const PATH_TRACER_POST_WGSL = /* wgsl */ `
@group(0) @binding(0) var input_texture: texture_2d<f32>;

const FULLSCREEN_POSITIONS = array<vec2f, 3>(
  vec2f(-1.0, -1.0),
  vec2f(3.0, -1.0),
  vec2f(-1.0, 3.0)
);

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4f {
  return vec4f(FULLSCREEN_POSITIONS[vertex_index], 0.0, 1.0);
}

fn rgb_to_luminance(value: vec3f) -> f32 {
  return dot(value, vec3f(
    0.212639005871510,
    0.715168678767756,
    0.072192315360734
  ));
}

@fragment
fn fs_copy(@builtin(position) position: vec4f) -> @location(0) vec4f {
  return textureLoad(input_texture, vec2i(position.xy), 0);
}

@fragment
fn fs_nonzero_mip(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let output_pixel = vec2i(position.xy);
  let input_origin = output_pixel * 2;
  let dimensions = vec2i(textureDimensions(input_texture));
  var sum = vec3f(0.0);
  var count = 0.0;
  for (var y = 0; y < 2; y++) {
    for (var x = 0; x < 2; x++) {
      let coordinate = input_origin + vec2i(x, y);
      if (all(coordinate < dimensions)) {
        let sample = textureLoad(input_texture, coordinate, 0).rgb;
        if (rgb_to_luminance(sample) > 0.0) {
          sum += sample;
          count += 1.0;
        }
      }
    }
  }
  if (count > 0.0) {
    return vec4f(sum / count, 1.0);
  }
  return vec4f(0.0, 0.0, 0.0, 1.0);
}

@fragment
fn fs_flood_fill(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let pixel = vec2i(position.xy);
  let current = textureLoad(input_texture, pixel, 0);
  if (rgb_to_luminance(current.rgb) > 0.0) {
    return current;
  }
  let levels = i32(textureNumLevels(input_texture));
  let base_dimensions = vec2f(textureDimensions(input_texture, 0));
  let uv = (vec2f(pixel) + vec2f(0.5)) / base_dimensions;
  for (var level = 1; level < levels; level++) {
    let dimensions = vec2i(textureDimensions(input_texture, level));
    let coordinate = clamp(
      vec2i(uv * vec2f(dimensions)),
      vec2i(0),
      dimensions - vec2i(1)
    );
    let sample = textureLoad(input_texture, coordinate, level);
    if (rgb_to_luminance(sample.rgb) > 0.0) {
      return sample;
    }
  }
  return vec4f(0.0, 0.0, 0.0, 1.0);
}
`;

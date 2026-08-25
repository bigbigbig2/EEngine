/**
 * probe_gbuffer：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { LIGHT_PROBE_RECORD_WGSL } from "../gpu/LightProbeRecord.js";
import { GBUFFER_ENCODE_WGSL } from "./gbuffer_encode.js";
import { RAY_QUERY_WGSL } from "./ray_query.js";

export const PROBE_GBUFFER_TARGET_FORMATS = [
  "rgba8unorm",
  "r32uint",
  "rg8unorm",
  "rgba8unorm",
  "rgba16float"
] as const satisfies readonly GPUTextureFormat[];

export const PROBE_GBUFFER_SETTINGS_BYTES = 24;
export const PROBE_RESIDENT_MATERIAL_BYTES = 64;
export const PROBE_RESIDENT_MATERIAL_LIMIT = 1024;

export const PROBE_GBUFFER_WGSL = /* wgsl */ `
${LIGHT_PROBE_RECORD_WGSL}
${GBUFFER_ENCODE_WGSL}

struct ProbeGBufferSettings {
  probe_resolution: u32,
  output_resolution_width: u32,
  probe_index_offset: u32,
  probe_update_count: u32,
  probe_count: u32,
  random_seed: u32,
};

struct ProbeResidentMaterial {
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
};

struct ProbeMaterialData {
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

struct ProbeGBufferOutput {
  @location(0) albedo: vec4f,
  @location(1) emissive: u32,
  @location(2) normals: vec2f,
  @location(3) pbr: vec4f,
  @location(4) position: vec4f,
};

@group(0) @binding(0) var<uniform> settings: ProbeGBufferSettings;

@group(1) @binding(0) var<uniform> materials:
  array<ProbeResidentMaterial, ${PROBE_RESIDENT_MATERIAL_LIMIT}>;
@group(1) @binding(1) var ray_height: texture_2d_array<f32>;
@group(1) @binding(2) var sec_radix_passes: texture_2d<f32>;

@group(2) @binding(0) var<storage, read> scene_database: array<u32>;
@group(2) @binding(1) var<storage, read> tlas_data: array<u32>;
@group(2) @binding(2) var<storage, read> blas_addresses: array<u32>;
@group(2) @binding(3) var<storage, read> blas_nodes: array<u32>;
@group(2) @binding(4) var<storage, read> geometries: array<u32>;
@group(2) @binding(5) var<storage, read> meshlet_headers: array<u32>;
@group(2) @binding(6) var<storage, read> meshlet_data: array<u32>;

@group(3) @binding(0) var<storage, read> end: array<LightProbeData>;

${RAY_QUERY_WGSL}

var<private> rnd_state: u32 = 2891336453u;

fn probe_hash3(value_in: vec3u) -> vec3u {
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
  let value = probe_hash3(invocation + seed * 37u);
  rnd_state = value.x ^ value.y ^ value.z;
}

fn probe_random_u32() -> u32 {
  let state = rnd_state * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  rnd_state = (word >> 22u) ^ word;
  return rnd_state;
}

fn random() -> f32 {
  return bitcast<f32>(0x3f800000u | (probe_random_u32() >> 9u)) - 1.0;
}

fn random_vec2() -> vec2f {
  return unpack2x16unorm(probe_random_u32());
}

fn random_vec3() -> vec3f {
  let value = probe_random_u32();
  return vec3f(
    f32(value & 0x7FFu) / 2047.0,
    f32((value >> 11u) & 0x7FFu) / 2047.0,
    f32((value >> 22u) & 0x3FFu) / 1023.0
  );
}

fn random_round_vec2(value: vec2f) -> vec2f {
  let add = select(vec2f(0.0), vec2f(1.0), fract(value) > random_vec2());
  return floor(value) + add;
}

fn grid2d_to_index(position: vec2u, width: u32) -> u32 {
  return position.y * width + position.x;
}

fn texel_coordinate_to_uv(position: vec2f, resolution: vec2f) -> vec2f {
  return (position + 0.5) / resolution;
}

fn coordinate_wrap_repeat(value: f32, period: f32) -> f32 {
  return fract(value / period) * period;
}

fn indirect_sample_texture(id: u32, uv: vec2f) -> vec4f {
  const slots_per_axis = 32u;
  const slots_per_layer = 1024u;
  const tile_size = 64u;
  let layer = id / slots_per_layer;
  let in_layer = id - layer * slots_per_layer;
  let slot_y = in_layer / slots_per_axis;
  let slot_x = in_layer % slots_per_axis;
  let texel = uv * vec2f(f32(tile_size)) - 0.5;
  let rounded = random_round_vec2(texel);
  let wrapped = vec2f(
    coordinate_wrap_repeat(rounded.x, f32(tile_size)),
    coordinate_wrap_repeat(rounded.y, f32(tile_size))
  );
  let pixel = vec2u(slot_x, slot_y) * tile_size + vec2u(wrapped);
  return textureLoad(ray_height, vec2i(pixel), i32(layer), 0);
}

fn interpolate_2(a: vec2f, b: vec2f, c: vec2f, lambda: vec3f) -> vec2f {
  return a * lambda.x + b * lambda.y + c * lambda.z;
}

fn interpolate_3(a: vec3f, b: vec3f, c: vec3f, lambda: vec3f) -> vec3f {
  return a * lambda.x + b * lambda.y + c * lambda.z;
}

fn interpolate_4(a: vec4f, b: vec4f, c: vec4f, lambda: vec3f) -> vec4f {
  return a * lambda.x + b * lambda.y + c * lambda.z;
}

fn triangle_face_normal(a: vec3f, b: vec3f, c: vec3f) -> vec3f {
  return normalize(cross(b - a, c - a));
}

fn build_orthonormal_matrix_nt(normal: vec3f, tangent: vec4f) -> mat3x3f {
  let t = normalize(tangent.xyz - normal * dot(normal, tangent.xyz));
  let b = normalize(cross(normal, t) * tangent.w);
  return mat3x3f(t, b, normal);
}

fn sample_material_data(
  ray: RqRay,
  material: ProbeResidentMaterial,
  triangle: MeshletTri,
  lambda: vec3f,
  instance_transform: mat4x4f
) -> ProbeMaterialData {
  let uv = interpolate_2(triangle.uva, triangle.uvb, triangle.uvc, lambda);
  let vertex_color = interpolate_3(triangle.ca, triangle.cb, triangle.cc, lambda);
  let albedo_sample = indirect_sample_texture(material.texture_albedo, uv);
  let orm_sample = indirect_sample_texture(material.texture_orm, uv);
  var normal_local = interpolate_3(triangle.na, triangle.nb, triangle.nc, lambda);
  let tangent_local = interpolate_4(triangle.ta, triangle.tb, triangle.tc, lambda);
  let normal_matrix = mat3x3f(
    instance_transform[0].xyz,
    instance_transform[1].xyz,
    instance_transform[2].xyz
  );
  let face_local = triangle_face_normal(triangle.pa, triangle.pb, triangle.pc);
  var normal_geometric = normalize(normal_matrix * face_local);
  var normal_vertex = normalize(normal_matrix * normal_local);
  var tangent_vertex = normalize(normal_matrix * tangent_local.xyz);
  if (dot(normal_geometric, ray.direction) > 0.0) {
    normal_geometric = -normal_geometric;
    normal_vertex = -normal_vertex;
    tangent_vertex = -tangent_vertex;
  }
  let tangent_frame = build_orthonormal_matrix_nt(
    normal_vertex,
    vec4f(tangent_vertex, tangent_local.w)
  );
  let normal_sample = indirect_sample_texture(material.texture_normal, uv).rgb * 2.0 - 1.0;
  let normal_shading = normalize(tangent_frame * normal_sample);
  const dither = 1.0 / 255.0;
  let albedo = max(
    vec3f(0.0),
    albedo_sample.rgb + (random_vec3() - 0.5) * dither
  );
  let emissive = max(
    vec3f(0.0),
    indirect_sample_texture(material.texture_emissive, uv).rgb +
      (random_vec3() - 0.5) * dither
  );
  var out: ProbeMaterialData;
  out.opacity = albedo_sample.a * material.color_albedo.a;
  out.normal_shading = normal_shading;
  out.normal_geometric = normal_geometric;
  out.albedo = albedo * material.color_albedo.rgb * vertex_color;
  out.metalness = orm_sample.b * material.metallic_factor;
  out.roughness = clamp(
    orm_sample.g + (random() - 0.5) * dither,
    0.0,
    1.0
  ) * material.roughness_factor;
  out.transmission = material.transmission_factor;
  out.ior = material.ior_factor;
  out.emissive = emissive * material.emissive_factor;
  return out;
}

fn oct_wrap_coordinate(position: vec2i, resolution: i32) -> vec2u {
  let wrapped = ((position % resolution) + resolution) % resolution;
  let x_crossings = abs(position.x / resolution) + i32(position.x < 0);
  let y_crossings = abs(position.y / resolution) + i32(position.y < 0);
  let flip = ((x_crossings ^ y_crossings) & 1) != 0;
  return select(
    vec2u(wrapped),
    vec2u(resolution - (wrapped + vec2i(1))),
    flip
  );
}

fn sample_environment_color(environment: texture_2d<f32>, direction: vec3f) -> vec3f {
  let dimensions = textureDimensions(environment, 0);
  let resolution = dimensions.x;
  let uv = uv_octahedral_unit_encode(direction);
  let texel = uv * vec2f(f32(resolution)) - 0.5;
  let fraction = fract(texel);
  let base = vec2i(floor(texel));
  let c00 = textureLoad(environment, vec2i(oct_wrap_coordinate(base, i32(resolution))), 0);
  let c10 = textureLoad(environment, vec2i(oct_wrap_coordinate(base + vec2i(1, 0), i32(resolution))), 0);
  let c01 = textureLoad(environment, vec2i(oct_wrap_coordinate(base + vec2i(0, 1), i32(resolution))), 0);
  let c11 = textureLoad(environment, vec2i(oct_wrap_coordinate(base + vec2i(1, 1), i32(resolution))), 0);
  return mix(mix(c00, c10, fraction.x), mix(c01, c11, fraction.x), fraction.y).rgb;
}

const FULLSCREEN_POSITIONS = array<vec2f, 3>(
  vec2f(-1.0, -1.0),
  vec2f( 3.0, -1.0),
  vec2f(-1.0,  3.0)
);

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4f {
  return vec4f(FULLSCREEN_POSITIONS[vertex_index], 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) fragment_position: vec4f) -> ProbeGBufferOutput {
  let pixel = vec2u(fragment_position.xy);
  let probe_coord = pixel / settings.probe_resolution;
  let probe_texel = pixel % settings.probe_resolution;
  let local_probe_index = grid2d_to_index(
    probe_coord,
    settings.output_resolution_width
  );
  var out: ProbeGBufferOutput;
  if (local_probe_index >= settings.probe_update_count) {
    return out;
  }

  let probe_index = (
    settings.probe_index_offset + local_probe_index
  ) % settings.probe_count;
  let probe = end[probe_index];
  random_initialize(
    vec3u(probe_texel, probe_index),
    vec3u(settings.random_seed)
  );
  let jittered_texel = vec2f(probe_texel) + vec2f(random(), random()) - 0.5;
  let uv = texel_coordinate_to_uv(
    jittered_texel,
    vec2f(f32(settings.probe_resolution))
  );

  var ray: RqRay;
  ray.origin = vec3f(probe.position[0], probe.position[1], probe.position[2]);
  ray.direction = uv_octahedral_unit_decode(uv);
  ray.tmax = 1e10;
  let hit = ray_query_nearest(ray);

  if (hit.t <= 0.0) {
    out.emissive = rgbe9995_encode(
      sample_environment_color(sec_radix_passes, ray.direction)
    );
    out.pbr.a = 1.0;
    out.position = vec4f(ray.direction, 0.0);
    return out;
  }

  let mesh = scene_read_mesh(&scene_database, hit.instance);
  let scene_node = scene_read_node(&scene_database, mesh.node);
  let material = materials[mesh.material];
  let triangle = rq_geometry_triangle(mesh.geometry, hit.triangle);
  let lambda = vec3f(
    1.0 - hit.barycentrics.x - hit.barycentrics.y,
    hit.barycentrics.x,
    hit.barycentrics.y
  );
  let sampled = sample_material_data(
    ray,
    material,
    triangle,
    lambda,
    scene_node.global
  );
  let relative_position = hit.t * ray.direction;
  out.position = vec4f(relative_position, 0.0);
  out.albedo = vec4f(sampled.albedo, 1.0);
  out.pbr = vec4f(sampled.metalness, sampled.roughness, 0.0, 0.0);
  out.emissive = rgbe9995_encode(sampled.emissive);
  out.normals = uv_octahedral_unit_encode(sampled.normal_shading);
  return out;
}
`;

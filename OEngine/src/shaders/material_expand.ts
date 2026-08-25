/**
 * material_expand：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { MESHLET_ELEMENT_WGSL } from "../geometry/MeshletTypes.js";
import { MATERIAL_META_TYPE } from "../gpu/MaterialMetadataTable.js";
import { SCENE_DATABASE_READ_WGSL } from "../gpu/SceneDatabase.js";
import { GPU_VIEW_TYPE } from "../render/ViewManager.js";
import { LPV_CAMERA_TYPE } from "./lpv_indirect_diffuse.js";
import { GBUFFER_ENCODE_WGSL } from "./gbuffer_encode.js";
import { BARYCENTRIC_UV_WGSL, MESHLET_READ_WGSL } from "./meshlet_read.js";

export const MATERIAL_EXPAND_WGSL = /* wgsl */ `
${MATERIAL_META_TYPE.wgsl_declaration}
${GPU_VIEW_TYPE.wgsl_declaration}
${LPV_CAMERA_TYPE.wgsl_declaration}
${MESHLET_ELEMENT_WGSL}
${GBUFFER_ENCODE_WGSL}
${SCENE_DATABASE_READ_WGSL}

const MIP_BIAS: f32 = ${((1 / 1.33)).toFixed(8)};

struct SceneBundle {
  bounding_sphere: vec4f,
  bounding_box: array<f32, 6>,
  index_count: u32,
  meshlets_address: u32,
  meshlets_count: u32,
}

@group(0) @binding(0) var<uniform> material_info: EventDispatcher;
@group(0) @binding(1) var normal: texture_2d<f32>;
@group(0) @binding(2) var lookup: sampler;
@group(0) @binding(3) var transmitted_energy_factor: texture_2d<f32>;
@group(0) @binding(4) var screen_st: sampler;
@group(0) @binding(5) var xyz: texture_2d<f32>;
@group(0) @binding(6) var elements_per_texel_depth: sampler;
@group(0) @binding(7) var bb_dim: texture_2d<f32>;
@group(0) @binding(8) var normals: sampler;

@group(1) @binding(0) var clamped: texture_2d<u32>;
@group(1) @binding(1) var total_fraction: texture_2d<u32>;
@group(1) @binding(2) var<uniform> view: PipelineCacheKey;
@group(1) @binding(3) var<uniform> camera: CommandEncoder;

@group(2) @binding(0) var<storage, read> scene_database: array<u32>;
@group(2) @binding(1) var<storage, read> geometries: array<SceneBundle>;
@group(2) @binding(2) var<storage, read> meshlet_headers: array<u32>;
@group(2) @binding(3) var<storage, read> meshlet_data: array<u32>;

${MESHLET_READ_WGSL}
${BARYCENTRIC_UV_WGSL}

fn saturate(value: f32) -> f32 { return clamp(value, 0.0, 1.0); }

fn compute_triangle_face_normal(a: vec3f, b: vec3f, c: vec3f) -> vec3f {
  return normalize(cross(c - b, a - b));
}

fn compute_normal_matrix_from_m4(matrix: mat4x4f) -> mat3x3f {
  let x = matrix[0].xyz;
  let y = matrix[1].xyz;
  let z = matrix[2].xyz;
  return mat3x3f(cross(y, z), cross(z, x), cross(x, y));
}

fn build_orthonormal_matrix_nt(normal_value: vec3f, tangent_value: vec4f) -> mat3x3f {
  let tangent = normalize(
    tangent_value.xyz - normal_value * dot(normal_value, tangent_value.xyz)
  );
  let bitangent = normalize(cross(normal_value, tangent) * tangent_value.w);
  return mat3x3f(tangent, bitangent, normal_value);
}

fn anti_alias_roughness_kaplanyan(
  roughness: f32,
  normal_value: vec3f,
  tangent: vec3f,
  bitangent: vec3f
) -> f32 {
  let projected = vec2f(dot(normal_value, tangent), dot(normal_value, bitangent));
  let width = fwidth(projected);
  let variance = clamp(max(width.x, width.y), 1e-3, 0.3);
  let kernel = 0.25 * variance * variance;
  let filtered = min(0.18, kernel * 2.0);
  return sqrt(roughness * roughness + filtered);
}

fn rgbe_read_multiple_tap(position: vec2f) -> f32 {
  var value = fract(position * vec2f(5.3987, 5.4421));
  value += dot(value.yx, value.xy + vec2f(21.5351, 14.3137));
  let product = value.x * value.y;
  return fract(product * 95.4307) + fract(product * 75.04961) - 1.0;
}

fn dither_color_8bit_triangle_noise(position: vec2f) -> f32 {
  return rgbe_read_multiple_tap(position) / 255.0;
}

const POSITIONS = array<vec2f, 3>(
  vec2f(-1.0, -1.0),
  vec2f(3.0, -1.0),
  vec2f(-1.0, 3.0)
);

struct MaterialVertexOutput { @builtin(position) position: vec4f, }

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> MaterialVertexOutput {
  var output: MaterialVertexOutput;
  output.position = vec4f(
    POSITIONS[vertex_index],
    f32(material_info.id) / 16777216.0,
    1.0
  );
  return output;
}

struct MaterialOutput {
  @location(0) pbr: vec2f,
  @location(1) normal: vec4u,
  @location(2) albedo: vec4f,
  @location(3) emissive: u32,
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> MaterialOutput {
  var output: MaterialOutput;
  let pixel = vec2i(position.xy);
  let encoded = textureLoad(clamped, pixel, 0).r;
  let meshlet_element = decode_meshlet_element(encoded);
  let meshlet_index = meshlet_element.x;
  let triangle_index = meshlet_element.y;
  let mesh_index = textureLoad(total_fraction, pixel, 0).r;
  let mesh = scene_read_mesh(&scene_database, mesh_index);
  let node = scene_read_node(&scene_database, mesh.node);
  let _geometry = geometries[mesh.geometry];
  let triangle = read_meshlet_triangle_vertices(meshlet_index, triangle_index);

  let face_normal_local = compute_triangle_face_normal(
    triangle.pa,
    triangle.pb,
    triangle.pc
  );
  let global = node.global;
  let world_0 = global * vec4f(triangle.pa, 1.0);
  let world_1 = global * vec4f(triangle.pb, 1.0);
  let world_2 = global * vec4f(triangle.pc, 1.0);
  let projected_0 = view.projection_matrix * world_0;
  let projected_1 = view.projection_matrix * world_1;
  let projected_2 = view.projection_matrix * world_2;
  let bary = barycentric_full(
    projected_0,
    projected_1,
    projected_2,
    position.xy
  );
  let position_ws = interpolate_attribute_3f32(
    world_0.xyz / world_0.w,
    world_1.xyz / world_1.w,
    world_2.xyz / world_2.w,
    bary.lambda
  );
  var uv = barycentric_interpolate_uv(
    bary,
    triangle.uva,
    triangle.uvb,
    triangle.uvc
  );
  let mip_scale = MIP_BIAS / view.upscale_ratio;
  uv.ddx *= mip_scale.x;
  uv.ddy *= mip_scale.y;

  let orm = textureSampleBarycentric(xyz, elements_per_texel_depth, uv);
  let roughness_source = orm.g * material_info.roughness_factor;
  let metalness = orm.b * material_info.metallic_factor;
  let ambient = fma(
    orm.r,
    material_info.ambient_factors.x,
    material_info.ambient_factors.y
  );

  let normal_local = interpolate_attribute_3f32(
    triangle.na,
    triangle.nb,
    triangle.nc,
    bary.lambda
  );
  let tangent_local = interpolate_attribute_3f32(
    triangle.ta.xyz,
    triangle.tb.xyz,
    triangle.tc.xyz,
    bary.lambda
  );
  let vertex_color = interpolate_attribute_3f32(
    triangle.ca,
    triangle.cb,
    triangle.cc,
    bary.lambda
  );
  let camera_position = camera.transform[3].xyz;
  let view_direction = normalize(camera_position - position_ws);
  let normal_matrix = compute_normal_matrix_from_m4(global);
  var shading_normal = normalize(normal_matrix * normal_local);
  var tangent = normalize(normal_matrix * tangent_local);
  var geometric_normal = normalize(normal_matrix * face_normal_local);
  if (dot(geometric_normal, view_direction) < 0.0) {
    shading_normal = -shading_normal;
    tangent = -tangent;
    geometric_normal = -geometric_normal;
  }
  let tangent_frame = build_orthonormal_matrix_nt(
    shading_normal,
    vec4f(tangent, triangle.ta.w)
  );
  let normal_map = textureSampleBarycentric(
    transmitted_energy_factor,
    screen_st,
    uv
  ).rgb * 2.0 - 1.0;
  let mapped_normal = normalize(tangent_frame * normal_map);
  let filtered_roughness = anti_alias_roughness_kaplanyan(
    roughness_source,
    mapped_normal,
    tangent_frame[0],
    tangent_frame[1]
  );
  let roughness = filtered_roughness + dither_color_8bit_triangle_noise(position.xy);
  let albedo_sample = textureSampleBarycentric(normal, lookup, uv);
  let albedo = albedo_sample.rgb / albedo_sample.a;
  let emissive_sample = textureSampleBarycentric(bb_dim, normals, uv);

  output.albedo = vec4f(
    albedo * vertex_color * material_info.albedo_color.rgb,
    ambient
  );
  output.normal = vec4u(
    encode_g_buffer_normal(mapped_normal),
    encode_g_buffer_normal(geometric_normal)
  );
  output.pbr = vec2f(metalness, roughness);
  output.emissive = rgbe9995_encode(
    emissive_sample.rgb * material_info.emissive_factor
  );
  return output;
}
`;

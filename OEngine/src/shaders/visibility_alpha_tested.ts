/**
 * visibility_alpha_tested：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { SCENE_DATABASE_READ_WGSL } from "../gpu/SceneDatabase.js";
import { LPV_CAMERA_TYPE } from "./lpv_indirect_diffuse.js";

export const VISIBILITY_ALPHA_TESTED_WGSL = /* wgsl */ `
${LPV_CAMERA_TYPE.wgsl_declaration}
${SCENE_DATABASE_READ_WGSL}

struct MaterialInfo {
  albedo_color: vec4f,
  emissive_factor: vec3f,
  id: u32,
  ambient_factors: vec2f,
  metallic_factor: f32,
  roughness_factor: f32,
  transmission_factor: f32,
  ior_factor: f32,
  transparency_mode: u32,
  draw_mode: u32,
  draw_side: u32,
}

struct ViewUniform {
  projection_matrix: mat4x4f,
  upscale_ratio: vec2f,
  jitter: vec2f,
  width: u32,
  height: u32,
  frame_index: u32,
}

struct MeshletElement {
  index: u32,
  mesh: u32,
}

struct MeshletHeader {
  bounds_box: array<f32, 6>,
  address: u32,
  primitive_count: u32,
  vertex_count: u32,
  flags: u32,
}

struct AlphaVisibilityVertexOutput {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) m_mesh: u32,
  @location(1) @interpolate(flat) m_triangle: u32,
  @location(2) uv: vec2f,
  @location(3) position_world: vec3f,
}

struct AlphaVisibilityOutput {
  @location(0) m_triangle: u32,
  @location(1) m_mesh: u32,
}

@group(0) @binding(0) var tile_p: texture_2d<f32>;
@group(0) @binding(1) var chunk_texture_aabb: sampler;
@group(0) @binding(2) var<uniform> material: MaterialInfo;

@group(1) @binding(0) var<storage, read> meshlets: array<MeshletElement>;
@group(1) @binding(1) var<storage, read> camera_icon: array<u32>;
@group(1) @binding(2) var<storage, read> history_raw_type: array<f32>;
@group(1) @binding(3) var<storage, read> scene_database: array<u32>;
@group(1) @binding(4) var<storage, read> geometries: array<u32>;

@group(2) @binding(0) var<uniform> camera: CommandEncoder;
@group(2) @binding(1) var<uniform> view: ViewUniform;
@group(2) @binding(2) var sphere_radius: texture_2d<u32>;

fn read_meshlet_header(meshlet_id: u32) -> MeshletHeader {
  let offset = meshlet_id * 10u;
  var header: MeshletHeader;
  header.bounds_box = array<f32, 6>(
    bitcast<f32>(camera_icon[offset]),
    bitcast<f32>(camera_icon[offset + 1u]),
    bitcast<f32>(camera_icon[offset + 2u]),
    bitcast<f32>(camera_icon[offset + 3u]),
    bitcast<f32>(camera_icon[offset + 4u]),
    bitcast<f32>(camera_icon[offset + 5u]),
  );
  header.address = camera_icon[offset + 6u];
  header.primitive_count = camera_icon[offset + 7u];
  header.vertex_count = camera_icon[offset + 8u];
  header.flags = camera_icon[offset + 9u];
  return header;
}

fn read_meshlet_attribute_u32(offset: u32) -> u32 {
  return bitcast<u32>(history_raw_type[offset]);
}

fn read_meshlet_attribute_vec2f(offset: u32) -> vec2f {
  return vec2f(history_raw_type[offset], history_raw_type[offset + 1u]);
}

fn read_meshlet_attribute_vec3f(offset: u32) -> vec3f {
  return vec3f(
    history_raw_type[offset],
    history_raw_type[offset + 1u],
    history_raw_type[offset + 2u],
  );
}

fn meshlet_compute_attribute_section_offset(header: MeshletHeader) -> u32 {
  return header.address + ((header.primitive_count * 3u + 3u) >> 2u);
}

fn read_meshlet_resolved_index(
  header: MeshletHeader,
  draw_index: u32,
) -> u32 {
  let word_offset = draw_index >> 2u;
  let bit_offset = (draw_index & 3u) << 3u;
  let packed = read_meshlet_attribute_u32(header.address + word_offset);
  return (packed >> bit_offset) & 0xffu;
}

fn read_meshlet_vertex_uv_position(
  header: MeshletHeader,
  vertex_id: u32,
) -> array<vec4f, 2> {
  let clamped_vertex_id = min(vertex_id, header.vertex_count - 1u);
  var offset = meshlet_compute_attribute_section_offset(header);

  let position = read_meshlet_attribute_vec3f(
    offset + clamped_vertex_id * 3u,
  );
  offset += header.vertex_count * 3u;

  offset += select(header.vertex_count, 1u, (header.flags & 1u) != 0u);
  offset += select(header.vertex_count, 1u, (header.flags & 2u) != 0u);
  offset += select(header.vertex_count, 1u, (header.flags & 4u) != 0u);

  let uv_local_offset = select(
    clamped_vertex_id,
    0u,
    (header.flags & 8u) != 0u,
  );
  let uv = read_meshlet_attribute_vec2f(offset + uv_local_offset * 2u);
  return array<vec4f, 2>(vec4f(position, 1.0), vec4f(uv, 0.0, 0.0));
}

fn read_meshlet_vertex_by_draw_index(
  header: MeshletHeader,
  draw_index: u32,
) -> array<vec4f, 2> {
  let max_draw_index = header.primitive_count * 3u - 1u;
  let clamped_draw_index = min(draw_index, max_draw_index);
  let vertex_id = read_meshlet_resolved_index(header, clamped_draw_index);
  return read_meshlet_vertex_uv_position(header, vertex_id);
}

fn encode_meshlet_element(meshlet_id: u32, primitive_id: u32) -> u32 {
  return ((meshlet_id & 0x00ffffffu) << 8u) | (primitive_id & 0xffu);
}

fn random_device(value: u32) -> u32 {
  var result = value;
  result ^= result >> 16u;
  result *= 0x21f0aaadu;
  result ^= result >> 15u;
  result *= 0xd35a2d97u;
  result ^= result >> 15u;
  return result;
}

fn read_node_capacity(value: u32) -> f32 {
  return bitcast<f32>(0x3f800000u | (value >> 9u)) - 1.0;
}

fn scene_read_meshlet_geometry(position: vec3f) -> f32 {
  let bits = bitcast<vec3u>(position);
  let hash = random_device(
    bits.x * 0x85ebca6bu +
    bits.y * 0xc2b2ae35u +
    bits.z * 0x27d4eb2du
  );
  return read_node_capacity(hash);
}

fn transparency_hashed_alpha_threshold(
  scale: f32,
  offset: f32,
  position: vec3f,
) -> f32 {
  let derivative_x = dpdx(position);
  let derivative_y = dpdy(position);
  let max_derivative = max(length(derivative_x), length(derivative_y));
  let inverse_pixel_scale = 1.0 / (scale * max_derivative);
  let log_scale = log2(inverse_pixel_scale);
  let lower_scale = exp2(floor(log_scale));
  let scales = vec2f(lower_scale, lower_scale * 2.0);
  let hash_lower = scene_read_meshlet_geometry(floor(scales.x * position));
  let hash_upper = scene_read_meshlet_geometry(floor(scales.y * position));
  let interpolation = fract(log_scale);
  let hash = mix(hash_lower, hash_upper, interpolation);
  let distance_to_edge = min(interpolation, 1.0 - interpolation);
  let inverse_edge_area = 1.0 / (
    2.0 * distance_to_edge * (1.0 - distance_to_edge)
  );
  let one_minus_hash = 1.0 - hash;
  let thresholds = vec3f(
    hash * hash * inverse_edge_area,
    (hash - 0.5 * distance_to_edge) / (1.0 - distance_to_edge),
    1.0 - one_minus_hash * one_minus_hash * inverse_edge_area,
  );
  var threshold = select(
    thresholds.z,
    select(thresholds.y, thresholds.x, hash < distance_to_edge),
    hash < 1.0 - distance_to_edge,
  );
  threshold = fract(threshold + offset);
  return clamp(threshold, 1.0e-6, 1.0);
}

fn convert_specular_ao(value: u32) -> vec2f {
  let converted = fma(
    vec2f(f32(value)),
    vec2f(0.245122333753, 0.430159709002),
    vec2f(0.5),
  );
  return fract(converted);
}

fn spatio_temporal_noise_r2_64(
  pixel: vec2u,
  frame_index: u32,
  noise_texture: texture_2d<u32>,
) -> vec2f {
  let texel = pixel & vec2u(63u);
  var value = textureLoad(noise_texture, texel, 0).r;
  value += 288u * (frame_index & 63u);
  return convert_specular_ao(value);
}

@vertex
fn vs_main(
  @builtin(vertex_index) vertex_index: u32,
  @builtin(instance_index) instance_index: u32,
) -> AlphaVisibilityVertexOutput {
  let element = meshlets[instance_index];
  let meshlet_id = element.index;
  let mesh_row = element.mesh;
  let header = read_meshlet_header(meshlet_id);
  let last_draw_index = header.primitive_count * 3u - 1u;
  if vertex_index > last_draw_index {
    return AlphaVisibilityVertexOutput();
  }

  let encoded_triangle = encode_meshlet_element(
    meshlet_id,
    vertex_index / 3u,
  );
  let vertex = read_meshlet_vertex_by_draw_index(header, vertex_index);
  let mesh = scene_read_mesh(&scene_database, mesh_row);
  let node = scene_read_node(&scene_database, mesh.node);
  let world = node.global * vertex[0];

  var output: AlphaVisibilityVertexOutput;
  output.position_world = world.xyz / world.w;
  output.position = camera.view_projection_matrix * world;
  output.m_mesh = mesh_row;
  output.m_triangle = encoded_triangle;
  output.uv = vertex[1].xy;
  return output;
}

@fragment
fn fs_main(input: AlphaVisibilityVertexOutput) -> AlphaVisibilityOutput {
  let mip_bias =
    -log2(max(view.upscale_ratio.x, view.upscale_ratio.y)) - 0.33;
  let alpha_sample = textureSampleBias(
    tile_p,
    chunk_texture_aabb,
    input.uv,
    mip_bias,
  ).a * material.albedo_color.a;
  let pixel = vec2u(input.position.xy);
  let noise = spatio_temporal_noise_r2_64(
    pixel,
    view.frame_index,
    sphere_radius,
  );
  let threshold = transparency_hashed_alpha_threshold(
    1.0,
    noise.x,
    input.position_world,
  );
  if alpha_sample < threshold {
    discard;
  }

  var output: AlphaVisibilityOutput;
  output.m_triangle = input.m_triangle;
  output.m_mesh = input.m_mesh;
  return output;
}
`;

/**
 * shadow_raster：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { SCENE_DATABASE_READ_WGSL } from "../gpu/SceneDatabase.js";
import { StructType } from "../core/WgslStruct.js";
import { WGSL_vec4f } from "../core/WebGPUTypes.js";
import { LPV_CAMERA_TYPE } from "./lpv_indirect_diffuse.js";
import { GPU_VIEW_TYPE } from "../render/ViewContext.js";

export const SHADOW_DEPTH_CLEAR_WGSL = /* wgsl */ `
const positions = array<vec2f, 3>(
  vec2f(-1.0, -1.0),
  vec2f( 3.0, -1.0),
  vec2f(-1.0,  3.0),
);

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4f {
  return vec4f(positions[vertex_index], 0.0, 1.0);
}

@fragment
fn fs_main() -> @builtin(frag_depth) f32 {
  return 0.0;
}
`;

export const SHADOW_OPAQUE_RASTER_WGSL = /* wgsl */ `
${SCENE_DATABASE_READ_WGSL}
${LPV_CAMERA_TYPE.wgsl_declaration}

@group(0) @binding(0) var<uniform> camera: ${LPV_CAMERA_TYPE.wgsl_ref};
@group(0) @binding(1) var<storage, read> meshlet_headers: array<u32>;
@group(0) @binding(2) var<storage, read> meshlet_data: array<u32>;
// Dg/Cg: count at word 0, 16-byte header, then {index, mesh} pairs.
@group(0) @binding(3) var<storage, read> meshlets: array<u32>;
@group(0) @binding(4) var<storage, read> scene_database: array<u32>;

fn meshlet_header_address(meshlet_id: u32) -> u32 {
  return meshlet_headers[meshlet_id * 10u + 6u];
}

fn meshlet_header_primitive_count(meshlet_id: u32) -> u32 {
  return meshlet_headers[meshlet_id * 10u + 7u];
}

fn meshlet_header_vertex_count(meshlet_id: u32) -> u32 {
  return meshlet_headers[meshlet_id * 10u + 8u];
}

fn read_meshlet_resolved_index(address: u32, corner: u32) -> u32 {
  let word = address + (corner >> 2u);
  let shift = (corner & 3u) * 8u;
  return (meshlet_data[word] >> shift) & 0xffu;
}

fn meshlet_attribute_section_offset(address: u32, primitive_count: u32) -> u32 {
  return address + ((primitive_count * 3u + 3u) >> 2u);
}

fn read_meshlet_vertex_position(meshlet_id: u32, vertex_id: u32) -> vec3f {
  let address = meshlet_header_address(meshlet_id);
  let primitive_count = meshlet_header_primitive_count(meshlet_id);
  let base = meshlet_attribute_section_offset(address, primitive_count)
    + vertex_id * 3u;
  return vec3f(
    bitcast<f32>(meshlet_data[base]),
    bitcast<f32>(meshlet_data[base + 1u]),
    bitcast<f32>(meshlet_data[base + 2u]),
  );
}

@vertex
fn vs_main(
  @builtin(vertex_index) vertex_index: u32,
  @builtin(instance_index) instance_index: u32,
) -> @builtin(position) vec4f {
  let element_offset = 4u + instance_index * 2u;
  let meshlet_id = meshlets[element_offset];
  let mesh_row = meshlets[element_offset + 1u];
  let primitive_count = meshlet_header_primitive_count(meshlet_id);
  let last_draw_index = primitive_count * 3u - 1u;
  if (vertex_index > last_draw_index) {
    return vec4f(0.0);
  }

  let local_vertex = read_meshlet_resolved_index(
    meshlet_header_address(meshlet_id),
    vertex_index,
  );
  let position = read_meshlet_vertex_position(meshlet_id, local_vertex);
  let mesh = scene_read_mesh(&scene_database, mesh_row);
  let node = scene_read_node(&scene_database, mesh.node);
  return camera.view_projection_matrix * node.global * vec4f(position, 1.0);
}
`;

export const SHADOW_ALPHA_RASTER_WGSL = /* wgsl */ `
${SCENE_DATABASE_READ_WGSL}
${LPV_CAMERA_TYPE.wgsl_declaration}
${GPU_VIEW_TYPE.wgsl_declaration}

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

struct MeshletElement {
  index: u32,
  mesh: u32,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) position_world: vec3f,
}

@group(0) @binding(0) var tile_p: texture_2d<f32>;
@group(0) @binding(1) var chunk_texture_aabb: sampler;
@group(0) @binding(2) var<uniform> material: MaterialInfo;

@group(1) @binding(0) var<storage, read> meshlets: array<MeshletElement>;
@group(1) @binding(1) var<storage, read> meshlet_headers: array<u32>;
@group(1) @binding(2) var<storage, read> meshlet_data: array<u32>;
@group(1) @binding(3) var<storage, read> scene_database: array<u32>;
@group(1) @binding(4) var<storage, read> geometries: array<u32>;

@group(2) @binding(0) var<uniform> camera: ${LPV_CAMERA_TYPE.wgsl_ref};
@group(2) @binding(1) var<uniform> view: ${GPU_VIEW_TYPE.wgsl_ref};
@group(2) @binding(2) var sphere_radius: texture_2d<u32>;

fn meshlet_header_address(meshlet_id: u32) -> u32 {
  return meshlet_headers[meshlet_id * 10u + 6u];
}

fn meshlet_header_flags(meshlet_id: u32) -> u32 {
  return meshlet_headers[meshlet_id * 10u + 9u];
}

fn meshlet_header_vertex_count(meshlet_id: u32) -> u32 {
  return meshlet_headers[meshlet_id * 10u + 8u];
}

fn meshlet_header_primitive_count(meshlet_id: u32) -> u32 {
  return meshlet_headers[meshlet_id * 10u + 7u];
}

fn read_meshlet_attribute_u32(offset: u32) -> u32 {
  return meshlet_data[offset];
}

fn read_meshlet_resolved_index(address: u32, draw_index: u32) -> u32 {
  let word_offset = draw_index >> 2u;
  let bit_offset = (draw_index & 3u) << 3u;
  return (read_meshlet_attribute_u32(address + word_offset) >> bit_offset) & 0xffu;
}

fn meshlet_attribute_section_offset(address: u32, primitive_count: u32) -> u32 {
  return address + ((primitive_count * 3u + 3u) >> 2u);
}

fn read_meshlet_vertex_uv_position(
  meshlet_id: u32,
  vertex_id: u32,
) -> array<vec4f, 2> {
  let address = meshlet_header_address(meshlet_id);
  let primitive_count = meshlet_header_primitive_count(meshlet_id);
  let vertex_count = meshlet_header_vertex_count(meshlet_id);
  let flags = meshlet_header_flags(meshlet_id);
  let clamped_vertex = min(vertex_id, vertex_count - 1u);
  var offset = meshlet_attribute_section_offset(address, primitive_count);
  let position = vec3f(
    bitcast<f32>(read_meshlet_attribute_u32(offset + clamped_vertex * 3u)),
    bitcast<f32>(read_meshlet_attribute_u32(offset + clamped_vertex * 3u + 1u)),
    bitcast<f32>(read_meshlet_attribute_u32(offset + clamped_vertex * 3u + 2u)),
  );
  offset += vertex_count * 3u;
  offset += select(vertex_count, 1u, (flags & 1u) != 0u);
  offset += select(vertex_count, 1u, (flags & 2u) != 0u);
  offset += select(vertex_count, 1u, (flags & 4u) != 0u);
  let uv_local = select(clamped_vertex, 0u, (flags & 8u) != 0u);
  let uv = vec2f(
    bitcast<f32>(read_meshlet_attribute_u32(offset + uv_local * 2u)),
    bitcast<f32>(read_meshlet_attribute_u32(offset + uv_local * 2u + 1u)),
  );
  return array<vec4f, 2>(vec4f(position, 1.0), vec4f(uv, 0.0, 0.0));
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

@vertex
fn vs_main(
  @builtin(vertex_index) vertex_index: u32,
  @builtin(instance_index) instance_index: u32,
) -> VertexOutput {
  let element = meshlets[instance_index];
  let meshlet_id = element.index;
  let primitive_count = meshlet_header_primitive_count(meshlet_id);
  let last_draw_index = primitive_count * 3u - 1u;
  var output: VertexOutput;
  if vertex_index > last_draw_index {
    return output;
  }
  let resolved_index = read_meshlet_resolved_index(
    meshlet_header_address(meshlet_id),
    vertex_index,
  );
  let vertex = read_meshlet_vertex_uv_position(meshlet_id, resolved_index);
  let mesh = scene_read_mesh(&scene_database, element.mesh);
  let node = scene_read_node(&scene_database, mesh.node);
  let world = node.global * vertex[0];
  output.position_world = world.xyz / world.w;
  output.position = camera.view_projection_matrix * world;
  output.uv = vertex[1].xy;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) {
  let mip_bias = -log2(max(view.upscale_ratio.x, view.upscale_ratio.y));
  let alpha = textureSampleBias(
    tile_p,
    chunk_texture_aabb,
    input.uv,
    mip_bias,
  ).a * material.albedo_color.a;
  let threshold = transparency_hashed_alpha_threshold(
    1.0,
    0.0,
    input.position_world,
  );
  if alpha < threshold {
    discard;
  }
}
`;

export const POINT_SHADOW_RESOLVE_SETTINGS_TYPE = StructType.from(
  {
    atlas_offset: WGSL_vec4f,
    light_params: WGSL_vec4f
  },
  "UsdUnsupportedError"
);
export const POINT_SHADOW_RESOLVE_SETTINGS_BYTES =
  POINT_SHADOW_RESOLVE_SETTINGS_TYPE.aligned_size;

export const POINT_SHADOW_OCTAHEDRAL_RESOLVE_WGSL = /* wgsl */ `
${POINT_SHADOW_RESOLVE_SETTINGS_TYPE.wgsl_declaration}

struct CubeFaceSample {
  face: u32,
  face_uv: vec2f,
  major_direction: f32,
}

@group(0) @binding(0) var<uniform> settings: ${POINT_SHADOW_RESOLVE_SETTINGS_TYPE.wgsl_ref};
@group(0) @binding(1) var cube_depth: texture_2d<f32>;

fn uv_octahedral_unit_decode(encoded: vec2f) -> vec3f {
  var xy = fma(encoded, vec2f(2.0), vec2f(-1.0));
  var direction = vec3f(xy, 1.0 - abs(xy.x) - abs(xy.y));
  let fold = max(-direction.z, 0.0);
  direction.x += select(fold, -fold, direction.x > 0.0);
  direction.y += select(fold, -fold, direction.y > 0.0);
  return normalize(direction);
}

fn texture_octahedral_wrap_texel_coordinates(
  coordinate: vec2i,
  resolution: i32,
) -> vec2u {
  let wrapped = ((coordinate % resolution) + resolution) % resolution;
  let wrap_x = abs(coordinate.x / resolution) + i32(coordinate.x < 0);
  let wrap_y = abs(coordinate.y / resolution) + i32(coordinate.y < 0);
  let flip = ((wrap_x ^ wrap_y) & 1) != 0;
  return select(
    vec2u(wrapped),
    vec2u(resolution - (wrapped + vec2i(1))),
    flip,
  );
}

fn cube_face_sample_direction(direction: vec3f) -> CubeFaceSample {
  let absolute_direction = abs(direction);
  let major_direction = max(
    absolute_direction.x,
    max(absolute_direction.y, absolute_direction.z),
  );

  var face = 0u;
  var face_x = 0.0;
  var face_y = 0.0;
  if absolute_direction.x == major_direction {
    if direction.x >= 0.0 {
      face = 0u;
      face_x = direction.z / major_direction;
      face_y = direction.y / major_direction;
    } else {
      face = 1u;
      face_x = -direction.z / major_direction;
      face_y = direction.y / major_direction;
    }
  } else if absolute_direction.y == major_direction {
    if direction.y >= 0.0 {
      face = 2u;
      face_x = direction.x / major_direction;
      face_y = direction.z / major_direction;
    } else {
      face = 3u;
      face_x = direction.x / major_direction;
      face_y = -direction.z / major_direction;
    }
  } else if direction.z >= 0.0 {
    face = 4u;
    face_x = -direction.x / major_direction;
    face_y = direction.y / major_direction;
  } else {
    face = 5u;
    face_x = direction.x / major_direction;
    face_y = direction.y / major_direction;
  }

  var result: CubeFaceSample;
  result.face = face;
  result.face_uv = vec2f(
    (face_x + 1.0) * 0.5,
    (1.0 - face_y) * 0.5,
  );
  result.major_direction = major_direction;
  return result;
}

const fullscreen_positions = array<vec2f, 3>(
  vec2f(-1.0, -1.0),
  vec2f( 3.0, -1.0),
  vec2f(-1.0,  3.0),
);

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4f {
  return vec4f(fullscreen_positions[vertex_index], 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @builtin(frag_depth) f32 {
  let atlas_origin = settings.atlas_offset.xy;
  let octahedral_resolution = settings.atlas_offset.zw;
  let light_distance = settings.light_params.x;
  let cube_near = settings.light_params.y;

  let atlas_relative = position.xy - atlas_origin;
  let atlas_texel = vec2i(floor(atlas_relative));
  let wrapped_texel = vec2i(texture_octahedral_wrap_texel_coordinates(
    atlas_texel,
    i32(octahedral_resolution.x),
  ));
  let octahedral_uv = (vec2f(wrapped_texel) + 0.5) / octahedral_resolution;
  let direction = uv_octahedral_unit_decode(octahedral_uv);
  let cube_sample = cube_face_sample_direction(direction);

  let face_x = cube_sample.face % 3u;
  let face_y = cube_sample.face / 3u;
  let face_resolution = textureDimensions(cube_depth).x / 3u;
  let face_texel = min(
    vec2u(cube_sample.face_uv * f32(face_resolution)),
    vec2u(face_resolution - 1u),
  );
  let cube_texel = vec2u(
    face_x * face_resolution + face_texel.x,
    face_y * face_resolution + face_texel.y,
  );
  let cube_device_depth = textureLoad(cube_depth, cube_texel, 0).r;
  if cube_device_depth <= 0.0 {
    return 0.0;
  }

  let perspective_distance = cube_near / cube_device_depth;
  let radial_distance = perspective_distance / max(cube_sample.major_direction, 1e-6);
  return 1.0 - clamp(radial_distance / max(light_distance, 1e-6), 0.0, 1.0);
}
`;

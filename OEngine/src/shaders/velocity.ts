/**
 * velocity：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { SCENE_DATABASE_READ_WGSL } from "../gpu/SceneDatabase.js";

export const VELOCITY_FORMAT = "rg16float" as const;
export const VELOCITY_VIZ_INVALID = 1 << 24;
export const VELOCITY_PREVIOUS_POSITION_INVALID = 0xffffffff;

export const VELOCITY_WGSL = /* wgsl */ `
${SCENE_DATABASE_READ_WGSL}

struct SkinningActive {
  value: u32,
};

@group(0) @binding(0) var gr_bucket: texture_2d<f32>;
@group(0) @binding(1) var scene_point: texture_2d<u32>;
@group(0) @binding(2) var render_resolution_f: texture_2d<u32>;
@group(0) @binding(3) var<uniform> mReprojectionRotation: mat4x4f;
@group(0) @binding(4) var<uniform> mInvViewProjCurrent: mat4x4f;
@group(0) @binding(5) var<uniform> mViewProjPrevious: mat4x4f;
@group(0) @binding(6) var<uniform> skinning_active: SkinningActive;
@group(0) @binding(7) var<storage, read> scene_database: array<u32>;
@group(0) @binding(8) var<storage, read> camera_icon: array<u32>;
@group(0) @binding(9) var<storage, read> history_raw_type: array<u32>;
@group(0) @binding(10) var<storage, read> strip_destination_resolution_folder: array<u32>;
@group(0) @binding(11) var<storage, read> b_bytes_to_point: array<u32>;

const VIZ_INVALID: u32 = ${VELOCITY_VIZ_INVALID}u;
const PREV_POS_OFFSET_INVALID: u32 = 0xffffffffu;
const MESHLET_HEADER_WORDS: u32 = 10u;

struct VelocityMeshletHeader {
  bounds_box: array<f32, 6>,
  address: u32,
  primitive_count: u32,
  vertex_count: u32,
  flags: u32,
};

fn read_meshlet_header(index: u32) -> VelocityMeshletHeader {
  let base = index * MESHLET_HEADER_WORDS;
  var header: VelocityMeshletHeader;
  for (var i = 0u; i < 6u; i++) {
    header.bounds_box[i] = bitcast<f32>(camera_icon[base + i]);
  }
  header.address = camera_icon[base + 6u];
  header.primitive_count = camera_icon[base + 7u];
  header.vertex_count = camera_icon[base + 8u];
  header.flags = camera_icon[base + 9u];
  return header;
}

fn meshlet_compute_attribute_section_offset(header: VelocityMeshletHeader) -> u32 {
  return header.address + ((header.primitive_count * 3u + 3u) >> 2u);
}

fn read_meshlet_attribute_u32(address: u32) -> u32 {
  return history_raw_type[address];
}

fn read_meshlet_resolved_index(header: VelocityMeshletHeader, corner: u32) -> u32 {
  let word_offset = corner >> 2u;
  let bit_offset = (corner & 0x03u) << 3u;
  return (read_meshlet_attribute_u32(header.address + word_offset) >> bit_offset) & 0xffu;
}

fn read_meshlet_vertex_position(header: VelocityMeshletHeader, vertex: u32) -> vec3f {
  let base = meshlet_compute_attribute_section_offset(header) + vertex * 3u;
  return vec3f(
    bitcast<f32>(history_raw_type[base]),
    bitcast<f32>(history_raw_type[base + 1u]),
    bitcast<f32>(history_raw_type[base + 2u])
  );
}

fn read_prev_position(offset: u32, vertex: u32) -> vec3f {
  let base = offset + vertex * 3u;
  return vec3f(
    bitcast<f32>(b_bytes_to_point[base]),
    bitcast<f32>(b_bytes_to_point[base + 1u]),
    bitcast<f32>(b_bytes_to_point[base + 2u])
  );
}

fn v3_matrix4_project(value: vec3f, matrix: mat4x4f) -> vec3f {
  let projected = matrix * vec4f(value, 1.0);
  return projected.xyz / projected.w;
}

fn mat4_inverse(m: mat4x4f) -> mat4x4f {
  let a00 = m[0][0]; let a01 = m[0][1]; let a02 = m[0][2]; let a03 = m[0][3];
  let a10 = m[1][0]; let a11 = m[1][1]; let a12 = m[1][2]; let a13 = m[1][3];
  let a20 = m[2][0]; let a21 = m[2][1]; let a22 = m[2][2]; let a23 = m[2][3];
  let a30 = m[3][0]; let a31 = m[3][1]; let a32 = m[3][2]; let a33 = m[3][3];

  let b00 = a00 * a11 - a01 * a10;
  let b01 = a00 * a12 - a02 * a10;
  let b02 = a00 * a13 - a03 * a10;
  let b03 = a01 * a12 - a02 * a11;
  let b04 = a01 * a13 - a03 * a11;
  let b05 = a02 * a13 - a03 * a12;
  let b06 = a20 * a31 - a21 * a30;
  let b07 = a20 * a32 - a22 * a30;
  let b08 = a20 * a33 - a23 * a30;
  let b09 = a21 * a32 - a22 * a31;
  let b10 = a21 * a33 - a23 * a31;
  let b11 = a22 * a33 - a23 * a32;
  let inverse_det = 1.0 / (
    b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
  );

  return mat4x4f(
    vec4f(a11 * b11 - a12 * b10 + a13 * b09, a02 * b10 - a01 * b11 - a03 * b09, a31 * b05 - a32 * b04 + a33 * b03, a22 * b04 - a21 * b05 - a23 * b03) * inverse_det,
    vec4f(a12 * b08 - a10 * b11 - a13 * b07, a00 * b11 - a02 * b08 + a03 * b07, a32 * b02 - a30 * b05 - a33 * b01, a20 * b05 - a22 * b02 + a23 * b01) * inverse_det,
    vec4f(a10 * b10 - a11 * b08 + a13 * b06, a01 * b08 - a00 * b10 - a03 * b06, a30 * b04 - a31 * b02 + a33 * b00, a21 * b02 - a20 * b04 - a23 * b00) * inverse_det,
    vec4f(a11 * b07 - a10 * b09 - a12 * b06, a00 * b09 - a01 * b07 + a02 * b06, a31 * b01 - a30 * b03 - a32 * b00, a20 * b03 - a21 * b01 + a22 * b00) * inverse_det
  );
}

const FULLSCREEN_POSITIONS = array<vec2f, 3>(
  vec2f(-1.0, -1.0),
  vec2f(3.0, -1.0),
  vec2f(-1.0, 3.0)
);

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4f {
  return vec4f(FULLSCREEN_POSITIONS[vertex_index], 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec2f {
  let current_pixel = position.xy;
  let pixel = vec2u(position.xy);
  let device_depth = textureLoad(gr_bucket, pixel, 0).r;
  let mesh_id = textureLoad(scene_point, pixel, 0).r;

  if (mesh_id == VIZ_INVALID) {
    let previous = v3_matrix4_project(
      vec3f(current_pixel, device_depth),
      mReprojectionRotation
    );
    return current_pixel - previous.xy;
  }

  let resolution = vec2f(textureDimensions(gr_bucket));
  let current_ndc = vec3f(
    current_pixel.x / resolution.x * 2.0 - 1.0,
    1.0 - current_pixel.y / resolution.y * 2.0,
    device_depth
  );
  let current_world_h = mInvViewProjCurrent * vec4f(current_ndc, 1.0);
  let current_world = current_world_h.xyz / current_world_h.w;
  let mesh = scene_read_mesh(&scene_database, mesh_id);
  let node = scene_read_node(&scene_database, mesh.node);
  let encoded_triangle = textureLoad(render_resolution_f, pixel, 0).r;
  let meshlet_id = (encoded_triangle >> 8u) & 0x00ffffffu;
  let triangle_id = encoded_triangle & 0xffu;

  var previous_position_offset = PREV_POS_OFFSET_INVALID;
  if (skinning_active.value != 0u) {
    previous_position_offset = strip_destination_resolution_folder[meshlet_id];
  }

  var previous_world: vec3f;
  if (previous_position_offset == PREV_POS_OFFSET_INVALID) {
    let current_inverse = mat4_inverse(node.global);
    let previous_from_current = node.prev_global * current_inverse;
    let transformed = previous_from_current * vec4f(current_world, 1.0);
    previous_world = transformed.xyz / transformed.w;
  } else {
    let header = read_meshlet_header(meshlet_id);
    let triangle_corner = triangle_id * 3u;
    let index_a = read_meshlet_resolved_index(header, triangle_corner);
    let index_b = read_meshlet_resolved_index(header, triangle_corner + 1u);
    let index_c = read_meshlet_resolved_index(header, triangle_corner + 2u);
    let local_a = read_meshlet_vertex_position(header, index_a);
    let local_b = read_meshlet_vertex_position(header, index_b);
    let local_c = read_meshlet_vertex_position(header, index_c);
    let world_a = (node.global * vec4f(local_a, 1.0)).xyz;
    let world_b = (node.global * vec4f(local_b, 1.0)).xyz;
    let world_c = (node.global * vec4f(local_c, 1.0)).xyz;
    let edge_ab = world_b - world_a;
    let edge_ac = world_c - world_a;
    let point_delta = current_world - world_a;
    let d00 = dot(edge_ab, edge_ab);
    let d01 = dot(edge_ab, edge_ac);
    let d11 = dot(edge_ac, edge_ac);
    let d20 = dot(point_delta, edge_ab);
    let d21 = dot(point_delta, edge_ac);
    let denominator = d00 * d11 - d01 * d01;
    let weight_b = (d11 * d20 - d01 * d21) / denominator;
    let weight_c = (d00 * d21 - d01 * d20) / denominator;
    let weight_a = 1.0 - weight_b - weight_c;
    let previous_local =
      read_prev_position(previous_position_offset, index_a) * weight_a +
      read_prev_position(previous_position_offset, index_b) * weight_b +
      read_prev_position(previous_position_offset, index_c) * weight_c;
    let transformed = node.prev_global * vec4f(previous_local, 1.0);
    previous_world = transformed.xyz / transformed.w;
  }

  let previous_clip = mViewProjPrevious * vec4f(previous_world, 1.0);
  let previous_ndc = previous_clip.xyz / previous_clip.w;
  let previous_pixel = vec2f(
    (previous_ndc.x + 1.0) * 0.5 * resolution.x,
    (1.0 - previous_ndc.y) * 0.5 * resolution.y
  );
  return current_pixel - previous_pixel;
}
`;

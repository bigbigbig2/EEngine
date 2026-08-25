/**
 * GPUSkinningShaders：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import {
  SCENE_DATABASE_READ_WGSL,
  SCENE_DATABASE_READ_WRITE_WGSL
} from "./SceneDatabase.js";

const SKINNING_BINDING_WGSL = /* wgsl */ `
struct SkinningBinding {
  skin_matrix_offset: u32,
  source_meshlet_metadata_offset: u32,
  clone_meshlet_metadata_offset: u32,
  meshlet_count: u32,
  clone_geometry_index: u32,
  mesh_instance_index: u32,
};
`;

const MESHLET_HEADER_WGSL = /* wgsl */ `
struct SkinningMeshletHeader {
  bounds_box: array<f32, 6>,
  address: u32,
  primitive_count: u32,
  vertex_count: u32,
  flags: u32,
};

fn meshlet_compute_attribute_section_offset(header: SkinningMeshletHeader) -> u32 {
  let index_word_count = (header.primitive_count * 3u + 3u) >> 2u;
  return header.address + index_word_count;
}
`;

const GEOMETRY_METADATA_WGSL = /* wgsl */ `
struct SkinningGeometryMetadata {
  bounding_sphere: vec4<f32>,
  bounding_box: array<f32, 6>,
  index_count: u32,
  meshlets_address: u32,
  meshlet_count: u32,
  padding: array<u32, 3>,
};
`;

const OCTAHEDRAL_WGSL = /* wgsl */ `
fn skinning_sign2(v: vec2<f32>) -> vec2<f32> {
  return select(vec2<f32>(-1.0), vec2<f32>(1.0), v >= vec2<f32>(0.0));
}

fn uv_octahedral_unit_encode(n: vec3<f32>) -> vec2<f32> {
  let denominator = abs(n.x) + abs(n.y) + abs(n.z);
  var p = n.xy / denominator;
  if n.z < 0.0 {
    p = (1.0 - abs(p.yx)) * skinning_sign2(p);
  }
  return p * 0.5 + 0.5;
}

fn uv_octahedral_unit_decode(encoded: vec2<f32>) -> vec3<f32> {
  var p = encoded * 2.0 - 1.0;
  var n = vec3<f32>(p, 1.0 - abs(p.x) - abs(p.y));
  let t = max(-n.z, 0.0);
  n.x = n.x + select(t, -t, n.x > 0.0);
  n.y = n.y + select(t, -t, n.y > 0.0);
  return normalize(n);
}

fn decode_vertex_normal(packed: u32) -> vec3<f32> {
  let bits = (vec2<u32>(packed) >> vec2<u32>(0u, 16u)) & vec2<u32>(0xFFFFu);
  return uv_octahedral_unit_decode(vec2<f32>(bits) / vec2<f32>(65535.0));
}

fn encode_vertex_normal(value: vec3<f32>) -> u32 {
  let oct = uv_octahedral_unit_encode(value);
  let bits = vec2<u32>(oct * 65535.0) & vec2<u32>(0xFFFFu);
  return bits.x | (bits.y << 16u);
}

fn decode_vertex_tangent(packed: u32) -> vec4<f32> {
  let handedness = f32(packed & 1u) * 2.0 - 1.0;
  let bits = (vec2<u32>(packed) >> vec2<u32>(1u, 16u)) & vec2<u32>(0x7FFFu, 0xFFFFu);
  let oct = vec2<f32>(bits) / vec2<f32>(32767.0, 65535.0);
  return vec4<f32>(uv_octahedral_unit_decode(oct), handedness);
}

fn encode_vertex_tangent(value: vec4<f32>) -> u32 {
  let handedness = u32(value.w >= 0.0);
  let oct = uv_octahedral_unit_encode(value.xyz);
  let x = u32(oct.x * 32767.0) & 0x7FFFu;
  let y = u32(oct.y * 65535.0) & 0xFFFFu;
  return handedness | (x << 1u) | (y << 16u);
}
`;

const MAT4_INVERSE_WGSL = /* wgsl */ `
fn mat4_inverse(m: mat4x4<f32>) -> mat4x4<f32> {
  let m00 = m[0][0]; let m01 = m[0][1]; let m02 = m[0][2]; let m03 = m[0][3];
  let m10 = m[1][0]; let m11 = m[1][1]; let m12 = m[1][2]; let m13 = m[1][3];
  let m20 = m[2][0]; let m21 = m[2][1]; let m22 = m[2][2]; let m23 = m[2][3];
  let m30 = m[3][0]; let m31 = m[3][1]; let m32 = m[3][2]; let m33 = m[3][3];

  let b00 = m00 * m11 - m01 * m10;
  let b01 = m00 * m12 - m02 * m10;
  let b02 = m00 * m13 - m03 * m10;
  let b03 = m01 * m12 - m02 * m11;
  let b04 = m01 * m13 - m03 * m11;
  let b05 = m02 * m13 - m03 * m12;
  let b06 = m20 * m31 - m21 * m30;
  let b07 = m20 * m32 - m22 * m30;
  let b08 = m20 * m33 - m23 * m30;
  let b09 = m21 * m32 - m22 * m31;
  let b10 = m21 * m33 - m23 * m31;
  let b11 = m22 * m33 - m23 * m32;

  let determinant = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  let inv_det = 1.0 / determinant;

  return mat4x4<f32>(
    m11 * b11 - m12 * b10 + m13 * b09,
    m02 * b10 - m01 * b11 - m03 * b09,
    m31 * b05 - m32 * b04 + m33 * b03,
    m22 * b04 - m21 * b05 - m23 * b03,
    m12 * b08 - m10 * b11 - m13 * b07,
    m00 * b11 - m02 * b08 + m03 * b07,
    m32 * b02 - m30 * b05 - m33 * b01,
    m20 * b05 - m22 * b02 + m23 * b01,
    m10 * b10 - m11 * b08 + m13 * b06,
    m01 * b08 - m00 * b10 - m03 * b06,
    m30 * b04 - m31 * b02 + m33 * b00,
    m21 * b02 - m20 * b04 - m23 * b00,
    m11 * b07 - m10 * b09 - m12 * b06,
    m00 * b09 - m01 * b07 + m02 * b06,
    m31 * b01 - m30 * b03 - m32 * b00,
    m20 * b03 - m21 * b01 + m22 * b00,
  ) * inv_det;
}
`;

const DUAL_QUATERNION_WGSL = /* wgsl */ `
fn receive_instance_bounds(value: f32) -> f32 {
  return select(1.0, -1.0, value < 0.0);
}

fn dual_quat_normalize(value: mat2x4<f32>) -> mat2x4<f32> {
  var result = value;
  let magnitude = length(value[0]);
  result[0] = value[0] / magnitude;
  result[1] = value[1] / magnitude;
  return result;
}

fn dual_quat_blend4(
  a: mat2x4<f32>, b: mat2x4<f32>, c: mat2x4<f32>, d: mat2x4<f32>,
  wa: f32, wb: f32, wc: f32, wd: f32,
) -> mat2x4<f32> {
  let signed_b = wb * receive_instance_bounds(dot(a[0], b[0]));
  let signed_c = wc * receive_instance_bounds(dot(a[0], c[0]));
  let signed_d = wd * receive_instance_bounds(dot(a[0], d[0]));
  return dual_quat_normalize(a * wa + b * signed_b + c * signed_c + d * signed_d);
}

fn quat_multiply(a: vec4<f32>, b: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(
    fma(b.xyz, vec3<f32>(a.w), fma(a.xyz, vec3<f32>(b.w), cross(a.xyz, b.xyz))),
    fma(a.w, b.w, -dot(a.xyz, b.xyz)),
  );
}

fn dual_quat_from_m4(m: mat4x4<f32>) -> mat2x4<f32> {
  var result: mat2x4<f32>;
  result[0].w = sqrt(max(0.0, 1.0 + m[0][0] + m[1][1] + m[2][2])) * 0.5;
  result[0].x = sqrt(max(0.0, 1.0 + m[0][0] - m[1][1] - m[2][2])) * 0.5;
  result[0].y = sqrt(max(0.0, 1.0 - m[0][0] + m[1][1] - m[2][2])) * 0.5;
  result[0].z = sqrt(max(0.0, 1.0 - m[0][0] - m[1][1] + m[2][2])) * 0.5;
  result[0].x = result[0].x * receive_instance_bounds(m[1][2] - m[2][1]);
  result[0].y = result[0].y * receive_instance_bounds(m[2][0] - m[0][2]);
  result[0].z = result[0].z * receive_instance_bounds(m[0][1] - m[1][0]);
  result[0] = normalize(result[0]);
  result[1] = vec4<f32>(m[3][0], m[3][1], m[3][2], 0.0);
  result[1] = quat_multiply(result[1], result[0]) * 0.5;
  return result;
}

fn quat_rotate(q: vec4<f32>, value: vec3<f32>) -> vec3<f32> {
  let t = 2.0 * cross(q.xyz, value);
  return value + q.w * t + cross(q.xyz, t);
}

fn dual_quat_transform_direction(q: mat2x4<f32>, value: vec3<f32>) -> vec3<f32> {
  return quat_rotate(q[0], value);
}

fn dual_quat_transform_point(q: mat2x4<f32>, value: vec3<f32>) -> vec3<f32> {
  let real = q[0];
  let dual = q[1];
  let translation = 2.0 * (dual.xyz * real.w - real.xyz * dual.w + cross(real.xyz, dual.xyz));
  return quat_rotate(real, value) + translation;
}
`;

export const SKINNING_VERTEX_WGSL = /* wgsl */ `
${SCENE_DATABASE_READ_WGSL}
${SKINNING_BINDING_WGSL}
${MESHLET_HEADER_WGSL}
${OCTAHEDRAL_WGSL}
${MAT4_INVERSE_WGSL}
${DUAL_QUATERNION_WGSL}

@group(0) @binding(0) var<uniform> dispatch_offset: u32;
@group(0) @binding(1) var<storage, read_write> meshlet_data: array<u32>;
@group(0) @binding(2) var<storage, read> meshlet_headers: array<SkinningMeshletHeader>;
@group(0) @binding(3) var<storage, read> skin_matrices: array<mat4x4<f32>>;
@group(0) @binding(4) var<storage, read> previous_skin_matrices: array<mat4x4<f32>>;
@group(0) @binding(5) var<storage, read> skinning_bindings: array<SkinningBinding>;
@group(0) @binding(6) var<storage, read> binding_meshlet_pairs: array<u32>;
@group(0) @binding(7) var<storage, read> previous_position_offsets: array<u32>;
@group(0) @binding(8) var<storage, read_write> previous_positions: array<u32>;
@group(0) @binding(9) var<storage, read> scene_database: array<u32>;

@compute @workgroup_size(64, 1, 1)
fn main(
  @builtin(workgroup_id) workgroup_id: vec3<u32>,
  @builtin(local_invocation_index) lane: u32,
) {
  let pair_index = workgroup_id.x + dispatch_offset;
  let pair_word = pair_index * 2u;
  let binding_index = binding_meshlet_pairs[pair_word];
  let meshlet_index = binding_meshlet_pairs[pair_word + 1u];
  let binding = skinning_bindings[binding_index];

  let mesh = scene_read_mesh(&scene_database, binding.mesh_instance_index);
  let node = scene_read_node(&scene_database, mesh.node);
  let inverse_global = mat4_inverse(node.global);
  let normal_matrix = transpose(mat3x3<f32>(
    node.global[0].xyz,
    node.global[1].xyz,
    node.global[2].xyz,
  ));

  let source_header = meshlet_headers[binding.source_meshlet_metadata_offset + meshlet_index];
  let clone_header = meshlet_headers[binding.clone_meshlet_metadata_offset + meshlet_index];
  let vertex_count = source_header.vertex_count;
  let source_attributes = meshlet_compute_attribute_section_offset(source_header);
  let clone_attributes = meshlet_compute_attribute_section_offset(clone_header);

  let position_offset = 0u;
  var section_offset = vertex_count * 3u;
  let normal_offset = section_offset;
  let normal_compressed = (source_header.flags & 1u) != 0u;
  section_offset = section_offset + select(vertex_count, 1u, normal_compressed);
  let tangent_offset = section_offset;
  let tangent_compressed = (source_header.flags & 2u) != 0u;
  section_offset = section_offset + select(vertex_count, 1u, tangent_compressed);
  let color_compressed = (source_header.flags & 4u) != 0u;
  section_offset = section_offset + select(vertex_count, 1u, color_compressed);
  let uv_compressed = (source_header.flags & 8u) != 0u;
  section_offset = section_offset + select(vertex_count * 2u, 2u, uv_compressed);
  let uv1_compressed = (source_header.flags & 16u) != 0u;
  section_offset = section_offset + select(vertex_count, 1u, uv1_compressed);
  let joint_offset = section_offset;
  let joints_compressed = (source_header.flags & 32u) != 0u;
  section_offset = section_offset + select(vertex_count * 2u, 2u, joints_compressed);
  let weight_offset = section_offset;
  let weights_compressed = (source_header.flags & 64u) != 0u;

  let matrix_offset = binding.skin_matrix_offset;
  let clone_global_meshlet = binding.clone_meshlet_metadata_offset + meshlet_index;
  let previous_offset = previous_position_offsets[clone_global_meshlet];
  let has_previous_output = previous_offset != 0xFFFFFFFFu;

  var vertex_index = lane;
  loop {
    if vertex_index >= vertex_count { break; }

    let joint_local = select(vertex_index * 2u, 0u, joints_compressed);
    let joint_word = source_attributes + joint_offset + joint_local;
    let joints01 = meshlet_data[joint_word];
    let joints23 = meshlet_data[joint_word + 1u];
    let joint0 = joints01 & 0xFFFFu;
    let joint1 = (joints01 >> 16u) & 0xFFFFu;
    let joint2 = joints23 & 0xFFFFu;
    let joint3 = (joints23 >> 16u) & 0xFFFFu;

    let weight_local = select(vertex_index, 0u, weights_compressed);
    let weights = unpack4x8unorm(meshlet_data[source_attributes + weight_offset + weight_local]);

    let dq0 = dual_quat_from_m4(skin_matrices[matrix_offset + joint0]);
    let dq1 = dual_quat_from_m4(skin_matrices[matrix_offset + joint1]);
    let dq2 = dual_quat_from_m4(skin_matrices[matrix_offset + joint2]);
    let dq3 = dual_quat_from_m4(skin_matrices[matrix_offset + joint3]);
    let skin = dual_quat_blend4(dq0, dq1, dq2, dq3, weights.x, weights.y, weights.z, weights.w);

    let source_position_word = source_attributes + position_offset + vertex_index * 3u;
    let source_position = vec3<f32>(
      bitcast<f32>(meshlet_data[source_position_word]),
      bitcast<f32>(meshlet_data[source_position_word + 1u]),
      bitcast<f32>(meshlet_data[source_position_word + 2u]),
    );
    let skinned_position = dual_quat_transform_point(skin, source_position);
    let local_position = (inverse_global * vec4<f32>(skinned_position, 1.0)).xyz;
    let clone_position_word = clone_attributes + position_offset + vertex_index * 3u;
    meshlet_data[clone_position_word] = bitcast<u32>(local_position.x);
    meshlet_data[clone_position_word + 1u] = bitcast<u32>(local_position.y);
    meshlet_data[clone_position_word + 2u] = bitcast<u32>(local_position.z);

    if has_previous_output {
      let prev0 = dual_quat_from_m4(previous_skin_matrices[matrix_offset + joint0]);
      let prev1 = dual_quat_from_m4(previous_skin_matrices[matrix_offset + joint1]);
      let prev2 = dual_quat_from_m4(previous_skin_matrices[matrix_offset + joint2]);
      let prev3 = dual_quat_from_m4(previous_skin_matrices[matrix_offset + joint3]);
      let previous_skin = dual_quat_blend4(prev0, prev1, prev2, prev3, weights.x, weights.y, weights.z, weights.w);
      let previous_world = dual_quat_transform_point(previous_skin, source_position);
      let previous_local = (inverse_global * vec4<f32>(previous_world, 1.0)).xyz;
      let destination = previous_offset + vertex_index * 3u;
      previous_positions[destination] = bitcast<u32>(previous_local.x);
      previous_positions[destination + 1u] = bitcast<u32>(previous_local.y);
      previous_positions[destination + 2u] = bitcast<u32>(previous_local.z);
    }

    if !normal_compressed {
      let source_normal_word = source_attributes + normal_offset + vertex_index;
      let normal = decode_vertex_normal(meshlet_data[source_normal_word]);
      let skinned_normal = dual_quat_transform_direction(skin, normal);
      let local_normal = normalize(normal_matrix * skinned_normal);
      meshlet_data[clone_attributes + normal_offset + vertex_index] = encode_vertex_normal(local_normal);
    }

    if !tangent_compressed {
      let source_tangent_word = source_attributes + tangent_offset + vertex_index;
      let tangent = decode_vertex_tangent(meshlet_data[source_tangent_word]);
      let skinned_tangent = dual_quat_transform_direction(skin, tangent.xyz);
      let local_tangent = normalize(normal_matrix * skinned_tangent);
      meshlet_data[clone_attributes + tangent_offset + vertex_index] =
        encode_vertex_tangent(vec4<f32>(local_tangent, tangent.w));
    }

    vertex_index = vertex_index + 64u;
  }
}
`;

export const SKINNING_BOUNDS_CLEAR_WGSL = /* wgsl */ `
${SKINNING_BINDING_WGSL}
@group(0) @binding(0) var<uniform> dispatch_offset: u32;
@group(0) @binding(1) var<uniform> total_pair_count: u32;
@group(0) @binding(2) var<storage, read> skinning_bindings: array<SkinningBinding>;
@group(0) @binding(3) var<storage, read> binding_meshlet_pairs: array<u32>;
@group(0) @binding(4) var<storage, read_write> meshlet_headers: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> geometries: array<atomic<u32>>;

const PLUS_INF: u32 = 0x7F800000u;
const MINUS_INF: u32 = 0xFF800000u;
const MESHLET_STRIDE: u32 = 10u;
const GEOMETRY_STRIDE: u32 = 16u;
const GEOMETRY_BBOX_OFFSET: u32 = 4u;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) invocation_id: vec3<u32>) {
  let pair_index = invocation_id.x + dispatch_offset;
  if pair_index >= total_pair_count { return; }
  let pair_word = pair_index * 2u;
  let binding = skinning_bindings[binding_meshlet_pairs[pair_word]];
  let meshlet_index = binding_meshlet_pairs[pair_word + 1u];
  let meshlet_base = (binding.clone_meshlet_metadata_offset + meshlet_index) * MESHLET_STRIDE;
  atomicStore(&meshlet_headers[meshlet_base + 0u], PLUS_INF);
  atomicStore(&meshlet_headers[meshlet_base + 1u], PLUS_INF);
  atomicStore(&meshlet_headers[meshlet_base + 2u], PLUS_INF);
  atomicStore(&meshlet_headers[meshlet_base + 3u], MINUS_INF);
  atomicStore(&meshlet_headers[meshlet_base + 4u], MINUS_INF);
  atomicStore(&meshlet_headers[meshlet_base + 5u], MINUS_INF);
  if meshlet_index == 0u {
    let geometry_base = binding.clone_geometry_index * GEOMETRY_STRIDE + GEOMETRY_BBOX_OFFSET;
    atomicStore(&geometries[geometry_base + 0u], PLUS_INF);
    atomicStore(&geometries[geometry_base + 1u], PLUS_INF);
    atomicStore(&geometries[geometry_base + 2u], PLUS_INF);
    atomicStore(&geometries[geometry_base + 3u], MINUS_INF);
    atomicStore(&geometries[geometry_base + 4u], MINUS_INF);
    atomicStore(&geometries[geometry_base + 5u], MINUS_INF);
  }
}
`;

const AABB_ATOMIC_WGSL = /* wgsl */ `
fn aabb_atomic_min_f32(destination: ptr<storage, atomic<u32>, read_write>, value: f32) {
  loop {
    let old_bits = atomicLoad(destination);
    if value >= bitcast<f32>(old_bits) { break; }
    let result = atomicCompareExchangeWeak(destination, old_bits, bitcast<u32>(value));
    if result.exchanged { break; }
  }
}

fn aabb_atomic_max_f32(destination: ptr<storage, atomic<u32>, read_write>, value: f32) {
  loop {
    let old_bits = atomicLoad(destination);
    if value <= bitcast<f32>(old_bits) { break; }
    let result = atomicCompareExchangeWeak(destination, old_bits, bitcast<u32>(value));
    if result.exchanged { break; }
  }
}
`;

export const SKINNING_BOUNDS_REDUCE_WGSL = /* wgsl */ `
${SKINNING_BINDING_WGSL}
${AABB_ATOMIC_WGSL}
@group(0) @binding(0) var<uniform> dispatch_offset: u32;
@group(0) @binding(1) var<storage, read> skinning_bindings: array<SkinningBinding>;
@group(0) @binding(2) var<storage, read> binding_meshlet_pairs: array<u32>;
@group(0) @binding(3) var<storage, read> meshlet_data: array<u32>;
@group(0) @binding(4) var<storage, read_write> meshlet_headers: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> geometries: array<atomic<u32>>;

const MESHLET_STRIDE: u32 = 10u;
const MESHLET_ADDRESS_OFFSET: u32 = 6u;
const MESHLET_PRIMITIVE_COUNT_OFFSET: u32 = 7u;
const MESHLET_VERTEX_COUNT_OFFSET: u32 = 8u;
const GEOMETRY_STRIDE: u32 = 16u;
const GEOMETRY_BBOX_OFFSET: u32 = 4u;
var<workgroup> group_min: array<vec3<f32>, 64>;
var<workgroup> group_max: array<vec3<f32>, 64>;

@compute @workgroup_size(64, 1, 1)
fn main(
  @builtin(workgroup_id) workgroup_id: vec3<u32>,
  @builtin(local_invocation_index) lane: u32,
) {
  let pair_index = workgroup_id.x + dispatch_offset;
  let pair_word = pair_index * 2u;
  let binding = skinning_bindings[binding_meshlet_pairs[pair_word]];
  let local_meshlet = binding_meshlet_pairs[pair_word + 1u];
  let global_meshlet = binding.clone_meshlet_metadata_offset + local_meshlet;
  let header_base = global_meshlet * MESHLET_STRIDE;
  let address = atomicLoad(&meshlet_headers[header_base + MESHLET_ADDRESS_OFFSET]);
  let primitive_count = atomicLoad(&meshlet_headers[header_base + MESHLET_PRIMITIVE_COUNT_OFFSET]);
  let vertex_count = atomicLoad(&meshlet_headers[header_base + MESHLET_VERTEX_COUNT_OFFSET]);
  let position_base = address + ((primitive_count * 3u + 3u) >> 2u);
  var minimum = vec3<f32>(3.4028234e38);
  var maximum = vec3<f32>(-3.4028234e38);
  var vertex = lane;
  loop {
    if vertex >= vertex_count { break; }
    let word = position_base + vertex * 3u;
    let position = vec3<f32>(
      bitcast<f32>(meshlet_data[word]),
      bitcast<f32>(meshlet_data[word + 1u]),
      bitcast<f32>(meshlet_data[word + 2u]),
    );
    minimum = min(minimum, position);
    maximum = max(maximum, position);
    vertex = vertex + 64u;
  }
  group_min[lane] = minimum;
  group_max[lane] = maximum;
  workgroupBarrier();
  var stride = 32u;
  loop {
    if stride == 0u { break; }
    if lane < stride {
      group_min[lane] = min(group_min[lane], group_min[lane + stride]);
      group_max[lane] = max(group_max[lane], group_max[lane + stride]);
    }
    workgroupBarrier();
    stride = stride >> 1u;
  }
  if lane == 0u {
    let bounds_base = header_base;
    aabb_atomic_min_f32(&meshlet_headers[bounds_base + 0u], group_min[0].x);
    aabb_atomic_min_f32(&meshlet_headers[bounds_base + 1u], group_min[0].y);
    aabb_atomic_min_f32(&meshlet_headers[bounds_base + 2u], group_min[0].z);
    aabb_atomic_max_f32(&meshlet_headers[bounds_base + 3u], group_max[0].x);
    aabb_atomic_max_f32(&meshlet_headers[bounds_base + 4u], group_max[0].y);
    aabb_atomic_max_f32(&meshlet_headers[bounds_base + 5u], group_max[0].z);
    let geometry_base = binding.clone_geometry_index * GEOMETRY_STRIDE + GEOMETRY_BBOX_OFFSET;
    aabb_atomic_min_f32(&geometries[geometry_base + 0u], group_min[0].x);
    aabb_atomic_min_f32(&geometries[geometry_base + 1u], group_min[0].y);
    aabb_atomic_min_f32(&geometries[geometry_base + 2u], group_min[0].z);
    aabb_atomic_max_f32(&geometries[geometry_base + 3u], group_max[0].x);
    aabb_atomic_max_f32(&geometries[geometry_base + 4u], group_max[0].y);
    aabb_atomic_max_f32(&geometries[geometry_base + 5u], group_max[0].z);
  }
}
`;

export const SKINNING_GEOMETRY_SPHERE_WGSL = /* wgsl */ `
${SKINNING_BINDING_WGSL}
@group(0) @binding(0) var<uniform> binding_count: u32;
@group(0) @binding(1) var<storage, read> skinning_bindings: array<SkinningBinding>;
@group(0) @binding(2) var<storage, read_write> geometries: array<atomic<u32>>;
const GEOMETRY_STRIDE: u32 = 16u;
const GEOMETRY_BBOX_OFFSET: u32 = 4u;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) invocation_id: vec3<u32>) {
  let binding_index = invocation_id.x;
  if binding_index >= binding_count { return; }
  let binding = skinning_bindings[binding_index];
  let base = binding.clone_geometry_index * GEOMETRY_STRIDE;
  let box_base = base + GEOMETRY_BBOX_OFFSET;
  let minimum = vec3<f32>(
    bitcast<f32>(atomicLoad(&geometries[box_base + 0u])),
    bitcast<f32>(atomicLoad(&geometries[box_base + 1u])),
    bitcast<f32>(atomicLoad(&geometries[box_base + 2u])),
  );
  let maximum = vec3<f32>(
    bitcast<f32>(atomicLoad(&geometries[box_base + 3u])),
    bitcast<f32>(atomicLoad(&geometries[box_base + 4u])),
    bitcast<f32>(atomicLoad(&geometries[box_base + 5u])),
  );
  let center = (minimum + maximum) * 0.5;
  let radius = length(maximum - minimum) * 0.5;
  atomicStore(&geometries[base + 0u], bitcast<u32>(center.x));
  atomicStore(&geometries[base + 1u], bitcast<u32>(center.y));
  atomicStore(&geometries[base + 2u], bitcast<u32>(center.z));
  atomicStore(&geometries[base + 3u], bitcast<u32>(radius));
}
`;

const AABB_PROJECT_WGSL = /* wgsl */ `
struct SkinningAabb {
  min: vec3<f32>,
  max: vec3<f32>,
};

fn aabb3_project(aabb: SkinningAabb, transform: mat4x4<f32>) -> SkinningAabb {
  var result = SkinningAabb(transform[3].xyz, transform[3].xyz);
  for (var j = 0u; j < 3u; j = j + 1u) {
    for (var i = 0u; i < 3u; i = i + 1u) {
      let coefficient = transform[j][i];
      let a = coefficient * aabb.min[j];
      let b = coefficient * aabb.max[j];
      result.min[i] = result.min[i] + min(a, b);
      result.max[i] = result.max[i] + max(a, b);
    }
  }
  return result;
}
`;

export const SKINNING_SCENE_BOUNDS_WGSL = /* wgsl */ `
${SCENE_DATABASE_READ_WRITE_WGSL}
${SKINNING_BINDING_WGSL}
${GEOMETRY_METADATA_WGSL}
${AABB_PROJECT_WGSL}
@group(0) @binding(0) var<uniform> binding_count: u32;
@group(0) @binding(1) var<storage, read> skinning_bindings: array<SkinningBinding>;
@group(0) @binding(2) var<storage, read_write> scene_database: array<u32>;
@group(0) @binding(3) var<storage, read> geometries: array<SkinningGeometryMetadata>;

fn update_object_property_mesh_instance_bounds(instance_index: u32) {
  let mesh = scene_read_mesh_rw(&scene_database, instance_index);
  let node = scene_read_node_rw(&scene_database, mesh.node);
  let geometry = geometries[mesh.geometry];
  let local_aabb = SkinningAabb(
    vec3<f32>(geometry.bounding_box[0], geometry.bounding_box[1], geometry.bounding_box[2]),
    vec3<f32>(geometry.bounding_box[3], geometry.bounding_box[4], geometry.bounding_box[5]),
  );
  let world_aabb = aabb3_project(local_aabb, node.global);
  let world_box = array<f32, 6>(
    world_aabb.min.x, world_aabb.min.y, world_aabb.min.z,
    world_aabb.max.x, world_aabb.max.y, world_aabb.max.z,
  );
  let world_center = (node.global * vec4<f32>(geometry.bounding_sphere.xyz, 1.0)).xyz;
  let max_axis_scale = max(
    length(node.global[0].xyz),
    max(length(node.global[1].xyz), length(node.global[2].xyz)),
  );
  let world_sphere = vec4<f32>(world_center, geometry.bounding_sphere.w * max_axis_scale);
  scene_write_mesh_bounding_box(&scene_database, instance_index, world_box);
  scene_write_mesh_bounding_sphere(&scene_database, instance_index, world_sphere);
}

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) invocation_id: vec3<u32>) {
  let binding_index = invocation_id.x;
  if binding_index >= binding_count { return; }
  update_object_property_mesh_instance_bounds(
    skinning_bindings[binding_index].mesh_instance_index
  );
}
`;

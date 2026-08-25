/**
 * light_cluster：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import {
  LIGHT_DATABASE_READ_WGSL,
  POINT_LIGHT_DESCRIPTOR,
  SPOT_LIGHT_DESCRIPTOR
} from "../gpu/LightDatabase.js";
import { LPV_CAMERA_TYPE } from "./lpv_indirect_diffuse.js";

export const LIGHT_CLUSTER_TILE_SIZE = 32;
export const LIGHT_CLUSTER_DEPTH_SLICES = 24;
export const LIGHT_CLUSTER_ASSIGN_WORKGROUP = 4;
export const LIGHT_CLUSTER_LIST_BYTES = 16_384 * 4;
export const LIGHT_CLUSTER_SETTINGS_BYTES = 128;
export const LIGHT_CLUSTER_METADATA_BYTES = 8;

const CLUSTER_COMMON_WGSL = /* wgsl */ `
${LPV_CAMERA_TYPE.wgsl_declaration}
${LIGHT_DATABASE_READ_WGSL}

const CLUSTER_LIGHT_TYPE_POINT: u32 = 0u;
const CLUSTER_LIGHT_TYPE_SPOT: u32 = 1u;

fn cluster_light_tuple_pack(id: u32, light_type: u32) -> u32 {
  return (id & 0x00ffffffu) | ((light_type & 0xffu) << 24u);
}

fn cluster_light_tuple_id(value: u32) -> u32 {
  return value & 0x00ffffffu;
}

fn cluster_light_tuple_type(value: u32) -> u32 {
  return (value >> 24u) & 0xffu;
}

fn sphere_intersects_frustum(
  sphere: vec4f,
  frustum: array<vec4f, 6>,
) -> bool {
  var intersects = true;
  for (var i = 0; i < 6; i++) {
    let plane = frustum[i];
    let distance_to_plane = dot(plane.xyz, sphere.xyz) + plane.w;
    intersects = intersects && distance_to_plane > -sphere.w;
  }
  return intersects;
}

fn point_light_intersects_frustum(
  database: ptr<storage, array<u32>>,
  index: u32,
  frustum: array<vec4f, 6>,
) -> bool {
  let light = ${POINT_LIGHT_DESCRIPTOR.marshalling_method_read}(database, index);
  return sphere_intersects_frustum(vec4f(light.position, light.distance), frustum);
}

fn ffx_sssr_advance_to(a: vec4f, b: vec4f, c: vec4f) -> vec3f {
  let cross_bc = cross(b.xyz, c.xyz);
  let cross_ca = cross(c.xyz, a.xyz);
  let cross_ab = cross(a.xyz, b.xyz);
  let numerator = -a.w * cross_bc - b.w * cross_ca - c.w * cross_ab;
  return numerator / dot(a.xyz, cross_bc);
}

fn frustum_corners(frustum: array<vec4f, 6>) -> array<vec3f, 8> {
  var corners: array<vec3f, 8>;
  corners[0] = ffx_sssr_advance_to(frustum[0], frustum[2], frustum[4]);
  corners[1] = ffx_sssr_advance_to(frustum[0], frustum[2], frustum[5]);
  corners[2] = ffx_sssr_advance_to(frustum[0], frustum[3], frustum[4]);
  corners[3] = ffx_sssr_advance_to(frustum[0], frustum[3], frustum[5]);
  corners[4] = ffx_sssr_advance_to(frustum[1], frustum[2], frustum[4]);
  corners[5] = ffx_sssr_advance_to(frustum[1], frustum[2], frustum[5]);
  corners[6] = ffx_sssr_advance_to(frustum[1], frustum[3], frustum[4]);
  corners[7] = ffx_sssr_advance_to(frustum[1], frustum[3], frustum[5]);
  return corners;
}

fn frustum_bounding_sphere(frustum: array<vec4f, 6>) -> vec4f {
  let corners = frustum_corners(frustum);
  var center = vec3f(0.0);
  for (var i = 0u; i < 8u; i++) { center += corners[i]; }
  center /= 8.0;
  var radius = 0.0;
  for (var i = 0u; i < 8u; i++) {
    radius = max(radius, distance(center, corners[i]));
  }
  return vec4f(center, radius);
}

fn cone_frustum_plane_test(
  apex: vec3f,
  direction: vec3f,
  height: f32,
  angle_cos: f32,
  sphere: vec4f,
) -> bool {
  let sin_angle = sqrt(1.0 - angle_cos * angle_cos);
  let to_center = sphere.xyz - apex;
  let center_distance_squared = dot(to_center, to_center);
  let axial_distance = dot(to_center, direction);
  let separating = angle_cos * sqrt(
    center_distance_squared - axial_distance * axial_distance
  ) - axial_distance * sin_angle;
  let outside_side = separating > sphere.w;
  let beyond_end = axial_distance > sphere.w + height;
  let behind_apex = axial_distance < -sphere.w;
  return !(outside_side || beyond_end || behind_apex);
}

fn cone_intersects_frustum(
  apex: vec3f,
  direction: vec3f,
  height: f32,
  angle_cos: f32,
  frustum: array<vec4f, 6>,
) -> bool {
  return cone_frustum_plane_test(
    apex,
    direction,
    height,
    angle_cos,
    frustum_bounding_sphere(frustum),
  );
}

fn spot_light_intersects_frustum(
  database: ptr<storage, array<u32>>,
  index: u32,
  frustum: array<vec4f, 6>,
) -> bool {
  let light = ${SPOT_LIGHT_DESCRIPTOR.marshalling_method_read}(database, index);
  return cone_intersects_frustum(
    light.position,
    light.direction,
    light.distance,
    light.coneCos,
    frustum,
  );
}
`;

function createPagedLightListShader(kind: "point" | "spot"): string {
  const upper = kind === "point" ? "POINT_LIGHTS" : "SPOT_LIGHTS";
  const lower = kind === "point" ? "point_lights" : "spot_lights";
  const intersects = kind === "point"
    ? "point_light_intersects_frustum"
    : "spot_light_intersects_frustum";
  const type = kind === "point" ? 0 : 1;
  return /* wgsl */ `
${CLUSTER_COMMON_WGSL}
struct AtomicLightList { offset: atomic<u32>, data: array<u32>, }
@group(0) @binding(0) var<uniform> camera: CommandEncoder;
@group(1) @binding(0) var<storage, read> node: array<u32>;
@group(2) @binding(0) var<storage, read_write> output: AtomicLightList;

@compute @workgroup_size(128, 1, 1)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let id = global_id.x;
  let page_index = id / ${upper}_ELEMENTS_PER_PAGE;
  let in_page_slot = id % ${upper}_ELEMENTS_PER_PAGE;
  if (page_index >= ${upper}_PAGE_LIMIT) { return; }
  let page_address = ${lower}_page_address(&node, page_index);
  if (page_address == 0xffffffffu) { return; }
  let word_index = in_page_slot >> 5u;
  let bit = in_page_slot & 31u;
  let bitmap_word = ${lower}_page_bitmap_word(&node, page_address, word_index);
  if ((bitmap_word & (1u << bit)) == 0u) { return; }
  let light_index = ${lower}_slot_to_index(page_index, in_page_slot);
  if (!${intersects}(&node, light_index, camera.frustum)) { return; }
  let packed_id = cluster_light_tuple_pack(light_index, ${type}u);
  let destination = atomicAdd(&output.offset, 1u);
  if (destination < arrayLength(&output.data)) {
    output.data[destination] = packed_id;
  }
}
`;
}

export const LIGHT_CLUSTER_POINT_LIST_WGSL = createPagedLightListShader("point");
export const LIGHT_CLUSTER_SPOT_LIST_WGSL = createPagedLightListShader("spot");

export const LIGHT_CLUSTER_HZB_FILTER_WGSL = /* wgsl */ `
${CLUSTER_COMMON_WGSL}
struct Aabb3 { min: vec3f, max: vec3f, }
struct LightList { count: u32, data: array<u32>, }
struct AtomicLightList { offset: atomic<u32>, data: array<u32>, }

@group(0) @binding(0) var<storage, read> node: array<u32>;
@group(1) @binding(0) var<uniform> camera: CommandEncoder;
@group(1) @binding(1) var triangle_index: texture_2d<f32>;
@group(2) @binding(0) var<storage, read> input: LightList;
@group(2) @binding(1) var<storage, read_write> output: AtomicLightList;

fn v3_angle_between(a: vec3f, b: vec3f) -> f32 {
  let denominator = length(a) * length(b);
  let cosine = select(clamp(dot(a, b) / denominator, -1.0, 1.0), 0.0, denominator == 0.0);
  return acos(cosine);
}

fn cone_to_bounding_box(apex: vec3f, direction: vec3f, height: f32, angle_cos: f32) -> Aabb3 {
  let angles = vec3f(
    v3_angle_between(direction, vec3f(1.0, 0.0, 0.0)),
    v3_angle_between(direction, vec3f(0.0, 1.0, 0.0)),
    v3_angle_between(direction, vec3f(0.0, 0.0, 1.0)),
  );
  let radius = height * sqrt((1.0 + angle_cos) * (1.0 - angle_cos)) / angle_cos;
  let center = apex + direction * height;
  let extent = sin(angles) * radius;
  return Aabb3(min(apex, center - extent), max(apex, center + extent));
}

fn point_light_to_aabb3(database: ptr<storage, array<u32>>, index: u32) -> Aabb3 {
  let light = ${POINT_LIGHT_DESCRIPTOR.marshalling_method_read}(database, index);
  return Aabb3(light.position - light.distance, light.position + light.distance);
}

fn spot_light_to_aabb3(database: ptr<storage, array<u32>>, index: u32) -> Aabb3 {
  let light = ${SPOT_LIGHT_DESCRIPTOR.marshalling_method_read}(database, index);
  return cone_to_bounding_box(light.position, light.direction, light.distance, light.coneCos);
}

fn aabb3_project_perspective(output: ptr<function, Aabb3>, bounds: Aabb3, matrix: mat4x4f) -> bool {
  var minimum = vec3f(0.0);
  var maximum = vec3f(0.0);
  for (var i = 0u; i < 8u; i++) {
    let point = vec3f(
      select(bounds.min.x, bounds.max.x, (i & 1u) != 0u),
      select(bounds.min.y, bounds.max.y, (i & 2u) != 0u),
      select(bounds.min.z, bounds.max.z, (i & 4u) != 0u),
    );
    let clip = matrix * vec4f(point, 1.0);
    if (clip.w < 0.0) { return false; }
    let projected = clip.xyz / clip.w;
    if (i == 0u) {
      minimum = projected;
      maximum = projected;
    } else {
      minimum = min(minimum, projected);
      maximum = max(maximum, projected);
    }
  }
  (*output).min = minimum;
  (*output).max = maximum;
  return true;
}

fn ndc_to_uv(value: vec2f) -> vec2f {
  return fma(value, vec2f(0.5, -0.5), vec2f(0.5));
}

fn uv_to_texel_coordinate(value: vec2f, dimensions: vec2u) -> vec2f {
  return fma(value, vec2f(dimensions), vec2f(-0.5));
}

fn min4(a: f32, b: f32, c: f32, d: f32) -> f32 {
  return min(min(a, b), min(c, d));
}

fn query_depth_from_screen_space_bb(bounds: Aabb3, hzb: texture_2d<f32>) -> f32 {
  let uv0 = clamp(ndc_to_uv(bounds.min.xy), vec2f(0.0), vec2f(1.0));
  let uv1 = clamp(ndc_to_uv(bounds.max.xy), vec2f(0.0), vec2f(1.0));
  let span = abs(uv1 - uv0) * vec2f(textureDimensions(hzb));
  let mip = min(
    u32(ceil(log2(max(max(span.x, span.y), 1.0)))),
    textureNumLevels(hzb) - 1u,
  );
  let dimensions = textureDimensions(hzb) >> vec2u(mip);
  let p0 = vec2u(uv_to_texel_coordinate(uv0, dimensions));
  let p1 = vec2u(uv_to_texel_coordinate(uv1, dimensions));
  let p2 = vec2u(p1.x, p0.y);
  let p3 = vec2u(p0.x, p1.y);
  let depth = min4(
    textureLoad(hzb, p0, mip).x,
    textureLoad(hzb, p2, mip).x,
    textureLoad(hzb, p3, mip).x,
    textureLoad(hzb, p1, mip).x,
  );
  return bounds.max.z - depth;
}

@compute @workgroup_size(256, 1, 1)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let i = global_id.x;
  if (i >= input.count) { return; }
  let tuple = input.data[i];
  let light_index = cluster_light_tuple_id(tuple);
  let light_type = cluster_light_tuple_type(tuple);
  var bounds: Aabb3;
  if (light_type == CLUSTER_LIGHT_TYPE_POINT) {
    bounds = point_light_to_aabb3(&node, light_index);
  } else if (light_type == CLUSTER_LIGHT_TYPE_SPOT) {
    bounds = spot_light_to_aabb3(&node, light_index);
  } else { return; }
  var projected: Aabb3;
  let valid = aabb3_project_perspective(&projected, bounds, camera.view_projection_matrix);
  if (valid && query_depth_from_screen_space_bb(projected, triangle_index) < 0.0) { return; }
  let destination = atomicAdd(&output.offset, 1u);
  if (destination < arrayLength(&output.data)) { output.data[destination] = tuple; }
}
`;

export const LIGHT_CLUSTER_ASSIGN_WGSL = /* wgsl */ `
${CLUSTER_COMMON_WGSL}
struct LightList { count: u32, data: array<u32>, }
struct ClusterMetadata { counts: u32, offset: u32, }
struct ClusterData { offset: atomic<u32>, data: array<u32>, }
struct ClusterSettings {
  cluster_params: vec3f,
  screen_resolution: vec2u,
  distance_min: f32,
  distance_max: f32,
  frustum: array<vec4f, 6>,
}

@group(0) @binding(0) var<uniform> camera: CommandEncoder;
@group(0) @binding(1) var<storage, read> input: LightList;
@group(0) @binding(2) var<uniform> settings: ClusterSettings;
@group(1) @binding(0) var<storage, read> node: array<u32>;
@group(2) @binding(0) var<storage, read_write> cluster_lookup: array<ClusterMetadata>;
@group(2) @binding(1) var<storage, read_write> cluster_data: ClusterData;

fn inverse_lerp(a: f32, b: f32, value: f32) -> f32 {
  let range = b - a;
  return select((value - a) / range, 0.0, range == 0.0);
}

fn cluster_depth_from_z_slice(z_slice: f32, parameters: vec3f, limit: f32) -> f32 {
  var depth = (exp2(z_slice / parameters.z) - parameters.y) / parameters.x;
  if (z_slice <= 0.0) { depth = 0.0; }
  if (z_slice >= limit) { depth = 3.402823466e+38; }
  return depth;
}

fn normalize_plane(plane: vec4f) -> vec4f {
  let length_xyz = length(plane.xyz);
  return select(plane, plane / length_xyz, length_xyz > 1.0e-7);
}

fn slice_plane_pair(a: vec4f, b: vec4f, range: vec2f) -> array<vec4f, 2> {
  return array<vec4f, 2>(
    normalize_plane(mix(a, -b, range.x)),
    normalize_plane(mix(-a, b, range.y)),
  );
}

fn frustum_slice(frustum: array<vec4f, 6>, minimum: vec3f, maximum: vec3f) -> array<vec4f, 6> {
  var result: array<vec4f, 6>;
  let x = slice_plane_pair(frustum[0], frustum[1], vec2f(minimum.x, maximum.x));
  let y = slice_plane_pair(frustum[2], frustum[3], vec2f(minimum.y, maximum.y));
  let z = slice_plane_pair(frustum[4], frustum[5], vec2f(minimum.z, maximum.z));
  result[0] = x[0]; result[1] = x[1];
  result[2] = y[0]; result[3] = y[1];
  result[4] = z[0]; result[5] = z[1];
  return result;
}

fn cluster_resolution_xy(screen: vec2u) -> vec2u {
  return (screen + vec2u(31u)) / vec2u(32u);
}

fn grid3d_to_index(position: vec3u, dimensions: vec2u) -> u32 {
  return position.x + (position.y + position.z * dimensions.y) * dimensions.x;
}

fn light_cluster_pack_counts(point_count: u32, spot_count: u32) -> u32 {
  return (point_count & 0xffu) | ((spot_count & 0xffu) << 8u);
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) voxel_position: vec3u) {
  let limit_xy = cluster_resolution_xy(settings.screen_resolution);
  if (any(voxel_position >= vec3u(limit_xy, 24u))) { return; }
  let cluster_index = grid3d_to_index(voxel_position, limit_xy);
  let z_planes = vec2f(settings.distance_min, settings.distance_max);
  let xy0 = vec2f((voxel_position.xy + vec2u(0u)) * 32u) / vec2f(settings.screen_resolution);
  let xy1 = vec2f((voxel_position.xy + vec2u(1u)) * 32u) / vec2f(settings.screen_resolution);
  var f0 = vec3f(xy0, 0.0);
  var f1 = vec3f(xy1, 0.0);
  let d0 = cluster_depth_from_z_slice(f32(voxel_position.z), settings.cluster_params, 24.0);
  let d1 = cluster_depth_from_z_slice(f32(voxel_position.z + 1u), settings.cluster_params, 24.0);
  f0.z = inverse_lerp(z_planes.x, z_planes.y, d0);
  f1.z = inverse_lerp(z_planes.x, z_planes.y, d1);
  let cluster_frustum = frustum_slice(settings.frustum, f0, f1);
  var point_count = 0u;
  var spot_count = 0u;
  var local_lights: array<u32, 256>;
  for (var i = 0u; i < input.count; i++) {
    let tuple = input.data[i];
    let light_index = cluster_light_tuple_id(tuple);
    let light_type = cluster_light_tuple_type(tuple);
    var intersects = false;
    if (light_type == CLUSTER_LIGHT_TYPE_POINT) {
      intersects = point_light_intersects_frustum(&node, light_index, cluster_frustum);
    } else if (light_type == CLUSTER_LIGHT_TYPE_SPOT) {
      intersects = spot_light_intersects_frustum(&node, light_index, cluster_frustum);
    }
    if (!intersects) { continue; }
    if (light_type == CLUSTER_LIGHT_TYPE_POINT) {
      if (point_count >= 128u) { continue; }
      local_lights[point_count] = light_index;
      point_count += 1u;
    } else {
      if (spot_count >= 128u) { continue; }
      local_lights[128u + spot_count] = light_index;
      spot_count += 1u;
    }
  }
  let total = point_count + spot_count;
  let write_offset = atomicAdd(&cluster_data.offset, total);
  let available = arrayLength(&cluster_data.data) - min(write_offset, arrayLength(&cluster_data.data));
  let write_total = min(total, available);
  let write_point_count = min(point_count, write_total);
  let write_spot_count = min(spot_count, write_total - write_point_count);
  for (var i = 0u; i < write_point_count; i++) {
    cluster_data.data[write_offset + i] = local_lights[i];
  }
  for (var i = 0u; i < write_spot_count; i++) {
    cluster_data.data[write_offset + write_point_count + i] = local_lights[128u + i];
  }
  cluster_lookup[cluster_index] = ClusterMetadata(
    light_cluster_pack_counts(write_point_count, write_spot_count),
    write_offset + 1u,
  );
}
`;

/**
 * meshlet_hzb_cull：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { VISIBILITY_CULL_COMMON_WGSL } from "./visibility_cull_common.js";

const MESHLET_CULL_TYPES_WGSL = /* wgsl */ `
struct MeshletCullElement {
  index: u32,
  mesh: u32,
};

struct MeshletCullInputList {
  count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  elements: array<MeshletCullElement>,
};

struct MeshletCullOutputList {
  count: atomic<u32>,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  elements: array<MeshletCullElement>,
};
`;

export const MESHLET_HZB_CULL_WGSL = /* wgsl */ `
${VISIBILITY_CULL_COMMON_WGSL}
${MESHLET_CULL_TYPES_WGSL}

@group(0) @binding(0) var<uniform> camera: CommandEncoder;
@group(0) @binding(1) var<uniform> resolution: vec2u;
@group(0) @binding(2) var<storage, read> scene_database: array<u32>;
@group(0) @binding(3) var<storage, read> camera_icon: array<VisibilityCullMeshletHeader>;
@group(0) @binding(4) var triangle_index: texture_2d<f32>;
@group(1) @binding(0) var<storage, read> input: MeshletCullInputList;
@group(1) @binding(1) var<storage, read_write> output: MeshletCullOutputList;

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let input_index = global_id.x;
  if (input_index >= input.count) {
    return;
  }

  let element = input.elements[input_index];
  let mesh = scene_read_mesh(&scene_database, element.mesh);
  let node = scene_read_node(&scene_database, mesh.node);
  let local_bounds = visibility_array_to_aabb3(
    camera_icon[element.index].bounds_box
  );
  let world_bounds = visibility_aabb3_project(local_bounds, node.global);
  if (!visibility_aabb3_intersects_frustum(world_bounds, camera.frustum)) {
    return;
  }

  var projected_bounds: VisibilityCullAabb;
  let projected = visibility_aabb3_project_perspective(
    &projected_bounds,
    world_bounds,
    camera.view_projection_matrix
  );
  let overlaps_texel_centers = visibility_aabb2_clip_overlaps_texel_centers(
    projected_bounds.min.xy,
    projected_bounds.max.xy,
    resolution
  );
  if (projected && !overlaps_texel_centers) {
    return;
  }
  if (
    projected &&
    visibility_query_depth_from_screen_space_bb(
      projected_bounds,
      triangle_index
    ) < 0.0
  ) {
    return;
  }

  let output_index = atomicAdd(&output.count, 1u);
  if (output_index < arrayLength(&output.elements)) {
    output.elements[output_index] = element;
  }
}
`;

export const MESHLET_HZB_CULL_SECOND_WGSL = /* wgsl */ `
${VISIBILITY_CULL_COMMON_WGSL}
${MESHLET_CULL_TYPES_WGSL}

@group(0) @binding(0) var<uniform> camera: CommandEncoder;
@group(0) @binding(1) var<storage, read> scene_database: array<u32>;
@group(0) @binding(2) var<storage, read> camera_icon: array<VisibilityCullMeshletHeader>;
@group(0) @binding(3) var triangle_index: texture_2d<f32>;
@group(1) @binding(0) var<storage, read> input: MeshletCullInputList;
@group(2) @binding(0) var<storage, read_write> output: MeshletCullOutputList;

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let input_index = global_id.x;
  if (input_index >= input.count) {
    return;
  }

  let element = input.elements[input_index];
  let mesh = scene_read_mesh(&scene_database, element.mesh);
  let node = scene_read_node(&scene_database, mesh.node);
  let local_bounds = visibility_array_to_aabb3(
    camera_icon[element.index].bounds_box
  );
  let world_bounds = visibility_aabb3_project(local_bounds, node.global);
  var projected_bounds: VisibilityCullAabb;
  let projected = visibility_aabb3_project_perspective(
    &projected_bounds,
    world_bounds,
    camera.view_projection_matrix
  );
  if (
    projected &&
    visibility_query_depth_from_screen_space_bb(
      projected_bounds,
      triangle_index
    ) < 0.0
  ) {
    return;
  }

  let output_index = atomicAdd(&output.count, 1u);
  if (output_index < arrayLength(&output.elements)) {
    output.elements[output_index] = element;
  }
}
`;

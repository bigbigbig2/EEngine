/**
 * mesh_instance_cull：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { VISIBILITY_CULL_COMMON_WGSL } from "./visibility_cull_common.js";

export const MESH_INSTANCE_CULL_WGSL = /* wgsl */ `
${VISIBILITY_CULL_COMMON_WGSL}

struct InstanceCullMeshList {
  count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  elements: array<u32>,
};

struct InstanceCullOutputList {
  count: atomic<u32>,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  elements: array<u32>,
};

@group(0) @binding(0) var<storage, read> input: InstanceCullMeshList;
@group(0) @binding(1) var<storage, read_write> output: InstanceCullOutputList;
@group(0) @binding(2) var<uniform> camera: CommandEncoder;
@group(0) @binding(3) var<storage, read> scene_database: array<u32>;
@group(0) @binding(4) var triangle_index: texture_2d<f32>;

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let input_index = global_id.x;
  let input_count = min(input.count, arrayLength(&input.elements));
  if (input_index >= input_count) {
    return;
  }

  let mesh_index = input.elements[input_index];
  let mesh = scene_read_mesh(&scene_database, mesh_index);
  let world_bounds = visibility_array_to_aabb3(mesh.bounding_box);
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
    output.elements[output_index] = mesh_index;
  }
}
`;

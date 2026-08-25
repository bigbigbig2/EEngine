/**
 * mesh_instance_cull_dual：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { MATERIAL_BUCKET_COUNT } from "../material/materialBucketId.js";
import { VISIBILITY_CULL_COMMON_WGSL } from "./visibility_cull_common.js";

export const MESH_INSTANCE_CULL_DUAL_WGSL = /* wgsl */ `
${VISIBILITY_CULL_COMMON_WGSL}

struct InstanceDualBucketParams {
  value: u32,
};

struct InstanceDualBucketHeader {
  count: u32,
  offset: u32,
};

struct InstanceDualBuckets {
  headers: array<InstanceDualBucketHeader, ${MATERIAL_BUCKET_COUNT}>,
  elements: array<u32>,
};

struct InstanceDualOutput {
  count: atomic<u32>,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  elements: array<u32>,
};

@group(0) @binding(0) var<uniform> bucket_index: InstanceDualBucketParams;
@group(0) @binding(1) var<storage, read> instance: InstanceDualBuckets;
@group(1) @binding(0) var<uniform> camera_previous: CommandEncoder;
@group(1) @binding(1) var triangle_index: texture_2d<f32>;
@group(2) @binding(0) var<storage, read> scene_database: array<u32>;
@group(3) @binding(0) var<storage, read_write> source_bounds_x1: InstanceDualOutput;
@group(3) @binding(1) var<storage, read_write> chunk_sh3_color_add: InstanceDualOutput;

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let input_index = global_id.x;
  let bucket = bucket_index.value;
  let source_offset = instance.headers[bucket].offset;
  let source_count = instance.headers[bucket].count;
  if (input_index >= source_count) {
    return;
  }
  let source_index = source_offset + input_index;
  if (source_index >= arrayLength(&instance.elements)) {
    return;
  }

  let mesh_index = instance.elements[source_index];
  let mesh = scene_read_mesh(&scene_database, mesh_index);
  let world_bounds = visibility_array_to_aabb3(mesh.bounding_box);
  var projected_bounds: VisibilityCullAabb;
  let projected = visibility_aabb3_project_perspective(
    &projected_bounds,
    world_bounds,
    camera_previous.view_projection_matrix
  );
  if (
    !projected ||
    visibility_query_depth_from_screen_space_bb(
      projected_bounds,
      triangle_index
    ) >= 0.0
  ) {
    let output_index = atomicAdd(&source_bounds_x1.count, 1u);
    if (output_index < arrayLength(&source_bounds_x1.elements)) {
      source_bounds_x1.elements[output_index] = mesh_index;
    }
  } else {
    let output_index = atomicAdd(&chunk_sh3_color_add.count, 1u);
    if (output_index < arrayLength(&chunk_sh3_color_add.elements)) {
      chunk_sh3_color_add.elements[output_index] = mesh_index;
    }
  }
}
`;

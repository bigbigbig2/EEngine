/**
 * meshlet_hzb_cull_dual：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { VISIBILITY_CULL_COMMON_WGSL } from "./visibility_cull_common.js";
import {
  createMeshletHzbCounterWgsl,
  type MeshletHzbCounterWgslOptions
} from "./meshlet_hzb_cull.js";

export function createMeshletHzbCullDualWgsl(
  options?: MeshletHzbCounterWgslOptions
): string {
  const counter = createMeshletHzbCounterWgsl(options);
  return /* wgsl */ `
${VISIBILITY_CULL_COMMON_WGSL}

struct PipelineCacheKey {
  projection_matrix: mat4x4f,
  upscale_ratio: vec2f,
  jitter: vec2f,
  width: u32,
  height: u32,
  frame_index: u32,
};

struct MeshletDualElement {
  index: u32,
  mesh: u32,
};

struct MeshletDualInputList {
  count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  elements: array<MeshletDualElement>,
};

struct MeshletDualOutputList {
  count: atomic<u32>,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  elements: array<MeshletDualElement>,
};

@group(0) @binding(0) var<uniform> camera_current: CommandEncoder;
@group(0) @binding(1) var<uniform> camera_previous: CommandEncoder;
@group(0) @binding(2) var<uniform> view: PipelineCacheKey;
@group(0) @binding(3) var<storage, read> scene_database: array<u32>;
@group(0) @binding(4) var<storage, read> camera_icon: array<VisibilityCullMeshletHeader>;
@group(0) @binding(5) var triangle_index: texture_2d<f32>;
@group(1) @binding(0) var<storage, read> input: MeshletDualInputList;
@group(1) @binding(1) var<storage, read_write> source_bounds_x1: MeshletDualOutputList;
@group(1) @binding(2) var<storage, read_write> chunk_sh3_color_add: MeshletDualOutputList;
${counter.declaration}

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
  if (
    !visibility_aabb3_intersects_frustum(
      world_bounds,
      camera_current.frustum
    )
  ) {
    return;
  }

  {
    var current_bounds: VisibilityCullAabb;
    let current_projected = visibility_aabb3_project_perspective(
      &current_bounds,
      world_bounds,
      camera_current.view_projection_matrix
    );
    let resolution = vec2u(view.width, view.height);
    let overlaps_texel_centers = visibility_aabb2_clip_overlaps_texel_centers(
      current_bounds.min.xy,
      current_bounds.max.xy,
      resolution
    );
    if (current_projected && !overlaps_texel_centers) {
      return;
    }
  }

  var previous_bounds: VisibilityCullAabb;
  let previous_projected = visibility_aabb3_project_perspective(
    &previous_bounds,
    world_bounds,
    camera_previous.view_projection_matrix
  );
  if (
    !previous_projected ||
    visibility_query_depth_from_screen_space_bb(
      previous_bounds,
      triangle_index
    ) >= 0.0
  ) {
    let output_index = atomicAdd(&source_bounds_x1.count, 1u);
    if (output_index < arrayLength(&source_bounds_x1.elements)) {
      source_bounds_x1.elements[output_index] = element;
    }
  } else {
    ${counter.increment}
    let output_index = atomicAdd(&chunk_sh3_color_add.count, 1u);
    if (output_index < arrayLength(&chunk_sh3_color_add.elements)) {
      chunk_sh3_color_add.elements[output_index] = element;
    }
  }
}
`;
}

export const MESHLET_HZB_CULL_DUAL_WGSL = createMeshletHzbCullDualWgsl();

/**
 * meshlet_expand_counts：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { SCENE_DATABASE_READ_WGSL } from "../gpu/SceneDatabase.js";

export const MESHLET_EXPAND_COUNTS_WGSL = /* wgsl */ `
${SCENE_DATABASE_READ_WGSL}

struct ExpandGeometryMeta {
  bounding_sphere: vec4f,
  bounding_box: array<f32, 6>,
  index_count: u32,
  meshlets_address: u32,
  meshlets_count: u32,
};

struct ExpandMeshList {
  count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  elements: array<u32>,
};

@group(0) @binding(0) var<storage, read> scene_database: array<u32>;
@group(0) @binding(1) var<storage, read> geometries: array<ExpandGeometryMeta>;
@group(1) @binding(0) var<storage, read> input: ExpandMeshList;
@group(1) @binding(1) var<storage, read_write> output: ExpandMeshList;

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let input_index = global_id.x;
  if (input_index >= input.count) {
    return;
  }
  if (input_index == 0u) {
    output.count = input.count;
  }
  let mesh_index = input.elements[input_index];
  let mesh = scene_read_mesh(&scene_database, mesh_index);
  let geometry = geometries[mesh.geometry];
  output.elements[input_index] = geometry.meshlets_count;
}
`;

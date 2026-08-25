/**
 * meshlet_expand：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { SCENE_DATABASE_READ_WGSL } from "../gpu/SceneDatabase.js";

const EXPAND_TYPES_WGSL = /* wgsl */ `
struct ExpandGeometryMeta {
  bounding_sphere: vec4f,
  bounding_box: array<f32, 6>,
  index_count: u32,
  meshlets_address: u32,
  meshlets_count: u32,
};

struct ExpandMeshElement {
  index: u32,
  mesh: u32,
};

struct ExpandMeshIndexList {
  count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  elements: array<u32>,
};

struct ExpandMeshletList {
  count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  elements: array<ExpandMeshElement>,
};
`;

export const MESHLET_EXPAND_WGSL = /* wgsl */ `
${SCENE_DATABASE_READ_WGSL}
${EXPAND_TYPES_WGSL}

@group(0) @binding(0) var<storage, read> prefix_sums: ExpandMeshIndexList;
@group(1) @binding(0) var<storage, read> scene_database: array<u32>;
@group(1) @binding(1) var<storage, read> geometries: array<ExpandGeometryMeta>;
@group(2) @binding(0) var<storage, read> input_meshes: ExpandMeshIndexList;
@group(2) @binding(1) var<storage, read_write> output_meshlets: ExpandMeshletList;

fn saturate(value: f32) -> f32 {
  return clamp(value, 0.0, 1.0);
}

fn lower_bound_branchless(
  values: ptr<storage, array<u32>, read>,
  sought_value: u32,
  count: u32
) -> u32 {
  let total = (*values)[count - 1u];
  let normalized = saturate(f32(sought_value) / f32(total));
  let guess = u32(normalized * f32(count - 1u));
  let guess_value = (*values)[guess];
  let after_guess = guess_value < sought_value;
  var lower = select(0u, guess + 1u, after_guess);
  var upper = select(guess, count, after_guess);
  loop {
    if (lower >= upper) {
      break;
    }
    let middle = lower + (upper - lower) / 2u;
    let value = (*values)[middle];
    let before_target = value < sought_value;
    lower = select(lower, middle + 1u, before_target);
    upper = select(middle, upper, before_target);
  }
  return lower;
}

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let input_index = global_id.x;
  let input_mesh_count = prefix_sums.count;
  let mesh_search_index = lower_bound_branchless(
    &prefix_sums.elements,
    input_index + 1u,
    input_mesh_count
  );
  if (mesh_search_index >= input_mesh_count) {
    return;
  }
  var prefix_sum_prev = 0u;
  if (mesh_search_index > 0u) {
    prefix_sum_prev = prefix_sums.elements[mesh_search_index - 1u];
  }
  let local_offset = input_index - prefix_sum_prev;
  let mesh_index = input_meshes.elements[mesh_search_index];
  let mesh = scene_read_mesh(&scene_database, mesh_index);
  let geometry = geometries[mesh.geometry];
  let meshlet_index = geometry.meshlets_address
    + min(local_offset, geometry.meshlets_count - 1u);
  let output_index = input_index + output_meshlets.count;
  output_meshlets.elements[output_index] = ExpandMeshElement(
    meshlet_index,
    mesh_index
  );
}
`;

export const MESHLET_EXPAND_DISPATCH_WGSL = /* wgsl */ `
struct ExpandPrefix {
  count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  elements: array<u32>,
};

struct ExpandDispatchArgs {
  workgroupCountX: u32,
  workgroupCountY: u32,
  workgroupCountZ: u32,
};

@group(0) @binding(0) var<storage, read> prefix_sums: ExpandPrefix;
@group(0) @binding(1) var<storage, read_write> command: ExpandDispatchArgs;

@compute @workgroup_size(1)
fn main() {
  let total_count = prefix_sums.elements[prefix_sums.count - 1u];
  command.workgroupCountX = (total_count + 127u) / 128u;
  command.workgroupCountY = 1u;
  command.workgroupCountZ = 1u;
}
`;

export const MESHLET_EXPAND_COMMIT_WGSL = /* wgsl */ `
struct ExpandPrefix {
  count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  elements: array<u32>,
};

@group(0) @binding(0) var<storage, read> prefix_sums: ExpandPrefix;
@group(0) @binding(1) var<storage, read_write> output_count: u32;

@compute @workgroup_size(1)
fn main() {
  output_count += prefix_sums.elements[prefix_sums.count - 1u];
}
`;

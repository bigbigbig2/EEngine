/**
 * meshlet_bucket_ka：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { MATERIAL_META_TYPE } from "../gpu/MaterialMetadataTable.js";
import { SCENE_DATABASE_READ_WGSL } from "../gpu/SceneDatabase.js";
import { MATERIAL_BUCKET_COUNT } from "../material/materialBucketId.js";
import { rasterizationMaterialBucketWgsl } from "./material_bucket_wgsl.js";

export const MESHLET_KA_EPW = 128;
export const MESHLET_KA_BUCKET_COUNT = MATERIAL_BUCKET_COUNT;
export const MESHLET_KA_HEADER_STRIDE_BYTES = 8;
export const MESHLET_KA_HEADER_STRIDE_U32 = 2;
export const MESHLET_KA_COUNTS_BYTES = MATERIAL_BUCKET_COUNT * 4;
export const MESHLET_KA_HEADERS_BYTES =
  MATERIAL_BUCKET_COUNT * MESHLET_KA_HEADER_STRIDE_BYTES;

const KA_COMMON_WGSL = /* wgsl */ `
${SCENE_DATABASE_READ_WGSL}
${MATERIAL_META_TYPE.wgsl_declaration}
${rasterizationMaterialBucketWgsl()}

const MATERIAL_BUCKET_COUNT: u32 = ${MATERIAL_BUCKET_COUNT}u;

struct KaMeshList {
  count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  elements: array<u32>,
};

struct KaCounts {
  counts: array<atomic<u32>, ${MATERIAL_BUCKET_COUNT}>,
};

struct KaBucketHeader {
  count: atomic<u32>,
  offset: u32,
};

struct KaBucketData {
  headers: array<KaBucketHeader, ${MATERIAL_BUCKET_COUNT}>,
  elements: array<u32>,
};
`;

export const MESHLET_KA_RA_WGSL = /* wgsl */ `
${KA_COMMON_WGSL}

var<workgroup> wg_buckets: array<atomic<u32>, ${MATERIAL_BUCKET_COUNT}>;

@group(0) @binding(0) var<storage, read> scene_database: array<u32>;
@group(0) @binding(1) var<storage, read> materials: array<EventDispatcher>;
@group(1) @binding(0) var<storage, read> input: KaMeshList;
@group(1) @binding(1) var<storage, read_write> output: KaCounts;

@compute @workgroup_size(128)
fn main(
  @builtin(global_invocation_id) global_id: vec3u,
  @builtin(local_invocation_index) local_id: u32
) {
  let input_index = global_id.x;
  let input_count = min(input.count, arrayLength(&input.elements));
  if (input_index < input_count) {
    let mesh_index = input.elements[input_index];
    let mesh = scene_read_mesh(&scene_database, mesh_index);
    let material = materials[mesh.material];
    let bucket_index = rasterization_material_bucket(
      material.transparency_mode,
      material.draw_mode,
      material.draw_side
    );
    atomicAdd(&wg_buckets[bucket_index], 1u);
  }

  workgroupBarrier();

  if (local_id < MATERIAL_BUCKET_COUNT) {
    let count = atomicLoad(&wg_buckets[local_id]);
    if (count > 0u) {
      atomicAdd(&output.counts[local_id], count);
    }
  }
}
`;

export const MESHLET_KA_GA_WGSL = /* wgsl */ `
struct KaOffsets {
  elements: array<u32, ${MATERIAL_BUCKET_COUNT}>,
};

@group(0) @binding(0) var<storage, read_write> data: KaOffsets;

@compute @workgroup_size(1)
fn main() {
  var total = 0u;
  for (var bucket_index = 0u; bucket_index < ${MATERIAL_BUCKET_COUNT}u; bucket_index++) {
    let bucket_count = data.elements[bucket_index];
    data.elements[bucket_index] = total;
    total += bucket_count;
  }
}
`;

export const MESHLET_KA_JA_WGSL = /* wgsl */ `
${KA_COMMON_WGSL}

@group(0) @binding(0) var<storage, read> scene_database: array<u32>;
@group(0) @binding(1) var<storage, read> materials: array<EventDispatcher>;
@group(1) @binding(0) var<storage, read> input: KaMeshList;
@group(1) @binding(1) var<storage, read> output_count: array<u32, ${MATERIAL_BUCKET_COUNT}>;
@group(1) @binding(2) var<storage, read_write> output: KaBucketData;

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let input_index = global_id.x;
  let input_count = min(input.count, arrayLength(&input.elements));
  if (input_index >= input_count) {
    return;
  }

  let mesh_index = input.elements[input_index];
  let mesh = scene_read_mesh(&scene_database, mesh_index);
  let material = materials[mesh.material];
  let bucket_index = rasterization_material_bucket(
    material.transparency_mode,
    material.draw_mode,
    material.draw_side
  );
  let local_index = atomicAdd(&output.headers[bucket_index].count, 1u);
  let bucket_offset = output_count[bucket_index];
  if (local_index == 0u) {
    output.headers[bucket_index].offset = bucket_offset;
  }
  let output_index = bucket_offset + local_index;
  if (output_index < arrayLength(&output.elements)) {
    output.elements[output_index] = mesh_index;
  }
}
`;

export const MESHLET_KA_UB_WGSL = /* wgsl */ `
struct KaBucketParams {
  value: u32,
};

struct KaBucketHeader {
  count: u32,
  offset: u32,
};

struct KaBucketData {
  headers: array<KaBucketHeader, ${MATERIAL_BUCKET_COUNT}>,
  elements: array<u32>,
};

struct KaMeshOutput {
  count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  elements: array<u32>,
};

@group(0) @binding(0) var<uniform> bucket_index: KaBucketParams;
@group(0) @binding(1) var<storage, read> instance: KaBucketData;
@group(0) @binding(2) var<storage, read_write> output: KaMeshOutput;

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let input_index = global_id.x;
  let bucket = bucket_index.value;
  let source_offset = instance.headers[bucket].offset;
  let source_count = instance.headers[bucket].count;
  if (input_index == 0u) {
    output.count = source_count;
  }
  if (input_index >= source_count) {
    return;
  }
  let source_index = source_offset + input_index;
  if (source_index >= arrayLength(&instance.elements)) {
    return;
  }
  output.elements[input_index] = instance.elements[source_index];
}
`;

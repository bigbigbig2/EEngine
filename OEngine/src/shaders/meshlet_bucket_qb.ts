/**
 * meshlet_bucket_qb：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { MATERIAL_META_TYPE } from "../gpu/MaterialMetadataTable.js";
import { SCENE_DATABASE_READ_WGSL } from "../gpu/SceneDatabase.js";
import { MATERIAL_BUCKET_COUNT } from "../material/materialBucketId.js";
import { rasterizationMaterialBucketWgsl } from "./material_bucket_wgsl.js";

export const MESHLET_QB_EPW = 128;
export const MESHLET_QB_BUCKET_COUNT = MATERIAL_BUCKET_COUNT;
export const MESHLET_QB_HEADER_STRIDE_BYTES = 8;
export const MESHLET_QB_HEADERS_BYTES =
  MATERIAL_BUCKET_COUNT * MESHLET_QB_HEADER_STRIDE_BYTES;

const QB_COMMON_WGSL = /* wgsl */ `
${SCENE_DATABASE_READ_WGSL}
${MATERIAL_META_TYPE.wgsl_declaration}
${rasterizationMaterialBucketWgsl()}

const MATERIAL_BUCKET_COUNT: u32 = ${MATERIAL_BUCKET_COUNT}u;

struct MeshletRef {
  index: u32,
  mesh: u32,
};

struct MeshletList {
  count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  elements: array<MeshletRef>,
};

struct BucketCounts {
  counts: array<atomic<u32>, ${MATERIAL_BUCKET_COUNT}>,
};

struct MeshletBucketHeader {
  count: atomic<u32>,
  offset: u32,
};

struct MeshletBucketData {
  headers: array<MeshletBucketHeader, ${MATERIAL_BUCKET_COUNT}>,
  elements: array<MeshletRef>,
};
`;

export const MESHLET_QB_COUNT_WGSL = /* wgsl */ `
${QB_COMMON_WGSL}

var<workgroup> wg_buckets: array<atomic<u32>, ${MATERIAL_BUCKET_COUNT}>;

@group(0) @binding(0) var<storage, read> input: MeshletList;
@group(0) @binding(1) var<storage, read> scene_database: array<u32>;
@group(0) @binding(2) var<storage, read> materials: array<EventDispatcher>;
@group(0) @binding(3) var<storage, read_write> output: BucketCounts;

@compute @workgroup_size(${MESHLET_QB_EPW})
fn main(
  @builtin(global_invocation_id) global_id: vec3u,
  @builtin(local_invocation_index) local_id: u32
) {
  let input_index = global_id.x;
  let input_count = min(input.count, arrayLength(&input.elements));
  if (input_index < input_count) {
    let meshlet = input.elements[input_index];
    let mesh = scene_read_mesh(&scene_database, meshlet.mesh);
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

export const MESHLET_QB_SCATTER_WGSL = /* wgsl */ `
${QB_COMMON_WGSL}

@group(0) @binding(0) var<storage, read> scene_database: array<u32>;
@group(0) @binding(1) var<storage, read> materials: array<EventDispatcher>;
@group(0) @binding(2) var<storage, read> input: MeshletList;
@group(0) @binding(3) var<storage, read> output_count: array<u32, ${MATERIAL_BUCKET_COUNT}>;
@group(0) @binding(4) var<storage, read_write> output: MeshletBucketData;

@compute @workgroup_size(${MESHLET_QB_EPW})
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let input_index = global_id.x;
  let input_count = min(input.count, arrayLength(&input.elements));
  if (input_index >= input_count) {
    return;
  }

  let meshlet = input.elements[input_index];
  let mesh = scene_read_mesh(&scene_database, meshlet.mesh);
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
    output.elements[output_index] = meshlet;
  }
}
`;

export const MESHLET_QB_SLICE_WGSL = /* wgsl */ `
struct BucketParams {
  value: u32,
};

struct MeshletRef {
  index: u32,
  mesh: u32,
};

struct MeshletBucketHeader {
  count: u32,
  offset: u32,
};

struct MeshletBucketData {
  headers: array<MeshletBucketHeader, ${MATERIAL_BUCKET_COUNT}>,
  elements: array<MeshletRef>,
};

struct MeshletList {
  count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  elements: array<MeshletRef>,
};

@group(0) @binding(0) var<uniform> bucket_index: BucketParams;
@group(0) @binding(1) var<storage, read> instance: MeshletBucketData;
@group(0) @binding(2) var<storage, read_write> output: MeshletList;

@compute @workgroup_size(${MESHLET_QB_EPW})
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

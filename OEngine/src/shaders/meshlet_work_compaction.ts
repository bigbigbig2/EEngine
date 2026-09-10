import { counterByteOffset } from "../debug/GpuFrameCounters.js";
import {
  GPU_CLUSTER_RECORD_WGSL,
  GPU_GEOMETRY_RECORD_WGSL,
  GPU_GEOMETRY_VERTEX_DECODE_WGSL,
  GPU_MESHLET_RECORD_WGSL,
  GPU_POSITION_FORMAT
} from "../gpu/GpuGeometryAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import {
  GPU_MESHLET_BUCKET_COUNT,
  GPU_MESHLET_DRAW_COUNT,
  GPU_MESHLET_DECODE_PROFILE,
  GPU_MESHLET_RASTER_FLAGS,
  GPU_MESHLET_RISK_BUCKET_OFFSET,
  GPU_MESHLET_RASTER_WORK_RECORD_STRIDE,
  GPU_MESHLET_RASTER_WORK_WGSL
} from "../gpu/GpuMeshletRasterWorkAbi.js";
import {
  GPU_VISIBLE_CLUSTER_RECORD_SCHEMA,
  GPU_WORK_GENERATION_WGSL
} from "../gpu/GpuWorkGenerationAbi.js";
import { LPV_CAMERA_TYPE } from "./lpv_indirect_diffuse.js";

export const MESHLET_WORK_COMPACTION_WORKGROUP_SIZE = 64;
export const MESHLET_WORK_COMPACTION_SETTINGS_SIZE = 16;
export const MESHLET_WORK_BUCKET_STATE_SIZE = GPU_MESHLET_DRAW_COUNT * 16;
export const MESHLET_WORK_BUCKET_INDIRECT_SIZE = GPU_MESHLET_DRAW_COUNT * 16;

const COUNTER_MESHLET_WORKS = counterByteOffset("geometryMeshletWorksProduced") / 4;
const COUNTER_QUEUE_BYTES = counterByteOffset("geometryQueueBytes") / 4;
const COUNTER_ATTEMPTED = counterByteOffset("meshletQueueAttempted") / 4;
const COUNTER_WRITTEN = counterByteOffset("meshletQueueWritten") / 4;
const COUNTER_CONSUMED = counterByteOffset("meshletQueueConsumed") / 4;
const COUNTER_OVERFLOW = counterByteOffset("meshletQueueOverflow") / 4;
const COUNTER_INVALID = counterByteOffset("meshletQueueInvalid") / 4;
const COUNTER_NON_EMPTY_BUCKETS = counterByteOffset("meshletBucketNonEmpty") / 4;
const COUNTER_BUCKET_DRAWS = counterByteOffset("meshletBucketDraws") / 4;
const COUNTER_SUBGROUP_RESERVATIONS = counterByteOffset("meshletSubgroupReservations") / 4;
const COUNTER_PORTABLE_RESERVATIONS = counterByteOffset("meshletPortableReservations") / 4;
const COUNTER_INDIRECT_INSTANCES = counterByteOffset("meshletIndirectInstances") / 4;
const COUNTER_PADDED_VERTICES = counterByteOffset("geometryPaddedVertices") / 4;
const COUNTER_RASTER_TRIANGLES = counterByteOffset("meshletRasterTriangles") / 4;
const COUNTER_GEOMETRY_RASTER_TRIANGLES = counterByteOffset("geometryRasterTriangles") / 4;
const COUNTER_GEOMETRY_CANDIDATE_TRIANGLES = counterByteOffset("geometryCandidateTriangles") / 4;
const COUNTER_GEOMETRY_RISKY_TRIANGLES = counterByteOffset("geometryRiskyTriangles") / 4;
const COUNTER_GEOMETRY_EXACT_SURVIVED = counterByteOffset("geometryExactSurvivedTriangles") / 4;

export type MeshletWorkCompactionPath = "portable" | "subgroup";

const COMMON = /* wgsl */ `
${GPU_CLUSTER_RECORD_WGSL}
${GPU_GEOMETRY_RECORD_WGSL}
${GPU_GEOMETRY_VERTEX_DECODE_WGSL}
${GPU_MESHLET_RECORD_WGSL}
${GPU_INSTANCE_RECORD_WGSL}
${LPV_CAMERA_TYPE.wgsl_declaration}
${GPU_WORK_GENERATION_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}

struct OEngineCandidateVisibleHeaderRead {
  written: u32,
  attempted: u32,
  peak: u32,
  overflow: u32,
  fallback: u32,
  capacity: u32,
  rejected_cone: u32,
  rejected_hzb: u32,
};
struct OEngineVisibleClusterQueueRead {
  header: OEngineCandidateVisibleHeaderRead,
  elements: array<OEngineVisibleClusterRecord>,
};
struct OEngineMeshletCandidateSettings {
  max_workgroups_per_dimension: u32,
  counters_enabled: u32,
  indirect_first_instance: u32,
  reserved: u32,
};
struct OEngineMeshletDispatchArgs { x: u32, y: u32, z: u32 };
struct OEngineMeshletBucketState {
  count: atomic<u32>,
  base: u32,
  cursor: atomic<u32>,
  overflow: atomic<u32>,
};
struct OEngineDrawIndirectArgs {
  vertex_count: u32,
  instance_count: u32,
  first_vertex: u32,
  first_instance: u32,
};

@group(0) @binding(0) var<storage, read> candidate_visible: OEngineVisibleClusterQueueRead;
@group(0) @binding(1) var<storage, read> candidate_clusters: array<GpuClusterRecord>;
@group(0) @binding(2) var<storage, read> candidate_geometries: array<GpuGeometryRecord>;
@group(0) @binding(3) var<storage, read> candidate_meshlets: array<GpuMeshletRecord>;
@group(0) @binding(4) var<storage, read_write> candidate_staging: OEngineMeshletWorkQueue;
@group(0) @binding(5) var<storage, read_write> candidate_dispatch: OEngineMeshletDispatchArgs;
@group(0) @binding(6) var<uniform> candidate_settings: OEngineMeshletCandidateSettings;
@group(0) @binding(7) var<storage, read_write> candidate_counters: array<atomic<u32>>;
@group(0) @binding(8) var<storage, read_write> candidate_buckets: array<OEngineMeshletBucketState>;
@group(0) @binding(9) var<storage, read_write> candidate_bucketed: OEngineMeshletWorkQueue;
@group(0) @binding(10) var<storage, read_write> candidate_indirect: array<OEngineDrawIndirectArgs>;

var<workgroup> candidate_prefix: array<u32, ${MESHLET_WORK_COMPACTION_WORKGROUP_SIZE}>;
var<workgroup> candidate_group_base: u32;

fn candidate_next_generation(current: u32) -> u32 {
  let next = current + 1u;
  return select(next, 1u, next == 0u);
}
fn candidate_set_dispatch(item_count: u32) {
  let groups = (item_count + ${MESHLET_WORK_COMPACTION_WORKGROUP_SIZE - 1}u) /
    ${MESHLET_WORK_COMPACTION_WORKGROUP_SIZE}u;
  candidate_dispatch.x = min(groups, candidate_settings.max_workgroups_per_dimension);
  candidate_dispatch.y = max((groups + candidate_settings.max_workgroups_per_dimension - 1u) /
    candidate_settings.max_workgroups_per_dimension, 1u);
  candidate_dispatch.z = 1u;
}
fn candidate_reserve(count: u32) -> u32 {
  atomicAdd(&candidate_staging.header.attempted_count, count);
  var observed = atomicLoad(&candidate_staging.header.written_count);
  loop {
    if count == 0u || count > candidate_staging.header.capacity -
      min(observed, candidate_staging.header.capacity) {
      atomicAdd(&candidate_staging.header.overflow_count, count);
      return 0xffffffffu;
    }
    let result = atomicCompareExchangeWeak(&candidate_staging.header.written_count,
      observed, observed + count);
    if result.exchanged { return observed; }
    observed = result.old_value;
  }
}
fn candidate_bucket_key(triangle_count: u32, profile: u32, flags: u32) -> u32 {
  let capacity_class = select(select(select(3u, 2u, triangle_count <= 96u), 1u,
    triangle_count <= 64u), 0u, triangle_count <= 32u);
  let profile_class = select(1u, 0u,
    profile == ${GPU_MESHLET_DECODE_PROFILE.StaticPbrCompactV2}u);
  let raster_class = select(0u, 1u,
    (flags & ${GPU_MESHLET_RASTER_FLAGS.DoubleSided}u) != 0u);
  let coverage_class = select(0u, 1u,
    (flags & ${GPU_MESHLET_RASTER_FLAGS.AlphaTested}u) != 0u);
  return capacity_class | (profile_class << 2u) |
    (raster_class << 3u) | (coverage_class << 4u);
}
fn candidate_triangle_capacity(bucket: u32) -> u32 {
  return array<u32, 4>(32u, 64u, 96u, 128u)[bucket & 3u];
}

@compute @workgroup_size(1)
fn prepare_meshlet_work_candidate() {
  atomicStore(&candidate_staging.header.attempted_count, 0u);
  atomicStore(&candidate_staging.header.written_count, 0u);
  atomicStore(&candidate_staging.header.consumed_count, 0u);
  atomicStore(&candidate_staging.header.overflow_count, 0u);
  atomicStore(&candidate_staging.header.invalid_count, 0u);
  let generation = candidate_next_generation(atomicLoad(&candidate_staging.header.generation));
  atomicStore(&candidate_staging.header.generation, generation);
  atomicStore(&candidate_bucketed.header.attempted_count, 0u);
  atomicStore(&candidate_bucketed.header.written_count, 0u);
  atomicStore(&candidate_bucketed.header.consumed_count, 0u);
  atomicStore(&candidate_bucketed.header.overflow_count, 0u);
  atomicStore(&candidate_bucketed.header.invalid_count, 0u);
  atomicStore(&candidate_bucketed.header.generation, generation);
  let visible_count = min(candidate_visible.header.written, candidate_visible.header.capacity);
  candidate_dispatch.x = min(visible_count, candidate_settings.max_workgroups_per_dimension);
  candidate_dispatch.y = max((visible_count + candidate_settings.max_workgroups_per_dimension - 1u) /
    candidate_settings.max_workgroups_per_dimension, 1u);
  candidate_dispatch.z = 1u;
  for (var bucket = 0u; bucket < ${GPU_MESHLET_DRAW_COUNT}u; bucket++) {
    atomicStore(&candidate_buckets[bucket].count, 0u);
    candidate_buckets[bucket].base = 0u;
    atomicStore(&candidate_buckets[bucket].cursor, 0u);
    atomicStore(&candidate_buckets[bucket].overflow, 0u);
    candidate_indirect[bucket] = OEngineDrawIndirectArgs(0u, 0u, 0u, 0u);
  }
}
`;

const GENERATE_HEAD = /* wgsl */ `fn generate_meshlet_work_candidate(
  @builtin(local_invocation_index) lane: u32,
  @builtin(workgroup_id) group: vec3u,
  @builtin(num_workgroups) grid: vec3u`;
const GENERATE_PREFIX = /* wgsl */ `) {
  let visible_count = min(candidate_visible.header.written, candidate_visible.header.capacity);
  let visible_index = group.x + group.y * grid.x;
  if visible_index >= visible_count { return; }
  let visible = candidate_visible.elements[visible_index];
  if visible.cluster_record_index >= arrayLength(&candidate_clusters) ||
      visible.geometry_record_index >= arrayLength(&candidate_geometries) {
    if lane == 0u { atomicAdd(&candidate_staging.header.invalid_count, 1u); }
    return;
  }
  let cluster = candidate_clusters[visible.cluster_record_index];
  let geometry = candidate_geometries[visible.geometry_record_index];
  let profile = select(${GPU_MESHLET_DECODE_PROFILE.ExplicitFloat32FallbackV2}u,
    ${GPU_MESHLET_DECODE_PROFILE.StaticPbrCompactV2}u,
    geometry.position_format == ${GPU_POSITION_FORMAT.AabbUnorm16x3}u);
  for (var tile = 0u; tile < cluster.meshlet_count;
    tile += ${MESHLET_WORK_COMPACTION_WORKGROUP_SIZE}u) {
    let local_meshlet = tile + lane;
    let meshlet_slot = cluster.meshlet_begin + local_meshlet;
    var valid = local_meshlet < cluster.meshlet_count &&
      meshlet_slot < arrayLength(&candidate_meshlets);
    if local_meshlet < cluster.meshlet_count && !valid {
      atomicAdd(&candidate_staging.header.invalid_count, 1u);
    }
    if valid {
      let triangle_count = candidate_meshlets[meshlet_slot].triangle_count;
      if triangle_count == 0u || triangle_count > 128u {
        valid = false;
        atomicAdd(&candidate_staging.header.invalid_count, 1u);
      }
    }
`;
const GENERATE_SUFFIX = /* wgsl */ `
    if valid && candidate_group_base != 0xffffffffu {
      let meshlet = candidate_meshlets[meshlet_slot];
      let bucket = candidate_bucket_key(meshlet.triangle_count, profile, visible.raster_flags);
      let packed = profile | (min(cluster.depth, 255u) << 8u) | (bucket << 16u);
      candidate_staging.elements[candidate_group_base + candidate_local_prefix] =
        OEngineMeshletRasterWork(visible.instance_record_index,
          visible.geometry_record_index, meshlet_slot, visible.material_handle,
          visible.raster_flags, packed);
    }
    workgroupBarrier();
  }
}
`;

const PORTABLE_COMPACT = /* wgsl */ `
    candidate_prefix[lane] = select(0u, 1u, valid);
    workgroupBarrier();
    for (var offset = 1u; offset < ${MESHLET_WORK_COMPACTION_WORKGROUP_SIZE}u; offset <<= 1u) {
      var addend = 0u;
      if lane >= offset { addend = candidate_prefix[lane - offset]; }
      workgroupBarrier();
      candidate_prefix[lane] += addend;
      workgroupBarrier();
    }
    let candidate_local_prefix = candidate_prefix[lane] - select(0u, 1u, valid);
    if lane == 0u {
      let total = candidate_prefix[${MESHLET_WORK_COMPACTION_WORKGROUP_SIZE - 1}u];
      candidate_group_base = candidate_reserve(total);
      if total > 0u && candidate_settings.counters_enabled != 0u {
        atomicAdd(&candidate_counters[${COUNTER_PORTABLE_RESERVATIONS}u], 1u);
      }
    }
    workgroupBarrier();
`;

const SUBGROUP_DECLARATIONS = /* wgsl */ `
var<workgroup> candidate_subgroup_count: array<u32, ${MESHLET_WORK_COMPACTION_WORKGROUP_SIZE}>;
var<workgroup> candidate_subgroup_base: array<u32, ${MESHLET_WORK_COMPACTION_WORKGROUP_SIZE}>;
var<workgroup> candidate_subgroup_allocator: atomic<u32>;
`;
const SUBGROUP_COMPACT = /* wgsl */ `
    if lane == 0u { atomicStore(&candidate_subgroup_allocator, 0u); }
    workgroupBarrier();
    let ballot = subgroupBallot(valid);
    let subgroup_count = countOneBits(ballot.x) + countOneBits(ballot.y) +
      countOneBits(ballot.z) + countOneBits(ballot.w);
    var subgroup_ordinal = 0u;
    if subgroup_invocation_id == 0u {
      subgroup_ordinal = atomicAdd(&candidate_subgroup_allocator, 1u);
      candidate_subgroup_count[subgroup_ordinal] = subgroup_count;
    }
    subgroup_ordinal = subgroupBroadcastFirst(subgroup_ordinal);
    workgroupBarrier();
    if lane == 0u {
      let subgroup_total = atomicLoad(&candidate_subgroup_allocator);
      var total = 0u;
      for (var index = 0u; index < subgroup_total; index++) {
        candidate_subgroup_base[index] = total;
        total += candidate_subgroup_count[index];
      }
      candidate_group_base = candidate_reserve(total);
      if total > 0u && candidate_settings.counters_enabled != 0u {
        atomicAdd(&candidate_counters[${COUNTER_SUBGROUP_RESERVATIONS}u], 1u);
      }
    }
    workgroupBarrier();
    var candidate_local_prefix = candidate_subgroup_base[subgroup_ordinal];
    let subgroup_word = subgroup_invocation_id >> 5u;
    let subgroup_bit = subgroup_invocation_id & 31u;
    for (var word = 0u; word < subgroup_word; word++) {
      candidate_local_prefix += countOneBits(ballot[word]);
    }
    let lower_mask = select(0u, (1u << subgroup_bit) - 1u, subgroup_bit != 0u);
    candidate_local_prefix += countOneBits(ballot[subgroup_word] & lower_mask);
    workgroupBarrier();
`;

const RISK_CLASSIFICATION = /* wgsl */ `
@group(1) @binding(0) var<uniform> risk_camera: CommandEncoder;
@group(1) @binding(1) var<uniform> risk_settings: OEngineMeshletCandidateSettings;
@group(1) @binding(2) var<storage, read_write> risk_work: OEngineMeshletWorkQueue;
@group(1) @binding(3) var<storage, read> risk_instances: array<OEngineInstanceRecord>;
@group(1) @binding(4) var<storage, read> risk_geometries: array<GpuGeometryRecord>;
@group(1) @binding(5) var<storage, read> risk_meshlets: array<GpuMeshletRecord>;
@group(1) @binding(6) var<storage, read> risk_meshlet_vertices: array<u32>;
@group(1) @binding(7) var<storage, read> risk_meshlet_triangles: array<u32>;
@group(1) @binding(8) var<storage, read> risk_vertex_data: array<u32>;
@group(1) @binding(9) var<storage, read_write> risk_buckets: array<OEngineMeshletBucketState>;
@group(1) @binding(10) var<storage, read_write> risk_counters: array<atomic<u32>>;

fn risk_read_u8(byte_offset: u32) -> u32 {
  let word = risk_meshlet_triangles[byte_offset >> 2u];
  return (word >> ((byte_offset & 3u) * 8u)) & 0xffu;
}

fn risk_finite(value: vec4f) -> bool {
  return all(value == value) && all(abs(value) <= vec4f(3.402823466e+38));
}

fn risk_orientation(a: vec4f, b: vec4f, c: vec4f) -> f32 {
  return a.x * (b.y * c.w - b.w * c.y) -
    a.y * (b.x * c.w - b.w * c.x) +
    a.w * (b.x * c.y - b.y * c.x);
}

fn risk_near_clip_boundary(value: vec4f) -> bool {
  let scale = max(abs(value.w), 1.0);
  let epsilon = scale * 1e-5;
  return value.w <= epsilon || value.z <= epsilon ||
    abs(value.w - value.z) <= epsilon ||
    abs(value.w - abs(value.x)) <= epsilon ||
    abs(value.w - abs(value.y)) <= epsilon;
}

fn risk_triangle_requires_exact(
  instance: OEngineInstanceRecord,
  geometry: GpuGeometryRecord,
  meshlet: GpuMeshletRecord,
  triangle: u32
) -> bool {
  let triangle_byte = meshlet.triangle_byte_offset + triangle * 3u;
  let local0 = risk_read_u8(triangle_byte);
  let local1 = risk_read_u8(triangle_byte + 1u);
  let local2 = risk_read_u8(triangle_byte + 2u);
  if local0 >= meshlet.vertex_count || local1 >= meshlet.vertex_count ||
      local2 >= meshlet.vertex_count {
    return true;
  }
  let source0 = risk_meshlet_vertices[meshlet.vertex_offset + local0];
  let source1 = risk_meshlet_vertices[meshlet.vertex_offset + local1];
  let source2 = risk_meshlet_vertices[meshlet.vertex_offset + local2];
  if source0 >= geometry.vertex_count || source1 >= geometry.vertex_count ||
      source2 >= geometry.vertex_count {
    return true;
  }
  let transform = risk_camera.view_projection_matrix *
    oengine_instance_current_object_to_world(instance);
  let a = transform * vec4f(oengine_geometry_position(&risk_vertex_data, geometry, source0), 1.0);
  let b = transform * vec4f(oengine_geometry_position(&risk_vertex_data, geometry, source1), 1.0);
  let c = transform * vec4f(oengine_geometry_position(&risk_vertex_data, geometry, source2), 1.0);
  if !risk_finite(a) || !risk_finite(b) || !risk_finite(c) { return true; }
  if risk_near_clip_boundary(a) || risk_near_clip_boundary(b) ||
      risk_near_clip_boundary(c) { return true; }
  return abs(risk_orientation(a, b, c)) <= 1e-20;
}

@compute @workgroup_size(1)
fn prepare_meshlet_risk_dispatch() {
  candidate_set_dispatch(min(atomicLoad(&candidate_staging.header.written_count),
    candidate_staging.header.capacity));
}

@compute @workgroup_size(${MESHLET_WORK_COMPACTION_WORKGROUP_SIZE})
fn classify_meshlet_projection_risk(
  @builtin(global_invocation_id) id: vec3u,
  @builtin(num_workgroups) grid: vec3u
) {
  let linear = id.x + id.y * grid.x * ${MESHLET_WORK_COMPACTION_WORKGROUP_SIZE}u;
  let written = min(atomicLoad(&risk_work.header.written_count), risk_work.header.capacity);
  if linear >= written { return; }
  var work = risk_work.elements[linear];
  var risky = (work.packed_raster_flags & (${GPU_MESHLET_RASTER_FLAGS.ForceExact >>> 0}u |
    ${GPU_MESHLET_RASTER_FLAGS.AlphaTested}u)) != 0u;
  if work.instance_slot >= arrayLength(&risk_instances) ||
      work.geometry_slot >= arrayLength(&risk_geometries) ||
      work.meshlet_slot >= arrayLength(&risk_meshlets) {
    atomicAdd(&risk_work.header.invalid_count, 1u);
    risky = true;
  } else {
    let instance = risk_instances[work.instance_slot];
    let geometry = risk_geometries[work.geometry_slot];
    let meshlet = risk_meshlets[work.meshlet_slot];
    for (var triangle = 0u; triangle < meshlet.triangle_count && !risky; triangle++) {
      risky = risk_triangle_requires_exact(instance, geometry, meshlet, triangle);
    }
    let bucket = (work.packed_profile_lod >> 16u) & 0xffu;
    if bucket >= ${GPU_MESHLET_BUCKET_COUNT}u {
      atomicAdd(&risk_work.header.invalid_count, 1u);
      risky = true;
    } else {
      let route_bucket = bucket + select(0u, ${GPU_MESHLET_RISK_BUCKET_OFFSET}u, risky);
      atomicAdd(&risk_buckets[route_bucket].count, 1u);
      if risky {
        work.packed_raster_flags |= ${GPU_MESHLET_RASTER_FLAGS.SelectiveExact}u;
      }
      risk_work.elements[linear] = work;
      if risk_settings.counters_enabled != 0u {
        atomicAdd(&risk_counters[${COUNTER_GEOMETRY_CANDIDATE_TRIANGLES}u], meshlet.triangle_count);
        atomicAdd(&risk_counters[${COUNTER_RASTER_TRIANGLES}u], meshlet.triangle_count);
        atomicAdd(&risk_counters[${COUNTER_PADDED_VERTICES}u],
          (candidate_triangle_capacity(bucket) - meshlet.triangle_count) * 3u);
        if risky {
          atomicAdd(&risk_counters[${COUNTER_GEOMETRY_RISKY_TRIANGLES}u], meshlet.triangle_count);
          atomicAdd(&risk_counters[${COUNTER_GEOMETRY_EXACT_SURVIVED}u], meshlet.triangle_count);
        }
      }
    }
  }
}
`;

const FINAL_STAGES = /* wgsl */ `
@compute @workgroup_size(${GPU_MESHLET_DRAW_COUNT})
fn finalize_meshlet_work_buckets(@builtin(local_invocation_index) bucket: u32) {
  let count = atomicLoad(&candidate_buckets[bucket].count);
  let correctness_failure = atomicLoad(&candidate_staging.header.overflow_count) != 0u ||
    atomicLoad(&candidate_staging.header.invalid_count) != 0u;
  var base = 0u;
  for (var prior = 0u; prior < bucket; prior++) {
    base += atomicLoad(&candidate_buckets[prior].count);
  }
  candidate_buckets[bucket].base = base;
  atomicStore(&candidate_buckets[bucket].cursor, 0u);
  candidate_indirect[bucket] = OEngineDrawIndirectArgs(
    candidate_triangle_capacity(bucket % ${GPU_MESHLET_BUCKET_COUNT}u) * 3u,
    select(count, 0u, correctness_failure), 0u,
    select(0u, base, candidate_settings.indirect_first_instance != 0u));
  if bucket == ${GPU_MESHLET_DRAW_COUNT - 1}u {
    let written = min(atomicLoad(&candidate_staging.header.written_count),
      candidate_staging.header.capacity);
    atomicStore(&candidate_bucketed.header.attempted_count,
      atomicLoad(&candidate_staging.header.attempted_count));
    atomicStore(&candidate_bucketed.header.written_count, written);
    atomicStore(&candidate_bucketed.header.overflow_count,
      atomicLoad(&candidate_staging.header.overflow_count));
    atomicStore(&candidate_bucketed.header.invalid_count,
      atomicLoad(&candidate_staging.header.invalid_count));
    candidate_set_dispatch(written);
  }
}

@compute @workgroup_size(${MESHLET_WORK_COMPACTION_WORKGROUP_SIZE})
fn scatter_meshlet_work_buckets(
  @builtin(global_invocation_id) id: vec3u,
  @builtin(num_workgroups) grid: vec3u
) {
  let linear = id.x + id.y * grid.x * ${MESHLET_WORK_COMPACTION_WORKGROUP_SIZE}u;
  let written = min(atomicLoad(&candidate_staging.header.written_count),
    candidate_staging.header.capacity);
  if linear >= written { return; }
  let work = candidate_staging.elements[linear];
  var bucket = (work.packed_profile_lod >> 16u) & 0xffu;
  if bucket >= ${GPU_MESHLET_BUCKET_COUNT}u {
    atomicAdd(&candidate_bucketed.header.invalid_count, 1u);
    return;
  }
  if (work.packed_raster_flags & ${GPU_MESHLET_RASTER_FLAGS.SelectiveExact}u) != 0u {
    bucket += ${GPU_MESHLET_RISK_BUCKET_OFFSET}u;
  }
  let local = atomicAdd(&candidate_buckets[bucket].cursor, 1u);
  let count = atomicLoad(&candidate_buckets[bucket].count);
  let destination = candidate_buckets[bucket].base + local;
  if local >= count || destination >= candidate_bucketed.header.capacity {
    atomicAdd(&candidate_buckets[bucket].overflow, 1u);
    atomicAdd(&candidate_bucketed.header.invalid_count, 1u);
    return;
  }
  candidate_bucketed.elements[destination] = work;
}

@compute @workgroup_size(1)
fn prepare_meshlet_work_validation() {
  candidate_set_dispatch(min(atomicLoad(&candidate_bucketed.header.written_count),
    candidate_bucketed.header.capacity));
}

@compute @workgroup_size(${MESHLET_WORK_COMPACTION_WORKGROUP_SIZE})
fn validate_meshlet_work_candidate(
  @builtin(global_invocation_id) id: vec3u,
  @builtin(num_workgroups) grid: vec3u
) {
  let linear = id.x + id.y * grid.x * ${MESHLET_WORK_COMPACTION_WORKGROUP_SIZE}u;
  let written = min(atomicLoad(&candidate_bucketed.header.written_count),
    candidate_bucketed.header.capacity);
  if linear >= written { return; }
  let work = candidate_bucketed.elements[linear];
  let bucket = (work.packed_profile_lod >> 16u) & 0xffu;
  var valid = atomicLoad(&candidate_bucketed.header.generation) != 0u &&
    bucket < ${GPU_MESHLET_BUCKET_COUNT}u &&
    work.geometry_slot < arrayLength(&candidate_geometries) &&
    work.meshlet_slot < arrayLength(&candidate_meshlets) &&
    work.material_slot_or_range != 0xffffffffu;
  if valid {
    let geometry = candidate_geometries[work.geometry_slot];
    let meshlet = candidate_meshlets[work.meshlet_slot];
    valid = work.meshlet_slot >= geometry.meshlet_begin &&
      work.meshlet_slot < geometry.meshlet_begin + geometry.meshlet_count &&
      candidate_bucket_key(meshlet.triangle_count, work.packed_profile_lod & 0xffu,
        work.packed_raster_flags) == bucket;
  }
  atomicAdd(&candidate_bucketed.header.consumed_count, 1u);
  if !valid { atomicAdd(&candidate_bucketed.header.invalid_count, 1u); }
}

@compute @workgroup_size(1)
fn publish_meshlet_work_candidate_counters() {
  let attempted = atomicLoad(&candidate_bucketed.header.attempted_count);
  let written = atomicLoad(&candidate_bucketed.header.written_count);
  let consumed = atomicLoad(&candidate_bucketed.header.consumed_count);
  let overflow = atomicLoad(&candidate_bucketed.header.overflow_count);
  var invalid = atomicLoad(&candidate_bucketed.header.invalid_count);
  var non_empty = 0u;
  var indirect_instances = 0u;
  for (var bucket = 0u; bucket < ${GPU_MESHLET_DRAW_COUNT}u; bucket++) {
    non_empty += select(0u, 1u, atomicLoad(&candidate_buckets[bucket].count) > 0u);
    indirect_instances += candidate_indirect[bucket].instance_count;
    invalid += atomicLoad(&candidate_buckets[bucket].overflow);
  }
  if overflow != 0u || invalid != 0u {
    for (var bucket = 0u; bucket < ${GPU_MESHLET_DRAW_COUNT}u; bucket++) {
      candidate_indirect[bucket].instance_count = 0u;
    }
  }
  if candidate_settings.counters_enabled == 0u { return; }
  atomicAdd(&candidate_counters[${COUNTER_MESHLET_WORKS}u], written);
  atomicAdd(&candidate_counters[${COUNTER_QUEUE_BYTES}u],
    written * ${GPU_MESHLET_RASTER_WORK_RECORD_STRIDE}u);
  atomicAdd(&candidate_counters[${COUNTER_ATTEMPTED}u], attempted);
  atomicAdd(&candidate_counters[${COUNTER_WRITTEN}u], written);
  atomicAdd(&candidate_counters[${COUNTER_CONSUMED}u], consumed);
  atomicAdd(&candidate_counters[${COUNTER_OVERFLOW}u], overflow);
  atomicAdd(&candidate_counters[${COUNTER_INVALID}u], invalid);
  atomicAdd(&candidate_counters[${COUNTER_NON_EMPTY_BUCKETS}u], non_empty);
  atomicAdd(&candidate_counters[${COUNTER_BUCKET_DRAWS}u], ${GPU_MESHLET_DRAW_COUNT}u);
  atomicAdd(&candidate_counters[${COUNTER_INDIRECT_INSTANCES}u], indirect_instances);
  if overflow != 0u || invalid != 0u {
    atomicStore(&candidate_counters[${COUNTER_RASTER_TRIANGLES}u], 0u);
    atomicStore(&candidate_counters[${COUNTER_PADDED_VERTICES}u], 0u);
  } else {
    atomicAdd(&candidate_counters[${COUNTER_GEOMETRY_RASTER_TRIANGLES}u],
      atomicLoad(&candidate_counters[${COUNTER_RASTER_TRIANGLES}u]));
  }
}
`;

export function meshletWorkCompactionWgsl(path: MeshletWorkCompactionPath): string {
  if (path === "subgroup") {
    return `enable subgroups;\n${COMMON}\n${SUBGROUP_DECLARATIONS}\n@compute @workgroup_size(${MESHLET_WORK_COMPACTION_WORKGROUP_SIZE})\n${GENERATE_HEAD},\n  @builtin(subgroup_invocation_id) subgroup_invocation_id: u32\n${GENERATE_PREFIX}${SUBGROUP_COMPACT}${GENERATE_SUFFIX}${RISK_CLASSIFICATION}${FINAL_STAGES}`;
  }
  return `${COMMON}\n@compute @workgroup_size(${MESHLET_WORK_COMPACTION_WORKGROUP_SIZE})\n${GENERATE_HEAD}\n${GENERATE_PREFIX}${PORTABLE_COMPACT}${GENERATE_SUFFIX}${RISK_CLASSIFICATION}${FINAL_STAGES}`;
}

export const MESHLET_WORK_COMPACTION_PORTABLE_WGSL = meshletWorkCompactionWgsl("portable");
export const MESHLET_WORK_COMPACTION_SUBGROUP_WGSL = meshletWorkCompactionWgsl("subgroup");
export const MESHLET_WORK_COMPACTION_VISIBLE_RECORD_STRIDE =
  GPU_VISIBLE_CLUSTER_RECORD_SCHEMA.stride;

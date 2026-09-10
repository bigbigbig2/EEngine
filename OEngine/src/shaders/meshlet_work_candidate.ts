import { counterByteOffset } from "../debug/GpuFrameCounters.js";
import {
  GPU_CLUSTER_RECORD_WGSL,
  GPU_GEOMETRY_RECORD_WGSL,
  GPU_MESHLET_RECORD_WGSL,
  GPU_POSITION_FORMAT
} from "../gpu/GpuGeometryAbi.js";
import {
  GPU_MESHLET_DECODE_PROFILE,
  GPU_MESHLET_RASTER_WORK_RECORD_STRIDE,
  GPU_MESHLET_RASTER_WORK_WGSL
} from "../gpu/GpuMeshletRasterWorkAbi.js";
import {
  GPU_VISIBLE_CLUSTER_RECORD_SCHEMA,
  GPU_WORK_GENERATION_WGSL
} from "../gpu/GpuWorkGenerationAbi.js";

export const MESHLET_WORK_CANDIDATE_WORKGROUP_SIZE = 64;
export const MESHLET_WORK_CANDIDATE_SETTINGS_SIZE = 16;

const COUNTER_MESHLET_WORKS = counterByteOffset("geometryMeshletWorksProduced") / 4;
const COUNTER_QUEUE_BYTES = counterByteOffset("geometryQueueBytes") / 4;
const COUNTER_ATTEMPTED = counterByteOffset("meshletQueueAttempted") / 4;
const COUNTER_WRITTEN = counterByteOffset("meshletQueueWritten") / 4;
const COUNTER_CONSUMED = counterByteOffset("meshletQueueConsumed") / 4;
const COUNTER_OVERFLOW = counterByteOffset("meshletQueueOverflow") / 4;
const COUNTER_INVALID = counterByteOffset("meshletQueueInvalid") / 4;

/**
 * Step-1 candidate source of truth. This portable all-or-nothing producer is
 * intentionally replaced by the subgroup/workgroup compact variants in Step 2.
 */
export const MESHLET_WORK_CANDIDATE_WGSL = /* wgsl */ `
${GPU_CLUSTER_RECORD_WGSL}
${GPU_GEOMETRY_RECORD_WGSL}
${GPU_MESHLET_RECORD_WGSL}
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
  reserved0: u32,
  reserved1: u32,
};

struct OEngineMeshletDispatchArgs {
  x: u32,
  y: u32,
  z: u32,
};

@group(0) @binding(0) var<storage, read> candidate_visible: OEngineVisibleClusterQueueRead;
@group(0) @binding(1) var<storage, read> candidate_clusters: array<GpuClusterRecord>;
@group(0) @binding(2) var<storage, read> candidate_geometries: array<GpuGeometryRecord>;
@group(0) @binding(3) var<storage, read> candidate_meshlets: array<GpuMeshletRecord>;
@group(0) @binding(4) var<storage, read_write> candidate_output: OEngineMeshletWorkQueue;
@group(0) @binding(5) var<storage, read_write> candidate_dispatch: OEngineMeshletDispatchArgs;
@group(0) @binding(6) var<uniform> candidate_settings: OEngineMeshletCandidateSettings;
@group(0) @binding(7) var<storage, read_write> candidate_counters: array<atomic<u32>>;

var<workgroup> candidate_group_base: u32;

fn candidate_next_generation(current: u32) -> u32 {
  let next = current + 1u;
  return select(next, 1u, next == 0u);
}

fn candidate_set_dispatch(item_count: u32) {
  let group_count = (item_count + ${MESHLET_WORK_CANDIDATE_WORKGROUP_SIZE - 1}u) /
    ${MESHLET_WORK_CANDIDATE_WORKGROUP_SIZE}u;
  candidate_dispatch.x = min(group_count, candidate_settings.max_workgroups_per_dimension);
  candidate_dispatch.y = max(
    (group_count + candidate_settings.max_workgroups_per_dimension - 1u) /
      candidate_settings.max_workgroups_per_dimension,
    1u
  );
  candidate_dispatch.z = 1u;
}

fn candidate_reserve(count: u32) -> u32 {
  atomicAdd(&candidate_output.header.attempted_count, count);
  var observed = atomicLoad(&candidate_output.header.written_count);
  loop {
    if count == 0u || count > candidate_output.header.capacity -
      min(observed, candidate_output.header.capacity) {
      atomicAdd(&candidate_output.header.overflow_count, count);
      return 0xffffffffu;
    }
    let next = observed + count;
    let result = atomicCompareExchangeWeak(
      &candidate_output.header.written_count,
      observed,
      next
    );
    if result.exchanged { return observed; }
    observed = result.old_value;
  }
}

@compute @workgroup_size(1)
fn prepare_meshlet_work_candidate() {
  atomicStore(&candidate_output.header.attempted_count, 0u);
  atomicStore(&candidate_output.header.written_count, 0u);
  atomicStore(&candidate_output.header.consumed_count, 0u);
  atomicStore(&candidate_output.header.overflow_count, 0u);
  atomicStore(&candidate_output.header.invalid_count, 0u);
  atomicStore(
    &candidate_output.header.generation,
    candidate_next_generation(atomicLoad(&candidate_output.header.generation))
  );
  let visible_count = min(candidate_visible.header.written, candidate_visible.header.capacity);
  candidate_dispatch.x = min(visible_count, candidate_settings.max_workgroups_per_dimension);
  candidate_dispatch.y = max(
    (visible_count + candidate_settings.max_workgroups_per_dimension - 1u) /
      candidate_settings.max_workgroups_per_dimension,
    1u
  );
  candidate_dispatch.z = 1u;
}

@compute @workgroup_size(${MESHLET_WORK_CANDIDATE_WORKGROUP_SIZE})
fn generate_meshlet_work_candidate(
  @builtin(local_invocation_index) lane: u32,
  @builtin(workgroup_id) group: vec3u,
  @builtin(num_workgroups) grid: vec3u
) {
  let visible_count = min(candidate_visible.header.written, candidate_visible.header.capacity);
  let visible_index = group.x + group.y * grid.x;
  if visible_index >= visible_count { return; }
  let visible = candidate_visible.elements[visible_index];
  if visible.cluster_record_index >= arrayLength(&candidate_clusters) ||
      visible.geometry_record_index >= arrayLength(&candidate_geometries) {
    if lane == 0u { atomicAdd(&candidate_output.header.invalid_count, 1u); }
    return;
  }
  let cluster = candidate_clusters[visible.cluster_record_index];
  let geometry = candidate_geometries[visible.geometry_record_index];
  if lane == 0u {
    candidate_group_base = candidate_reserve(cluster.meshlet_count);
  }
  workgroupBarrier();
  if candidate_group_base == 0xffffffffu { return; }
  let profile = select(
    ${GPU_MESHLET_DECODE_PROFILE.ExplicitFloat32FallbackV2}u,
    ${GPU_MESHLET_DECODE_PROFILE.StaticPbrCompactV2}u,
    geometry.position_format == ${GPU_POSITION_FORMAT.AabbUnorm16x3}u
  );
  let packed_profile_lod = profile | (min(cluster.depth, 255u) << 8u);
  for (var local_meshlet = lane; local_meshlet < cluster.meshlet_count;
    local_meshlet += ${MESHLET_WORK_CANDIDATE_WORKGROUP_SIZE}u) {
    let meshlet_slot = cluster.meshlet_begin + local_meshlet;
    candidate_output.elements[candidate_group_base + local_meshlet] =
      OEngineMeshletRasterWork(
        visible.instance_record_index,
        visible.geometry_record_index,
        meshlet_slot,
        visible.material_handle,
        visible.raster_flags,
        packed_profile_lod
      );
  }
}

@compute @workgroup_size(1)
fn prepare_meshlet_work_validation() {
  candidate_set_dispatch(min(
    atomicLoad(&candidate_output.header.written_count),
    candidate_output.header.capacity
  ));
}

@compute @workgroup_size(${MESHLET_WORK_CANDIDATE_WORKGROUP_SIZE})
fn validate_meshlet_work_candidate(
  @builtin(global_invocation_id) id: vec3u,
  @builtin(num_workgroups) grid: vec3u
) {
  let linear = id.x + id.y * grid.x * ${MESHLET_WORK_CANDIDATE_WORKGROUP_SIZE}u;
  let written = min(
    atomicLoad(&candidate_output.header.written_count),
    candidate_output.header.capacity
  );
  if linear >= written { return; }
  let work = candidate_output.elements[linear];
  var valid = atomicLoad(&candidate_output.header.generation) != 0u &&
    work.geometry_slot < arrayLength(&candidate_geometries) &&
    work.meshlet_slot < arrayLength(&candidate_meshlets) &&
    work.material_slot_or_range != 0xffffffffu;
  if valid {
    let geometry = candidate_geometries[work.geometry_slot];
    valid = work.meshlet_slot >= geometry.meshlet_begin &&
      work.meshlet_slot < geometry.meshlet_begin + geometry.meshlet_count;
  }
  atomicAdd(&candidate_output.header.consumed_count, 1u);
  if !valid { atomicAdd(&candidate_output.header.invalid_count, 1u); }
}

@compute @workgroup_size(1)
fn publish_meshlet_work_candidate_counters() {
  if candidate_settings.counters_enabled == 0u { return; }
  let attempted = atomicLoad(&candidate_output.header.attempted_count);
  let written = atomicLoad(&candidate_output.header.written_count);
  let consumed = atomicLoad(&candidate_output.header.consumed_count);
  let overflow = atomicLoad(&candidate_output.header.overflow_count);
  let invalid = atomicLoad(&candidate_output.header.invalid_count);
  atomicAdd(&candidate_counters[${COUNTER_MESHLET_WORKS}u], written);
  atomicAdd(
    &candidate_counters[${COUNTER_QUEUE_BYTES}u],
    written * ${GPU_MESHLET_RASTER_WORK_RECORD_STRIDE}u
  );
  atomicAdd(&candidate_counters[${COUNTER_ATTEMPTED}u], attempted);
  atomicAdd(&candidate_counters[${COUNTER_WRITTEN}u], written);
  atomicAdd(&candidate_counters[${COUNTER_CONSUMED}u], consumed);
  atomicAdd(&candidate_counters[${COUNTER_OVERFLOW}u], overflow);
  atomicAdd(&candidate_counters[${COUNTER_INVALID}u], invalid);
}
`;

export const MESHLET_WORK_CANDIDATE_VISIBLE_RECORD_STRIDE =
  GPU_VISIBLE_CLUSTER_RECORD_SCHEMA.stride;

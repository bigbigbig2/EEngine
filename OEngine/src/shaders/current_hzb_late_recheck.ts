import { HZB_FOOTPRINT_WGSL } from "./hzb_footprint.js";
import { counterByteOffset } from "../debug/GpuFrameCounters.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { PACKED_CAMERA_TYPE } from "./packed_camera.js";
import { VIRTUAL_GEOMETRY_PRODUCT_WGSL } from "./virtual_geometry_product.js";
import { FRAME_GEOMETRY_WGSL } from "../gpu/GpuWinnerInterpolationAbi.js";

/**
 * Phase I GPU producer/consumer contract. The caller supplies conservative
 * projection metadata; invalid metadata always remains visible (fail-open).
 */
export const CURRENT_HZB_LATE_RECHECK_WGSL = /* wgsl */ `
${HZB_FOOTPRINT_WGSL}
struct OEngineCurrentHzbLateRecheckHeader {
  attempted_count: atomic<u32>,
  written_count: atomic<u32>,
  consumed_count: atomic<u32>,
  capacity: u32,
  overflow_count: atomic<u32>,
  generation: atomic<u32>,
  invalid_count: atomic<u32>,
  reserved: u32,
};

struct OEngineCurrentHzbLateRecheckCandidate {
  work_slot: u32,
  flags: u32,
  screen_min: vec2f,
  screen_max: vec2f,
  nearest_depth: f32,
  raster_vertices: u32,
};

struct OEngineCurrentHzbLateRecheckQueue {
  header: OEngineCurrentHzbLateRecheckHeader,
  records: array<OEngineCurrentHzbLateRecheckCandidate>,
};

struct OEngineCurrentHzbLateRecheckSettings {
  view_size: vec2u,
  mip_count: u32,
  epsilon: f32,
  counters_enabled: u32,
  reserved: vec3u,
};

@group(0) @binding(0) var<storage, read> recheck_input: OEngineCurrentHzbLateRecheckQueue;
@group(0) @binding(1) var<storage, read_write> recheck_output: OEngineCurrentHzbLateRecheckQueue;
@group(0) @binding(2) var current_hzb: texture_2d<f32>;
@group(0) @binding(3) var<uniform> recheck_settings: OEngineCurrentHzbLateRecheckSettings;

const CURRENT_HZB_RECHECK_UNCERTAIN: u32 = 1u;
const CURRENT_HZB_RECHECK_EXPENSIVE: u32 = 2u;
const CURRENT_HZB_RECHECK_CONSERVATIVE: u32 = 4u;
const CURRENT_HZB_RECHECK_INVALID_OFFSET: u32 = 0xffffffffu;
const CURRENT_HZB_RECHECK_WORKGROUP_SIZE: u32 = 64u;

fn recheck_candidate_valid(candidate: OEngineCurrentHzbLateRecheckCandidate) -> bool {
  return all(candidate.screen_min == candidate.screen_min) &&
    all(candidate.screen_max == candidate.screen_max) &&
    candidate.screen_min.x >= 0.0 && candidate.screen_min.y >= 0.0 &&
    candidate.screen_max.x <= 1.0 && candidate.screen_max.y <= 1.0 &&
    all(candidate.screen_min < candidate.screen_max) &&
    candidate.nearest_depth == candidate.nearest_depth;
}

fn recheck_occluded(candidate: OEngineCurrentHzbLateRecheckCandidate) -> bool {
  let farthest = hzb_footprint_min_depth(current_hzb, candidate.screen_min, candidate.screen_max);
  return candidate.nearest_depth + recheck_settings.epsilon < farthest;
}

fn recheck_try_reserve(count: u32) -> u32 {
  atomicAdd(&recheck_output.header.attempted_count, count);
  var observed = atomicLoad(&recheck_output.header.written_count);
  loop {
    if count == 0u || count > recheck_output.header.capacity -
      min(observed, recheck_output.header.capacity) {
      atomicAdd(&recheck_output.header.overflow_count, count);
      return CURRENT_HZB_RECHECK_INVALID_OFFSET;
    }
    let result = atomicCompareExchangeWeak(
      &recheck_output.header.written_count, observed, observed + count);
    if result.exchanged { return observed; }
    observed = result.old_value;
  }
}

@compute @workgroup_size(${64})
fn current_hzb_late_recheck(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  let count = min(atomicLoad(&recheck_input.header.written_count), recheck_input.header.capacity);
  if index >= count { return; }
  let candidate = recheck_input.records[index];
  var keep = true;
  if !recheck_candidate_valid(candidate) {
    atomicAdd(&recheck_output.header.invalid_count, 1u);
  } else {
    let eligible = (candidate.flags &
      (CURRENT_HZB_RECHECK_UNCERTAIN | CURRENT_HZB_RECHECK_EXPENSIVE)) != 0u;
    let parity_safe = (candidate.flags & CURRENT_HZB_RECHECK_CONSERVATIVE) != 0u;
    keep = !(eligible && parity_safe && recheck_occluded(candidate));
  }
  if !keep { return; }
  let slot = recheck_try_reserve(1u);
  if slot == CURRENT_HZB_RECHECK_INVALID_OFFSET { return; }
  recheck_output.records[slot] = candidate;
}
`;

export const CURRENT_HZB_LATE_RECHECK_COUNTER_OFFSETS = Object.freeze({
  attempted: counterByteOffset("meshletQueueAttempted"),
  written: counterByteOffset("meshletQueueWritten"),
  overflow: counterByteOffset("meshletQueueOverflow"),
});

const CURRENT_HZB_REJECTED_COUNTER_WORD = counterByteOffset("rejectedHzb") / 4;

/**
 * Production Product-MeshletWork filter. The input and output are both the
 * standard correctness-critical MeshletWork ABI, so the final raster and all
 * downstream VisibilityKey consumers see one coherent work-slot namespace.
 * Invalid metadata and stale/source-overflow state keep the source record.
 */
export const CURRENT_HZB_MESHLET_WORK_LATE_RECHECK_WGSL = /* wgsl */ `
${PACKED_CAMERA_TYPE.wgsl_declaration}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${VIRTUAL_GEOMETRY_PRODUCT_WGSL}
${FRAME_GEOMETRY_WGSL}

${HZB_FOOTPRINT_WGSL}
struct OEngineCurrentHzbMeshletSettings {
  view_size: vec2u,
  mip_count: u32,
  capacity: u32,
  epsilon: f32,
  counters_enabled: u32,
  max_workgroups: u32,
  reserved: u32,
};

struct OEngineCurrentHzbDrawIndirect {
  vertex_count: u32,
  instance_count: atomic<u32>,
  first_vertex: u32,
  first_instance: u32,
};

@group(0) @binding(0) var<uniform> current_camera: CommandEncoder;
@group(0) @binding(1) var<storage, read> current_instances: array<OEngineInstanceRecord>;
@group(0) @binding(2) var<storage, read> current_source: OEngineMeshletWorkQueueRead;
@group(0) @binding(3) var<storage, read_write> current_output: OEngineMeshletWorkQueue;
@group(0) @binding(4) var<storage, read> current_heap: array<u32>;
@group(0) @binding(5) var<storage, read> current_bank_0: array<u32>;
@group(0) @binding(6) var<storage, read> current_bank_1: array<u32>;
@group(0) @binding(7) var<storage, read> current_bank_2: array<u32>;
@group(0) @binding(8) var<storage, read> current_bank_3: array<u32>;
@group(0) @binding(9) var current_hzb_meshlets: texture_2d<f32>;
@group(0) @binding(10) var<uniform> current_settings: OEngineCurrentHzbMeshletSettings;
@group(0) @binding(11) var<storage, read_write> current_draw: OEngineCurrentHzbDrawIndirect;
@group(0) @binding(12) var<storage, read_write> current_counters: array<atomic<u32>>;
// Shared arena ranges must both use Storage usage in this dispatch. The input
// directory is logically read-only; the binding ranges are disjoint.
@group(0) @binding(13) var<storage, read_write> current_source_geometry: FrameGeometryDirectory;
@group(0) @binding(14) var<storage, read_write> current_filtered_geometry: FrameGeometryDirectory;
@group(1) @binding(0) var<storage, read_write> current_filter_dispatch: vec4u;

fn current_group_header(bank: u32, location: OEngineGeometryPageLookupV1,
  group: OEngineVirtualGroupV1) -> OEngineVirtualGroupHeaderV1 {
  if (bank == 0u) { return oengine_virtual_group_header_v1(&current_bank_0, location, group); }
  if (bank == 1u) { return oengine_virtual_group_header_v1(&current_bank_1, location, group); }
  if (bank == 2u) { return oengine_virtual_group_header_v1(&current_bank_2, location, group); }
  return oengine_virtual_group_header_v1(&current_bank_3, location, group);
}

fn current_meshlet_header(bank: u32, location: OEngineGeometryPageLookupV1,
  group: OEngineVirtualGroupV1, header: OEngineVirtualGroupHeaderV1,
  local_meshlet: u32) -> OEngineVirtualMeshletHeaderV1 {
  if (bank == 0u) { return oengine_virtual_meshlet_header_v1(&current_bank_0, location, group, header, local_meshlet); }
  if (bank == 1u) { return oengine_virtual_meshlet_header_v1(&current_bank_1, location, group, header, local_meshlet); }
  if (bank == 2u) { return oengine_virtual_meshlet_header_v1(&current_bank_2, location, group, header, local_meshlet); }
  return oengine_virtual_meshlet_header_v1(&current_bank_3, location, group, header, local_meshlet);
}

fn current_meshlet_occluded(work: OEngineMeshletRasterWork) -> bool {
  if (work.instance_slot >= arrayLength(&current_instances)) { return false; }
  let instance = current_instances[work.instance_slot];
  let asset = oengine_geometry_product_resolve_asset_v1(&current_heap,
    work.geometry_slot, oengine_instance_geometry_generation(instance));
  let group_id = work.meshlet_slot >> 7u;
  let local_meshlet = work.meshlet_slot & 127u;
  let group = oengine_virtual_group_v1(&current_heap, asset, group_id);
  let location = oengine_geometry_product_lookup_page_heap_v1(&current_heap, asset, group.page_id);
  if (!asset.valid || !group.valid || !location.valid || location.bank_index >= 4u) { return false; }
  let header = current_group_header(location.bank_index, location, group);
  let meshlet = current_meshlet_header(location.bank_index, location, group, header, local_meshlet);
  if (!header.valid || !meshlet.valid) { return false; }

  let object_to_world = oengine_instance_current_object_to_world(instance);
  var uv_min = vec2f(1.0);
  var uv_max = vec2f(0.0);
  var nearest = 0.0;
  for (var corner = 0u; corner < 8u; corner++) {
    let local = vec3f(
      select(meshlet.bounds_min.x, meshlet.bounds_max.x, (corner & 1u) != 0u),
      select(meshlet.bounds_min.y, meshlet.bounds_max.y, (corner & 2u) != 0u),
      select(meshlet.bounds_min.z, meshlet.bounds_max.z, (corner & 4u) != 0u));
    let clip = current_camera.view_projection_matrix * object_to_world * vec4f(local, 1.0);
    if any(clip != clip) || any(abs(clip) > vec4f(3.4e38)) || clip.w <= 1e-6 { return false; }
    let ndc = clip.xyz / clip.w;
    if any(ndc != ndc) || any(abs(ndc) > vec3f(3.4e38)) { return false; }
    let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    uv_min = min(uv_min, uv);
    uv_max = max(uv_max, uv);
    nearest = max(nearest, clamp(ndc.z, 0.0, 1.0));
  }
  if any(uv_max <= vec2f(0.0)) || any(uv_min >= vec2f(1.0)) { return false; }
  uv_min = clamp(uv_min, vec2f(0.0), vec2f(1.0));
  uv_max = clamp(uv_max, vec2f(0.0), vec2f(1.0));
  let farthest = hzb_footprint_min_depth(current_hzb_meshlets, uv_min, uv_max);
  return nearest + current_settings.epsilon < farthest;
}

fn current_reserve() -> u32 {
  atomicAdd(&current_output.header.attempted_count, 1u);
  var observed = atomicLoad(&current_output.header.written_count);
  loop {
    if observed >= current_output.header.capacity {
      atomicAdd(&current_output.header.overflow_count, 1u);
      return 0xffffffffu;
    }
    let result = atomicCompareExchangeWeak(&current_output.header.written_count,
      observed, observed + 1u);
    if result.exchanged { return observed; }
    observed = result.old_value;
  }
}

@compute @workgroup_size(1)
fn prepare_current_hzb_meshlet_recheck() {
  atomicStore(&current_output.header.attempted_count, 0u);
  atomicStore(&current_output.header.written_count, 0u);
  atomicStore(&current_output.header.consumed_count, 0u);
  current_output.header.capacity = current_settings.capacity;
  atomicStore(&current_output.header.overflow_count, 0u);
  atomicStore(&current_output.header.generation, current_source.header.generation);
  atomicStore(&current_output.header.invalid_count, 0u);
  current_output.header.reserved = 0u;
  current_draw.vertex_count = 384u;
  atomicStore(&current_draw.instance_count, 0u);
  current_draw.first_vertex = 0u;
  current_draw.first_instance = 0u;
  current_filtered_geometry.work_count = 0u;
  current_filtered_geometry.generation = current_source.header.generation;
  current_filtered_geometry.vertex_count = current_source_geometry.vertex_count;
  current_filtered_geometry.triangle_count = current_source_geometry.triangle_count;
  let groups = (min(current_source.header.written_count, min(current_source.header.capacity, current_settings.capacity)) + 63u) / 64u;
  let x = min(groups, current_settings.max_workgroups);
  current_filter_dispatch = vec4u(x, select((groups + max(x, 1u) - 1u) / max(x, 1u), 1u, groups == 0u), 1u, 0u);
}

@compute @workgroup_size(64)
fn filter_current_hzb_meshlet_recheck(@builtin(global_invocation_id) id: vec3u) {
  let source_count = min(current_source.header.written_count, current_source.header.capacity);
  let x_groups = min((min(source_count, current_settings.capacity) + 63u) / 64u, current_settings.max_workgroups);
  let index = id.y * x_groups * 64u + id.x;
  if index >= source_count || index >= current_settings.capacity { return; }
  let work = current_source.elements[index];
  let source_fail_open = current_source.header.generation == 0u ||
    current_source.header.overflow_count != 0u || current_source.header.invalid_count != 0u;
  if !source_fail_open && current_meshlet_occluded(work) {
    if current_settings.counters_enabled != 0u {
      atomicAdd(&current_counters[${CURRENT_HZB_REJECTED_COUNTER_WORD}u], 1u);
    }
    return;
  }
  let slot = current_reserve();
  if slot != 0xffffffffu {
    current_output.elements[slot] = work;
    var geometry = FrameGeometryMeshlet(0u, 0u, 0u, 0u);
    if current_source_geometry.generation == current_source.header.generation && index < current_source_geometry.work_count {
      geometry = current_source_geometry.meshlets[index];
    }
    // Namespace is remapped with the queue reservation, never by packing an
    // original index into the profile/LOD/flags ABI. Clips/triangles are reused.
    current_filtered_geometry.meshlets[slot] = geometry;
  }
}

@compute @workgroup_size(1)
fn finalize_current_hzb_meshlet_recheck() {
  let written = min(atomicLoad(&current_output.header.written_count), current_output.header.capacity);
  atomicStore(&current_output.header.consumed_count, written);
  // Invalid/stale/overflowed input is copied without rejection above. Publishing
  // the copied count is the fail-open path; zeroing it would drop all geometry.
  atomicStore(&current_draw.instance_count, written);
  current_filtered_geometry.work_count = written;
}
`;

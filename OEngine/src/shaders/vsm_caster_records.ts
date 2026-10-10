import { GPU_INSTANCE_RECORD_WGSL, GPU_INSTANCE_FLAGS } from "../gpu/GpuInstanceAbi.js";
import { GPU_GEOMETRY_RECORD_WGSL, GPU_MESHLET_RECORD_WGSL } from "../gpu/GpuGeometryAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { VSM_PAGE_TABLE_WGSL } from "./vsm_page_table.js";
import { HIERARCHY_LOD_WGSL } from "./hierarchy_lod.js";

const GPU_INSTANCE_RASTER_CASTS_SHADOW = GPU_INSTANCE_FLAGS.CastsShadow;
const GPU_INSTANCE_RASTER_TRANSPARENT = GPU_INSTANCE_FLAGS.Transparent;
const VSM_PAGE_ALLOCATED = 1;
const VSM_PAGE_DIRTY = 2;
const VSM_PAGE_GENERATION_VALID = 8;

/** GPU-only bounded caster expansion for the VSM dirty-page work list. */
export const VSM_CASTER_RECORDS_WGSL = /* wgsl */ `
${VSM_PAGE_TABLE_WGSL}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_GEOMETRY_RECORD_WGSL}
${GPU_MESHLET_RECORD_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${HIERARCHY_LOD_WGSL}

struct Constants {
  light_view: mat4x4f,
  clip_origin_extent: array<vec4f, 6>,
  dimensions: vec4u, // pages/axis, page size, border, atlas dimension
  control: vec4u,    // generation, work capacity, record capacity, resident slots
  parameters: vec4f,
  depth_range: vec4f,
  identity: vec4u,
};
struct VsmPageWork {
  virtual_page: u32, slot: u32, priority: u32, generation: u32,
  flags: u32, fallback_mip: u32, reserved_0: u32, reserved_1: u32,
};
struct VsmAllocationBuffer {
  attempted: atomic<u32>, written: atomic<u32>, overflow: atomic<u32>, generation: atomic<u32>,
  records: array<VsmPageWork>,
};
struct VsmCasterRecord {
  instance_record_index: u32,
  geometry_record_index: u32,
  meshlet_record_index: u32,
  material_handle: u32,
  page_slot: u32,
  virtual_page: u32,
  raster_flags: u32,
  packed_profile_lod: u32,
};
struct VsmCasterBuffer {
  attempted: atomic<u32>, written: atomic<u32>, overflow: atomic<u32>, generation: atomic<u32>,
  records: array<VsmCasterRecord>,
};
struct VsmPageTableBuffer { entries: array<VsmPageEntry>, };
struct VsmTelemetry { allocation_failed: atomic<u32>, evictions: atomic<u32>, reused: atomic<u32>, lock_contention: atomic<u32>, caster_overflow: atomic<u32>, raster_overflow: atomic<u32>, reserved_0: atomic<u32>, reserved_1: atomic<u32> };

@group(0) @binding(0) var<uniform> constants: Constants;
@group(0) @binding(1) var<storage, read_write> allocation: VsmAllocationBuffer;
@group(0) @binding(2) var<storage, read> page_table: VsmPageTableBuffer;
@group(0) @binding(3) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(4) var<storage, read> instances: array<OEngineInstanceRecord>;
@group(0) @binding(5) var<storage, read_write> caster: VsmCasterBuffer;
@group(0) @binding(6) var<storage, read_write> telemetry: VsmTelemetry;

fn append_caster(record: VsmCasterRecord) {
  let ticket = atomicAdd(&caster.attempted, 1u);
  if (ticket >= constants.control.z) {
    atomicAdd(&caster.overflow, 1u);
    atomicAdd(&telemetry.caster_overflow, 1u);
    return;
  }
  // Reserve the bounded slot independently from attempted. A later overflow
  // cannot overwrite a valid record already published by another lane.
  var observed = atomicLoad(&caster.written);
  loop {
    if (observed >= constants.control.z) {
      atomicAdd(&caster.overflow, 1u);
      atomicAdd(&telemetry.caster_overflow, 1u);
      return;
    }
    let result = atomicCompareExchangeWeak(&caster.written, observed, observed + 1u);
    if (result.exchanged) {
      caster.records[observed] = record;
      return;
    }
    observed = result.old_value;
  }
}

fn page_overlaps_sphere(center: vec3f, radius: f32, work: VsmPageWork,
  entry: VsmPageEntry) -> bool {
  let pages = constants.dimensions.x;
  let coordinates = vsm_page_entry_coordinates(work.virtual_page, pages);
  let level = min(coordinates.x, 5u);
  let page_x = entry.world_x;
  let page_y = entry.world_y;
  let mip = min(entry.mip, 5u);
  let axis = max(1u, pages >> mip);
  let extent = constants.clip_origin_extent[level].z;
  let page_world = extent / f32(axis);
  let minimum = vec2f(f32(page_x), f32(page_y)) * page_world;
  let maximum = minimum + vec2f(page_world);
  let q = clamp(center.xy, minimum, maximum);
  return distance(q, center.xy) <= radius;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) grid: vec3u) {
  let index = id.x + id.y * grid.x * 64u;
  let capacity = min(constants.control.y,
    min(meshlet_work.header.capacity, arrayLength(&meshlet_work.elements)));
  let failure = select(1u, 0u, constants.depth_range.w != 0.0) | meshlet_work.header.invalid_count | meshlet_work.header.overflow_count |
    select(0u, 1u, meshlet_work.header.written_count > capacity);
  if (index == 0u) {
    atomicStore(&caster.generation, constants.control.x);
    if (failure != 0u) {
      atomicStore(&caster.overflow, 1u);
      atomicAdd(&telemetry.caster_overflow, 1u);
    }
  }
  if (failure != 0u) { return; }
  let work_count = meshlet_work.header.written_count;
  if (index >= work_count || index >= arrayLength(&meshlet_work.elements)) { return; }
  let work = meshlet_work.elements[index];
  if (work.instance_slot >= arrayLength(&instances)) { return; }
  let instance = instances[work.instance_slot];
  if (!oengine_instance_active(instance) ||
      (instance.flags & ${GPU_INSTANCE_RASTER_CASTS_SHADOW}u) == 0u ||
      (instance.flags & ${GPU_INSTANCE_RASTER_TRANSPARENT}u) != 0u) { return; }
  let object_to_world = oengine_instance_current_object_to_world(instance);
  let local_center = instance.bounds_sphere.xyz;
  let center = (constants.light_view * object_to_world * vec4f(local_center, 1.0)).xyz;
  let radius = max(0.001, instance.bounds_sphere.w * hierarchy_conservative_scale(object_to_world));
  let page_count = min(atomicLoad(&allocation.written), constants.control.w);
  for (var page_index = 0u; page_index < page_count; page_index++) {
    let page = allocation.records[page_index];
    if (page.generation != constants.control.x ||
        (page.flags & (${VSM_PAGE_ALLOCATED}u | ${VSM_PAGE_DIRTY}u | ${VSM_PAGE_GENERATION_VALID}u)) !=
          (${VSM_PAGE_ALLOCATED}u | ${VSM_PAGE_DIRTY}u | ${VSM_PAGE_GENERATION_VALID}u)) { continue; }
    if (page.slot >= constants.control.w || page.virtual_page >= arrayLength(&page_table.entries)) { continue; }
    let entry = page_table.entries[page.virtual_page];
    let atlas_axis = max(1u, constants.dimensions.w / (constants.dimensions.y + constants.dimensions.z * 2u));
    if (entry.slot_x + entry.slot_y * atlas_axis != page.slot ||
        entry.generation != constants.control.x || entry.projection_epoch != constants.identity.x || entry.content_namespace != constants.identity.y ||
        (entry.flags & (${VSM_PAGE_ALLOCATED}u | ${VSM_PAGE_DIRTY}u | ${VSM_PAGE_GENERATION_VALID}u)) !=
          (${VSM_PAGE_ALLOCATED}u | ${VSM_PAGE_DIRTY}u | ${VSM_PAGE_GENERATION_VALID}u)) { continue; }
    if (!page_overlaps_sphere(center, radius, page, entry)) { continue; }
    append_caster(VsmCasterRecord(work.instance_slot, work.geometry_slot, work.meshlet_slot,
      work.material_slot_or_range, page.slot, page.virtual_page, work.packed_raster_flags,
      work.packed_profile_lod));
  }
}

struct OEngineDrawIndirectArgs { vertex_count: u32, instance_count: u32, first_vertex: u32, first_instance: u32 };
@group(0) @binding(7) var<storage, read_write> raster_indirect: array<OEngineDrawIndirectArgs>;

@compute @workgroup_size(1)
fn finalize_indirect() {
  let count = select(0u, min(atomicLoad(&caster.written), constants.control.z), atomicLoad(&caster.overflow) == 0u);
  raster_indirect[0] = OEngineDrawIndirectArgs(384u, count, 0u, 0u);
  raster_indirect[1] = OEngineDrawIndirectArgs(384u, count, 0u, 0u);
  raster_indirect[2] = OEngineDrawIndirectArgs(6u,
    min(atomicLoad(&allocation.written), constants.control.w), 0u, 0u);
}
`;

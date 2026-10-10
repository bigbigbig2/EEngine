import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { SHADOW_BOUNDS_WGSL, VSM_PAIR_WRITE_WGSL } from "../gpu/GpuVsmPairAbi.js";
import { VSM_PAGE_TABLE_WGSL } from "./vsm_page_table.js";
import { VSM_PAIR_PAGE_WGSL } from "./vsm_pair_page.js";

/** One actual Geometry work lane scans the bounded dirty list. At most one
 * global ticket/overlap; no CAS, locks, barriers, copied source or partial draw.
 * Preflight guarantees W × D fits u32, including attempted count. */
export const VSM_CASTER_RECORDS_WGSL = /* wgsl */ `
${VSM_PAGE_TABLE_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${SHADOW_BOUNDS_WGSL}
struct Constants {
  light_view: mat4x4f,
  clip_origin_extent: array<vec4f, 6>,
  dimensions: vec4u,
  control: vec4u,
  parameters: vec4f,
  depth_range: vec4f,
  identity: vec4u,
}
struct VsmPageWork {
  virtual_page: u32,
  slot: u32,
  priority: u32,
  generation: u32,
  flags: u32,
  fallback_mip: u32,
  world: vec2i,
}
struct VsmAllocationBuffer {
  attempted: u32,
  written: u32,
  overflow: u32,
  generation: u32,
  records: array<VsmPageWork>,
}
${VSM_PAIR_WRITE_WGSL}
struct VsmPageTableBuffer {
  entries: array<VsmPageEntry>,
}
@group(0) @binding(0) var<uniform> constants: Constants;
@group(0) @binding(1) var<storage, read> allocation: VsmAllocationBuffer;
@group(0) @binding(2) var<storage, read> page_table: VsmPageTableBuffer;
@group(0) @binding(3) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(4) var<storage, read> bounds: ShadowBoundsQueue;
@group(0) @binding(5) var<storage, read_write> pairs: VsmPairQueue;
@group(0) @binding(6) var<storage, read_write> telemetry: array<u32>;
@group(0) @binding(7) var<storage, read_write> indirect: array<vec4u>;
${VSM_PAIR_PAGE_WGSL}
@compute @workgroup_size(1)
fn prepare_pairs() {
  let capacity = min(constants.control.y, min(meshlet_work.header.capacity, arrayLength(&meshlet_work.elements)));
  let invalid = meshlet_work.header.invalid_count | meshlet_work.header.overflow_count | bounds.header.invalid |
    select(0u, 1u, constants.depth_range.w == 0.0 || meshlet_work.header.written_count > capacity ||
      bounds.header.generation != meshlet_work.header.generation || bounds.header.count != meshlet_work.header.written_count ||
      bounds.header.count > arrayLength(&bounds.elements) || allocation.written > constants.control.w ||
      allocation.written > arrayLength(&allocation.records) || allocation.overflow != 0u ||
      allocation.generation != constants.control.x || constants.control.z > arrayLength(&pairs.elements));
  atomicStore(&pairs.header.attempted, 0u);
  atomicStore(&pairs.header.failure, invalid);
  pairs.header.written_count = 0u;
  pairs.header.generation = constants.control.x;
  pairs.header.mode = 2u;
  pairs.header.source_count = meshlet_work.header.written_count;
  pairs.header.dirty_count = allocation.written;
  pairs.header.source_generation = meshlet_work.header.generation;
  let groups = select((pairs.header.source_count + 63u) / 64u, 0u, invalid != 0u || pairs.header.dirty_count == 0u);
  let dimension = constants.identity.w;
  indirect[0] = vec4u(min(groups, dimension), (groups + dimension - 1u) / dimension, 1u, 0u);
  indirect[2] = vec4u(6u, select(allocation.written, 0u, invalid != 0u), 0u, 0u);
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let slot = id.x + id.y * constants.identity.w * 64u;
  if slot >= pairs.header.source_count {
    return;
  }
  let bound = bounds.elements[slot];
  if bound.valid == 0u {
    atomicOr(&pairs.header.failure, 1u);
    return;
  }
  for (var page_index = 0u; page_index < pairs.header.dirty_count; page_index++) {
    let page = allocation.records[page_index];
    if page.slot >= constants.control.w || page.virtual_page >= arrayLength(&page_table.entries) {
      atomicOr(&pairs.header.failure, 1u);
      continue;
    }
    let entry = page_table.entries[page.virtual_page];
    if !vsm_pair_page_valid(page, entry) {
      atomicOr(&pairs.header.failure, 1u);
      continue;
    }
    if !vsm_pair_overlaps(bound.light_xy, entry, page.virtual_page) {
      continue;
    }
    let ticket = atomicAdd(&pairs.header.attempted, 1u);
    if ticket < constants.control.z {
      pairs.elements[ticket] = VsmPair(slot, page.slot, page.virtual_page, 1u);
    }
  }
}
@compute @workgroup_size(1)
fn finalize_indirect() {
  let attempted = atomicLoad(&pairs.header.attempted);
  let failure = atomicLoad(&pairs.header.failure);
  pairs.header.mode = select(select(0u, 1u, attempted > constants.control.z), 2u, failure != 0u);
  // Every partial explicit record is unreachable in implicit/failed mode.
  pairs.header.written_count = select(0u, attempted, pairs.header.mode == 0u);
  telemetry[4] = attempted - min(attempted, constants.control.z);
  telemetry[5] = failure;
  telemetry[6] = pairs.header.mode;
  indirect[1] = vec4u(0u);
}
`;

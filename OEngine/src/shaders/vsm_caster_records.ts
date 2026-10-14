import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { SHADOW_BOUNDS_WGSL, VSM_PAIR_WRITE_WGSL } from "../gpu/GpuVsmPairAbi.js";
import { VSM_PAGE_TABLE_WGSL } from "./vsm_page_table.js";
import { VSM_PAIR_PAGE_WGSL } from "./vsm_pair_page.js";

/** Actual Geometry work scans the bounded dirty list. Small lists use direct
 * intersections; full batches share page setup and conservative coarse bounds.
 * At most one global ticket/overlap; no copied geometry or partial draw.
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
var<workgroup> wg_page_rects: array<vec4f, 64>;
var<workgroup> wg_page_slots: array<vec2u, 64>;
var<workgroup> wg_page_valid: array<u32, 64>;
var<workgroup> wg_group_rects: array<vec4f, 8>;
var<workgroup> wg_batch_rect: vec4f;
var<workgroup> wg_dirty_count: u32;

fn record_direct_pair(slot: u32, bound: ShadowMeshletBounds, page_index: u32) {
  let page = allocation.records[page_index];
  if (page.slot >= constants.control.w || page.virtual_page >= arrayLength(&page_table.entries)) {
    atomicOr(&pairs.header.failure, 1u);
    return;
  }
  let entry = page_table.entries[page.virtual_page];
  if (!vsm_pair_page_valid(page, entry)) {
    atomicOr(&pairs.header.failure, 1u);
    return;
  }
  if (vsm_pair_overlaps(bound.light_xy, entry, page.virtual_page)) {
    let ticket = atomicAdd(&pairs.header.attempted, 1u);
    if (ticket < constants.control.z) {
      pairs.elements[ticket] = VsmPair(slot, page.slot, page.virtual_page, 1u);
    }
  }
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_index) lane: u32) {
  if (lane == 0u) {
    wg_dirty_count = pairs.header.dirty_count;
  }
  let dirty_count = workgroupUniformLoad(&wg_dirty_count);
  let slot = id.x + id.y * constants.identity.w * 64u;
  let has_caster = slot < pairs.header.source_count;
  var bound = ShadowMeshletBounds(vec4f(0.0), 0u, 0u, vec2u(0u));
  if (has_caster) {
    bound = bounds.elements[slot];
    if (bound.valid == 0u) {
      atomicOr(&pairs.header.failure, 1u);
    }
  }
  let caster_valid = has_caster && bound.valid != 0u;
  // A partial batch cannot fill the 64 page-setup lanes. Avoid all four
  // hierarchical barriers for small lists, keeping exact page intersections.
  if (dirty_count < 64u) {
    if (caster_valid) {
      for (var page = 0u; page < dirty_count; page++) {
        record_direct_pair(slot, bound, page);
      }
    }
    return;
  }
  let has_any_caster = pairs.header.source_count > 0u;
  for (var batch = 0u; batch < dirty_count; batch += 64u) {
    let page_index = batch + lane;
    var valid_page = 0u;
    var rect = vec4f(1e30, 1e30, -1e30, -1e30);
    var page_meta = vec2u(0u);
    if (page_index < dirty_count) {
      let page = allocation.records[page_index];
      if (page.slot >= constants.control.w || page.virtual_page >= arrayLength(&page_table.entries)) {
        if (has_any_caster) {
          atomicOr(&pairs.header.failure, 1u);
        }
      } else {
        let entry = page_table.entries[page.virtual_page];
        if (!vsm_pair_page_valid(page, entry)) {
          if (has_any_caster) {
            atomicOr(&pairs.header.failure, 1u);
          }
        } else {
          let level = vsm_page_entry_coordinates(page.virtual_page, constants.dimensions.x).x;
          let page_world = constants.clip_origin_extent[min(level, 5u)].z /
            f32(max(1u, constants.dimensions.x >> min(entry.mip, 5u)));
          let gutter = page_world * f32(constants.dimensions.z) / f32(constants.dimensions.y);
          let low = vec2f(f32(entry.world_x), f32(entry.world_y)) * page_world;
          let high = low + vec2f(page_world);
          rect = vec4f(low - vec2f(gutter), high + vec2f(gutter));
          page_meta = vec2u(page.slot, page.virtual_page);
          valid_page = 1u;
        }
      }
    }
    wg_page_rects[lane] = rect;
    wg_page_slots[lane] = page_meta;
    wg_page_valid[lane] = valid_page;
    workgroupBarrier();
    if (lane < 8u) {
      var grect = vec4f(1e30, 1e30, -1e30, -1e30);
      let base = lane * 8u;
      for (var k = 0u; k < 8u; k++) {
        let prect = wg_page_rects[base + k];
        grect = vec4f(min(grect.xy, prect.xy), max(grect.zw, prect.zw));
      }
      wg_group_rects[lane] = grect;
    }
    workgroupBarrier();
    if (lane == 0u) {
      var brect = vec4f(1e30, 1e30, -1e30, -1e30);
      for (var g = 0u; g < 8u; g++) {
        let grect = wg_group_rects[g];
        brect = vec4f(min(brect.xy, grect.xy), max(brect.zw, grect.zw));
      }
      wg_batch_rect = brect;
    }
    let batch_rect = workgroupUniformLoad(&wg_batch_rect);
    if (caster_valid && all(bound.light_xy.zw >= batch_rect.xy) && all(bound.light_xy.xy <= batch_rect.zw)) {
      let batch_len = min(64u, dirty_count - batch);
      let group_count = (batch_len + 7u) / 8u;
      for (var g = 0u; g < group_count; g++) {
        let grect = wg_group_rects[g];
        if (all(bound.light_xy.zw >= grect.xy) && all(bound.light_xy.xy <= grect.zw)) {
          let k_end = min(8u, batch_len - g * 8u);
          for (var k = 0u; k < k_end; k++) {
            let idx = g * 8u + k;
            if (wg_page_valid[idx] != 0u) {
              let prect = wg_page_rects[idx];
              if (all(bound.light_xy.zw >= prect.xy) && all(bound.light_xy.xy <= prect.zw)) {
                let ticket = atomicAdd(&pairs.header.attempted, 1u);
                if (ticket < constants.control.z) {
                  let pmeta = wg_page_slots[idx];
                  pairs.elements[ticket] = VsmPair(slot, pmeta.x, pmeta.y, 1u);
                }
              }
            }
          }
        }
      }
    }
    workgroupBarrier();
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

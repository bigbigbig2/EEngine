import { VSM_PAGE_TABLE_WGSL } from "./vsm_page_table.js";
import { VSM_PAIR_WGSL } from "../gpu/GpuVsmPairAbi.js";

/** One dirty page writer after real raster completion. Empty pages publish the
 * clear result; incomplete Geometry/caster/native partitions never publish. */
export const VSM_PAGE_COMMIT_WGSL = /* wgsl */ `
${VSM_PAGE_TABLE_WGSL}
${VSM_PAIR_WGSL}
struct Constants {
  generation: u32,
  projection_epoch: u32,
  content_namespace: u32,
  atlas_axis: u32,
};
struct PageWork {
  virtual_page: u32,
  slot: u32,
  priority: u32,
  generation: u32,
  flags: u32,
  fallback_mip: u32,
  world: vec2i,
};
struct Allocation {
  attempted: u32,
  written: u32,
  overflow: u32,
  generation: u32,
  records: array<PageWork>,
};
@group(0) @binding(0) var<uniform> constants: Constants;
@group(0) @binding(1) var<storage, read> pairs: VsmPairHeader;
@group(0) @binding(2) var<storage, read_write> pages: array<VsmPageEntry>;
@group(0) @binding(3) var<storage, read_write> metas: array<VsmMetaEntry>;
@group(0) @binding(4) var<storage, read> completion: array<u32>;
@group(0) @binding(5) var<storage, read_write> content: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read> allocation: Allocation;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let length = arrayLength(&completion);
  if (length < 4u || pairs.failure != 0u || pairs.mode > 1u || pairs.generation != constants.generation ||
      (pairs.mode == 0u && pairs.written_count != pairs.attempted) ||
      (pairs.mode == 1u && pairs.written_count != 0u) || pairs.dirty_count != allocation.written ||
      allocation.overflow != 0u || allocation.generation != constants.generation ||
      allocation.written > arrayLength(&allocation.records)) {
    return;
  }
  let base = length - 4u;
  if ((completion[base] | completion[base + 1u] | completion[base + 2u] | completion[base + 3u]) != 0u ||
      id.x >= allocation.written) {
    return;
  }
  let work = allocation.records[id.x];
  if (work.virtual_page >= arrayLength(&pages) || work.slot >= arrayLength(&metas)) {
    return;
  }
  var entry = pages[work.virtual_page];
  var slot_meta = metas[work.slot];
  if ((work.flags & 11u) != 11u || (entry.flags & 11u) != 11u || entry.generation != constants.generation ||
      !vsm_key_matches(entry, work.world, vec4u(constants.projection_epoch, constants.content_namespace, 0u, 0u)) ||
      entry.slot_y * constants.atlas_axis + entry.slot_x != work.slot ||
      slot_meta.virtual_page != work.virtual_page || slot_meta.generation != constants.generation ||
      (slot_meta.flags & 11u) != 11u || slot_meta.owner != work.slot || slot_meta.mip != entry.mip ||
      work.generation != constants.generation || entry.reserved_0 == 0xffffffffu) {
    return;
  }
  entry.reserved_0++;
  entry.flags &= ~6u;
  slot_meta.flags &= ~6u;
  slot_meta.reserved_0 = entry.reserved_0;
  pages[work.virtual_page] = entry;
  metas[work.slot] = slot_meta;
  atomicStore(&content[1], 1u);
}
`;

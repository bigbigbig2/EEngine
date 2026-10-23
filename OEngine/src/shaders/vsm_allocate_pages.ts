import { VSM_MAX_CLIP_LEVELS } from "../gpu/GpuVsmProjectionAbi.js";
import { VSM_PAGE_TABLE_WGSL } from "./vsm_page_table.js";

/** Adapt Timberdoodle find_free_pages/allocate_pages free-first, unvisited-next
 * queues to ordered 32-bit records and unique writers. Local policies add
 * coarse partitions, cold ordering, admission and complete dirty-page budgets.
 * No split 64-bit atomics, cross-workgroup locks or retries. */
export const VSM_ALLOCATE_PAGES_WGSL = /* wgsl */ `
${VSM_PAGE_TABLE_WGSL}
struct Constants {
  control: vec4u, // generation, request capacity, slots, clips
  dimensions: vec4u, // pages, atlas axis, entries, submitted frame serial
  identity: vec4u, // projection epoch, namespace, coarse reserved slots, dirty page budget
  clips: array<vec4f, ${VSM_MAX_CLIP_LEVELS}>,
};
struct Request {
  virtual_page: u32,
  slot: u32,
  world: vec2i,
};
struct Requests {
  fine_count: u32,
  written: u32,
  overflow: u32,
  generation: u32,
  records: array<Request>,
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
struct Candidates {
  coarse_count: u32,
  fine_count: u32,
  reserved: vec2u,
  indices: array<u32>,
};
@group(0) @binding(0) var<uniform> constants: Constants;
@group(0) @binding(1) var<storage, read> requested: array<u32>;
@group(0) @binding(2) var<storage, read_write> missing: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read> requests: Requests;
@group(0) @binding(4) var<storage, read_write> pages: array<VsmPageEntry>;
@group(0) @binding(5) var<storage, read_write> metas: array<VsmMetaEntry>;
@group(0) @binding(6) var<storage, read_write> allocation: Allocation;
@group(0) @binding(7) var<storage, read_write> candidates: Candidates;
@group(0) @binding(8) var<storage, read_write> telemetry: array<atomic<u32>>;
@group(0) @binding(9) var<storage, read_write> content: array<atomic<u32>>;
@group(0) @binding(10) var<storage, read> scan: array<vec2u>;
var<workgroup> prefix: array<vec4u, 64>;
var<workgroup> oldest_slot: u32;

fn scan_lanes(lane: u32, value: vec4u) -> vec4u {
  prefix[lane] = value;
  workgroupBarrier();
  for (var stride = 1u; stride < 64u; stride *= 2u) {
    var prior = vec4u(0u);
    if (lane >= stride) {
      prior = prefix[lane - stride];
    }
    workgroupBarrier();
    prefix[lane] += prior;
    workgroupBarrier();
  }
  return prefix[lane] - value;
}
fn is_requested(page: u32) -> bool {
  return page < constants.dimensions.z && (requested[page / 32u] & (1u << (page % 32u))) != 0u;
}
@group(0) @binding(11) var<storage, read_write> descriptor_mutations: array<atomic<u32>>;
fn vsm_mark_descriptor(page: u32) {
  atomicOr(&descriptor_mutations[4u + page / 32u], 1u << (page % 32u));
}
@compute @workgroup_size(64)
fn touch(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= requests.written) {
    return;
  }
  let request = requests.records[id.x];
  var entry = pages[request.virtual_page];
  let slot = entry.slot_y * constants.dimensions.y + entry.slot_x;
  let mapped = (entry.flags & 9u) == 9u && slot < constants.control.z;
  if (mapped && metas[slot].virtual_page == request.virtual_page &&
      (metas[slot].flags & 9u) == 9u && metas[slot].generation == constants.control.x &&
      metas[slot].owner == slot && metas[slot].mip == entry.mip &&
      vsm_key_matches(entry, request.world, constants.identity) && entry.generation == constants.control.x) {
    metas[slot].last_visited = constants.dimensions.w;
    atomicAdd(&telemetry[2], 1u);
    return;
  }
  if (mapped && metas[slot].virtual_page == request.virtual_page) {
    metas[slot].flags = 0u;
    atomicStore(&content[1], 1u);
  }
  pages[request.virtual_page].flags = 0u;
  vsm_mark_descriptor(request.virtual_page);
  atomicOr(&missing[request.virtual_page / 32u], 1u << (request.virtual_page % 32u));
}
fn slot_class(slot: u32) -> u32 {
  let slot_meta = metas[slot];
  let coarse = slot < constants.identity.z;
  if ((slot_meta.flags & 9u) != 9u) {
    return select(2u, 0u, coarse);
  }
  // Prior-frame in-flight bits are not live protection: previous commands are
  // queue-ordered before this allocation, and this frame has not published work
  // yet. Failed old work must not displace the current quality admission.
  if (slot_meta.last_visited != constants.dimensions.w && !is_requested(slot_meta.virtual_page)) {
    return select(3u, 1u, coarse);
  }
  return 4u;
}
@compute @workgroup_size(64)
fn collect_slots(@builtin(local_invocation_index) lane: u32) {
  let span = (constants.control.z + 63u) / 64u;
  let begin = lane * span;
  let end = min(begin + span, constants.control.z);
  var counts = vec4u(0u);
  var cold_counts = vec4u(0u);
  for (var slot = begin; slot < end; slot++) {
    let category = slot_class(slot);
    if (category < 4u) {
      counts[category]++;
      if (constants.dimensions.w - metas[slot].last_visited > 8u) {
        cold_counts[category]++;
      }
    }
  }
  let base = scan_lanes(lane, counts);
  // Synchronize every reader before the second scan reuses prefix storage.
  let total = workgroupUniformLoad(&prefix[63]);
  // Reclaim genuinely cold slots before pages that only disappeared at a TAA
  // boundary. All current requests remain protected; recent candidates still
  // participate when capacity requires them. No historical-demand pinning.
  var cold_base = scan_lanes(lane, cold_counts);
  let cold_total = prefix[63];
  var warm_base = base - cold_base + cold_total;
  if (lane == 63u) {
    candidates.coarse_count = total.x + total.y;
    candidates.fine_count = total.z + total.w;
  }
  for (var slot = begin; slot < end; slot++) {
    let category = slot_class(slot);
    if (category >= 4u) {
      continue;
    }
    let cold = constants.dimensions.w - metas[slot].last_visited > 8u;
    var index = select(warm_base[category], cold_base[category], cold);
    if (category == 1u) {
      index += total.x;
    }
    if (category >= 2u) {
      index += constants.control.z;
      if (category == 3u) {
        index += total.z;
      }
    }
    candidates.indices[index] = slot;
    if (cold) {
      cold_base[category]++;
    } else {
      warm_base[category]++;
    }
  }
}
@compute @workgroup_size(64)
fn allocate(@builtin(global_invocation_id) id: vec3u) {
  let words = (constants.dimensions.z + 31u) / 32u;
  let groups = (words + 63u) / 64u;
  let totals = scan[words + groups * 2u];
  if (id.x >= totals.x + totals.y) {
    return;
  }
  let coarse = id.x < totals.x;
  let ordinal = select(id.x - totals.x, id.x, coarse);
  let count = select(candidates.fine_count, candidates.coarse_count, coarse);
  if (ordinal >= count) {
    atomicAdd(&telemetry[0], 1u);
    if (coarse) {
      atomicAdd(&telemetry[3], 1u);
    }
    return;
  }
  let request = requests.records[id.x];
  let slot = candidates.indices[select(constants.control.z + ordinal, ordinal, coarse)];
  let old_meta = metas[slot];
  if ((old_meta.flags & 9u) == 9u && old_meta.virtual_page < constants.dimensions.z) {
    let old_entry = pages[old_meta.virtual_page];
    if (old_entry.slot_y * constants.dimensions.y + old_entry.slot_x == slot) {
      pages[old_meta.virtual_page].flags = 0u;
      vsm_mark_descriptor(old_meta.virtual_page);
      atomicAdd(&telemetry[1], 1u);
    }
  }
  let coordinate = vsm_page_entry_coordinates(request.virtual_page, constants.dimensions.x);
  let flags = 11u | select(0u, 16u, coarse);
  vsm_mark_descriptor(request.virtual_page);
  pages[request.virtual_page] = VsmPageEntry(slot % constants.dimensions.y,
    slot / constants.dimensions.y, coordinate.y, flags, constants.control.x,
    5u, 0u, constants.identity.x, request.world.x, request.world.y, constants.identity.y, 0u);
  metas[slot] = VsmMetaEntry(request.virtual_page, coordinate.y, constants.dimensions.w,
    flags, constants.control.x, slot, 0u, constants.dimensions.w);
  atomicStore(&content[1], 1u);
}
fn dirty_tier(slot: u32) -> u32 {
  let slot_meta = metas[slot];
  if (slot_meta.virtual_page >= constants.dimensions.z) {
    return 3u;
  }
  let entry = pages[slot_meta.virtual_page];
  let is_dirty = (entry.flags & 11u) == 11u && entry.generation == constants.control.x &&
    entry.projection_epoch == constants.identity.x && entry.content_namespace == constants.identity.y &&
    entry.slot_y * constants.dimensions.y + entry.slot_x == slot && slot_meta.generation == constants.control.x &&
    (slot_meta.flags & 11u) == 11u && slot_meta.owner == slot && slot_meta.mip == entry.mip;
  if (!is_dirty) {
    return 3u;
  }
  // Restore valid coarse fallback first. Remaining requested fine pages have
  // equal priority; requested is rebuilt every frame, not historical demand.
  if (slot < constants.identity.z) {
    return 0u;
  }
  if (is_requested(slot_meta.virtual_page)) {
    return 1u;
  }
  // Tier 2: unrequested dirty (backlog draining)
  return 2u;
}
@compute @workgroup_size(64)
fn publish_dirty(@builtin(local_invocation_index) lane: u32) {
  let span = (constants.control.z + 63u) / 64u;
  let begin = lane * span;
  let end = min(begin + span, constants.control.z);

  // One oldest dirty page is guaranteed service independently of current
  // demand. Continuous re-invalidation of low slots cannot starve the backlog.
  // dirty_since is dirty-since frame serial, set on the clean -> dirty edge.
  var oldest = vec2u(0xffffffffu);
  for (var slot = begin; slot < end; slot++) {
    if (dirty_tier(slot) >= 3u) {
      continue;
    }
    let age = metas[slot].dirty_since;
    if (age < oldest.x || (age == oldest.x && slot < oldest.y)) {
      oldest = vec2u(age, slot);
    }
  }
  prefix[lane] = vec4u(oldest, 0u, 0u);
  workgroupBarrier();
  for (var stride = 32u; stride > 0u; stride /= 2u) {
    if (lane < stride) {
      let other = prefix[lane + stride].xy;
      let current = prefix[lane].xy;
      if (other.x < current.x || (other.x == current.x && other.y < current.y)) {
        prefix[lane] = vec4u(other, 0u, 0u);
      }
    }
    workgroupBarrier();
  }
  if (lane == 0u) {
    oldest_slot = prefix[0].y;
  }
  let oldest_selected = workgroupUniformLoad(&oldest_slot);
  let reserved = select(0u, 1u, oldest_selected != 0xffffffffu);

  var counts = vec4u(0u);
  for (var slot = begin; slot < end; slot++) {
    let tier = dirty_tier(slot);
    if (tier < 3u && slot != oldest_selected) {
      counts[tier]++;
    }
  }

  let base = scan_lanes(lane, counts);
  let total = prefix[63];
  let total_dirty = total.x + total.y + total.z + reserved;

  let budget = min(select(constants.identity.w, constants.control.z, constants.identity.w == 0u), constants.control.z);
  let remaining = budget - reserved;
  let take0 = min(total.x, remaining);
  let take1 = min(total.y, remaining - take0);
  let take2 = min(total.z, remaining - take0 - take1);
  let total_selected = reserved + take0 + take1 + take2;

  if (lane == 63u) {
    allocation.attempted = total_dirty;
    allocation.written = total_selected;
    allocation.overflow = 0u;
    allocation.generation = constants.control.x;
    atomicStore(&telemetry[7], total_dirty - total_selected);
  }

  var at0 = reserved + base.x;
  var at1 = reserved + take0 + base.y;
  var at2 = reserved + take0 + take1 + base.z;

  for (var slot = begin; slot < end; slot++) {
    let tier = dirty_tier(slot);
    let slot_meta = metas[slot];
    if (tier >= 3u) {
      if ((slot_meta.flags & 4u) != 0u) {
        metas[slot].flags = slot_meta.flags & ~4u;
      }
      continue;
    }
    var entry = pages[slot_meta.virtual_page];
    var selected = slot == oldest_selected;
    var at = 0u;
    if (!selected && tier == 0u && at0 < reserved + take0) {
      at = at0;
      at0++;
      selected = true;
    } else if (!selected && tier == 1u && at1 < reserved + take0 + take1) {
      at = at1;
      at1++;
      selected = true;
    } else if (!selected && tier == 2u && at2 < total_selected) {
      at = at2;
      at2++;
      selected = true;
    }
    if (slot_meta.dirty_since == 0u) {
      metas[slot].dirty_since = constants.dimensions.w;
    }

    if (selected) {
      pages[slot_meta.virtual_page].flags = entry.flags | 4u;
      metas[slot].flags = slot_meta.flags | 4u;
      allocation.records[at] = PageWork(slot_meta.virtual_page, slot, tier, constants.control.x,
        entry.flags | 4u, 5u, vec2i(entry.world_x, entry.world_y));
    } else {
      pages[slot_meta.virtual_page].flags = entry.flags & ~4u;
      metas[slot].flags = slot_meta.flags & ~4u;
    }
  }
}
`;

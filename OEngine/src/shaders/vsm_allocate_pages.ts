import { VSM_PAGE_TABLE_WGSL } from "./vsm_page_table.js";

/** GPU-only VSM residency: dedupe, free-slot reservation, bounded eviction and work publication. */
export const VSM_ALLOCATE_PAGES_WGSL = /* wgsl */ `
${VSM_PAGE_TABLE_WGSL}

struct Constants {
  control: vec4u,     // generation, demand capacity, resident slot count, clip level count
  dimensions: vec4u,  // virtual pages/axis, atlas pages/axis, virtual entry count, reserved
  identity: vec4u, // projection epoch, owner namespace, reserved
};

struct VsmDemandRecord {
  virtual_page: u32,
  mip: u32,
  priority: u32,
  flags: u32,
  world_page: vec2i,
  reserved: vec2u,
};

struct VsmDemandBuffer {
  attempted: atomic<u32>,
  written: atomic<u32>,
  overflow: atomic<u32>,
  generation: atomic<u32>,
  records: array<VsmDemandRecord>,
};

struct VsmPageWork {
  virtual_page: u32,
  slot: u32,
  priority: u32,
  generation: u32,
  flags: u32,
  fallback_mip: u32,
  reserved_0: u32,
  reserved_1: u32,
};

struct VsmAllocationBuffer {
  attempted: atomic<u32>,
  written: atomic<u32>,
  overflow: atomic<u32>,
  generation: atomic<u32>,
  records: array<VsmPageWork>,
};

struct VsmTelemetryBuffer {
  allocation_failed: atomic<u32>,
  evictions: atomic<u32>,
  reused: atomic<u32>,
  lock_contention: atomic<u32>,
};

struct VsmPageTableBuffer { entries: array<VsmPageEntry>, };
struct VsmMetaTableBuffer { entries: array<VsmMetaEntry>, };
struct VsmLockBuffer { values: array<atomic<u32>>, };

@group(0) @binding(0) var<uniform> constants: Constants;
@group(0) @binding(1) var<storage, read_write> demand: VsmDemandBuffer;
@group(0) @binding(2) var<storage, read_write> page_table: VsmPageTableBuffer;
@group(0) @binding(3) var<storage, read_write> meta_table: VsmMetaTableBuffer;
@group(0) @binding(4) var<storage, read_write> allocation: VsmAllocationBuffer;
@group(0) @binding(5) var<storage, read_write> page_locks: VsmLockBuffer;
@group(0) @binding(6) var<storage, read_write> slot_locks: VsmLockBuffer;
@group(0) @binding(7) var<storage, read_write> telemetry: VsmTelemetryBuffer;
@group(0) @binding(8) var<storage, read_write> content_version:array<atomic<u32>>;

const VSM_PAGE_DIRTY: u32 = 2u;
const VSM_PAGE_IN_FLIGHT: u32 = 4u;
const VSM_PAGE_ALLOCATED_AND_VALID: u32 = 9u;
const VSM_INVALID: u32 = 0xffffffffu;

fn append_work(record: VsmPageWork) -> bool {
  var observed = atomicLoad(&allocation.written);
  loop {
    if (observed >= constants.control.z) {
      atomicAdd(&allocation.overflow, 1u);
      return false;
    }
    let result = atomicCompareExchangeWeak(&allocation.written, observed, observed + 1u);
    if (result.exchanged) {
      allocation.records[observed] = record;
      return true;
    }
    observed = result.old_value;
  }
}

fn release_page_lock(index: u32) {
  atomicStore(&page_locks.values[index], 0u);
}

fn release_slot_lock(index: u32) {
  atomicStore(&slot_locks.values[index], 0u);
}

fn fallback_mip(mip: u32) -> u32 {
  return min(mip + 1u, constants.control.w - 1u);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let demand_index = id.x;
  if (demand_index == 0u) {
    atomicStore(&allocation.generation, constants.control.x);
  }
  let demand_count = min(atomicLoad(&demand.written), constants.control.y);
  if (demand_index >= demand_count) { return; }
  atomicAdd(&allocation.attempted, 1u);

  let request = demand.records[demand_index];
  let virtual_page = request.virtual_page;
  if (virtual_page >= constants.dimensions.z) { return; }

  // One logical page is processed once even when many receiver pixels requested it.
  var page_observed = atomicLoad(&page_locks.values[virtual_page]);
  var page_acquired = false;
  for (var retry = 0u; retry < 8u; retry++) {
    if (page_observed != 0u) { break; }
    let result = atomicCompareExchangeWeak(&page_locks.values[virtual_page], 0u, 1u);
    if (result.exchanged) {
      page_acquired = true;
      break;
    }
    page_observed = result.old_value;
  }
  if (!page_acquired) {
    atomicAdd(&telemetry.lock_contention, 1u);
    return;
  }

  let generation = constants.control.x;
  let current = page_table.entries[virtual_page];
  if ((current.flags & VSM_PAGE_ALLOCATED_AND_VALID) == VSM_PAGE_ALLOCATED_AND_VALID) {
    let slot = current.slot_y * constants.dimensions.y + current.slot_x;
    if (slot < constants.control.z) {
      let slot_result = atomicCompareExchangeWeak(&slot_locks.values[slot], 0u, 1u);
      if (slot_result.exchanged) {
        let verified = page_table.entries[virtual_page];
        if ((verified.flags & VSM_PAGE_ALLOCATED_AND_VALID) == VSM_PAGE_ALLOCATED_AND_VALID &&
            verified.slot_x == current.slot_x && verified.slot_y == current.slot_y &&
            meta_table.entries[slot].virtual_page == virtual_page) {
          if (verified.generation == generation && vsm_key_matches(verified, request.world_page, constants.identity)) {
            if (verified.flags & VSM_PAGE_DIRTY)!=0u { atomicStore(&content_version[1u],1u); }
            meta_table.entries[slot].last_visited = generation;
            let work = VsmPageWork(virtual_page, slot, request.priority, generation,
              verified.flags, verified.fallback_mip, 0u, 0u);
            _ = append_work(work);
            atomicAdd(&telemetry.reused, 1u);
          } else if ((meta_table.entries[slot].flags & VSM_PAGE_IN_FLIGHT) == 0u) {
            // A generation change invalidates the old sample, but the same
            // virtual page can safely reuse its physical slot in place.
            let flags = 1u | VSM_PAGE_DIRTY | VSM_PAGE_GENERATION_VALID;
            let fallback = fallback_mip(request.mip);
            page_table.entries[virtual_page] = VsmPageEntry(
              verified.slot_x, verified.slot_y, request.mip, flags, generation,
              fallback, 0u, constants.identity.x, request.world_page.x, request.world_page.y, constants.identity.y, 0u);
            atomicStore(&content_version[1u],1u);
            meta_table.entries[slot] = VsmMetaEntry(virtual_page, request.mip,
              generation, flags, generation, slot, 0u, 0u);
            _ = append_work(VsmPageWork(virtual_page, slot, request.priority,
              generation, flags, fallback, 0u, 0u));
          }
        }
        release_slot_lock(slot);
        release_page_lock(virtual_page);
        return;
      }
    }
    atomicAdd(&telemetry.lock_contention, 1u);
    release_page_lock(virtual_page);
    return;
  }

  var selected_slot = VSM_INVALID;

  // Free pages are always preferred. The slot lock is retained until the next
  // allocation pass, preventing same-frame eviction of newly published work.
  for (var slot = 0u; slot < constants.control.z; slot++) {
    if (atomicLoad(&slot_locks.values[slot]) != 0u) { continue; }
    let slot_result = atomicCompareExchangeWeak(&slot_locks.values[slot], 0u, 1u);
    if (!slot_result.exchanged) { continue; }
    if ((meta_table.entries[slot].flags & VSM_PAGE_ALLOCATED_AND_VALID) == 0u) {
      selected_slot = slot;
      break;
    }
    release_slot_lock(slot);
  }

  // Otherwise choose the oldest bounded candidate that is not current, dirty or in flight.
  if (selected_slot == VSM_INVALID) {
    var candidate = VSM_INVALID;
    var oldest = 0xffffffffu;
    for (var slot = 0u; slot < constants.control.z; slot++) {
      if (atomicLoad(&slot_locks.values[slot]) != 0u) { continue; }
      let slot_meta = meta_table.entries[slot];
      let slot_protected = (slot_meta.flags & (VSM_PAGE_DIRTY | VSM_PAGE_IN_FLIGHT)) != 0u;
      if ((slot_meta.flags & VSM_PAGE_ALLOCATED_AND_VALID) != VSM_PAGE_ALLOCATED_AND_VALID ||
          slot_protected || slot_meta.last_visited == generation) { continue; }
      if (slot_meta.last_visited <= oldest) {
        oldest = slot_meta.last_visited;
        candidate = slot;
      }
    }
    if (candidate != VSM_INVALID) {
      // Keep the same page -> slot lock order as the reuse path. Acquiring
      // slot first and then its owning page would permit a cross-demand cycle.
      let old_meta = meta_table.entries[candidate];
      let old_virtual = old_meta.virtual_page;
      if (old_virtual < constants.dimensions.z) {
        let old_page_result = atomicCompareExchangeWeak(&page_locks.values[old_virtual], 0u, 1u);
        if (old_page_result.exchanged) {
          let slot_result = atomicCompareExchangeWeak(&slot_locks.values[candidate], 0u, 1u);
          if (slot_result.exchanged) {
            let verify_meta = meta_table.entries[candidate];
            if (verify_meta.virtual_page == old_virtual &&
                (verify_meta.flags & (VSM_PAGE_DIRTY | VSM_PAGE_IN_FLIGHT)) == 0u &&
                verify_meta.last_visited != generation) {
              page_table.entries[old_virtual].slot_x = VSM_INVALID;
              page_table.entries[old_virtual].slot_y = VSM_INVALID;
              page_table.entries[old_virtual].flags = 0u;
              page_table.entries[old_virtual].generation = verify_meta.generation;
              atomicStore(&content_version[1u],1u);
              meta_table.entries[candidate].flags = 0u;
              atomicAdd(&telemetry.evictions, 1u);
              selected_slot = candidate;
            }
            if (selected_slot != candidate) { release_slot_lock(candidate); }
          }
          release_page_lock(old_virtual);
        }
      }
    }
  }

  if (selected_slot == VSM_INVALID) {
    atomicAdd(&allocation.overflow, 1u);
    atomicAdd(&telemetry.allocation_failed, 1u);
    release_page_lock(virtual_page);
    return;
  }

  let slot_x = selected_slot % constants.dimensions.y;
  let slot_y = selected_slot / constants.dimensions.y;
  let flags = 1u | VSM_PAGE_DIRTY | VSM_PAGE_GENERATION_VALID;
  let page = VsmPageEntry(slot_x, slot_y, request.mip, flags, generation,
    fallback_mip(request.mip), 0u, constants.identity.x, request.world_page.x, request.world_page.y, constants.identity.y, 0u);
  page_table.entries[virtual_page] = page;
  atomicStore(&content_version[1u],1u);
  meta_table.entries[selected_slot] = VsmMetaEntry(virtual_page, request.mip, generation,
    flags, generation, selected_slot, 0u, 0u);
  _ = append_work(VsmPageWork(virtual_page, selected_slot, request.priority, generation,
    flags, fallback_mip(request.mip), 0u, 0u));
  release_page_lock(virtual_page);
}
`;

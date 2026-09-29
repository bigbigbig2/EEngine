/** WGSL helpers shared by demand, allocation and sampling stages. */
export const VSM_PAGE_TABLE_WGSL = /* wgsl */ `
const VSM_INVALID_SLOT: u32 = 0xffffffffu;
const VSM_PAGE_ALLOCATED: u32 = 1u;
const VSM_PAGE_GENERATION_VALID: u32 = 8u;
const VSM_MIP_LEVELS: u32 = 6u;

struct VsmPageEntry {
  slot_x: u32,
  slot_y: u32,
  mip: u32,
  flags: u32,
  generation: u32,
  fallback_mip: u32,
  reserved_0: u32,
  reserved_1: u32,
};

struct VsmMetaEntry {
  virtual_page: u32,
  mip: u32,
  last_visited: u32,
  flags: u32,
  generation: u32,
  owner: u32,
  reserved_0: u32,
  reserved_1: u32,
};

fn vsm_entries_per_clip_level(pages_per_axis: u32) -> u32 {
  var count = 0u;
  for (var mip = 0u; mip < VSM_MIP_LEVELS; mip++) {
    let axis = max(1u, pages_per_axis >> mip);
    count += axis * axis;
  }
  return count;
}

fn vsm_page_entry_index(level: u32, mip: u32, page_x: u32, page_y: u32,
  pages_per_axis: u32) -> u32 {
  var offset = level * vsm_entries_per_clip_level(pages_per_axis);
  for (var previous = 0u; previous < min(mip, VSM_MIP_LEVELS); previous++) {
    let axis = max(1u, pages_per_axis >> previous);
    offset += axis * axis;
  }
  let axis = max(1u, pages_per_axis >> min(mip, VSM_MIP_LEVELS - 1u));
  return offset + page_y * axis + page_x;
}

/** Decode the ABI index as (clip level, mip, page x, page y). */
fn vsm_page_entry_coordinates(index: u32, pages_per_axis: u32) -> vec4u {
  let per_level = vsm_entries_per_clip_level(pages_per_axis);
  let level = index / per_level;
  var local = index % per_level;
  for (var mip = 0u; mip < VSM_MIP_LEVELS; mip++) {
    let axis = max(1u, pages_per_axis >> mip);
    let plane = axis * axis;
    if (local < plane) { return vec4u(level, mip, local % axis, local / axis); }
    local -= plane;
  }
  return vec4u(0xffffffffu);
}

fn vsm_page_is_current(entry: VsmPageEntry, generation: u32) -> bool {
  return (entry.flags & VSM_PAGE_ALLOCATED) != 0u &&
    (entry.flags & VSM_PAGE_GENERATION_VALID) != 0u && entry.generation == generation;
}

fn vsm_page_slot(entry: VsmPageEntry) -> vec2u {
  return vec2u(entry.slot_x, entry.slot_y);
}

fn vsm_invalid_slot() -> u32 { return VSM_INVALID_SLOT; }
`;

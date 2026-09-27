/** WGSL helpers shared by demand, allocation and sampling stages. */
export const VSM_PAGE_TABLE_WGSL = /* wgsl */ `
const VSM_INVALID_SLOT: u32 = 0xffffffffu;
const VSM_PAGE_ALLOCATED: u32 = 1u;
const VSM_PAGE_GENERATION_VALID: u32 = 8u;

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

fn vsm_page_entry_index(level: u32, page_x: u32, page_y: u32, pages_per_axis: u32) -> u32 {
  return (level * pages_per_axis + page_y) * pages_per_axis + page_x;
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

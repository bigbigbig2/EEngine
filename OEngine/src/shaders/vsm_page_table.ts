/** WGSL helpers shared by demand, allocation and sampling stages. */
export const VSM_PAGE_TABLE_WGSL = /* wgsl */ `
const VSM_INVALID_SLOT: u32 = 0xffffffffu;
const VSM_PAGE_ALLOCATED: u32 = 1u;
const VSM_PAGE_GENERATION_VALID: u32 = 8u;
const VSM_MIP_LEVELS: u32 = 6u;

fn vsm_storage_axis(pages: u32, mip: u32) -> u32 {
  let axis = max(1u, pages >> mip);
  return select(axis, axis * 2u, mip == 5u);
}

struct VsmPageEntry {
  slot_x: u32,
  slot_y: u32,
  mip: u32,
  flags: u32,
  generation: u32,
  fallback_mip: u32,
  reserved_0: u32,
  projection_epoch: u32,
  world_x: i32,
  world_y: i32,
  content_namespace: u32,
  reserved_2: u32,
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
    let axis = vsm_storage_axis(pages_per_axis, mip);
    count += axis * axis;
  }
  return count;
}

fn vsm_page_entry_index(level: u32, mip: u32, page_x: u32, page_y: u32,
  pages_per_axis: u32) -> u32 {
  var offset = level * vsm_entries_per_clip_level(pages_per_axis);
  for (var previous = 0u; previous < min(mip, VSM_MIP_LEVELS); previous++) {
    let axis = vsm_storage_axis(pages_per_axis, previous);
    offset += axis * axis;
  }
  let axis = vsm_storage_axis(pages_per_axis, min(mip, VSM_MIP_LEVELS - 1u));
  return offset + page_y * axis + page_x;
}

/** Decode the ABI index as (clip level, mip, page x, page y). */
fn vsm_page_entry_coordinates(index: u32, pages_per_axis: u32) -> vec4u {
  let per_level = vsm_entries_per_clip_level(pages_per_axis);
  let level = index / per_level;
  var local = index % per_level;
  for (var mip = 0u; mip < VSM_MIP_LEVELS; mip++) {
    let axis = vsm_storage_axis(pages_per_axis, mip);
    let plane = axis * axis;
    if (local < plane) {
      return vec4u(level, mip, local % axis, local / axis);
    }
    local -= plane;
  }
  return vec4u(0xffffffffu);
}

fn vsm_page_is_current(entry: VsmPageEntry, generation: u32) -> bool {
  return (entry.flags & VSM_PAGE_ALLOCATED) != 0u &&
    (entry.flags & VSM_PAGE_GENERATION_VALID) != 0u && entry.generation == generation;
}

fn vsm_floor_mod(value: i32, axis: u32) -> u32 {
  let divisor = i32(axis);
  return u32(((value % divisor) + divisor) % divisor);
}
fn vsm_world_page_entry_index(level: u32, mip: u32, world: vec2i, pages: u32) -> u32 {
  let axis = vsm_storage_axis(pages, mip);
  return vsm_page_entry_index(level, mip, vsm_floor_mod(world.x, axis), vsm_floor_mod(world.y, axis), pages);
}
fn vsm_world_page(light_xy: vec2f, clip: vec4f, mip: u32, pages: u32) -> vec2i {
  return vec2i(floor(light_xy / (clip.z / f32(max(1u, pages >> mip)))));
}
fn vsm_window_minimum(clip: vec4f, mip: u32, pages: u32) -> vec2i {
  if (mip == 5u) {
    // Cover every coarse cell intersecting the original fine window.
    let fine_center = clip.xy + vec2f(clip.z * 0.5);
    let fine_min = vec2i(floor(fine_center / (clip.z / f32(pages)))) - vec2i(i32(pages / 2u));
    return vec2i(floor(vec2f(fine_min) / 32.0));
  }
  let axis = max(1u, pages >> mip);
  let center = clip.xy + vec2f(clip.z * 0.5);
  return vec2i(floor(center / (clip.z / f32(axis)))) - vec2i(i32(axis / 2u));
}
fn vsm_window_size(clip: vec4f, mip: u32, pages: u32) -> vec2i {
  if (mip == 5u) {
    let fine_min = vsm_window_minimum(clip, 0u, pages);
    let last = vec2i(floor(vec2f(fine_min + vec2i(i32(pages) - 1)) / 32.0));
    return last - vsm_window_minimum(clip, mip, pages) + vec2i(1);
  }
  return vec2i(i32(max(1u, pages >> mip)));
}
fn vsm_world_in_window(world: vec2i, clip: vec4f, mip: u32, pages: u32) -> bool {
  let minimum = vsm_window_minimum(clip, mip, pages);
  return all(world >= minimum) && all(world < minimum + vsm_window_size(clip, mip, pages));
}
/** Shared receiver/sampler domain and target precision: first containing clip, mip0. */
fn vsm_select_clip(light_xy: vec2f, clips: array<vec4f, 6>, levels: u32, pages: u32) -> u32 {
  for (var level = 0u; level < min(levels, 6u); level++) {
    let world = vsm_world_page(light_xy, clips[level], 0u, pages);
    if (vsm_world_in_window(world, clips[level], 0u, pages)) {
      return level;
    }
  }
  return VSM_INVALID_SLOT;
}
fn vsm_key_matches(entry: VsmPageEntry, world: vec2i, identity: vec4u) -> bool {
  return entry.world_x == world.x && entry.world_y == world.y &&
    entry.projection_epoch == identity.x && entry.content_namespace == identity.y;
}
fn vsm_page_slot(entry: VsmPageEntry) -> vec2u {
  return vec2u(entry.slot_x, entry.slot_y);
}

fn vsm_invalid_slot() -> u32 { return VSM_INVALID_SLOT; }
`;

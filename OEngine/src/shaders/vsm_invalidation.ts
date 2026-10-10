import { VSM_PAGE_TABLE_WGSL } from "./vsm_page_table.js";

export const VSM_INVALIDATION_WGSL = /* wgsl */ `
${VSM_PAGE_TABLE_WGSL}
struct Constants {
  light_view: mat4x4f,
  clips: array<vec4f, 6>,
  dimensions: vec4u,
  control: vec4u,
  parameters: vec4f,
  depth_range: vec4f,
  identity: vec4u,
};
@group(0) @binding(0) var<uniform> constants: Constants;
@group(0) @binding(1) var<storage, read_write> pages: array<VsmPageEntry>;
@group(0) @binding(2) var<storage, read_write> metas: array<VsmMetaEntry>;
@group(0) @binding(3) var<storage, read_write> content: array<atomic<u32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&pages)) {
    return;
  }
  var entry = pages[id.x];
  if ((entry.flags & VSM_PAGE_ALLOCATED) == 0u) {
    return;
  }
  let coordinate = vsm_page_entry_coordinates(id.x, constants.dimensions.x);
  let world = vec2i(entry.world_x, entry.world_y);
  let minimum = vsm_window_minimum(constants.clips[coordinate.x], coordinate.y, constants.dimensions.x);
  let local = world - minimum;
  let outside = any(local < vec2i(0)) || any(local >= vsm_window_size(constants.clips[coordinate.x], coordinate.y, constants.dimensions.x));
  let stale = entry.generation != constants.control.x || !vsm_key_matches(entry, world, constants.identity);
  if (constants.control.y != 0u || outside || stale) {
    let slot = entry.slot_y * constants.dimensions.y + entry.slot_x;
    // Only the reverse mapping owner may release a physical slot.
    if (slot < arrayLength(&metas)) {
      var slot_meta = metas[slot];
      if (slot_meta.virtual_page == id.x && slot_meta.generation == entry.generation) {
        slot_meta.flags = 0u;
        metas[slot] = slot_meta;
      }
    }
    entry.flags = 0u;
    pages[id.x] = entry;
    atomicStore(&content[1u], 1u);
  }
}
`;

import { VSM_PAGE_TABLE_WGSL } from "./vsm_page_table.js";
import { VSM_CASTER_DAMAGE_WGSL } from "./vsm_depth_bounds.js";

/** One writer per physical slot/page. Revoke content-ready, retain allocation
 * and the complete world/projection/generation identity. */
export const VSM_CASTER_INVALIDATION_WGSL = /* wgsl */ `
${VSM_PAGE_TABLE_WGSL}
${VSM_CASTER_DAMAGE_WGSL}
struct Constants {
  light_view: mat4x4f,
  clips: array<vec4f, 6>,
  dimensions: vec4u, // virtual axis, atlas axis, page size, gutter
  control: vec4u, // generation, resident slots
  parameters: vec4f,
  depth_range: vec4f,
  identity: vec4u,
}
@group(0) @binding(0) var<uniform> constants: Constants;
@group(0) @binding(1) var<storage, read_write> pages: array<VsmPageEntry>;
@group(0) @binding(2) var<storage, read_write> metas: array<VsmMetaEntry>;
@group(0) @binding(3) var<storage, read_write> content: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> damages: CasterDamages;
fn overlaps(xy: vec4f, low: vec2f, high: vec2f) -> bool {
  return all(xy.zw >= low) && all(xy.xy <= high);
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= min(constants.control.y, arrayLength(&metas))) { return; }
  let slot_meta = metas[id.x];
  if ((slot_meta.flags & 9u) != 9u || slot_meta.generation != constants.control.x || slot_meta.owner != id.x ||
      slot_meta.virtual_page >= arrayLength(&pages)) { return; }
  var entry = pages[slot_meta.virtual_page];
  if ((entry.flags & 9u) != 9u || entry.generation != constants.control.x ||
      entry.slot_y * constants.dimensions.y + entry.slot_x != id.x ||
      entry.projection_epoch != constants.identity.x || entry.content_namespace != constants.identity.y ||
      entry.mip != slot_meta.mip) { return; }
  var dirty = atomicLoad(&damages.all_dirty) != 0u || atomicLoad(&damages.invalid) != 0u;
  let count = atomicLoad(&damages.count);
  if (count > arrayLength(&damages.records)) { dirty = true; }
  if (!dirty) {
    let coordinate = vsm_page_entry_coordinates(slot_meta.virtual_page, constants.dimensions.x);
    let page_world = constants.clips[min(coordinate.x, 5u)].z /
      f32(max(1u, constants.dimensions.x >> min(entry.mip, 5u)));
    let gutter = page_world * f32(constants.dimensions.w) / f32(constants.dimensions.z);
    let low = vec2f(f32(entry.world_x), f32(entry.world_y)) * page_world;
    let high = low + vec2f(page_world);
    for (var index = 0u; index < count; index++) {
      let damage = damages.records[index];
      if ((damage.caster_enabled.x != 0u && overlaps(damage.old_xy, low - vec2f(gutter), high + vec2f(gutter))) ||
          (damage.caster_enabled.y != 0u && overlaps(damage.new_xy, low - vec2f(gutter), high + vec2f(gutter)))) {
        dirty = true;
        break;
      }
    }
  }
  if (dirty) {
    pages[slot_meta.virtual_page].flags = (entry.flags | 2u) & ~4u;
    metas[id.x].flags = (slot_meta.flags | 2u) & ~4u;
    atomicStore(&content[1], 1u);
    atomicAdd(&damages.dirty_slots, 1u);
  }
}
`;

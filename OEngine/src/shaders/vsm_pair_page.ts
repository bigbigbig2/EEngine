/** Shared explicit/implicit page validation and gutter-expanded intersection.
 * Requires constants, page table ABI and VsmPageWork in the consumer. */
export const VSM_PAIR_PAGE_WGSL = /* wgsl */ `
fn vsm_pair_page_valid(work: VsmPageWork, entry: VsmPageEntry) -> bool {
  let pitch = constants.dimensions.y + constants.dimensions.z * 2u;
  let axis = constants.dimensions.w / pitch;
  return (work.flags & 11u) == 11u && work.generation == constants.control.x &&
    (entry.flags & 11u) == 11u && entry.generation == constants.control.x &&
    entry.projection_epoch == constants.identity.x && entry.content_namespace == constants.identity.y &&
    all(vec2i(entry.world_x, entry.world_y) == work.world) &&
    entry.slot_x + entry.slot_y * axis == work.slot;
}
fn vsm_pair_overlaps(light_xy: vec4f, entry: VsmPageEntry, virtual_page: u32) -> bool {
  let level = vsm_page_entry_coordinates(virtual_page, constants.dimensions.x).x;
  let page_world = constants.clip_origin_extent[min(level, 5u)].z /
    f32(max(1u, constants.dimensions.x >> min(entry.mip, 5u)));
  let gutter = page_world * f32(constants.dimensions.z) / f32(constants.dimensions.y);
  let low = vec2f(f32(entry.world_x), f32(entry.world_y)) * page_world;
  let high = low + vec2f(page_world);
  return all(light_xy.zw >= low - vec2f(gutter)) && all(light_xy.xy <= high + vec2f(gutter));
}
`;

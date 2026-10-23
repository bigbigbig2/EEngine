import { VSM_MAX_CLIP_LEVELS } from "../gpu/GpuVsmProjectionAbi.js";
import { VSM_SAMPLING_TYPES_WGSL } from "./vsm_sampling.js";

/** Full-domain publication after raster/content commit. No atomics or history.
 * 64 sequential lanes write 16B descriptors; management reads are modulo-window
 * coherent. Intermediate mips have no sampling consumer and are not published. */
export const VSM_SAMPLING_PUBLICATION_WGSL = /* wgsl */ `
${VSM_SAMPLING_TYPES_WGSL}
@group(0) @binding(0) var<uniform> constants: VsmSamplingConstants;
@group(0) @binding(1) var<storage, read> page_table: array<VsmPageEntry>;
@group(0) @binding(2) var<storage, read_write> descriptors: array<VsmSamplingDescriptor>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let pages = max(1u, constants.dimensions.x);
  let per_clip = vsm_sampling_entries_per_clip(pages);
  let count = min(${VSM_MAX_CLIP_LEVELS}u, constants.control.x) * per_clip;
  if (id.x >= count || id.x >= arrayLength(&descriptors)) {
    return;
  }
  let level = id.x / per_clip;
  let local = id.x % per_clip;
  let mip = select(0u, 5u, local >= pages * pages);
  let axis = vsm_storage_axis(pages, mip);
  let plane_local = local - select(0u, pages * pages, mip == 5u);
  let storage_world = vec2i(i32(plane_local % axis), i32(plane_local / axis));
  let clip = constants.clip_origin_extent[level];
  let minimum = vsm_window_minimum(clip, mip, pages);
  let world = minimum + vec2i(
    i32(vsm_floor_mod(storage_world.x - minimum.x, axis)),
    i32(vsm_floor_mod(storage_world.y - minimum.y, axis)));
  var result = VsmSamplingDescriptor(0u, 0u, VSM_QUERY_OUTSIDE, 0u);
  if (vsm_world_in_window(world, clip, mip, pages)) {
    result.status = VSM_QUERY_MISSING;
    let index = vsm_world_page_entry_index(level, mip, world, pages);
    if (index < arrayLength(&page_table)) {
      let entry = page_table[index];
      result.slot_x = entry.slot_x;
      result.slot_y = entry.slot_y;
      result.status = select(VSM_QUERY_FINE, VSM_QUERY_COARSE, mip == 5u);
      if ((entry.flags & VSM_PAGE_ALLOCATED) == 0u) {
        result.status = VSM_QUERY_MISSING;
      } else if (entry.mip != mip || !vsm_key_matches(entry, world, constants.identity) ||
          !vsm_page_is_current(entry, constants.control.y)) {
        result.status = VSM_QUERY_STALE;
      } else if ((entry.flags & 6u) != 0u) {
        result.status = VSM_QUERY_DIRTY;
      }
    }
  }
  descriptors[id.x] = result;
}
`;

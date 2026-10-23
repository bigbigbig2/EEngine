import { VSM_MAX_CLIP_LEVELS } from "../gpu/GpuVsmProjectionAbi.js";
import { VSM_SAMPLING_TYPES_WGSL } from "./vsm_sampling.js";

/** Initialize the complete domain once; atomic mutation words maintain the
 * persistent 16B descriptors after raster/content commit. Window rejection is
 * owned by the sampling query, so an unused ring address remains MISSING. */
export const VSM_SAMPLING_PUBLICATION_WGSL = /* wgsl */ `
${VSM_SAMPLING_TYPES_WGSL}
@group(0) @binding(0) var<uniform> constants: VsmSamplingConstants;
@group(0) @binding(1) var<storage, read> page_table: array<VsmPageEntry>;
@group(0) @binding(2) var<storage, read_write> descriptors: array<VsmSamplingDescriptor>;

@group(0) @binding(3) var<storage, read_write> mutations: array<atomic<u32>>;
override initialize: bool = false;

fn vsm_publish_descriptor(index: u32) {
  let pages = max(1u, constants.dimensions.x);
  let per_clip = vsm_sampling_entries_per_clip(pages);
  let count = min(${VSM_MAX_CLIP_LEVELS}u, constants.control.x) * per_clip;
  if (index >= count || index >= arrayLength(&descriptors)) {
    return;
  }
  let level = index / per_clip;
  let local = index % per_clip;
  let mip = select(0u, 5u, local >= pages * pages);
  let axis = vsm_storage_axis(pages, mip);
  let plane_local = local - select(0u, pages * pages, mip == 5u);
  let storage_world = vec2i(i32(plane_local % axis), i32(plane_local / axis));
  let clip = constants.clip_origin_extent[level];
  let minimum = vsm_window_minimum(clip, mip, pages);
  let world = minimum + vec2i(
    i32(vsm_floor_mod(storage_world.x - minimum.x, axis)),
    i32(vsm_floor_mod(storage_world.y - minimum.y, axis)));
  var result = VsmSamplingDescriptor(0u, 0u, VSM_QUERY_MISSING, 0u);
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
  descriptors[index] = result;
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if initialize {
    if atomicLoad(&mutations[0]) == 0u { vsm_publish_descriptor(id.x); }
  } else {
    let word = id.x + 4u;
    if word >= arrayLength(&mutations) { return; }
    var bits = atomicExchange(&mutations[word], 0u);
    while bits != 0u {
      let bit = firstTrailingBit(bits);
      bits &= bits - 1u;
      vsm_publish_descriptor(id.x * 32u + bit);
    }
  }
}
@compute @workgroup_size(1)
fn finish_initialization() { atomicStore(&mutations[0], 1u); }
`;

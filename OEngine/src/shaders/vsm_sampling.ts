import { VSM_PAGE_TABLE_WGSL } from "./vsm_page_table.js";

/**
 * Directional VSM sampling shared by the Surface direct-light consumer.
 *
 * The producer and consumer deliberately use the same clip origin, page
 * stride, generation and atlas depth convention. Missing, dirty or stale
 * pages return neutral visibility so bounded residency never creates black
 * frames while the next demand pass repairs the page.
 */
export const VSM_SAMPLING_WGSL = /* wgsl */ `
${VSM_PAGE_TABLE_WGSL}

struct VsmSamplingConstants {
  light_view: mat4x4f,
  clip_origin_extent: array<vec4f, 6>,
  dimensions: vec4u, // virtual pages/axis, page size, border, atlas pages/axis
  control: vec4u,    // clip levels, generation, taps per axis, atlas dimension
  filter_params: vec4f, // biases in actual shadow texels
  depth_range: vec4f, // GPU caster min/max Z, inverse range, validity
  identity: vec4u, // projection epoch, owner namespace
};

const VSM_QUERY_FINE: u32 = 0u;
const VSM_QUERY_COARSE: u32 = 1u;
const VSM_QUERY_MISSING: u32 = 2u;
const VSM_QUERY_STALE: u32 = 3u;
const VSM_QUERY_DIRTY: u32 = 4u;
const VSM_QUERY_OUTSIDE: u32 = 5u;

struct VsmPageQuery {
  entry: VsmPageEntry,
  level: u32,
  status: u32,
  // Preserve why the target fine page failed even when coarse succeeds.
  target_status: u32,
};

fn vsm_zero_entry() -> VsmPageEntry {
  return VsmPageEntry(0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0, 0, 0u, 0u);
}

fn vsm_clip_level(light_xy: vec2f) -> u32 {
  return vsm_select_clip(light_xy, vsm_constants.clip_origin_extent,
    vsm_constants.control.x, vsm_constants.dimensions.x);
}

fn vsm_lookup(level: u32, light_xy: vec2f, mip: u32) -> VsmPageQuery {
  let pages = max(1u, vsm_constants.dimensions.x);
  let clip = vsm_constants.clip_origin_extent[level];
  let world = vsm_world_page(light_xy, clip, mip, pages);
  if (!vsm_world_in_window(world, clip, mip, pages)) {
    return VsmPageQuery(vsm_zero_entry(), level, VSM_QUERY_OUTSIDE, VSM_QUERY_OUTSIDE);
  }
  let index = vsm_world_page_entry_index(level, mip, world, pages);
  if (index >= arrayLength(&vsm_page_table)) {
    return VsmPageQuery(vsm_zero_entry(), level, VSM_QUERY_MISSING, VSM_QUERY_MISSING);
  }
  let entry = vsm_page_table[index];
  var status = select(VSM_QUERY_FINE, VSM_QUERY_COARSE, mip == 5u);
  if ((entry.flags & VSM_PAGE_ALLOCATED) == 0u) {
    status = VSM_QUERY_MISSING;
  } else if (entry.mip != mip || !vsm_key_matches(entry, world, vsm_constants.identity) ||
      !vsm_page_is_current(entry, vsm_constants.control.y)) {
    status = VSM_QUERY_STALE;
  } else if ((entry.flags & 6u) != 0u) {
    status = VSM_QUERY_DIRTY;
  }
  return VsmPageQuery(entry, level, status, status);
}

fn vsm_query_directional(light_xy: vec2f) -> VsmPageQuery {
  let selected = vsm_clip_level(light_xy);
  if (selected == VSM_INVALID_SLOT) {
    return VsmPageQuery(vsm_zero_entry(), 0u, VSM_QUERY_OUTSIDE, VSM_QUERY_OUTSIDE);
  }
  let fine = vsm_lookup(selected, light_xy, 0u);
  if (fine.status == VSM_QUERY_FINE) {
    return fine;
  }
  for (var level = selected; level < min(6u, vsm_constants.control.x); level++) {
    var coarse = vsm_lookup(level, light_xy, 5u);
    if (coarse.status == VSM_QUERY_COARSE) {
      coarse.target_status = fine.status;
      return coarse;
    }
  }
  return fine;
}

fn vsm_page_local_uv(light_xy: vec2f, level: u32, mip: u32) -> vec2f {
  let axis = max(1u, vsm_constants.dimensions.x >> mip);
  let page_world = vsm_constants.clip_origin_extent[level].z / f32(axis);
  return fract(light_xy / page_world);
}

fn vsm_atlas_texel(entry: VsmPageEntry, local_uv: vec2f, offset: vec2f) -> vec2i {
  let page_size = max(1u, vsm_constants.dimensions.y);
  let border = vsm_constants.dimensions.z;
  let stride = page_size + border * 2u;
  let base = vec2f(f32(entry.slot_x * stride + border),
    f32(entry.slot_y * stride + border));
  let texel = floor(local_uv * f32(page_size) + offset + vec2f(0.5));
  // PCF reads the rasterized gutter. The clamp only protects the physical slot.
  let in_slot = clamp(texel, vec2f(-f32(border)), vec2f(f32(page_size + border) - 1.0));
  return vec2i(base + in_slot);
}

fn vsm_sample_page(entry: VsmPageEntry, local_uv: vec2f,
  reference_depth: f32, bias: f32) -> f32 {
  let taps = max(1u, min(4u, vsm_constants.control.z));
  var visible = 0.0;
  var total = 0.0;
  for (var y = 0u; y < 4u; y++) {
    for (var x = 0u; x < 4u; x++) {
      if (x >= taps || y >= taps) {
        continue;
      }
      let center = (vec2f(f32(x) + 0.5, f32(y) + 0.5) /
        f32(taps) - vec2f(0.5)) * 1.5;
      let stored = textureLoad(vsm_atlas_depth,
        vsm_atlas_texel(entry, local_uv, center), 0);
      // Reverse depth zero is the clear/empty value. Caster bounds include
      // padding, so every rasterized caster has positive depth. Receivers can
      // lie beyond the caster-only far bound and have negative reference depth.
      visible += select(1.0, 0.0, stored > 0.0 && stored > reference_depth + bias);
      total += 1.0;
    }
  }
  return visible / max(total, 1.0);
}

fn vsm_sample_directional(position_ws: vec3f, normal_ws: vec3f,
  incident: GpuPrimitiveTypeTable) -> f32 {
  if (vsm_constants.depth_range.w == 0.0) {
    return 1.0;
  }
  let light = (vsm_constants.light_view * vec4f(position_ws, 1.0)).xyz;
  let query = vsm_query_directional(light.xy);
  if (query.status != VSM_QUERY_FINE && query.status != VSM_QUERY_COARSE) {
    return 1.0;
  }
  let receiver_cosine = max(dot(normal_ws, incident.direction), 1e-3);
  let normal_bias = vsm_constants.filter_params.x * (1.0 - receiver_cosine);
  let slope_bias = vsm_constants.filter_params.z * (1.0 - receiver_cosine);
  let entry = query.entry;
  let local_uv = vsm_page_local_uv(light.xy, query.level, entry.mip);
  let extent = vsm_constants.clip_origin_extent[query.level].z;
  let reference_depth = (vsm_constants.depth_range.y - light.z) * vsm_constants.depth_range.z;
  let depth_per_texel = extent / f32(vsm_constants.dimensions.x * vsm_constants.dimensions.y) *
    exp2(f32(entry.mip)) * vsm_constants.depth_range.z;
  return vsm_sample_page(entry, local_uv, reference_depth,
    (vsm_constants.filter_params.y + slope_bias + normal_bias) * depth_per_texel);
}
`;

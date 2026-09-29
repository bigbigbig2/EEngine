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
  filter_params: vec4f, // normal offset scale, depth bias, slope scale, reserved
};

struct VsmSamplingResult {
  visibility: f32,
  resident: u32,
};

fn vsm_zero_entry() -> VsmPageEntry {
  return VsmPageEntry(0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u);
}

fn vsm_clip_level(light_xy: vec2f) -> u32 {
  let level_count = max(1u, min(6u, vsm_constants.control.x));
  var selected = level_count - 1u;
  for (var level = 0u; level < 6u; level++) {
    if (level >= level_count) { break; }
    let extent = vsm_constants.clip_origin_extent[level].z;
    let uv = (light_xy - vsm_constants.clip_origin_extent[level].xy) /
      max(extent, 1e-5);
    if (all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0))) {
      selected = level;
      break;
    }
  }
  return selected;
}

fn vsm_clip_uv(light_xy: vec2f, level: u32) -> vec2f {
  let clip = vsm_constants.clip_origin_extent[min(level, 5u)];
  return clamp((light_xy - clip.xy) / max(clip.z, 1e-5), vec2f(0.0), vec2f(0.999999));
}

fn vsm_lookup(level: u32, uv: vec2f, mip: u32) -> VsmPageEntry {
  let pages = max(1u, vsm_constants.dimensions.x);
  let effective_mip = min(mip, 5u);
  let axis = max(1u, pages >> effective_mip);
  let page = vec2u(min(axis - 1u, u32(uv.x * f32(axis))),
    min(axis - 1u, u32(uv.y * f32(axis))));
  let index = vsm_page_entry_index(min(level, 5u), effective_mip, page.x, page.y, pages);
  if (index >= arrayLength(&vsm_page_table)) { return vsm_zero_entry(); }
  let entry = vsm_page_table[index];
  if (entry.mip != effective_mip) { return vsm_zero_entry(); }
  return entry;
}

fn vsm_page_local_uv(uv: vec2f, mip: u32) -> vec2f {
  let axis = max(1u, vsm_constants.dimensions.x >> min(mip, 5u));
  return fract(uv * f32(axis));
}

fn vsm_atlas_texel(entry: VsmPageEntry, local_uv: vec2f, offset: vec2f) -> vec2i {
  let page_size = max(1u, vsm_constants.dimensions.y);
  let border = vsm_constants.dimensions.z;
  let stride = page_size + border * 2u;
  let base = vec2f(f32(entry.slot_x * stride + border),
    f32(entry.slot_y * stride + border));
  let interior = clamp(local_uv * f32(page_size) + offset,
    vec2f(0.0), vec2f(f32(page_size) - 1.0));
  return vec2i(base + floor(interior + vec2f(0.5)));
}

fn vsm_sample_page(entry: VsmPageEntry, local_uv: vec2f,
  reference_depth: f32, bias: f32) -> f32 {
  let taps = max(1u, min(4u, vsm_constants.control.z));
  var visible = 0.0;
  var total = 0.0;
  for (var y = 0u; y < 4u; y++) {
    for (var x = 0u; x < 4u; x++) {
      if (x >= taps || y >= taps) { continue; }
      let center = (vec2f(f32(x) + 0.5, f32(y) + 0.5) /
        f32(taps) - vec2f(0.5)) * 1.5;
      let stored = textureLoad(vsm_atlas_depth,
        vsm_atlas_texel(entry, local_uv, center), 0);
      visible += select(1.0, 0.0, stored > reference_depth + bias);
      total += 1.0;
    }
  }
  return visible / max(total, 1.0);
}

fn vsm_sample_directional(position_ws: vec3f, normal_ws: vec3f,
  incident: GpuPrimitiveTypeTable) -> f32 {
  let light = (vsm_constants.light_view * vec4f(position_ws, 1.0)).xyz;
  let selected = vsm_clip_level(light.xy);
  let level_count = max(1u, min(6u, vsm_constants.control.x));
  let receiver_cosine = max(dot(normal_ws, incident.direction), 1e-3);
  let normal_bias = vsm_constants.filter_params.x * (1.0 - receiver_cosine);
  let slope_bias = vsm_constants.filter_params.z * (1.0 - receiver_cosine);
  for (var level_offset = 0u; level_offset < 6u; level_offset++) {
    let level = min(selected + level_offset, level_count - 1u);
    let uv = vsm_clip_uv(light.xy, level);
    for (var mip = 0u; mip < 6u; mip++) {
      let entry = vsm_lookup(level, uv, mip);
      let current = vsm_page_is_current(entry, vsm_constants.control.y);
      // Dirty pages have not passed the GPU commit stage and must not be read.
      if (current && (entry.flags & 2u) == 0u) {
        let local_uv = vsm_page_local_uv(uv, entry.mip);
        let extent = vsm_constants.clip_origin_extent[min(level, 5u)].z;
        let reference_depth = clamp(0.5 - light.z / max(extent * 8.0, 1.0), 0.0, 1.0);
        return vsm_sample_page(entry, local_uv, reference_depth,
          vsm_constants.filter_params.y + slope_bias + normal_bias);
      }
      if (mip >= 5u) { break; }
    }
    if (level >= level_count - 1u) { break; }
  }
  return 1.0;
}
`;

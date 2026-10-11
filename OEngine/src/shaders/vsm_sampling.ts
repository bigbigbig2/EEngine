import { VSM_PAGE_TABLE_WGSL } from "./vsm_page_table.js";

/**
 * Directional VSM sampling shared by the Surface direct-light consumer.
 *
 * The producer and consumer deliberately use the same clip origin, page
 * stride, generation and atlas depth convention. Missing, dirty or stale
 * pages return neutral visibility so bounded residency never creates black
 * frames while the next demand pass repairs the page.
 */
export const VSM_SAMPLING_TYPES_WGSL = /* wgsl */ `
${VSM_PAGE_TABLE_WGSL}

struct VsmSamplingConstants {
  light_view: mat4x4f,
  clip_origin_extent: array<vec4f, 6>,
  dimensions: vec4u, // virtual pages/axis, page size, border, atlas pages/axis
  control: vec4u,    // clip levels, generation, taps per axis, atlas dimension
  filter_params: vec4f, // normal/depth/slope bias, PCF width in actual shadow texels
  depth_range: vec4f, // GPU caster min/max Z, inverse range, validity
  identity: vec4u, // projection epoch, owner namespace, debug view, reserved
};

const VSM_QUERY_FINE: u32 = 0u;
const VSM_QUERY_COARSE: u32 = 1u;
const VSM_QUERY_MISSING: u32 = 2u;
const VSM_QUERY_STALE: u32 = 3u;
const VSM_QUERY_DIRTY: u32 = 4u;
const VSM_QUERY_OUTSIDE: u32 = 5u;

// Full identities are checked by the post-content-commit producer against the
// current frame. Only these fields have a sampling/debug consumer (16 bytes).
struct VsmSamplingDescriptor {
  slot_x: u32,
  slot_y: u32,
  status: u32,
  reserved: u32,
};

fn vsm_sampling_entries_per_clip(pages: u32) -> u32 {
  let coarse_axis = vsm_storage_axis(pages, 5u);
  return pages * pages + coarse_axis * coarse_axis;
}

fn vsm_sampling_index(level: u32, mip: u32, world: vec2i, pages: u32) -> u32 {
  let axis = vsm_storage_axis(pages, mip);
  let plane = select(0u, pages * pages, mip == 5u);
  return level * vsm_sampling_entries_per_clip(pages) + plane +
    vsm_floor_mod(world.y, axis) * axis + vsm_floor_mod(world.x, axis);
}
`;

export function vsmSamplingWgsl(finalPixel = false): string {
  const count = finalPixel ? "final_pixel_vsm_descriptor_count()" : "arrayLength(&vsm_sampling_descriptors)";
  const descriptor = finalPixel ? "final_pixel_vsm_descriptor(index)" : "vsm_sampling_descriptors[index]";
  return /* wgsl */ `
${VSM_SAMPLING_TYPES_WGSL}

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
  let index = vsm_sampling_index(level, mip, world, pages);
  if (index >= ${count}) {
    return VsmPageQuery(vsm_zero_entry(), level, VSM_QUERY_MISSING, VSM_QUERY_MISSING);
  }
  let descriptor = ${descriptor};
  // Keep the invocation-private query shape for unchanged PCF/debug consumers.
  // No unused management fields are fetched or kept live in Native.
  let entry = VsmPageEntry(descriptor.slot_x, descriptor.slot_y, mip, 0u,
    0u, 0u, 0u, 0u, 0, 0, 0u, 0u);
  let status = descriptor.status;
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
  // This is the same sixteen point comparisons, not a different filter.
  // Keep the original f32 offset/floor/clamp order before counting repeats.
  // Radius <= 1 gives at most two integer texels per axis; the actual span
  // check also protects that condition at floating-point/gutter boundaries.
  let radius = vsm_constants.filter_params.w;
  if (taps == 4u && radius >= 0.0 && radius <= 1.0) {
    let page_size = max(1u, vsm_constants.dimensions.y);
    let border = vsm_constants.dimensions.z;
    let stride = page_size + border * 2u;
    let offsets = (vec4f(0.5, 1.5, 2.5, 3.5) / 4.0 - vec4f(0.5)) * radius;
    let lower = vec4f(-f32(border));
    let upper = vec4f(f32(page_size + border) - 1.0);
    let xs = vec4i(clamp(floor(vec4f(local_uv.x * f32(page_size)) + offsets + vec4f(0.5)), lower, upper));
    let ys = vec4i(clamp(floor(vec4f(local_uv.y * f32(page_size)) + offsets + vec4f(0.5)), lower, upper));
    if (xs.w - xs.x <= 1 && ys.w - ys.x <= 1) {
      let x_matches = select(vec4u(0u), vec4u(1u), xs == vec4i(xs.x));
      let y_matches = select(vec4u(0u), vec4u(1u), ys == vec4i(ys.x));
      let nx = x_matches.x + x_matches.y + x_matches.z + x_matches.w;
      let ny = y_matches.x + y_matches.y + y_matches.z + y_matches.w;
      let base = vec2i(i32(entry.slot_x * stride + border), i32(entry.slot_y * stride + border));
      var depths: vec4f;
      let atlas_size = textureDimensions(vsm_atlas_depth);
      // Negotiated atlases are powers of two. Integer/size coordinates are
      // then exact f32 values; +1 selects the middle of this 2x2 footprint.
      // Raw gather preserves zero/negative-reference semantics (no compare
      // sampler and no interpolation). Zero-weight neighbours are ignored.
      if (all((atlas_size & (atlas_size - vec2u(1u))) == vec2u(0u))) {
        let uv = (vec2f(base + vec2i(xs.x, ys.x)) + vec2f(1.0)) / vec2f(atlas_size);
        depths = textureGather(vsm_atlas_depth, vsm_atlas_sampler, uv).wzxy;
      } else {
        depths = vec4f(
          textureLoad(vsm_atlas_depth, base + vec2i(xs.x, ys.x), 0),
          textureLoad(vsm_atlas_depth, base + vec2i(xs.w, ys.x), 0),
          textureLoad(vsm_atlas_depth, base + vec2i(xs.x, ys.w), 0),
          textureLoad(vsm_atlas_depth, base + vec2i(xs.w, ys.w), 0));
      }
      let weights = vec4u(nx * ny, (4u - nx) * ny, nx * (4u - ny), (4u - nx) * (4u - ny));
      let shadowed = select(vec4u(0u), weights, depths > vec4f(reference_depth + bias));
      let visible = weights - select(vec4u(0u), shadowed, depths > vec4f(0.0));
      return f32(visible.x + visible.y + visible.z + visible.w) / 16.0;
    }
  }
  var visible = 0.0;
  var total = 0.0;
  for (var y = 0u; y < 4u; y++) {
    for (var x = 0u; x < 4u; x++) {
      if (x >= taps || y >= taps) {
        continue;
      }
      let center = (vec2f(f32(x) + 0.5, f32(y) + 0.5) /
        f32(taps) - vec2f(0.5)) * vsm_constants.filter_params.w;
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

// Debug-only queries. No per-pixel atomic counter or additional frame product.
fn vsm_debug_color(position_ws: vec3f, normal_ws: vec3f, sun_direction: vec3f,
  receives_shadow: bool) -> vec3f {
  if (!receives_shadow || vsm_constants.depth_range.w == 0.0) {
    return vec3f(0.0, 0.6, 0.6);
  }
  let light = (vsm_constants.light_view * vec4f(position_ws, 1.0)).xyz;
  let query = vsm_query_directional(light.xy);
  let mode = vsm_constants.identity.z;
  if (mode == 3u) {
    switch query.status {
      case VSM_QUERY_FINE: { return vec3f(0.05, 0.85, 0.15); }
      case VSM_QUERY_COARSE: { return vec3f(0.1, 0.3, 1.0); }
      case VSM_QUERY_MISSING: { return vec3f(1.0, 0.0, 1.0); }
      case VSM_QUERY_STALE: { return vec3f(1.0, 0.05, 0.0); }
      case VSM_QUERY_DIRTY: { return vec3f(1.0, 0.8, 0.0); }
      default: { return vec3f(0.25); }
    }
  }
  if (query.status != VSM_QUERY_FINE && query.status != VSM_QUERY_COARSE) {
    // Never disguise a missing page as measured shadow visibility.
    return vec3f(1.0, 0.0, 1.0);
  }
  if (mode == 2u) {
    let colors = array<vec3f, 6>(vec3f(0.9, 0.1, 0.1), vec3f(1.0, 0.55, 0.0),
      vec3f(0.9, 0.85, 0.0), vec3f(0.05, 0.8, 0.15), vec3f(0.0, 0.5, 1.0), vec3f(0.65, 0.1, 1.0));
    return colors[min(query.level, 5u)];
  }
  var incident: GpuPrimitiveTypeTable;
  incident.direction = sun_direction;
  incident.color = vec3f(1.0);
  return vec3f(vsm_sample_directional(position_ws, normal_ws, incident));
}
`;
}

export const VSM_SAMPLING_WGSL = vsmSamplingWgsl();

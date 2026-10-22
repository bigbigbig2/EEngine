import {
  VSM_FILTER_MODES,
  VSM_FILTER_NOISE_BYTES,
  VSM_FILTER_NOISE_WIDTH,
  VSM_FILTER_NOISE_HEIGHT,
  VSM_VOGEL_POINTS,
} from "../gpu/GpuVsmFilterAbi.js";
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
  control: vec4u,    // clip levels, generation, filter mode, noise phase
  filter_params: vec4f, // angular/depth bias, clip transition ratio, disk radius in actual shadow texels
  depth_range: vec4f, // GPU caster min/max Z, inverse range, validity
  identity: vec4u, // projection epoch, owner namespace, debug view, filter data word offset
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

fn vsm_local_texel(receiver: vec2f, offset: vec2f) -> vec2i {
  let size = vsm_constants.dimensions.y;
  let border = vsm_constants.dimensions.z;
  // Raster projects page UV to texel boundaries; a stored texel is sampled at
  // integer+.5. floor(receiver+offset) selects the nearest stored centre.
  return vec2i(clamp(floor(receiver + offset), vec2f(-f32(border)),
    vec2f(f32(size + border) - 1.0)));
}

fn vsm_receiver_plane_gradient(normal_ws: vec3f, depth_per_texel: f32) -> vec2f {
  // For n.x*dx+n.y*dy+n.z*dz=0 and reverse depth (maxZ-z)/range,
  // dDepth/dTexel = n.xy/n.z * worldTexel/range. Native already owns n.
  // No fragment derivatives, extra geometry reconstruction or output product.
  let light_normal = (vsm_constants.light_view * vec4f(normal_ws, 0.0)).xyz;
  if (!(abs(light_normal.z) >= 1e-4)) {
    // An almost edge-on plane has no bounded z(x,y) representation. Retain the
    // ordinary finite comparison bias for that singular case.
    return vec2f(0.0);
  }
  return light_normal.xy / light_normal.z * depth_per_texel;
}

fn vsm_depth_visibility(stored: f32, reference: f32) -> f32 {
  // Preserve reverse-Z zero/empty and negative receiver-reference semantics.
  return select(1.0, 0.0, stored > 0.0 && stored > reference);
}

fn vsm_sample_page(entry: VsmPageEntry, local_uv: vec2f,
  reference_depth: f32, bias: f32, rotation: vec2f, plane_gradient: vec2f) -> f32 {
  let reference = reference_depth + bias;
  let mode = vsm_constants.control.z;
  let size = vsm_constants.dimensions.y;
  let border = vsm_constants.dimensions.z;
  let stride = size + border * 2u;
  let base = vec2i(vec2u(entry.slot_x * stride + border, entry.slot_y * stride + border));
  let receiver = local_uv * f32(size);
  if (mode == ${VSM_FILTER_MODES.point}u) {
    let texel = vsm_local_texel(receiver, vec2f(0.0));
    let sample_reference = reference + dot(vec2f(texel) + vec2f(0.5) - receiver, plane_gradient);
    return vsm_depth_visibility(textureLoad(vsm_atlas_depth, base + texel, 0), sample_reference);
  }
  if (mode == ${VSM_FILTER_MODES["gather2x2"]}u) {
    // Compare each raw depth before interpolation. One sampling instruction,
    // four depth texels; a stable 2x2 kernel with no temporal noise.
    let point = clamp(receiver - vec2f(0.5), vec2f(-f32(border)),
      vec2f(f32(size + border) - 2.0));
    let lower = floor(point);
    let fraction = fract(point);
    let uv = (vec2f(base) + lower + vec2f(1.0)) / vec2f(textureDimensions(vsm_atlas_depth));
    let depths = textureGather(vsm_atlas_depth, vsm_atlas_sampler, uv).wzxy;
    let lower_reference = reference + dot(lower + vec2f(0.5) - receiver, plane_gradient);
    let references = lower_reference + vec4f(0.0, plane_gradient.x, plane_gradient.y,
      plane_gradient.x + plane_gradient.y);
    let visible = vec4f(vsm_depth_visibility(depths.x, references.x),
      vsm_depth_visibility(depths.y, references.y),
      vsm_depth_visibility(depths.z, references.z),
      vsm_depth_visibility(depths.w, references.w));
    return mix(mix(visible.x, visible.y, fraction.x),
      mix(visible.z, visible.w, fraction.x), fraction.y);
  }
  let kernel = array<vec2f, 4>(
    ${VSM_VOGEL_POINTS.map((point) => `vec2f(${point[0]}, ${point[1]})`).join(",\n    ")});
  let radius = vsm_constants.filter_params.w;
  var visible = 0.0;
  // Exactly four loads. Rotation and receiver/page setup are shared by all taps.
  for (var i = 0u; i < 4u; i++) {
    let p = kernel[i];
    let offset = vec2f(rotation.x * p.x - rotation.y * p.y,
      rotation.y * p.x + rotation.x * p.y) * radius;
    let texel = vsm_local_texel(receiver, offset);
    let stored = textureLoad(vsm_atlas_depth, base + texel, 0);
    let sample_reference = reference + dot(vec2f(texel) + vec2f(0.5) - receiver, plane_gradient);
    visible += vsm_depth_visibility(stored, sample_reference);
  }
  return visible * 0.25;
}

fn vsm_clip_transition_weight(light_xy: vec2f, level: u32) -> f32 {
  if (level + 1u >= min(6u, vsm_constants.control.x) || vsm_constants.filter_params.z <= 0.0) {
    return 0.0;
  }
  let pages = max(1u, vsm_constants.dimensions.x);
  let clip = vsm_constants.clip_origin_extent[level];
  let page_world = clip.z / f32(pages);
  let local = light_xy / page_world - vec2f(vsm_window_minimum(clip, 0u, pages));
  let window = vec2f(vsm_window_size(clip, 0u, pages));
  let edge_distance = min(min(local.x, window.x - local.x), min(local.y, window.y - local.y));
  let width = max(1.0, f32(pages) * vsm_constants.filter_params.z);
  return 1.0 - smoothstep(0.0, width, edge_distance);
}

fn vsm_sample_query(query: VsmPageQuery, light_xy: vec2f, normal_ws: vec3f,
  reference_depth: f32, angular_bias: f32, rotation: vec2f) -> f32 {
  let local_uv = vsm_page_local_uv(light_xy, query.level, query.entry.mip);
  let extent = vsm_constants.clip_origin_extent[query.level].z;
  let depth_per_texel = extent / f32(vsm_constants.dimensions.x * vsm_constants.dimensions.y) *
    exp2(f32(query.entry.mip)) * vsm_constants.depth_range.z;
  return vsm_sample_page(query.entry, local_uv, reference_depth,
    (vsm_constants.filter_params.y + angular_bias) * depth_per_texel,
    rotation, vsm_receiver_plane_gradient(normal_ws, depth_per_texel));
}

var<private> vsm_visibility_qualified: bool;
fn vsm_sample_directional(position_ws: vec3f, normal_ws: vec3f,
  incident: GpuPrimitiveTypeTable, receiver: ${finalPixel ? "vec2u" : "vec2f"}) -> f32 {
  vsm_visibility_qualified = false;
  if (vsm_constants.depth_range.w == 0.0) {
    return 1.0;
  }
  let light = (vsm_constants.light_view * vec4f(position_ws, 1.0)).xyz;
  let query = vsm_query_directional(light.xy);
  if (query.status != VSM_QUERY_FINE && query.status != VSM_QUERY_COARSE) {
    return 1.0;
  }
  let receiver_cosine = clamp(dot(normal_ws, incident.direction), 1e-3, 1.0);
  let angular_bias = vsm_constants.filter_params.x * (1.0 - receiver_cosine);
  let reference_depth = (vsm_constants.depth_range.y - light.z) * vsm_constants.depth_range.z;
  // A neutral/clamped depth result outside the published projection is not
  // measured receiver visibility for another transport consumer.
  vsm_visibility_qualified = reference_depth >= 0.0 && reference_depth <= 1.0;
  let rotation = ${finalPixel ? "vsm_filter_rotation(receiver)" : "receiver"};
  let current = vsm_sample_query(query, light.xy, normal_ws, reference_depth, angular_bias, rotation);
  if (query.status != VSM_QUERY_FINE) {
    return current;
  }
  let blend = vsm_clip_transition_weight(light.xy, query.level);
  if (blend <= 0.0) {
    return current;
  }
  let coarse = vsm_lookup(query.level + 1u, light.xy, 5u);
  if (coarse.status != VSM_QUERY_COARSE) {
    return current;
  }
  let fallback = vsm_sample_query(coarse, light.xy, normal_ws, reference_depth, angular_bias, rotation);
  return mix(current, fallback, blend);
}

// Debug-only queries. No per-pixel atomic counter or additional frame product.
fn vsm_debug_color(position_ws: vec3f, normal_ws: vec3f, sun_direction: vec3f,
  receives_shadow: bool, receiver: ${finalPixel ? "vec2u" : "vec2f"}) -> vec3f {
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
  return vec3f(vsm_sample_directional(position_ws, normal_ws, incident, receiver));
}
`;
}

/** Standalone VSM publications and Native directory windows have different
 * offset owners. The sampling algorithm is shared; each caller names its ABI. */
export function vsmFilterNoiseWgsl(noiseWordOffset = "vsm_constants.identity.w"): string {
  return /* wgsl */ `
fn vsm_filter_rotation(pixel: vec2u) -> vec2f {
  if (vsm_constants.control.z != ${VSM_FILTER_MODES.disk4}u) {
    return vec2f(1.0, 0.0);
  }
  let phase = vsm_constants.control.w;
  let index = (pixel.x % ${VSM_FILTER_NOISE_WIDTH}u) +
    (pixel.y % ${VSM_FILTER_NOISE_HEIGHT}u) * ${VSM_FILTER_NOISE_WIDTH}u +
    phase * ${VSM_FILTER_NOISE_WIDTH * VSM_FILTER_NOISE_HEIGHT}u;
  let packed = lighting_directory[${noiseWordOffset} + index / 4u];
  let noise = (packed >> ((index % 4u) * 8u)) & 255u;
  let at = ${noiseWordOffset} + ${VSM_FILTER_NOISE_BYTES / 4}u + noise * 2u;
  return bitcast<vec2f>(vec2u(lighting_directory[at], lighting_directory[at + 1u]));
}
`;
}

export const VSM_FILTER_NOISE_WGSL = vsmFilterNoiseWgsl();

export const VSM_SAMPLING_WGSL = vsmSamplingWgsl();

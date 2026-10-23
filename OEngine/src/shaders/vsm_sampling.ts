import { VSM_MAX_CLIP_LEVELS } from "../gpu/GpuVsmProjectionAbi.js";
import {
  VSM_FILTER_MODES,
  VSM_FILTER_NOISE_BYTES,
  VSM_FILTER_NOISE_WIDTH,
  VSM_FILTER_NOISE_HEIGHT,
  VSM_FILTER_ROTATIONS,
} from "../gpu/GpuVsmFilterAbi.js";
import { VSM_PAGE_TABLE_WGSL } from "./vsm_page_table.js";

/**
 * Directional VSM sampling shared by the Surface direct-light consumer.
 *
 * Implements Bevy Castano 13 Gaussian (stable-pcf, default) and Jimenez 14 PCSS (soft-pcss)
 * with analytical interleaved gradient noise and 4-depth reconstructed bilinear taps.
 */
export const VSM_SAMPLING_TYPES_WGSL = /* wgsl */ `
${VSM_PAGE_TABLE_WGSL}

struct VsmSamplingConstants {
  light_view: mat4x4f,
  clip_origin_extent: array<vec4f, ${VSM_MAX_CLIP_LEVELS}>,
  dimensions: vec4u, // virtual pages/axis, page size, border, atlas pages/axis
  control: vec4u,    // clip levels, generation, filter mode, temporal flag (0=off/static, 1=on)
  filter_params: vec4f, // angular/depth bias, clip transition ratio, light size in shadow texels
  depth_range: vec4f, // GPU caster min/max Z, inverse range, validity
  identity: vec4u, // projection epoch, owner namespace, debug view, filter data word offset
  selector: vec4f, // camera world position, distance multiplier
  footprint: vec4f, // bounded maximum filter radius (texels), active radius, clip transition ratio, border
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
  target_status: u32,
};

fn vsm_zero_entry() -> VsmPageEntry {
  return VsmPageEntry(0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0, 0, 0u, 0u);
}

fn vsm_clip_level(distance: f32) -> u32 {
  return vsm_select_clip(distance, vsm_constants.clip_origin_extent[0].z,
    vsm_constants.selector.w, vsm_constants.control.x, vsm_constants.dimensions.x);
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
  let entry = VsmPageEntry(descriptor.slot_x, descriptor.slot_y, mip, 0u,
    0u, 0u, 0u, 0u, 0, 0, 0u, 0u);
  let status = descriptor.status;
  return VsmPageQuery(entry, level, status, status);
}

fn vsm_query_directional(light_xy: vec2f, distance: f32) -> VsmPageQuery {
  let selected = vsm_clip_level(distance);
  if (selected == VSM_INVALID_SLOT) {
    return VsmPageQuery(vsm_zero_entry(), 0u, VSM_QUERY_OUTSIDE, VSM_QUERY_OUTSIDE);
  }
  let fine = vsm_lookup(selected, light_xy, 0u);
  if (fine.status == VSM_QUERY_FINE) {
    return fine;
  }
  for (var level = selected + 1u; level < min(VSM_CLIP_LEVELS, vsm_constants.control.x); level++) {
    var adjacent = vsm_lookup(level, light_xy, 0u);
    if (adjacent.status == VSM_QUERY_FINE) {
      adjacent.target_status = fine.status;
      return adjacent;
    }
  }
  for (var level = selected; level < min(${VSM_MAX_CLIP_LEVELS}u, vsm_constants.control.x); level++) {
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
  return vec2i(clamp(floor(receiver + offset), vec2f(-f32(border)),
    vec2f(f32(size + border) - 1.0)));
}

fn vsm_receiver_plane_gradient(normal_ws: vec3f, depth_per_texel: f32) -> vec2f {
  let light_normal = (vsm_constants.light_view * vec4f(normal_ws, 0.0)).xyz;
  if (!(abs(light_normal.z) >= 1e-4)) {
    return vec2f(0.0);
  }
  return light_normal.xy / light_normal.z * depth_per_texel;
}

fn vsm_depth_visibility(stored: f32, reference: f32) -> f32 {
  return select(1.0, 0.0, stored > 0.0 && stored > reference);
}

const D3D_SAMPLE_POINT_POSITIONS = array<vec2f, 8>(
  vec2f( 0.125, -0.375),
  vec2f(-0.125,  0.375),
  vec2f( 0.625,  0.125),
  vec2f(-0.375, -0.625),
  vec2f(-0.625,  0.625),
  vec2f(-0.875, -0.125),
  vec2f( 0.375,  0.875),
  vec2f( 0.875, -0.875),
);

const SPIRAL_OFFSETS = array<vec2f, 8>(
  vec2f(-0.7071,  0.7071),
  vec2f(-0.0000, -0.8750),
  vec2f( 0.5303,  0.5303),
  vec2f(-0.6250, -0.0000),
  vec2f( 0.3536, -0.3536),
  vec2f(-0.0000,  0.3750),
  vec2f(-0.1768, -0.1768),
  vec2f( 0.1250,  0.0000),
);

fn vsm_interleaved_gradient_noise(pixel: vec2f, frame: u32) -> f32 {
  let xy = pixel + 5.588238 * f32(frame % 64u);
  return fract(52.9829189 * fract(0.06711056 * xy.x + 0.00583715 * xy.y));
}

fn vsm_random_rotation_matrix(pixel: vec2f, frame: u32, temporal: bool) -> mat2x2f {
  let random_angle = 6.283185307179586 * vsm_interleaved_gradient_noise(
    pixel, select(1u, frame, temporal));
  let m = vec2f(sin(random_angle), cos(random_angle));
  return mat2x2f(
    m.y, -m.x,
    m.x,  m.y
  );
}

fn vsm_sample_depth_offset(query: VsmPageQuery, light_xy: vec2f, offset_texels: vec2f) -> f32 {
  let size = vsm_constants.dimensions.y;
  let border = vsm_constants.dimensions.z;
  let stride = size + border * 2u;
  let local_uv = vsm_page_local_uv(light_xy, query.level, query.entry.mip);
  let receiver = local_uv * f32(size);
  let tap_texel = receiver + offset_texels;
  if (tap_texel.x >= -f32(border) && tap_texel.x < f32(size + border) &&
      tap_texel.y >= -f32(border) && tap_texel.y < f32(size + border)) {
    let base = vec2i(vec2u(query.entry.slot_x * stride + border, query.entry.slot_y * stride + border));
    let coord = vec2i(floor(tap_texel));
    return textureLoad(vsm_atlas_depth, base + coord, 0);
  }
  let extent = vsm_constants.clip_origin_extent[query.level].z;
  let world_texel = extent / f32(vsm_constants.dimensions.x * size);
  let tap_light = light_xy + offset_texels * world_texel;
  let cross_query = vsm_lookup(query.level, tap_light, query.entry.mip);
  if (cross_query.status != VSM_QUERY_FINE && cross_query.status != VSM_QUERY_COARSE) {
    return 0.0;
  }
  let target_uv = vsm_page_local_uv(tap_light, cross_query.level, cross_query.entry.mip);
  let target_receiver = target_uv * f32(size);
  let target_base = vec2i(vec2u(cross_query.entry.slot_x * stride + border, cross_query.entry.slot_y * stride + border));
  let coord = vsm_local_texel(target_receiver, vec2f(0.0));
  return textureLoad(vsm_atlas_depth, target_base + coord, 0);
}

fn vsm_bilinear_tap(query: VsmPageQuery, light_xy: vec2f, tap_texels: vec2f,
  receiver: vec2f, reference: f32, plane_gradient: vec2f) -> f32 {
  let size = vsm_constants.dimensions.y;
  let border = vsm_constants.dimensions.z;
  let stride = size + border * 2u;
  let point = tap_texels - vec2f(0.5);
  if (point.x >= -f32(border) && point.x <= f32(size + border) - 2.0 &&
      point.y >= -f32(border) && point.y <= f32(size + border) - 2.0) {
    let base = vec2i(vec2u(query.entry.slot_x * stride + border, query.entry.slot_y * stride + border));
    let lower = floor(point);
    let fraction = fract(point);
    let uv = (vec2f(base) + lower + vec2f(1.0)) / vec2f(textureDimensions(vsm_atlas_depth));
    let depths = textureGather(vsm_atlas_depth, vsm_atlas_sampler, uv).wzxy;
    let lower_reference = reference + dot(lower + vec2f(0.5) - receiver, plane_gradient);
    let references = lower_reference + vec4f(0.0, plane_gradient.x, plane_gradient.y,
      plane_gradient.x + plane_gradient.y);
    let visible = vec4f(
      vsm_depth_visibility(depths.x, references.x),
      vsm_depth_visibility(depths.y, references.y),
      vsm_depth_visibility(depths.z, references.z),
      vsm_depth_visibility(depths.w, references.w)
    );
    return mix(mix(visible.x, visible.y, fraction.x),
      mix(visible.z, visible.w, fraction.x), fraction.y);
  }
  let lower = floor(point);
  let fraction = fract(point);
  let d00 = vsm_sample_depth_offset(query, light_xy, lower - receiver + vec2f(0.5));
  let d10 = vsm_sample_depth_offset(query, light_xy, lower - receiver + vec2f(1.5, 0.5));
  let d01 = vsm_sample_depth_offset(query, light_xy, lower - receiver + vec2f(0.5, 1.5));
  let d11 = vsm_sample_depth_offset(query, light_xy, lower - receiver + vec2f(1.5, 1.5));
  let lower_reference = reference + dot(lower + vec2f(0.5) - receiver, plane_gradient);
  let references = lower_reference + vec4f(0.0, plane_gradient.x, plane_gradient.y,
    plane_gradient.x + plane_gradient.y);
  let visible = vec4f(
    vsm_depth_visibility(d00, references.x),
    vsm_depth_visibility(d10, references.y),
    vsm_depth_visibility(d01, references.z),
    vsm_depth_visibility(d11, references.w)
  );
  return mix(mix(visible.x, visible.y, fraction.x),
    mix(visible.z, visible.w, fraction.x), fraction.y);
}

fn vsm_sample_castano_thirteen(query: VsmPageQuery, light_xy: vec2f,
  reference: f32, plane_gradient: vec2f) -> f32 {
  let size = vsm_constants.dimensions.y;
  let local_uv = vsm_page_local_uv(light_xy, query.level, query.entry.mip);
  let receiver = local_uv * f32(size);
  var base_uv = floor(receiver + vec2f(0.5));
  let s = receiver.x + 0.5 - base_uv.x;
  let t = receiver.y + 0.5 - base_uv.y;
  base_uv -= vec2f(0.5);

  let uw0 = 4.0 - 3.0 * s;
  let uw1 = 7.0;
  let uw2 = 1.0 + 3.0 * s;

  let u0 = (3.0 - 2.0 * s) / uw0 - 2.0;
  let u1 = (3.0 + s) / uw1;
  let u2 = s / uw2 + 2.0;

  let vw0 = 4.0 - 3.0 * t;
  let vw1 = 7.0;
  let vw2 = 1.0 + 3.0 * t;

  let v0 = (3.0 - 2.0 * t) / vw0 - 2.0;
  let v1 = (3.0 + t) / vw1;
  let v2 = t / vw2 + 2.0;

  var sum = 0.0;
  sum += uw0 * vw0 * vsm_bilinear_tap(query, light_xy, base_uv + vec2f(u0, v0), receiver, reference, plane_gradient);
  sum += uw1 * vw0 * vsm_bilinear_tap(query, light_xy, base_uv + vec2f(u1, v0), receiver, reference, plane_gradient);
  sum += uw2 * vw0 * vsm_bilinear_tap(query, light_xy, base_uv + vec2f(u2, v0), receiver, reference, plane_gradient);

  sum += uw0 * vw1 * vsm_bilinear_tap(query, light_xy, base_uv + vec2f(u0, v1), receiver, reference, plane_gradient);
  sum += uw1 * vw1 * vsm_bilinear_tap(query, light_xy, base_uv + vec2f(u1, v1), receiver, reference, plane_gradient);
  sum += uw2 * vw1 * vsm_bilinear_tap(query, light_xy, base_uv + vec2f(u2, v1), receiver, reference, plane_gradient);

  sum += uw0 * vw2 * vsm_bilinear_tap(query, light_xy, base_uv + vec2f(u0, v2), receiver, reference, plane_gradient);
  sum += uw1 * vw2 * vsm_bilinear_tap(query, light_xy, base_uv + vec2f(u1, v2), receiver, reference, plane_gradient);
  sum += uw2 * vw2 * vsm_bilinear_tap(query, light_xy, base_uv + vec2f(u2, v2), receiver, reference, plane_gradient);

  return sum * (1.0 / 144.0);
}

fn vsm_search_for_blockers(query: VsmPageQuery, light_xy: vec2f,
  reference: f32, plane_gradient: vec2f, texel_size: f32, light_size: f32) -> vec2f {
  let search_radius_texels = light_size / max(texel_size, 1e-5);
  var sum = vec2f(0.0);
  for (var i = 0u; i < 8u; i++) {
    let offset = D3D_SAMPLE_POINT_POSITIONS[i] * search_radius_texels;
    let stored = vsm_sample_depth_offset(query, light_xy, offset);
    let sample_ref = reference + dot(offset, plane_gradient);
    if (stored > 0.0 && stored > sample_ref) {
      sum.x += stored;
      sum.y += 1.0;
    }
  }
  return sum;
}

fn vsm_calculate_uv_offset_scale_jimenez(texel_size: f32, blur_size: f32) -> f32 {
  let f = 0.015 + (texel_size - 0.00390625) * (0.035 - 0.015) / (0.022949219 - 0.00390625);
  return f * blur_size / max(texel_size, 1e-5);
}

fn vsm_sample_jimenez_fourteen(query: VsmPageQuery, light_xy: vec2f,
  reference: f32, plane_gradient: vec2f, pixel_xy: vec2f, texel_size: f32,
  blur_size: f32, temporal: bool) -> f32 {
  let rotation_matrix = vsm_random_rotation_matrix(pixel_xy, vsm_constants.control.y, temporal);
  let filter_radius_texels = vsm_calculate_uv_offset_scale_jimenez(texel_size, blur_size);

  let size = vsm_constants.dimensions.y;
  let local_uv = vsm_page_local_uv(light_xy, query.level, query.entry.mip);
  let receiver = local_uv * f32(size);

  var sum = 0.0;
  for (var i = 0u; i < 8u; i++) {
    let offset_texels = (rotation_matrix * SPIRAL_OFFSETS[i]) * filter_radius_texels;
    sum += vsm_bilinear_tap(query, light_xy, receiver + offset_texels, receiver, reference, plane_gradient);
  }
  return sum * 0.125;
}

fn vsm_sample_pcss(query: VsmPageQuery, light_xy: vec2f,
  reference: f32, plane_gradient: vec2f, pixel_xy: vec2f,
  texel_size: f32, light_size: f32, temporal: bool) -> f32 {
  let blocker_info = vsm_search_for_blockers(query, light_xy, reference, plane_gradient, texel_size, light_size);
  if (blocker_info.y == 0.0) {
    return 1.0;
  }
  let z_blocker = blocker_info.x / blocker_info.y;
  let safe_depth = max(reference, 1e-3);
  let blur_size = max((z_blocker - reference) * light_size / safe_depth, 0.5);
  let filter_radius_texels = vsm_calculate_uv_offset_scale_jimenez(texel_size, blur_size);
  if (filter_radius_texels > vsm_constants.footprint.x && vsm_constants.footprint.x > 0.0) {
    return vsm_sample_castano_thirteen(query, light_xy, reference, plane_gradient);
  }
  return vsm_sample_jimenez_fourteen(query, light_xy, reference, plane_gradient, pixel_xy, texel_size, blur_size, temporal);
}

fn vsm_sample_point(query: VsmPageQuery, light_xy: vec2f, reference: f32, plane_gradient: vec2f) -> f32 {
  let size = vsm_constants.dimensions.y;
  let border = vsm_constants.dimensions.z;
  let stride = size + border * 2u;
  let base = vec2i(vec2u(query.entry.slot_x * stride + border, query.entry.slot_y * stride + border));
  let local_uv = vsm_page_local_uv(light_xy, query.level, query.entry.mip);
  let receiver = local_uv * f32(size);
  let texel = vsm_local_texel(receiver, vec2f(0.0));
  let sample_ref = reference + dot(vec2f(texel) + vec2f(0.5) - receiver, plane_gradient);
  return vsm_depth_visibility(textureLoad(vsm_atlas_depth, base + texel, 0), sample_ref);
}

fn vsm_clip_transition_weight(distance: f32, level: u32) -> f32 {
  return vsm_transition_weight(distance, level, vsm_constants.clip_origin_extent[0].z,
    vsm_constants.selector.w, vsm_constants.control.x, vsm_constants.dimensions.x,
    vsm_constants.filter_params.z);
}

fn vsm_sample_query(query: VsmPageQuery, light_xy: vec2f, normal_ws: vec3f,
  reference_depth: f32, angular_bias: f32, pixel_xy: vec2f, temporal: bool) -> f32 {
  let extent = vsm_constants.clip_origin_extent[query.level].z;
  let texel_size = extent / f32(vsm_constants.dimensions.x * vsm_constants.dimensions.y) *
    exp2(f32(query.entry.mip));
  let depth_per_texel = texel_size * vsm_constants.depth_range.z;
  let plane_gradient = vsm_receiver_plane_gradient(normal_ws, depth_per_texel);
  let reference = reference_depth + (vsm_constants.filter_params.y + angular_bias) * depth_per_texel;
  let mode = vsm_constants.control.z;
  if (mode == ${VSM_FILTER_MODES.point}u) {
    return vsm_sample_point(query, light_xy, reference, plane_gradient);
  }
  if (mode == ${VSM_FILTER_MODES["soft-pcss"]}u) {
    let light_size = vsm_constants.filter_params.w;
    return vsm_sample_pcss(query, light_xy, reference, plane_gradient, pixel_xy, texel_size, light_size, temporal);
  }
  return vsm_sample_castano_thirteen(query, light_xy, reference, plane_gradient);
}

var<private> vsm_visibility_qualified: bool;
fn vsm_sample_directional(position_ws: vec3f, normal_ws: vec3f,
  incident: GpuPrimitiveTypeTable, receiver: ${finalPixel ? "vec2u" : "vec2f"}) -> f32 {
  vsm_visibility_qualified = false;
  if (vsm_constants.depth_range.w == 0.0) {
    return 1.0;
  }
  let light = (vsm_constants.light_view * vec4f(position_ws, 1.0)).xyz;
  let distance = length(position_ws - vsm_constants.selector.xyz);
  let query = vsm_query_directional(light.xy, distance);
  if (query.status != VSM_QUERY_FINE && query.status != VSM_QUERY_COARSE) {
    return 1.0;
  }
  let receiver_cosine = clamp(dot(normal_ws, incident.direction), 1e-3, 1.0);
  let angular_bias = vsm_constants.filter_params.x * (1.0 - receiver_cosine);
  let reference_depth = (vsm_constants.depth_range.y - light.z) * vsm_constants.depth_range.z;
  vsm_visibility_qualified = reference_depth >= 0.0 && reference_depth <= 1.0;
  let pixel_xy = vec2f(receiver);
  let temporal = vsm_constants.control.w != 0u;
  let current = vsm_sample_query(query, light.xy, normal_ws, reference_depth, angular_bias, pixel_xy, temporal);
  if (query.status != VSM_QUERY_FINE) {
    return current;
  }
  if (query.level != vsm_clip_level(distance)) { return current; }
  let blend = vsm_clip_transition_weight(distance, query.level);
  if (blend <= 0.0) {
    return current;
  }
  let adjacent_level = query.level + 1u;
  let adjacent = vsm_lookup(adjacent_level, light.xy, 0u);
  if (adjacent.status != VSM_QUERY_FINE) {
    return current;
  }
  let next = vsm_sample_query(adjacent, light.xy, normal_ws, reference_depth, angular_bias, pixel_xy, temporal);
  return mix(current, next, blend);
}

fn vsm_debug_color(position_ws: vec3f, normal_ws: vec3f, sun_direction: vec3f,
  receives_shadow: bool, receiver: ${finalPixel ? "vec2u" : "vec2f"}) -> vec3f {
  if (!receives_shadow || vsm_constants.depth_range.w == 0.0) {
    return vec3f(0.0, 0.6, 0.6);
  }
  let light = (vsm_constants.light_view * vec4f(position_ws, 1.0)).xyz;
  let distance = length(position_ws - vsm_constants.selector.xyz);
  let query = vsm_query_directional(light.xy, distance);
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
    return vec3f(1.0, 0.0, 1.0);
  }
  if (mode == 2u) {
    let hue = f32(query.level) * 0.618033989;
    return clamp(abs(fract(vec3f(hue) + vec3f(0.0, 0.666666667, 0.333333333)) * 6.0 - 3.0) - 1.0,
      vec3f(0.0), vec3f(1.0)) * 0.85 + vec3f(0.05);
  }
  var incident: GpuPrimitiveTypeTable;
  incident.direction = sun_direction;
  incident.color = vec3f(1.0);
  return vec3f(vsm_sample_directional(position_ws, normal_ws, incident, receiver));
}
`;
}

export function vsmFilterNoiseWgsl(_noiseWordOffset = "vsm_constants.identity.w"): string {
  return "";
}

export const VSM_FILTER_NOISE_WGSL = vsmFilterNoiseWgsl();

export const VSM_SAMPLING_WGSL = vsmSamplingWgsl();

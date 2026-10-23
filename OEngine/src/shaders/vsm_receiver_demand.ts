import { VSM_MAX_CLIP_LEVELS } from "../gpu/GpuVsmProjectionAbi.js";
import { GPU_INSTANCE_FLAGS, GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { VSM_PAGE_TABLE_WGSL } from "./vsm_page_table.js";

/** Complete two-level demand, aggregated into 128 slots per 64-lane group.
 * Footprints may exceed the hash capacity: probe exhaustion publishes both
 * the bit and score directly, without dropping demand. */
export const VSM_RECEIVER_AGGREGATION_WGSL = /* wgsl */ `
var<workgroup> receiver_keys: array<atomic<u32>, 128>;
var<workgroup> receiver_scores: array<atomic<u32>, 128>;

fn record_receiver_page(page: u32, weight: u32) {
  if (page == VSM_INVALID_SLOT) {
    return;
  }
  let key = page + 1u;
  var slot = (page * 2654435761u) & 127u;
  for (var attempt = 0u; attempt < 128u; attempt++) {
    let reservation = atomicCompareExchangeWeak(&receiver_keys[slot], 0u, key);
    if (reservation.exchanged || reservation.old_value == key) {
      atomicAdd(&receiver_scores[slot], weight);
      return;
    }
    if (reservation.old_value != 0u) {
      slot = (slot + 1u) & 127u;
    }
  }
  atomicOr(&requested[page / 32u], 1u << (page % 32u));
  atomicAdd(&receiver_priority[page], weight);
}

fn publish_receiver_pages(pair: vec2u, lane: u32) {
  record_receiver_page(pair.x, 2u);
  record_receiver_page(pair.y, 1u);
  workgroupBarrier();
  for (var slot = lane; slot < 128u; slot += 64u) {
    let key = atomicLoad(&receiver_keys[slot]);
    if (key != 0u) {
      let page = key - 1u;
      atomicOr(&requested[page / 32u], 1u << (page % 32u));
      atomicAdd(&receiver_priority[page], atomicLoad(&receiver_scores[slot]));
    }
  }
}
`;

/** Receiver-driven directional VSM demand. GPU allocation consumes this bounded buffer next. */
export const VSM_RECEIVER_DEMAND_WGSL = /* wgsl */ `
${VSM_PAGE_TABLE_WGSL}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_VISIBILITY_KEY_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}

struct Camera {
  transform: mat4x4f,
  transform_inverse: mat4x4f,
  view_matrix: mat4x4f,
  view_matrix_inverse: mat4x4f,
  projection_matrix: mat4x4f,
  projection_matrix_inverse: mat4x4f,
  view_projection_matrix: mat4x4f,
  view_projection_matrix_inverse: mat4x4f,
  frustum: array<vec4f,
  6>,
  device_depth_to_view_space: vec4f,
};

struct Constants {
  light_view: mat4x4f,
  clip_origin_extent: array<vec4f, ${VSM_MAX_CLIP_LEVELS}>,
  dimensions: vec4u,
  control: vec4u,
  viewport: vec4f,
  depth_range: vec4f,
  identity: vec4u,
  selector: vec4f, // camera world position, distance multiplier
  footprint: vec4f, // bounded maximum filter radius (texels), reserved
};

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var receiver_depth: texture_depth_2d;
@group(0) @binding(2) var visibility_key: texture_2d<u32>;
@group(0) @binding(3) var<uniform> constants: Constants;
@group(0) @binding(4) var<storage, read_write> requested: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(6) var<storage, read> instances: array<OEngineInstanceRecord>;
@group(0) @binding(8) var<storage, read_write> receiver_priority: array<atomic<u32>>;

fn world_from_depth(pixel: vec2u, depth: f32) -> vec3f {
  let uv = (vec2f(pixel) + vec2f(0.5)) * constants.viewport.xy;
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let projected = camera.view_projection_matrix_inverse * vec4f(ndc, depth, 1.0);
  return projected.xyz / projected.w;
}

var<private> receiver_light_xy: vec2f;
fn project_pixel_depth_to_pages(pixel: vec2u, depth: f32) -> vec2u {
  let world = world_from_depth(pixel, depth);
  if (any(world != world) || any(abs(world) > vec3f(3.4028234663852886e38))) {
    return vec2u(VSM_INVALID_SLOT);
  }
  let light = constants.light_view * vec4f(world, 1.0);
  receiver_light_xy = light.xy;
  let selected = vsm_select_clip(length(world - constants.selector.xyz),
    constants.clip_origin_extent[0].z, constants.selector.w, constants.control.x, constants.dimensions.w);
  var result = vec2u(VSM_INVALID_SLOT);
  for (var endpoint = 0u; endpoint < 2u; endpoint++) {
    let level = selected + endpoint;
    if (level >= constants.control.x) { break; }
    let clip = constants.clip_origin_extent[level];
    let page = vsm_world_page(light.xy, clip, 0u, constants.dimensions.w);
    if (vsm_world_in_window(page, clip, 0u, constants.dimensions.w)) {
      result[endpoint] = vsm_world_page_entry_index(level, 0u, page, constants.dimensions.w);
    }
  }
  return result;
}

// Distance selection is discontinuous across clip shells. Equal corner
// indices do not prove that an interior pixel selects the same finer level.
// Only exact per-receiver requests are merged by the page-key aggregation below.
fn receiver_pages(id: vec3u) -> vec2u {
  if (id.x >= constants.dimensions.x || id.y >= constants.dimensions.y) {
    return vec2u(VSM_INVALID_SLOT);
  }
  let pixel = vec2i(id.xy);
  let depth = textureLoad(receiver_depth, pixel, 0);
  if (!(depth > 0.0 && depth <= 1.0)) {
    return vec2u(VSM_INVALID_SLOT);
  }
  let key = textureLoad(visibility_key, pixel, 0).x;
  let decoded = oengine_visibility_key_resolve(key, meshlet_work.header.generation, meshlet_work.header.written_count);
  if (decoded.valid == 0u || decoded.meshlet_work_slot >= min(meshlet_work.header.capacity, arrayLength(&meshlet_work.elements))) {
    return vec2u(VSM_INVALID_SLOT);
  }
  let instance_slot = meshlet_work.elements[decoded.meshlet_work_slot].instance_slot;
  if (instance_slot >= arrayLength(&instances)) {
    return vec2u(VSM_INVALID_SLOT);
  }
  let flags = instances[instance_slot].flags;
  if ((flags & ${GPU_INSTANCE_FLAGS.Active | GPU_INSTANCE_FLAGS.ReceivesShadow}u) != ${GPU_INSTANCE_FLAGS.Active | GPU_INSTANCE_FLAGS.ReceivesShadow}u ||
      (flags & ${GPU_INSTANCE_FLAGS.Transparent}u) != 0u || oengine_instance_shading_bin_id(flags) < 4u) {
    return vec2u(VSM_INVALID_SLOT);
  }
  return project_pixel_depth_to_pages(id.xy, depth);
}

${VSM_RECEIVER_AGGREGATION_WGSL}

// Bound is negotiated by the CPU before encoding; each endpoint visits <= 3x3
// pages. Gutter-covered taps need no neighbour residency; larger kernels expand demand.
fn record_receiver_footprint(id: vec3u, pair: vec2u) {
  if (all(pair == vec2u(VSM_INVALID_SLOT)) || constants.footprint.x <= constants.footprint.w) { return; }
  let light = receiver_light_xy;
  let pages = constants.dimensions.w;
  for (var endpoint = 0u; endpoint < 2u; endpoint++) {
    if (pair[endpoint] == VSM_INVALID_SLOT) { continue; }
    let level = vsm_page_entry_coordinates(pair[endpoint], pages).x;
    let clip = constants.clip_origin_extent[level];
    let radius_world = constants.footprint.x * clip.w;
    let lo = vsm_world_page(light - vec2f(radius_world), clip, 0u, pages);
    let hi = vsm_world_page(light + vec2f(radius_world), clip, 0u, pages);
    for (var y = lo.y; y <= hi.y; y++) {
      for (var x = lo.x; x <= hi.x; x++) {
        let world = vec2i(x, y);
        if (!vsm_world_in_window(world, clip, 0u, pages)) { continue; }
        let page = vsm_world_page_entry_index(level, 0u, world, pages);
        if (page != pair[endpoint]) { record_receiver_page(page, select(2u, 1u, endpoint == 1u)); }
      }
    }
  }
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u,
  @builtin(local_invocation_index) lane: u32) {
  let pair = receiver_pages(id);
  record_receiver_footprint(id, pair);
  publish_receiver_pages(pair, lane);
}
@compute @workgroup_size(64)
fn mark_coarse(@builtin(global_invocation_id) id: vec3u) {
  let pages = constants.dimensions.w;
  let axis = vsm_storage_axis(pages, 5u);
  let level = id.x / (axis * axis);
  if (level >= constants.control.x || constants.depth_range.w == 0.0) {
    return;
  }
  let local = id.x % (axis * axis);
  let clip = constants.clip_origin_extent[level];
  let minimum = vsm_window_minimum(clip, 5u, pages);
  let world = minimum + vec2i(i32(local % axis), i32(local / axis));
  if (!vsm_world_in_window(world, clip, 5u, pages)) {
    return;
  }
  let entry = vsm_world_page_entry_index(level, 5u, world, pages);
  atomicOr(&requested[entry / 32u], 1u << (entry % 32u));
}

`;

/** Temporary diagnostic specialization. Reuse the exact production receiver
 * predicate/projection and aggregation. Adds 256B pages + 16B atomics, two
 * barriers and one 16B write per group. Raw counts are logical receiver
 * attempts before aggregation, not the new global atomic count. Never time this.
 */
export function vsmReceiverDemandDiagnosticWgsl(): string {
  const begin = VSM_RECEIVER_DEMAND_WGSL.indexOf("@compute @workgroup_size(8, 8, 1)");
  const end = VSM_RECEIVER_DEMAND_WGSL.indexOf("@compute @workgroup_size(64)", begin);
  const original = VSM_RECEIVER_DEMAND_WGSL.slice(begin, end);
  if (begin < 0 || end < 0 || !original.includes("publish_receiver_pages(pair, lane);")) {
    throw new Error("VSM diagnostic receiver specialization no longer matches its producer");
  }
  const main = /* wgsl */ `
@group(0) @binding(7) var<storage, read_write> diagnostic_workgroups: array<vec4u>;
var<workgroup> diagnostic_pages: array<u32, 64>;
var<workgroup> diagnostic_totals: array<atomic<u32>, 4>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u,
  @builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3u,
  @builtin(num_workgroups) groups: vec3u) {
  let pair = receiver_pages(id);
  record_receiver_footprint(id, pair);
  let page = pair.x;
  diagnostic_pages[lane] = page;
  publish_receiver_pages(pair, lane);
  workgroupBarrier();
  if (page != VSM_INVALID_SLOT) {
    var first_page = true;
    var first_word = true;
    for (var previous = 0u; previous < lane; previous++) {
      let other = diagnostic_pages[previous];
      first_page = first_page && other != page;
      first_word = first_word && (other == VSM_INVALID_SLOT || other / 32u != page / 32u);
    }
    atomicAdd(&diagnostic_totals[0], 1u);
    if (first_page) { atomicAdd(&diagnostic_totals[1], 1u); }
    if (first_word) { atomicAdd(&diagnostic_totals[2], 1u); }
  }
  workgroupBarrier();
  if (lane == 0u) {
    let index = group.y * groups.x + group.x;
    let raw = atomicLoad(&diagnostic_totals[0]);
    let pages = atomicLoad(&diagnostic_totals[1]);
    let words = atomicLoad(&diagnostic_totals[2]);
    let global_attempts = atomicLoad(&diagnostic_totals[3]);
    diagnostic_workgroups[index + 1u] = vec4u(raw, pages, words, global_attempts);
    if (index == 0u) {
      diagnostic_workgroups[0] = vec4u(constants.dimensions.xy, constants.control.y, groups.x * groups.y);
    }
  }
}
`;
  // Count both exhausted-probe publication and normal slot publication. This
  // specialization is absent from timed/production shaders.
  const aggregation = VSM_RECEIVER_AGGREGATION_WGSL.replaceAll(
    "atomicOr(&requested[",
    "atomicAdd(&diagnostic_totals[3], 1u);\n    atomicOr(&requested[",
  );
  const prefix = VSM_RECEIVER_DEMAND_WGSL.slice(0, begin).replace(VSM_RECEIVER_AGGREGATION_WGSL, aggregation);
  return prefix + main + VSM_RECEIVER_DEMAND_WGSL.slice(end);
}

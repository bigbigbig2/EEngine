import { GPU_INSTANCE_FLAGS, GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { VSM_PAGE_TABLE_WGSL } from "./vsm_page_table.js";

/** Portable 64-lane aggregation. Workgroup storage is zero-initialized by WGSL.
 * A bounded probe failure publishes the original bit instead of dropping it. */
export const VSM_RECEIVER_WORD_AGGREGATION_WGSL = /* wgsl */ `
var<workgroup> receiver_words: array<atomic<u32>, 64>;
var<workgroup> receiver_masks: array<atomic<u32>, 64>;

fn publish_receiver_word(page: u32, lane: u32) {
  if (page != VSM_INVALID_SLOT) {
    let word = page / 32u;
    let bit = 1u << (page % 32u);
    // page is u32, so word + 1 cannot overflow. Zero remains the empty key.
    let key = word + 1u;
    var slot = (word * 2654435761u) & 63u;
    var merged = false;
    for (var attempt = 0u; attempt < 64u; attempt++) {
      let reservation = atomicCompareExchangeWeak(&receiver_words[slot], 0u, key);
      if (reservation.exchanged || reservation.old_value == key) {
        atomicOr(&receiver_masks[slot], bit);
        merged = true;
        break;
      }
      // A spurious failure at an empty slot retries that slot. The bound also
      // covers spurious failures; exhaustion still publishes the exact bit.
      if (reservation.old_value != 0u) {
        slot = (slot + 1u) & 63u;
      }
    }
    if (!merged) {
      atomicOr(&requested[word], bit);
    }
  }
  // Empty/partial groups and rejected receiver lanes must all reach this.
  workgroupBarrier();
  let key = atomicLoad(&receiver_words[lane]);
  if (key != 0u) {
    atomicOr(&requested[key - 1u], atomicLoad(&receiver_masks[lane]));
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
  clip_origin_extent: array<vec4f, 6>,
  dimensions: vec4u,
  control: vec4u,
  viewport: vec4f,
  depth_range: vec4f,
  identity: vec4u,
};

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var receiver_depth: texture_depth_2d;
@group(0) @binding(2) var visibility_key: texture_2d<u32>;
@group(0) @binding(3) var<uniform> constants: Constants;
@group(0) @binding(4) var<storage, read_write> requested: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(6) var<storage, read> instances: array<OEngineInstanceRecord>;

fn world_from_depth(pixel: vec2u, depth: f32) -> vec3f {
  let uv = (vec2f(pixel) + vec2f(0.5)) * constants.viewport.xy;
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let projected = camera.view_projection_matrix_inverse * vec4f(ndc, depth, 1.0);
  return projected.xyz / projected.w;
}

fn receiver_page(id: vec3u) -> u32 {
  if (id.x >= constants.dimensions.x || id.y >= constants.dimensions.y) {
    return VSM_INVALID_SLOT;
  }
  let pixel = id.xy;
  let depth = textureLoad(receiver_depth, vec2i(pixel), 0);
  if (depth <= 0.0001) {
    return VSM_INVALID_SLOT;
  }
  let key = textureLoad(visibility_key, vec2i(pixel), 0).x;
  if (key == 0xffffffffu || key == 0xfffffffeu) {
    return VSM_INVALID_SLOT;
  }
  let decoded = oengine_visibility_key_resolve(key, meshlet_work.header.generation, meshlet_work.header.written_count);
  if (decoded.valid == 0u || decoded.meshlet_work_slot >= min(meshlet_work.header.capacity, arrayLength(&meshlet_work.elements))) {
    return VSM_INVALID_SLOT;
  }
  let instance_slot = meshlet_work.elements[decoded.meshlet_work_slot].instance_slot;
  if (instance_slot >= arrayLength(&instances)) {
    return VSM_INVALID_SLOT;
  }
  let instance = instances[instance_slot];
  if ((instance.flags & ${GPU_INSTANCE_FLAGS.Active | GPU_INSTANCE_FLAGS.ReceivesShadow}u) != ${GPU_INSTANCE_FLAGS.Active | GPU_INSTANCE_FLAGS.ReceivesShadow}u ||
      (instance.flags & ${GPU_INSTANCE_FLAGS.Transparent}u) != 0u || oengine_instance_shading_bin_id(instance.flags) < 4u) {
    return VSM_INVALID_SLOT;
  }
  let world = world_from_depth(pixel, depth);
  let light_position = (constants.light_view * vec4f(world, 1.0)).xyz;
  let level = vsm_select_clip(light_position.xy, constants.clip_origin_extent, constants.control.x, constants.dimensions.w);
  if (level == VSM_INVALID_SLOT) {
    return VSM_INVALID_SLOT;
  }
  let mip = 0u;
  let clip = constants.clip_origin_extent[level];
  let world_page = vsm_world_page(light_position.xy, clip, mip, constants.dimensions.w);
  let virtual_page = vsm_world_page_entry_index(level, mip, world_page, constants.dimensions.w);
  return virtual_page;
}

${VSM_RECEIVER_WORD_AGGREGATION_WGSL}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u,
  @builtin(local_invocation_index) lane: u32) {
  let page = receiver_page(id);
  publish_receiver_word(page, lane);
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
  if (begin < 0 || end < 0 || !original.includes("publish_receiver_word(page, lane);")) {
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
  let page = receiver_page(id);
  diagnostic_pages[lane] = page;
  publish_receiver_word(page, lane);
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
  const aggregation = VSM_RECEIVER_WORD_AGGREGATION_WGSL.replaceAll(
    "atomicOr(&requested[",
    "atomicAdd(&diagnostic_totals[3], 1u);\n    atomicOr(&requested["
  );
  const prefix = VSM_RECEIVER_DEMAND_WGSL.slice(0, begin).replace(
    VSM_RECEIVER_WORD_AGGREGATION_WGSL,
    aggregation
  );
  return prefix + main + VSM_RECEIVER_DEMAND_WGSL.slice(end);
}

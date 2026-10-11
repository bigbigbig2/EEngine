// Rejected Shadow Projection V2 candidate, frozen 2026-10-11.
// Test-only: no production import, runtime switch, or adoption claim.
import {
  GPU_INSTANCE_FLAGS,
  GPU_INSTANCE_SHADING_BIN_SHIFT,
  GPU_INSTANCE_SHADING_BIN_MASK,
} from "../../../.test-dist/gpu/GpuInstanceAbi.js";
import { surfaceGeometryCompletionWgsl } from "../../../.test-dist/shaders/surface_geometry_completion.js";
import { VSM_SAMPLING_WGSL } from "../../../.test-dist/shaders/vsm_sampling.js";
/** One fine descriptor broadcast, not a shared coarse-result cache. Frame-wide
 * generation/epoch/namespace are already checked by post-commit publication.
 * Full signed page coordinates and selected clip must match before reuse. */
export const VSM_FINE_BROADCAST_WGSL = /* wgsl */ `
var<workgroup> shadow_fine_key: vec3i;
var<workgroup> shadow_fine_valid: u32;
var<workgroup> shadow_fine_descriptor: VsmSamplingDescriptor;

fn shadow_publish_fine(light_xy: vec2f, receiver_enabled: bool) {
  shadow_fine_valid = 0u;
  if (!receiver_enabled) { return; }
  let selected = vsm_clip_level(light_xy);
  if (selected == VSM_INVALID_SLOT) { return; }
  let pages = max(1u, vsm_constants.dimensions.x);
  let clip = vsm_constants.clip_origin_extent[selected];
  let world = vsm_world_page(light_xy, clip, 0u, pages);
  if (!vsm_world_in_window(world, clip, 0u, pages)) { return; }
  let index = vsm_sampling_index(selected, 0u, world, pages);
  if (index >= arrayLength(&vsm_sampling_descriptors)) { return; }
  shadow_fine_key = vec3i(i32(selected), world);
  shadow_fine_descriptor = vsm_sampling_descriptors[index];
  shadow_fine_valid = 1u;
}

fn shadow_query_directional(light_xy: vec2f) -> VsmPageQuery {
  let selected = vsm_clip_level(light_xy);
  if (selected == VSM_INVALID_SLOT) {
    return VsmPageQuery(vsm_zero_entry(), 0u, VSM_QUERY_OUTSIDE, VSM_QUERY_OUTSIDE);
  }
  let world = vsm_world_page(light_xy, vsm_constants.clip_origin_extent[selected],
    0u, max(1u, vsm_constants.dimensions.x));
  var fine: VsmPageQuery;
  if (shadow_fine_valid != 0u && all(shadow_fine_key == vec3i(i32(selected), world))) {
    let descriptor = shadow_fine_descriptor;
    let entry = VsmPageEntry(descriptor.slot_x, descriptor.slot_y, 0u,
      0u, 0u, 0u, 0u, 0u, 0, 0, 0u, 0u);
    fine = VsmPageQuery(entry, selected, descriptor.status, descriptor.status);
  } else {
    fine = vsm_lookup(selected, light_xy, 0u);
  }
  if (fine.status == VSM_QUERY_FINE) { return fine; }
  for (var level = selected; level < min(6u, vsm_constants.control.x); level++) {
    var coarse = vsm_lookup(level, light_xy, 5u);
    if (coarse.status == VSM_QUERY_COARSE) {
      coarse.target_status = fine.status;
      return coarse;
    }
  }
  return fine;
}

fn shadow_sample_query(light: vec3f, normal: vec3f, sun: vec3f, query: VsmPageQuery) -> f32 {
  if (query.status != VSM_QUERY_FINE && query.status != VSM_QUERY_COARSE) {
    return 1.0;
  }
  let cosine = max(dot(normal, sun), 1e-3);
  let normal_bias = vsm_constants.filter_params.x * (1.0 - cosine);
  let slope_bias = vsm_constants.filter_params.z * (1.0 - cosine);
  let extent = vsm_constants.clip_origin_extent[query.level].z;
  let reference = (vsm_constants.depth_range.y - light.z) * vsm_constants.depth_range.z;
  let depth_per_texel = extent / f32(vsm_constants.dimensions.x * vsm_constants.dimensions.y) *
    exp2(f32(query.entry.mip)) * vsm_constants.depth_range.z;
  return vsm_sample_page(query.entry, vsm_page_local_uv(light.xy, query.level, query.entry.mip),
    reference, (vsm_constants.filter_params.y + slope_bias + normal_bias) * depth_per_texel);
}
`;
export function vsmShadowResolveWgsl(productGeometry, diagnosticKeys = false) {
  return /* wgsl */ `
${surfaceGeometryCompletionWgsl(productGeometry, true, false)}
struct GpuPrimitiveTypeTable { direction: vec3f, color: vec3f, }
${VSM_SAMPLING_WGSL}
${VSM_FINE_BROADCAST_WGSL}
struct ShadowReceiverSettings {
  source: vec4u,
  source_payload: vec4u,
  dimensions: vec4u,
  camera_position_exposure: vec4f,
  view_matrix: mat4x4f,
  background: vec4f,
}
struct ShadowSun { direction: vec3f, world_to_unit: f32, }
@group(0) @binding(0) var<uniform> settings: ShadowReceiverSettings;
@group(0) @binding(1) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(2) var<storage, read> source_heap: array<u32>;
@group(0) @binding(3) var<storage, read> vertex_payload: array<u32>;
@group(0) @binding(4) var<storage, read> frame_instances: array<OEngineFrameInstanceRecord>;
@group(0) @binding(5) var visibility: texture_2d<u32>;
@group(0) @binding(7) var shadow_output: texture_storage_2d<r32uint, write>;
${diagnosticKeys ? "@group(0) @binding(15) var shadow_query_keys: texture_storage_2d_array<rgba32uint, write>;" : ""}
${
  productGeometry
    ? `@group(0) @binding(10) var<storage, read> product_heap: array<u32>;
${Array.from({ length: 4 }, (_, i) => `@group(0) @binding(${11 + i}) var<storage, read> product_bank_${i}: array<u32>;`).join("\n")}`
    : ""
}
@group(1) @binding(0) var<uniform> vsm_constants: VsmSamplingConstants;
@group(1) @binding(1) var<storage, read> vsm_sampling_descriptors: array<VsmSamplingDescriptor>;
@group(1) @binding(2) var vsm_atlas_depth: texture_depth_2d;
@group(1) @binding(3) var<uniform> shadow_sun: ShadowSun;
const geometry_needs: u32 = ${(1 << 5) | (1 << 7)}u;
var<workgroup> shadow_bytes: array<u32, 64>;
struct ShadowReceiver { position: vec3f, normal: vec3f, valid: bool, }
fn shadow_safe_normal(value: vec3f, fallback: vec3f) -> vec3f {
  let length2 = dot(value, value);
  if (length2 > 1e-20) { return value * inverseSqrt(length2); }
  return fallback;
}
fn shadow_receiver(pixel: vec2u) -> ShadowReceiver {
  var result: ShadowReceiver;
  if (any(pixel >= settings.dimensions.xy) || meshlet_work.header.generation != settings.dimensions.w) {
    return result;
  }
  let key = textureLoad(visibility, vec2i(pixel), 0).r;
  let decoded = oengine_visibility_key_resolve(key,
    meshlet_work.header.generation, meshlet_work.header.written_count);
  if (decoded.valid == 0u || decoded.meshlet_work_slot >= min(meshlet_work.header.capacity, arrayLength(&meshlet_work.elements))) {
    return result;
  }
  let work = meshlet_work.elements[decoded.meshlet_work_slot];
  if (work.instance_slot >= arrayLength(&frame_instances)) { return result; }
  let instance = frame_instances[work.instance_slot];
  if (instance.generation != settings.dimensions.w ||
    (instance.source.flags & ${GPU_INSTANCE_FLAGS.Active | GPU_INSTANCE_FLAGS.ReceivesShadow}u) != ${GPU_INSTANCE_FLAGS.Active | GPU_INSTANCE_FLAGS.ReceivesShadow}u ||
    (instance.source.flags & ${GPU_INSTANCE_FLAGS.Transparent}u) != 0u ||
    ((instance.source.flags & ${GPU_INSTANCE_SHADING_BIN_MASK}u) >> ${GPU_INSTANCE_SHADING_BIN_SHIFT}u) < 4u) {
    return result;
  }
  let corners = geometry_complete_resolved(decoded, work, instance);
  let interpolation = winner_interpolate(corners.coefficients, vec2f(pixel) + vec2f(0.5), vec2f(settings.dimensions.xy));
  if ((interpolation.flags & WINNER_VALUE_VALID) == 0u) { return result; }
  let weights = interpolation.weights;
  result.position = (corners.position.p0 * weights.x + corners.position.p1 * weights.y + corners.position.p2 * weights.z).xyz;
  let geometric = shadow_safe_normal(corners.world_plane.xyz, vec3f(0.0, 0.0, 1.0));
  let raw = corners.normal.p0 * weights.x + corners.normal.p1 * weights.y + corners.normal.p2 * weights.z;
  let unflipped = shadow_safe_normal(raw.xyz, geometric);
  let flip = (corners.flags & ${GPU_INSTANCE_FLAGS.DoubleSided}u) != 0u &&
    dot(unflipped, settings.camera_position_exposure.xyz - result.position) < 0.0;
  result.normal = select(unflipped, -unflipped, flip);
  result.valid = true;
  return result;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_index) lane: u32) {
  let receiver = shadow_receiver(id.xy);
  let receiver_enabled = receiver.valid && vsm_constants.depth_range.w != 0.0;
  let light = (vsm_constants.light_view * vec4f(receiver.position, 1.0)).xyz;
  if (lane == 0u) { shadow_publish_fine(light.xy, receiver_enabled); }
  workgroupBarrier();
  var value = 1u;
  ${diagnosticKeys ? "var diagnostic_fine = vec4u(0u);\n  var diagnostic_resolved = vec4u(0u);" : ""}
  if (receiver_enabled) {
    let query = shadow_query_directional(light.xy);
    ${
      diagnosticKeys
        ? `let selected = vsm_clip_level(light.xy);
    var fine_world = vec2i(0);
    if (selected != VSM_INVALID_SLOT) {
      fine_world = vsm_world_page(light.xy, vsm_constants.clip_origin_extent[selected], 0u, vsm_constants.dimensions.x);
    }
    var resolved_world = vec2i(0);
    if (query.status == VSM_QUERY_FINE || query.status == VSM_QUERY_COARSE) {
      resolved_world = vsm_world_page(light.xy, vsm_constants.clip_origin_extent[query.level], query.entry.mip, vsm_constants.dimensions.x);
    }
    let enums = 0x80000000u | query.status | (query.target_status << 4u) | (query.level << 8u) | (query.entry.mip << 12u);
    diagnostic_fine = vec4u(selected, bitcast<vec2u>(fine_world), enums);
    diagnostic_resolved = vec4u(bitcast<vec2u>(resolved_world), query.entry.slot_x, query.entry.slot_y);`
        : ""
    }
    let mode = vsm_constants.identity.z;
    if (mode == 3u) {
      value = query.status;
    } else if ((mode != 0u) && query.status != VSM_QUERY_FINE && query.status != VSM_QUERY_COARSE) {
      value = 255u;
    } else if (mode == 2u) {
      value = query.level;
    } else {
      let taps = max(1u, min(4u, vsm_constants.control.z));
      let visibility_value = shadow_sample_query(light, receiver.normal, normalize(shadow_sun.direction), query);
      let count = u32(visibility_value * f32(taps * taps) + 0.5);
      value = count | ((taps - 1u) << 5u);
    }
  } else if (vsm_constants.identity.z != 0u) {
    value = 254u;
  }
  shadow_bytes[lane] = value;
  ${
    diagnosticKeys
      ? `if (all(id.xy < settings.dimensions.xy)) {
    textureStore(shadow_query_keys, vec2i(id.xy), 0, diagnostic_fine);
    textureStore(shadow_query_keys, vec2i(id.xy), 1, diagnostic_resolved);
    textureStore(shadow_query_keys, vec2i(id.xy), 2, vec4u(textureLoad(visibility, vec2i(id.xy), 0).r,
      u32(receiver_enabled), meshlet_work.header.generation, 0u));
  }`
      : ""
  }
  workgroupBarrier();
  // Every real texel, including background and tail bytes, is overwritten.
  // All lanes reach all barriers even in a partial/empty edge workgroup.
  if ((lane % 4u) == 0u && all(id.xy < settings.dimensions.xy)) {
    let word = shadow_bytes[lane] | (shadow_bytes[lane + 1u] << 8u) |
      (shadow_bytes[lane + 2u] << 16u) | (shadow_bytes[lane + 3u] << 24u);
    textureStore(shadow_output, vec2i(i32(id.x / 4u), i32(id.y)), vec4u(word, 0u, 0u, 0u));
  }
}
`;
}

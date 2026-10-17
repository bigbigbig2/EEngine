import { SCGI_ABI, SCGI_ABI_WGSL } from "../render/gi/ScgiAbi.js";
import type { ScgiAllocationPlan } from "../render/gi/ScgiCapacity.js";
import { surfaceGeometryCompletionWgsl } from "./surface_geometry_completion.js";
import { PRIMARY_SURFACE_POSITION_WGSL } from "./native_resolved_position.js";
import { PRIMARY_SURFACE_MOTION_WGSL } from "./primary_surface_motion.js";
import { PRIMARY_SURFACE_IDENTITY_WGSL } from "./primary_surface_identity.js";
import { nativePublicationAccessors } from "../gpu/NativePublicationAbi.js";
import { FINAL_PIXEL_DIRECTORY_WGSL } from "../gpu/FinalPixelAbi.js";
import { scgiCacheRequestWgsl } from "./scgi_cache.js";

export const SCGI_ANCHOR_SETTINGS_BYTES = 368;

/** Existing resident geometry decode, exact scene lineage and material revision.
 * One invocation owns one half pixel. No Surface/Temporal output is read. */
export function scgiAnchorWgsl(plan: ScgiAllocationPlan, product: boolean): string {
  const productBindings = product
    ? `
@group(1) @binding(0) var<storage, read> product_heap: array<u32>;
@group(1) @binding(1) var<storage, read> product_bank_0: array<u32>;
@group(1) @binding(2) var<storage, read> product_bank_1: array<u32>;
@group(1) @binding(3) var<storage, read> product_bank_2: array<u32>;
@group(1) @binding(4) var<storage, read> product_bank_3: array<u32>;
`
    : "";
  return /* wgsl */ `
${surfaceGeometryCompletionWgsl(product, false, false, true)}
${PRIMARY_SURFACE_POSITION_WGSL}
${PRIMARY_SURFACE_MOTION_WGSL}
${PRIMARY_SURFACE_IDENTITY_WGSL}
${SCGI_ABI_WGSL}
${FINAL_PIXEL_DIRECTORY_WGSL}
struct PrimaryAnchor {
  positionValid: vec4f,
  normal: vec3f,
  sourcePixel: u32,
  previousPositionValid: vec4f,
  motionDepth: vec4f,
  identity: array<u32, 16>,
}
struct AnchorSettings {
  source: vec4u,
  source_payload: vec4u,
  dimensions: vec4u,
  camera_position_exposure: vec4f,
  view_matrix: mat4x4f,
  background: vec4f,
  inverse_view_projection: mat4x4f,
  previous_view: mat4x4f,
  previous_projection: mat4x4f,
  segment: vec4u,
  control: vec4u,
}
@group(0) @binding(0) var<uniform> settings: AnchorSettings;
@group(0) @binding(1) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(2) var<storage, read> source_heap: array<u32>;
@group(0) @binding(3) var<storage, read> vertex_payload: array<u32>;
@group(0) @binding(4) var<storage, read> frame_instances: array<OEngineFrameInstanceRecord>;
@group(0) @binding(5) var visibility: texture_2d<u32>;
@group(0) @binding(6) var<storage, read> instance_identity: array<vec4u>;
@group(0) @binding(7) var<storage, read> native_publication: array<u32>;
@group(0) @binding(8) var<storage, read_write> scratch: array<atomic<u32>>;
@group(0) @binding(9) var<storage, read_write> anchors: array<PrimaryAnchor>;
${productBindings}
const geometry_needs: u32 = 1u << 7u;
${nativePublicationAccessors("native_publication")}
${scgiCacheRequestWgsl(plan, true)}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= settings.segment.y {
    return;
  }
  let halfIndex = settings.segment.x + id.x;
  let halfExtent = (settings.dimensions.xy + vec2u(1u)) / 2u;
  let base = vec2u(halfIndex % halfExtent.x, halfIndex / halfExtent.x) * 2u;
  var result: PrimaryAnchor;
  result.sourcePixel = 0xffffffffu;
  var pixel = base;
  var key = OENGINE_VISIBILITY_KEY_EMPTY;
  for (var step = 0u; step < 4u; step++) {
    let corner = (settings.control.x + step) % 4u;
    let candidate = base + vec2u(corner & 1u, corner >> 1u);
    if any(candidate >= settings.dimensions.xy) {
      continue;
    }
    let value = textureLoad(visibility, vec2i(candidate), 0).x;
    let resolved = oengine_visibility_key_resolve(value, meshlet_work.header.generation,
      meshlet_work.header.written_count);
    if resolved.valid != 0u {
      pixel = candidate;
      key = value;
      break;
    }
  }
  let decoded = oengine_visibility_key_resolve(key, meshlet_work.header.generation,
    meshlet_work.header.written_count);
  if decoded.valid == 0u {
    anchors[halfIndex - settings.segment.x] = result;
    return;
  }
  let work = meshlet_work.elements[decoded.meshlet_work_slot];
  if work.instance_slot >= arrayLength(&frame_instances) || work.instance_slot >= arrayLength(&instance_identity) ||
    work.material_slot_or_range >= native_material_count() {
    anchors[halfIndex - settings.segment.x] = result;
    return;
  }
  let instance = frame_instances[work.instance_slot];
  let lineage = instance_identity[work.instance_slot];
  let entry = native_material_entry(work.material_slot_or_range);
  if instance.generation != meshlet_work.header.generation ||
    !oengine_instance_active(instance.source) || lineage.x == 0u || lineage.y != instance.source.instance_set_generation ||
    lineage.w == 0u || entry.value_revision == 0u || entry.program_index == 0xffffffffu ||
    work.geometry_slot != instance.source.geometry_record_index ||
    work.material_slot_or_range != instance.source.material_handle {
    anchors[halfIndex - settings.segment.x] = result;
    return;
  }
  ${product ? "" : `if oengine_instance_virtual_geometry(instance.source) {
    anchors[halfIndex - settings.segment.x] = result;
    return;
  }`}
  var asset = instance.source.geometry_record_index;
  var meshlet = work.meshlet_slot;
  ${
    product
      ? `if oengine_instance_virtual_geometry(instance.source) {
    let resolvedAsset = oengine_geometry_product_resolve_asset_v1(&product_heap,
      work.geometry_slot, oengine_instance_geometry_generation(instance.source));
    if !resolvedAsset.valid || resolvedAsset.product_table_slot != instance.source.product_table_slot {
      anchors[halfIndex - settings.segment.x] = result;
      return;
    }
    let reference = product_heap[5u] + work.geometry_slot * 4u;
    asset = product_heap[reference + 2u];
    let groupBegin = product_heap[resolvedAsset.asset_word_offset + 22u];
    let group = work.meshlet_slot >> 7u;
    if group < groupBegin || group - groupBegin >= resolvedAsset.group_count {
      anchors[halfIndex - settings.segment.x] = result;
      return;
    }
    meshlet = (group - groupBegin) * 128u + (work.meshlet_slot & 127u);
  }`
      : ""
  }
  let geometry = geometry_complete_resolved(decoded, work, instance);
  let interpolation = winner_interpolate(geometry.coefficients, vec2f(pixel) + vec2f(0.5), vec2f(settings.dimensions.xy));
  if (interpolation.flags & WINNER_VALUE_VALID) == 0u {
    anchors[halfIndex - settings.segment.x] = result;
    return;
  }
  let position = primary_surface_position(geometry.world_plane, settings.inverse_view_projection,
    pixel, settings.dimensions.xy, geometry.position.p0, geometry.position.p1, geometry.position.p2, geometry.coefficients);
  var normal = geometry.world_plane.xyz;
  if (instance.source.flags & 16u) != 0u && dot(normal, settings.camera_position_exposure.xyz - position) < 0.0 {
    normal = -normal;
  }
  if !winner_finite3(position) || !winner_finite3(normal) {
    anchors[halfIndex - settings.segment.x] = result;
    return;
  }
  let previous = (oengine_instance_previous_from_current(instance.source) * vec4f(position, 1.0)).xyz;
  // A dynamic revision alone is not a previous-position publication. Until the
  // shared geometry producer supplies it, never invent skin/morph motion.
  let available = oengine_instance_motion_valid(instance.source) && instance.source.dynamic_revision == 0u && settings.control.y != 0u;
  let motion = primary_surface_motion(position, previous, pixel, settings.dimensions.xy,
    settings.view_matrix, settings.previous_view, settings.previous_projection, available);
  result.positionValid = vec4f(position, 1.0);
  result.normal = normal;
  result.sourcePixel = pixel.y * settings.dimensions.x + pixel.x;
  result.previousPositionValid = vec4f(previous, select(0.0, 1.0, motion.valid));
  result.motionDepth = vec4f(motion.motion, motion.expected_depth, motion.current_depth);
  // Full meshlet/local primitive tuple. No 32-bit hash or truncation.
  if !oengine_instance_virtual_geometry(instance.source) {
    meshlet = work.meshlet_slot - source_geometry.meshlet_begin;
  }
  result.identity = primary_surface_identity(lineage, instance.source, asset, meshlet,
    decoded.local_primitive, entry.value_revision);
  anchors[halfIndex - settings.segment.x] = result;
  // Deterministic global cyclic budget, independent of workgroup scheduling and
  // physical segment order. Every anchor is still written, and deferred demand
  // remains observable. No low-index segment can monopolize a full queue.
  let demandPriority = (halfIndex + ${plan.halfPixels}u - settings.control.z) % ${plan.halfPixels}u;
  if demandPriority >= ${plan.profile.requests}u {
    atomicAdd(&scratch[${plan.scratch.ranges.cacheControl!.offset / 4 + 7}u], 1u);
    return;
  }
  var request: array<u32, ${SCGI_ABI.request.stride / 4}>;
  request[0] = bitcast<u32>(position.x);
  request[1] = bitcast<u32>(position.y);
  request[2] = bitcast<u32>(position.z);
  request[4] = bitcast<u32>(normal.x);
  request[5] = bitcast<u32>(normal.y);
  request[6] = bitcast<u32>(normal.z);
  for (var lane = 0u; lane < 12u; lane++) {
    request[8u + lane] = result.identity[lane];
  }
  for (var lane = 0u; lane < 4u; lane++) {
    request[24u + lane] = result.identity[12u + lane];
  }
  request[22] = halfIndex;
  let accepted = scgi_append_receiver_request(request);
}
`;
}

/** One invocation per new physical patch, never per request: unique seed writer.
 * History is a committed world-only field, with its own old guide and scale. */
export function scgiSeedWgsl(plan: ScgiAllocationPlan): string {
  const patch = plan.world.ranges.patches!.offset / 4;
  const state = plan.world.ranges.cacheState!.offset / 4;
  const sources = plan.scratch.ranges.seedSources!.offset / 4;
  return /* wgsl */ `
${SCGI_ABI_WGSL}
struct SeedSettings {
  previous_inverse_view_projection: mat4x4f,
  previous_view: mat4x4f,
  extent_segment: vec4u,
  history_segment: vec4u,
  thresholds: vec4f,
  control: vec4u,
}
@group(0) @binding(0) var<uniform> settings: SeedSettings;
@group(0) @binding(1) var<storage, read_write> world: array<u32>;
@group(0) @binding(2) var<storage, read> scratch: array<u32>;
@group(0) @binding(3) var<storage, read> anchors: array<ScgiAnchor>;
@group(0) @binding(4) var<storage, read> history: array<ScgiHalfField>;
@group(0) @binding(5) var<storage, read> previous_world: array<u32>;
fn finite(v: vec3f) -> bool {
  return all(abs(v) <= vec3f(3.402823466e38));
}
fn decode_oct(packed: u32) -> vec3f {
  let p = unpack2x16snorm(packed);
  var n = vec3f(p, 1.0 - abs(p.x) - abs(p.y));
  let t = max(-n.z, 0.0);
  n.x += select(t, -t, n.x >= 0.0);
  n.y += select(t, -t, n.y >= 0.0);
  return normalize(n);
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let slot = id.x;
  if slot >= ${plan.profile.patches}u || settings.control.x == 0u || world[15u] != 0u ||
    previous_world[15u] != 0u || previous_world[43u] != world[43u] || previous_world[27u] != world[27u] {
    return;
  }
  for (var lane = 1u; lane < 8u; lane++) {
    // View cuts are a screen fact. Device/scene/numeric revisions must agree.
    if lane != 3u && previous_world[lane] != world[lane] {
      return;
    }
  }
  let at = ${patch}u + slot * ${SCGI_ABI.patch.stride / 4}u;
  let source = scratch[${sources}u + slot];
  if source == 0u || world[${state}u + slot * 4u + 3u] == 0u || world[at + 68u] != 0u {
    return;
  }
  let index = source - 1u;
  if index < settings.extent_segment.z || index - settings.extent_segment.z >= settings.extent_segment.w {
    return;
  }
  let anchor = anchors[index - settings.extent_segment.z];
  if anchor.positionValid[3] != 1.0 || anchor.previousPositionValid[3] != 1.0 {
    return;
  }
  let normal = vec3f(anchor.normal[0], anchor.normal[1], anchor.normal[2]);
  let current = vec3f(anchor.positionValid[0], anchor.positionValid[1], anchor.positionValid[2]);
  let previous = vec3f(anchor.previousPositionValid[0], anchor.previousPositionValid[1], anchor.previousPositionValid[2]);
  let pixelIndex = anchor.sourcePixel;
  let pixel = vec2u(pixelIndex % settings.extent_segment.x, pixelIndex / settings.extent_segment.x);
  let uv = (vec2f(pixel) + 0.5) / vec2f(settings.extent_segment.xy) - vec2f(anchor.motionDepth[0], anchor.motionDepth[1]);
  if any(uv < vec2f(0.0)) || any(uv >= vec2f(1.0)) {
    return;
  }
  let halfExtent = (settings.extent_segment.xy + vec2u(1u)) / 2u;
  let oldPixel = vec2u(uv * vec2f(settings.extent_segment.xy)) / 2u;
  let oldIndex = oldPixel.y * halfExtent.x + oldPixel.x;
  if oldIndex < settings.history_segment.x || oldIndex - settings.history_segment.x >= settings.history_segment.y {
    return;
  }
  let old = history[oldIndex - settings.history_segment.x];
  if (old.confidenceFlags & 1u) == 0u || !(old.depth > 0.0) || old.sourcePixel >= settings.extent_segment.x * settings.extent_segment.y {
    return;
  }
  for (var lane = 0u; lane < 16u; lane++) {
    if old.identity[lane] != anchor.identity[lane] {
      return;
    }
  }
  let oldNormal = decode_oct(old.octNormal);
  if !(dot(normal, oldNormal) >= settings.thresholds.y) || !(abs(old.depth - anchor.motionDepth[2]) <= settings.thresholds.x) {
    return;
  }
  let oldSource = vec2u(old.sourcePixel % settings.extent_segment.x, old.sourcePixel / settings.extent_segment.x);
  if any(oldSource / 2u != oldPixel) {
    return;
  }
  let ndc = (vec2f(oldSource) + 0.5) / vec2f(settings.extent_segment.xy) * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
  let a = settings.previous_inverse_view_projection * vec4f(ndc, 0.0, 1.0);
  let b = settings.previous_inverse_view_projection[2];
  let va = settings.previous_view * a;
  let vb = settings.previous_view * b;
  let denominator = vb.z + old.depth * b.w;
  if denominator == 0.0 {
    return;
  }
  let h = a - b * ((va.z + old.depth * a.w) / denominator);
  if h.w == 0.0 {
    return;
  }
  let oldPosition = h.xyz / h.w;
  if !finite(oldPosition) || !finite(previous) || !finite(current) {
    return;
  }
  let delta = previous - oldPosition;
  let worldDelta = current - oldPosition;
  if abs(dot(delta, normal)) > settings.thresholds.x || abs(dot(delta, oldNormal)) > settings.thresholds.x ||
    abs(dot(worldDelta, normal)) > settings.thresholds.x || abs(dot(worldDelta, oldNormal)) > settings.thresholds.x ||
    length(delta) > settings.thresholds.z || length(worldDelta) > settings.thresholds.z {
    return;
  }
  let coefficients = scgi_unpack_l1(old.packedCoefficients, settings.thresholds.w);
  for (var lane = 0u; lane < 12u; lane++) {
    if !(abs(coefficients[lane]) <= 3.402823466e38) {
      return;
    }
  }
  for (var lane = 0u; lane < 3u; lane++) {
    world[at + 32u + lane] = bitcast<u32>(coefficients[lane]);
  }
  world[at + 35u] = bitcast<u32>(1.0);
  for (var lane = 0u; lane < 12u; lane++) {
    world[at + 40u + lane] = bitcast<u32>(coefficients[lane]);
    world[at + 52u + lane] = bitcast<u32>(coefficients[lane]);
  }
  // Seed confidence is not a real MC cohort. Age/count stay at allocation zero.
  world[at + 39u] = bitcast<u32>(1.0);
  world[at + 69u] = 1u;
}
`;
}

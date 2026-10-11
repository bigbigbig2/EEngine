import { NATIVE_TEMPORAL_SEED_VIEW_WGSL } from "../gpu/FinalPixelAbi.js";

/** Composed into Native and only the unassigned lanes of existing bin classify.
 * Three sequential output stores; no history read, geometry fetch or barriers. */
export function nativeTemporalSeedWgsl(
  group: number,
  seed: number,
  response: number,
  identity: number,
  surface = true,
): string {
  return /* wgsl */ `
${NATIVE_TEMPORAL_SEED_VIEW_WGSL}
@group(${group}) @binding(${seed}) var temporal_seed: texture_storage_2d<rgba32float, write>;
@group(${group}) @binding(${response}) var temporal_response: texture_storage_2d<rgba8unorm, write>;
@group(${group}) @binding(${identity}) var temporal_identity: texture_storage_2d<rgba32uint, write>;
fn seed_hash(value: u32, word: u32) -> u32 {
  return (value ^ word) * 16777619u;
}
fn seed_inside(uv: vec2f) -> bool {
  return all(uv >= vec2f(0.0)) && all(uv < vec2f(1.0));
}
fn seed_store(pixel: vec2u, clip: vec4f, expected_depth: f32, current_depth: f32,
  identity: vec4u, motion_available: bool, reactive: f32, alpha_mask: bool) {
  let view = seed_view();
  let uv = (vec2f(pixel) + vec2f(0.5)) / vec2f(view.control.xy);
  let previous_uv = clip.xy / clip.w * vec2f(0.5, -0.5) + vec2f(0.5);
  let motion = uv - previous_uv;
  let sky = identity.x == 0xffffffffu;
  let valid = motion_available && view.control.z != 0u &&
    all(abs(clip) < vec4f(3.402823466e38)) && clip.w > 1e-6 &&
    (sky || (clip.z >= 0.0 && clip.z <= clip.w && expected_depth > 0.0 && current_depth > 0.0)) &&
    seed_inside(previous_uv) && all(abs(motion) < vec2f(2.0));
  textureStore(temporal_seed, vec2i(pixel),
    vec4f(select(vec2f(0.0), motion, valid), expected_depth, current_depth));
  textureStore(temporal_response, vec2i(pixel), vec4f(clamp(reactive, 0.0, 1.0),
    select(0.0, 1.0, valid), select(0.0, 1.0, alpha_mask), select(16.0 / 255.0, 0.0, valid)));
  textureStore(temporal_identity, vec2i(pixel), identity);
}
fn seed_unassigned(pixel: vec2u, sky: bool) {
  if (!sky) {
    textureStore(temporal_seed, vec2i(pixel), vec4f(0.0));
    textureStore(temporal_response, vec2i(pixel), vec4f(0.0, 0.0, 0.0, 16.0 / 255.0));
    textureStore(temporal_identity, vec2i(pixel), vec4u(0u));
    return;
  }
  let view = seed_view();
  let uv = (vec2f(pixel) + vec2f(0.5)) / vec2f(view.control.xy);
  let ndc = uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
  let point = view.current_inverse_projection * vec4f(ndc, 1.0, 1.0);
  let direction = normalize(point.xyz / max(abs(point.w), 1e-6));
  let world = view.current_inverse_view * vec4f(direction, 0.0);
  let clip = view.previous_projection * view.previous_view * world;
  seed_store(pixel, clip, 0.0, 0.0, vec4u(0xffffffffu, 0u, 0u, 0u), true, 0.0, false);
}
${
  surface
    ? `fn seed_surface(pixel: vec2u, position: vec3f, current_view: mat4x4f,
  instance: OEngineInstanceRecord, work: OEngineMeshletRasterWork,
  entry: NativeMaterialDirectoryEntry, alpha_mask: bool) {
  let view = seed_view();
  let previous_world = oengine_instance_previous_from_current(instance) * vec4f(position, 1.0);
  let previous_view = view.previous_view * previous_world;
  let clip = view.previous_projection * previous_view;
  var geometry_signature = seed_hash(2166136261u, instance.instance_set_generation);
  geometry_signature = seed_hash(geometry_signature, oengine_instance_geometry_generation(instance));
  geometry_signature = seed_hash(geometry_signature, work.geometry_slot);
  var material_signature = seed_hash(2166136261u, instance.material_handle);
  material_signature = seed_hash(material_signature, instance.flags);
  material_signature = seed_hash(material_signature, work.material_slot_or_range);
  material_signature = seed_hash(material_signature, entry.signature);
  material_signature = seed_hash(material_signature, entry.value_revision);
  let identity = vec4u(work.instance_slot + 1u, geometry_signature,
    material_signature, work.material_slot_or_range + 1u);
  seed_store(pixel, clip, max(-previous_view.z, 0.0),
    max(-(current_view * vec4f(position, 1.0)).z, 0.0), identity,
    oengine_instance_motion_valid(instance) && entry.value_revision != 0u, 0.0, alpha_mask);
}`
    : ""
}
`;
}

export const NATIVE_TEMPORAL_BACKGROUND_WGSL = /* wgsl */ `
${nativeTemporalSeedWgsl(0, 1, 2, 3, false)}
@group(0) @binding(0) var<uniform> view: NativeTemporalSeedView;
@group(0) @binding(4) var visibility: texture_2d<u32>;
fn seed_view() -> NativeTemporalSeedView { return view; }
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= view.control.xy)) { return; }
  seed_unassigned(id.xy, textureLoad(visibility, vec2i(id.xy), 0).r == 0xffffffffu);
}
`;

/** Actual Seed consumer. No Visibility/Depth/Scene/geometry bindings. Preserves
 * previous-identity hard/soft comparison and four-neighbour coverage semantics. */
export const NATIVE_TEMPORAL_SEED_CLASSIFY_WGSL = /* wgsl */ `
@group(0) @binding(0) var seed: texture_2d<f32>;
@group(0) @binding(1) var response: texture_2d<f32>;
@group(0) @binding(2) var identity: texture_2d<u32>;
@group(0) @binding(3) var previous_identity: texture_2d<u32>;
@group(0) @binding(4) var mask: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(seed);
  if (any(id.xy >= size)) { return; }
  let pixel = vec2i(id.xy);
  let facts = textureLoad(seed, pixel, 0);
  let current_response = textureLoad(response, pixel, 0);
  let current = textureLoad(identity, pixel, 0);
  let valid = current_response.y > 0.5;
  var reactive = current_response.x;
  var bits = u32(round(current_response.w * 255.0));
  var hard = false;
  if (valid) {
    let uv = (vec2f(id.xy) + vec2f(0.5)) / vec2f(size) - facts.xy;
    let previous = textureLoad(previous_identity, clamp(vec2i(uv * vec2f(size)), vec2i(0), vec2i(size) - 1), 0);
    hard = previous.x == current.x && (previous.y != current.y ||
      (previous.w == current.w && previous.z != current.z));
    if (previous.x != current.x) { bits |= 1u; }
    if (previous.y != current.y) { bits |= 2u; }
    if (previous.z != current.z) { bits |= 4u; }
    if (previous.w != current.w) { bits |= 8u; }
  }
  if (current_response.z > 0.5) {
    let offsets = array<vec2i, 4>(vec2i(-1, 0), vec2i(1, 0), vec2i(0, -1), vec2i(0, 1));
    for (var i = 0u; i < 4u; i++) {
      let neighbor = textureLoad(identity, clamp(pixel + offsets[i], vec2i(0), vec2i(size) - 1), 0);
      if (neighbor.x != current.x) { reactive = max(reactive, 0.1); }
    }
  }
  textureStore(mask, pixel, vec4f(reactive, select(0.0, 1.0, valid),
    select(0.0, 1.0, hard), f32(bits) / 255.0));
}
`;

/** Local response output for isolated Surface fixtures without a Seed consumer. */
export function nativeResponseWgsl(enabled: boolean): string {
  return enabled ? `
@group(0) @binding(8) var native_response: texture_storage_2d<rgba8unorm, write>;
fn native_response_write(pixel: vec2i, alpha_mask: bool) {
  textureStore(native_response, pixel, vec4f(0.0, select(0.0, 1.0, alpha_mask), 0.0, 0.0));
}
` : "";
}

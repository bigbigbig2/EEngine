import { FRAME_GEOMETRY_WGSL, WINNER_DICTIONARY_WGSL, WINNER_HASH_WGSL, WINNER_COEFFICIENT_STRIDE, WINNER_DICTIONARY_STRIDE, FRAME_GEOMETRY_MESHLET_STRIDE } from "../gpu/GpuWinnerInterpolationAbi.js";
import { FRAME_GEOMETRY_ARENA_HEADER_WORDS as ARENA } from "../gpu/GpuFrameGeometryArenaAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { WINNER_INTERPOLATION_WGSL } from "./winner_interpolation.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";

export const WINNER_SETTINGS_SIZE = 48;
export const WINNER_WORKGROUP_SIZE = 64;

const SETTINGS_WGSL = /* wgsl */ `
struct WinnerSettings {
  viewport: vec2u,
  dictionary_capacity: u32,
  coefficient_capacity: u32,
  probe_limit: u32,
  max_workgroups: u32,
  reserved0: vec2u,
  reserved1: vec4u,
}
`;
const SHARED_GEOMETRY_WGSL = /* wgsl */ `
// Checked once per winner setup (also for direct capacity misses). No source
// attribute decompression/model transform is repeated in this consumer.
fn winner_coefficients_for_key(key: u32) -> WinnerCoefficients {
  let decoded = oengine_visibility_key_decode(key);
  if decoded.valid == 0u || winner_geometry.generation == 0u ||
    decoded.meshlet_work_slot >= min(winner_geometry.work_count, arrayLength(&winner_geometry.meshlets)) {
    return winner_empty_coefficients();
  }
  let meshlet = winner_geometry.meshlets[decoded.meshlet_work_slot];
  if decoded.local_primitive >= meshlet.triangle_count ||
    meshlet.triangle_base >= min(winner_geometry.triangle_count, arrayLength(&winner_triangles)) ||
    decoded.local_primitive >= min(winner_geometry.triangle_count, arrayLength(&winner_triangles)) - meshlet.triangle_base {
    return winner_empty_coefficients();
  }
  let packed = winner_triangles[meshlet.triangle_base + decoded.local_primitive];
  let corners = vec3u(packed & 255u, (packed >> 8u) & 255u, (packed >> 16u) & 255u);
  let vertices = min(winner_geometry.vertex_count, arrayLength(&winner_clips));
  if any(corners >= vec3u(meshlet.vertex_count)) || meshlet.vertex_base >= vertices ||
    any(corners >= vec3u(vertices - meshlet.vertex_base)) {
    return winner_empty_coefficients();
  }
  let ids = corners + vec3u(meshlet.vertex_base);
  return winner_build_coefficients(winner_clips[ids.x], winner_clips[ids.y], winner_clips[ids.z]);
}
`;

/** Four dispatch publication stages; only requests/reservations require atomics.
 * No workgroup barriers, global spinlocks, subgroup-width assumptions or readback.
 * Weak CAS retries are bounded; exhausting retries on an empty cell returns a
 * direct miss rather than probing past it (which could insert the key twice). */
export function winnerPrimitiveWorkWgsl(observe: boolean): string {
  return /* wgsl */ `
${GPU_VISIBILITY_KEY_WGSL}
${FRAME_GEOMETRY_WGSL}
${WINNER_DICTIONARY_WGSL}
${WINNER_INTERPOLATION_WGSL}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${SETTINGS_WGSL}
@group(0) @binding(0) var<uniform> winner_settings: WinnerSettings;
@group(0) @binding(1) var winner_visibility: texture_2d<u32>;
// Inputs are not modified. A unified Storage usage is required when their
// disjoint ranges share the output arena; read-only + writable usage conflicts
// at whole-buffer scope even when binding ranges do not overlap.
@group(0) @binding(2) var<storage, read_write> winner_geometry: FrameGeometryDirectory;
@group(0) @binding(3) var<storage, read_write> winner_clips: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> winner_triangles: array<u32>;
@group(0) @binding(5) var<storage, read_write> winner_dictionary: array<WinnerDictionaryEntry>;
@group(0) @binding(6) var<storage, read_write> winner_work: array<u32>;
@group(0) @binding(7) var<storage, read_write> winner_coefficients: array<WinnerCoefficients>;
@group(0) @binding(8) var<storage, read_write> winner_control: WinnerControl;
@group(1) @binding(0) var<storage, read_write> winner_indirect: vec4u;
${SHARED_GEOMETRY_WGSL}
@compute @workgroup_size(${WINNER_WORKGROUP_SIZE})
fn winner_reset(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) grid: vec3u) {
  let index = id.y * grid.x * ${WINNER_WORKGROUP_SIZE}u + id.x;
  if index >= winner_settings.dictionary_capacity { return; }
  atomicStore(&winner_dictionary[index].key, OENGINE_VISIBILITY_KEY_EMPTY);
  winner_dictionary[index].coefficient_slot = OENGINE_VISIBILITY_KEY_EMPTY;
}
@compute @workgroup_size(8, 8)
fn winner_request(@builtin(global_invocation_id) id: vec3u) {
  if any(id.xy >= winner_settings.viewport) { return; }
  let key = textureLoad(winner_visibility, vec2i(id.xy), 0).x;
  if !oengine_visibility_key_is_valid(key) { return; }
  let mask = winner_settings.dictionary_capacity - 1u;
  let hash = winner_hash(key);
  for (var probe = 0u; probe < winner_settings.probe_limit; probe++) {
    let cell = (hash + probe) & mask;
    var other_key = OENGINE_VISIBILITY_KEY_EMPTY;
    for (var retry = 0u; retry < 16u; retry++) {
      let exchanged = atomicCompareExchangeWeak(&winner_dictionary[cell].key, OENGINE_VISIBILITY_KEY_EMPTY, key);
      if exchanged.exchanged {
        let slot = atomicAdd(&winner_control.unique_count, 1u);
        if slot < winner_settings.coefficient_capacity {
          winner_dictionary[cell].coefficient_slot = slot;
          winner_work[slot] = cell;
        }
        return;
      }
      other_key = exchanged.old_value;
      if other_key == key { return; }
      if other_key != OENGINE_VISIBILITY_KEY_EMPTY { break; }
    }
    if other_key == OENGINE_VISIBILITY_KEY_EMPTY { break; }
  }
  ${observe ? "atomicAdd(&winner_control.request_failures, 1u);" : ""}
}
@compute @workgroup_size(1)
fn winner_finalize() {
  let count = min(atomicLoad(&winner_control.unique_count), winner_settings.coefficient_capacity);
  let groups = (count + ${WINNER_WORKGROUP_SIZE - 1}u) / ${WINNER_WORKGROUP_SIZE}u;
  let x = min(groups, winner_settings.max_workgroups);
  winner_control.dispatch_x = x;
  winner_control.dispatch_y = select((groups + max(x, 1u) - 1u) / max(x, 1u), 1u, groups == 0u);
  winner_control.dispatch_z = 1u;
  winner_indirect = vec4u(winner_control.dispatch_x, winner_control.dispatch_y, 1u, 0u);
}
@compute @workgroup_size(${WINNER_WORKGROUP_SIZE})
fn winner_build(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let slot = (group.y * winner_control.dispatch_x + group.x) * ${WINNER_WORKGROUP_SIZE}u + lane;
  if slot >= min(atomicLoad(&winner_control.unique_count), winner_settings.coefficient_capacity) { return; }
  let cell = winner_work[slot];
  let coeff = winner_coefficients_for_key(atomicLoad(&winner_dictionary[cell].key));
  winner_coefficients[slot] = coeff;
  ${observe ? "if coeff.row0.w != 0.0 { atomicAdd(&winner_control.built_count, 1u); } else { atomicAdd(&winner_control.invalid_count, 1u); }" : ""}
}
`;
}

/** Actual downstream shader library. Read-only lookup after build publication;
 * a capacity/probe miss recomputes only compact coefficients from the same shared
 * geometry. This is the new-chain overflow behavior, not an old Setup bridge. */
export function winnerPrimitiveConsumerWgsl(group = 0): string {
  if (!Number.isSafeInteger(group) || group < 0) throw new RangeError("Winner consumer group must be nonnegative");
  return /* wgsl */ `
${GPU_VISIBILITY_KEY_WGSL}
${FRAME_GEOMETRY_WGSL}
${WINNER_INTERPOLATION_WGSL}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${SETTINGS_WGSL}
struct WinnerDictionaryReadEntry { key: u32, coefficient_slot: u32, }
${WINNER_HASH_WGSL}
@group(${group}) @binding(0) var<uniform> winner_settings: WinnerSettings;
@group(${group}) @binding(2) var<storage, read> winner_geometry: FrameGeometryDirectory;
@group(${group}) @binding(3) var<storage, read> winner_clips: array<vec4f>;
@group(${group}) @binding(4) var<storage, read> winner_triangles: array<u32>;
@group(${group}) @binding(5) var<storage, read> winner_dictionary: array<WinnerDictionaryReadEntry>;
@group(${group}) @binding(7) var<storage, read> winner_coefficients: array<WinnerCoefficients>;
${SHARED_GEOMETRY_WGSL}
fn winner_coefficient_slot(key: u32) -> u32 {
  if !oengine_visibility_key_is_valid(key) { return OENGINE_VISIBILITY_KEY_EMPTY; }
  let hash = winner_hash(key); let mask = winner_settings.dictionary_capacity - 1u;
  for (var probe = 0u; probe < winner_settings.probe_limit; probe++) {
    let entry = winner_dictionary[(hash + probe) & mask];
    if entry.key == OENGINE_VISIBILITY_KEY_EMPTY { break; }
    if entry.key == key { return entry.coefficient_slot; }
  }
  return OENGINE_VISIBILITY_KEY_EMPTY;
}

fn winner_interpolate_key(key: u32, pixel: vec2f) -> WinnerInterpolation {
  let slot = winner_coefficient_slot(key);
  var coeff: WinnerCoefficients;
  if slot != OENGINE_VISIBILITY_KEY_EMPTY {
    coeff = winner_coefficients[slot];
  } else {
    coeff = winner_coefficients_for_key(key);
  }
  return winner_interpolate(coeff, pixel, vec2f(winner_settings.viewport));
}
`;
}

/** Final Surface resource profile: all shared geometry and winner products are
 * read through the existing raw metadata binding. Producer stages use typed,
 * disjoint ranges; this whole-arena read is exclusively a later usage scope.
 * Header/directory offsets are supplied by the frame product, never identities. */
export function winnerPrimitiveArenaConsumerWgsl(heap = "asset_metadata_heap", includeKeyAbi = true): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(heap)) throw new RangeError("Invalid frame arena WGSL heap identifier");
  return /* wgsl */ `
${includeKeyAbi ? GPU_VISIBILITY_KEY_WGSL : ""}
${WINNER_INTERPOLATION_WGSL}
${WINNER_HASH_WGSL}
fn winner_arena_vec4(at: u32) -> vec4f {
  return bitcast<vec4f>(vec4u(${heap}[at], ${heap}[at + 1u], ${heap}[at + 2u], ${heap}[at + 3u]));
}
fn winner_arena_coefficient_slot(key: u32, frame_at: u32) -> u32 {
  if !oengine_visibility_key_is_valid(key) { return OENGINE_VISIBILITY_KEY_EMPTY; }
  let dictionary = ${heap}[frame_at + ${ARENA.dictionary}u];
  let capacity = ${heap}[frame_at + ${ARENA.dictionaryCapacity}u];
  let hash = winner_hash(key);
  for (var probe = 0u; probe < ${heap}[frame_at + ${ARENA.probeLimit}u]; probe++) {
    let at = dictionary + ((hash + probe) & (capacity - 1u)) * ${WINNER_DICTIONARY_STRIDE / 4}u;
    let other = ${heap}[at];
    if other == OENGINE_VISIBILITY_KEY_EMPTY { break; }
    if other == key { return ${heap}[at + 1u]; }
  }
  return OENGINE_VISIBILITY_KEY_EMPTY;
}
fn winner_arena_direct_coefficients(key: u32, frame_at: u32, directory_at: u32) -> WinnerCoefficients {
  let decoded = oengine_visibility_key_decode(key);
  if decoded.valid == 0u || ${heap}[directory_at + 1u] == 0u ||
    decoded.meshlet_work_slot >= min(${heap}[directory_at], ${heap}[frame_at + ${ARENA.workCapacity}u]) {
    return winner_empty_coefficients();
  }
  let at = directory_at + 4u + decoded.meshlet_work_slot * ${FRAME_GEOMETRY_MESHLET_STRIDE / 4}u;
  let vertex_base = ${heap}[at]; let triangle_base = ${heap}[at + 1u];
  let vertices = min(${heap}[directory_at + 2u], ${heap}[frame_at + ${ARENA.vertexCapacity}u]);
  let triangles = min(${heap}[directory_at + 3u], ${heap}[frame_at + ${ARENA.triangleCapacity}u]);
  if decoded.local_primitive >= ${heap}[at + 3u] || triangle_base >= triangles ||
    decoded.local_primitive >= triangles - triangle_base { return winner_empty_coefficients(); }
  let packed = ${heap}[${heap}[frame_at + ${ARENA.triangles}u] + triangle_base + decoded.local_primitive];
  let corners = vec3u(packed & 255u, (packed >> 8u) & 255u, (packed >> 16u) & 255u);
  if any(corners >= vec3u(${heap}[at + 2u])) || vertex_base >= vertices ||
    any(corners >= vec3u(vertices - vertex_base)) { return winner_empty_coefficients(); }
  let ids = (corners + vec3u(vertex_base)) * 4u + vec3u(${heap}[frame_at + ${ARENA.clips}u]);
  return winner_build_coefficients(winner_arena_vec4(ids.x), winner_arena_vec4(ids.y), winner_arena_vec4(ids.z));
}
fn winner_arena_interpolate_key(key: u32, pixel: vec2f, viewport: vec2f,
  frame_at: u32, directory_at: u32) -> WinnerInterpolation {
  let slot = winner_arena_coefficient_slot(key, frame_at);
  var coeff: WinnerCoefficients;
  if slot < ${heap}[frame_at + ${ARENA.coefficientCapacity}u] {
    let at = ${heap}[frame_at + ${ARENA.coefficients}u] + slot * ${WINNER_COEFFICIENT_STRIDE / 4}u;
    coeff = WinnerCoefficients(winner_arena_vec4(at), winner_arena_vec4(at + 4u), winner_arena_vec4(at + 8u));
    // The arena consumer can run without the optional dictionary producer.
    // A zero-initialized entry must not turn VisibilityKey 0 into a false hit;
    // recover the coefficients directly from the published geometry instead.
    if coeff.row0.w == 0.0 {
      coeff = winner_arena_direct_coefficients(key, frame_at, directory_at);
    }
  } else {
    coeff = winner_arena_direct_coefficients(key, frame_at, directory_at);
  }
  return winner_interpolate(coeff, pixel, viewport);
}
`;
}

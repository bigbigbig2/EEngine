import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_FRAME_INSTANCE_WGSL } from "../gpu/GpuFrameInstanceAbi.js";
import { NATIVE_MATERIAL_DIRECTORY_WGSL } from "../gpu/GpuNativeMaterialPublication.js";

/** One 12B tile record with an exact 64-bit coverage mask. Bin metadata
 * retains the 32B indirect ABI; counts/dispatches now count tiles, not pixels. */
export const NATIVE_EXECUTION_BIN_WORDS = 8;
export const NATIVE_EXECUTION_BIN_STRIDE = NATIVE_EXECUTION_BIN_WORDS * 4;
export const NATIVE_EXECUTION_TILE_WORDS = 3;
export const NATIVE_EXECUTION_WORKGROUP_SIZE = 64;
export const NATIVE_EXECUTION_SHARED_BYTES = 2064;

export const NATIVE_EXECUTION_CLASSIFY_WGSL = /* wgsl */ `
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_VISIBILITY_KEY_WGSL}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_FRAME_INSTANCE_WGSL}
${NATIVE_MATERIAL_DIRECTORY_WGSL}
struct BinSettings {
  width: u32, height: u32, bins: u32, tile_capacity: u32,
  generation: u32, tiles_x: u32, metadata_words: u32, reserved: u32,
}
@group(0) @binding(0) var<uniform> settings: BinSettings;
@group(0) @binding(1) var visibility: texture_2d<u32>;
@group(0) @binding(2) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(3) var<storage, read> instances: array<OEngineFrameInstanceRecord>;
@group(0) @binding(4) var<storage, read> materials: array<NativeMaterialDirectoryEntry>;
@group(0) @binding(5) var<storage, read> known_bins: array<vec2u>;
@group(0) @binding(6) var<storage, read_write> scratch: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read_write> queue: array<u32>;
var<workgroup> tile_keys: array<u32, 64>;
var<workgroup> primitive_keys: array<u32, 64>;
var<workgroup> mixed: atomic<u32>;
var<workgroup> primitive_mixed: atomic<u32>;
var<workgroup> uniform_mixed: u32;
// At most 64 distinct keys, with 128 slots; no loss at high entropy.
var<workgroup> local_keys: array<atomic<u32>, 128>;
var<workgroup> local_low: array<atomic<u32>, 128>;
var<workgroup> local_high: array<atomic<u32>, 128>;
fn winner_bin(pixel: vec2u, key: u32) -> vec2u {
  if pixel.x >= settings.width || pixel.y >= settings.height {
    return vec2u(0xffffffffu, 0u);
  }
  let decoded = oengine_visibility_key_decode(key);
  if decoded.empty != 0u {
    return vec2u(0xffffffffu, 0u);
  }
  if decoded.valid == 0u || settings.generation == 0u ||
      meshlet_work.header.generation != settings.generation ||
      decoded.meshlet_work_slot >= min(meshlet_work.header.written_count,
        min(meshlet_work.header.capacity, arrayLength(&meshlet_work.elements))) {
    return vec2u(0xffffffffu, 1u);
  }
  let work = meshlet_work.elements[decoded.meshlet_work_slot];
  if work.instance_slot >= arrayLength(&instances) ||
      work.material_slot_or_range >= arrayLength(&materials) {
    return vec2u(0xffffffffu, 1u);
  }
  if instances[work.instance_slot].generation != settings.generation {
    return vec2u(0xffffffffu, 1u);
  }
  // MeshletWork is the resolved material owner, including multi-material meshes.
  let material = materials[work.material_slot_or_range];
  let bin = material.execution_bin;
  if material.program_index == 0xffffffffu || bin >= settings.bins {
    return vec2u(0xffffffffu, 1u);
  }
  if any(known_bins[bin] != vec2u(material.program_index, material.binding_set)) {
    return vec2u(0xffffffffu, 1u);
  }
  return vec2u(bin, 0u);
}

fn publish_tile(bin: u32, tile: u32, low: u32, high: u32, uniform_primitive: bool) {
  let at = atomicAdd(&scratch[4u + bin], 1u);
  // A bin can occur at most once per tile. Its admitted capacity is all tiles,
  // independent of scene entropy or previous-frame feedback.
  if at >= settings.tile_capacity { atomicAdd(&scratch[1u], 1u); return; }
  let destination = settings.metadata_words + (bin * settings.tile_capacity + at) * ${NATIVE_EXECUTION_TILE_WORDS}u;
  queue[destination] = tile | select(0u, 0x80000000u, uniform_primitive);
  queue[destination + 1u] = low;
  queue[destination + 2u] = high;
}
@compute @workgroup_size(64)
fn classify(@builtin(workgroup_id) group: vec3u, @builtin(num_workgroups) groups: vec3u,
  @builtin(local_invocation_index) lane: u32) {
  let tile = group.y * groups.x + group.x;
  if tile >= settings.tile_capacity { return; }
  let pixel = vec2u((tile % settings.tiles_x) * 8u + lane % 8u,
    (tile / settings.tiles_x) * 8u + lane / 8u);
  var key = 0xffffffffu;
  if pixel.x < settings.width && pixel.y < settings.height {
    key = textureLoad(visibility, vec2i(pixel), 0).x;
  }
  let result = winner_bin(pixel, key);
  tile_keys[lane] = result.x;
  var primitive = 0xffffffffu;
  if result.x != 0xffffffffu { primitive = key; }
  primitive_keys[lane] = primitive;
  for (var at = lane; at < 128u; at += 64u) {
    atomicStore(&local_keys[at], 0xffffffffu);
    atomicStore(&local_low[at], 0u);
    atomicStore(&local_high[at], 0u);
  }
  if result.y != 0u { atomicAdd(&scratch[0u], 1u); }
  workgroupBarrier();
  if result.x != tile_keys[0] { atomicOr(&mixed, 1u); }
  if primitive != primitive_keys[0] { atomicOr(&primitive_mixed, 1u); }
  workgroupBarrier();
  if lane == 0u { uniform_mixed = atomicLoad(&mixed); }
  if workgroupUniformLoad(&uniform_mixed) == 0u {
    if lane == 0u && result.x != 0xffffffffu {
      let uniform_primitive = atomicLoad(&primitive_mixed) == 0u;
      publish_tile(result.x, tile, 0xffffffffu, 0xffffffffu, uniform_primitive);
      atomicAdd(&scratch[2u], 1u);
      if uniform_primitive { atomicAdd(&scratch[3u], 1u); }
    }
    return;
  }
  if result.x != 0xffffffffu {
    var slot = (result.x * 2654435761u) & 127u;
    for (var probe = 0u; probe < 128u; probe++) {
      var previous: u32;
      var exchanged: bool;
      // A weak-CAS spurious failure must not consume a probe or invent a miss.
      loop {
        let reservation = atomicCompareExchangeWeak(&local_keys[slot], 0xffffffffu, result.x);
        previous = reservation.old_value;
        exchanged = reservation.exchanged;
        if exchanged || previous != 0xffffffffu { break; }
      }
      if exchanged || previous == result.x {
        if lane < 32u { atomicOr(&local_low[slot], 1u << lane); }
        else { atomicOr(&local_high[slot], 1u << (lane - 32u)); }
        break;
      }
      slot = (slot + 1u) & 127u;
    }
  }
  workgroupBarrier();
  for (var at = lane; at < 128u; at += 64u) {
    let bin = atomicLoad(&local_keys[at]);
    if bin != 0xffffffffu {
      publish_tile(bin, tile, atomicLoad(&local_low[at]), atomicLoad(&local_high[at]), false);
    }
  }
}
`;

export const NATIVE_EXECUTION_FINALIZE_WGSL = /* wgsl */ `
struct FinalizeSettings { bins: u32, tile_capacity: u32, metadata_words: u32, max_groups: u32, }
@group(0) @binding(0) var<uniform> settings: FinalizeSettings;
@group(0) @binding(1) var<storage, read> scratch: array<u32>;
@group(0) @binding(2) var<storage, read> known_bins: array<vec2u>;
@group(0) @binding(3) var<storage, read_write> queue: array<u32>;
@compute @workgroup_size(64)
fn finalize(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) groups: vec3u) {
  let bin = id.x + id.y * groups.x * 64u;
  if bin >= settings.bins { return; }
  let count = scratch[4u + bin];
  let x = min(count, settings.max_groups);
  let y = select(0u, (count + settings.max_groups - 1u) / settings.max_groups, count != 0u);
  let record = bin * ${NATIVE_EXECUTION_BIN_WORDS}u;
  queue[record] = settings.metadata_words + bin * settings.tile_capacity * ${NATIVE_EXECUTION_TILE_WORDS}u;
  queue[record + 1u] = count;
  queue[record + 2u] = x;
  queue[record + 3u] = y;
  queue[record + 4u] = 1u;
  queue[record + 5u] = known_bins[bin].x;
  queue[record + 6u] = known_bins[bin].y;
  queue[record + 7u] = 0u;
}
`;

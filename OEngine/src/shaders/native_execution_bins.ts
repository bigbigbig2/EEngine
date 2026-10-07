import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_FRAME_INSTANCE_WGSL } from "../gpu/GpuFrameInstanceAbi.js";
import { NATIVE_MATERIAL_DIRECTORY_WGSL } from "../gpu/GpuNativeMaterialPublication.js";

/** One u32 pixel index per accepted winner. Indirect arguments begin at byte 8. */
export const NATIVE_EXECUTION_BIN_WORDS = 8;
export const NATIVE_EXECUTION_BIN_STRIDE = NATIVE_EXECUTION_BIN_WORDS * 4;
export const NATIVE_EXECUTION_WORKGROUP_SIZE = 64;
export const NATIVE_EXECUTION_SCAN_SIZE = 256;
export const NATIVE_EXECUTION_HISTOGRAM_SHARDS = 32;

/**
 * Portable local aggregation, no subgroup/lane mapping assumptions. A tile
 * reserves one contiguous interval per distinct bin in its histogram shard.
 * Mixed tiles compute exact local ranks by comparing at most 64 keys; this
 * deliberately exposes the high-entropy ALU cost instead of hiding a sort/VM.
 * Inputs must remain immutable between count and scatter in the same encoder.
 */
export const NATIVE_EXECUTION_CLASSIFY_WGSL = /* wgsl */ `
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_VISIBILITY_KEY_WGSL}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_FRAME_INSTANCE_WGSL}
${NATIVE_MATERIAL_DIRECTORY_WGSL}
struct BinSettings {
  width: u32,
  height: u32,
  bins: u32,
  shards: u32,
  generation: u32,
  tiles_x: u32,
  metadata_words: u32,
  reserved: u32,
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
var<workgroup> tile_bases: array<u32, 64>;
var<workgroup> mixed: atomic<u32>;

// x = bin, y = 1 for malformed/stale winner, 0 for valid/background.
fn winner_bin(pixel: vec2u) -> vec2u {
  if pixel.x >= settings.width || pixel.y >= settings.height {
    return vec2u(0xffffffffu, 0u);
  }
  let key = textureLoad(visibility, vec2i(pixel), 0).x;
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

fn tile_pixel(tile: u32, lane: u32) -> vec2u {
  return vec2u((tile % settings.tiles_x) * 8u + lane % 8u,
    (tile / settings.tiles_x) * 8u + lane / 8u);
}

@compute @workgroup_size(64)
fn count(@builtin(workgroup_id) group: vec3u,
    @builtin(num_workgroups) groups: vec3u,
    @builtin(local_invocation_index) lane: u32) {
  let tile = group.y * groups.x + group.x;
  let result = winner_bin(tile_pixel(tile, lane));
  tile_keys[lane] = result.x;
  workgroupBarrier();
  if result.x != tile_keys[0] {
    atomicOr(&mixed, 1u);
  }
  if result.y != 0u {
    atomicAdd(&scratch[0], 1u);
  }
  workgroupBarrier();
  let bin = result.x;
  if bin == 0xffffffffu {
    return;
  }
  let histogram = 4u + (tile % settings.shards) * settings.bins + bin;
  if atomicLoad(&mixed) == 0u {
    if lane == 0u {
      atomicAdd(&scratch[histogram], 64u);
    }
    return;
  }
  for (var previous = 0u; previous < lane; previous++) {
    if tile_keys[previous] == bin {
      return;
    }
  }
  var total = 0u;
  for (var at = lane; at < 64u; at++) {
    total += select(0u, 1u, tile_keys[at] == bin);
  }
  atomicAdd(&scratch[histogram], total);
}

@compute @workgroup_size(64)
fn scatter(@builtin(workgroup_id) group: vec3u,
    @builtin(num_workgroups) groups: vec3u,
    @builtin(local_invocation_index) lane: u32) {
  let tile = group.y * groups.x + group.x;
  let pixel = tile_pixel(tile, lane);
  let bin = winner_bin(pixel).x;
  tile_keys[lane] = bin;
  workgroupBarrier();
  if bin != tile_keys[0] {
    atomicOr(&mixed, 1u);
  }
  workgroupBarrier();
  var leader = lane;
  var rank = 0u;
  var total = 0u;
  if atomicLoad(&mixed) == 0u {
    leader = 0u;
    rank = lane;
    total = 64u;
  } else {
    for (var at = 0u; at < 64u; at++) {
      if tile_keys[at] == bin {
        leader = min(leader, at);
        rank += select(0u, 1u, at < lane);
        total++;
      }
    }
  }
  if bin != 0xffffffffu && lane == leader {
    let histogram = 4u + (tile % settings.shards) * settings.bins + bin;
    tile_bases[lane] = atomicAdd(&scratch[histogram], total);
  }
  workgroupBarrier();
  if bin != 0xffffffffu {
    let destination = tile_bases[leader] + rank;
    // Capacity is exactly width*height. This is an invariant check, never a
    // budget truncation: a nonzero counter makes the frame invalid to its owner.
    if destination >= arrayLength(&queue) {
      atomicAdd(&scratch[1], 1u);
    } else {
      queue[destination] = pixel.y * settings.width + pixel.x;
    }
  }
}
`;

/** Cooperative hierarchical exclusive scan. No lane-0 loop over the bin set. */
export const NATIVE_EXECUTION_PREFIX_WGSL = /* wgsl */ `
struct ScanSettings {
  count: u32,
  input_base: u32,
  output_base: u32,
  sums_base: u32,
  parent_base: u32,
  bins: u32,
  shards: u32,
  histogram: u32,
}
@group(0) @binding(0) var<uniform> settings: ScanSettings;
@group(0) @binding(1) var<storage, read_write> scratch: array<atomic<u32>>;
var<workgroup> scan_values: array<u32, 256>;

@compute @workgroup_size(256)
fn scan(@builtin(workgroup_id) group: vec3u,
    @builtin(num_workgroups) groups: vec3u,
    @builtin(local_invocation_index) lane: u32) {
  let block = group.y * groups.x + group.x;
  let at = block * 256u + lane;
  var value = 0u;
  if at < settings.count {
    if settings.histogram != 0u {
      for (var shard = 0u; shard < settings.shards; shard++) {
        value += atomicLoad(&scratch[4u + shard * settings.bins + at]);
      }
    } else {
      value = atomicLoad(&scratch[settings.input_base + at]);
    }
  }
  scan_values[lane] = value;
  workgroupBarrier();
  for (var step = 1u; step < 256u; step *= 2u) {
    var previous = 0u;
    if lane >= step {
      previous = scan_values[lane - step];
    }
    workgroupBarrier();
    scan_values[lane] += previous;
    workgroupBarrier();
  }
  if at < settings.count {
    atomicStore(&scratch[settings.output_base + at], scan_values[lane] - value);
  }
  if lane == 255u && block * 256u < settings.count {
    atomicStore(&scratch[settings.sums_base + block], scan_values[lane]);
  }
}

@compute @workgroup_size(256)
fn add(@builtin(workgroup_id) group: vec3u,
    @builtin(num_workgroups) groups: vec3u,
    @builtin(local_invocation_index) lane: u32) {
  let block = group.y * groups.x + group.x;
  let at = block * 256u + lane;
  if at < settings.count {
    let parent = atomicLoad(&scratch[settings.parent_base + block]);
    atomicAdd(&scratch[settings.output_base + at], parent);
  }
}
`;

export const NATIVE_EXECUTION_FINALIZE_WGSL = /* wgsl */ `
struct FinalizeSettings {
  bins: u32,
  shards: u32,
  offsets: u32,
  max_groups: u32,
}
@group(0) @binding(0) var<uniform> settings: FinalizeSettings;
@group(0) @binding(1) var<storage, read_write> scratch: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read> known_bins: array<vec2u>;
@group(0) @binding(3) var<storage, read_write> queue: array<u32>;

@compute @workgroup_size(64)
fn finalize(@builtin(workgroup_id) group: vec3u,
    @builtin(num_workgroups) groups: vec3u,
    @builtin(local_invocation_index) lane: u32) {
  let bin = (group.y * groups.x + group.x) * 64u + lane;
  if bin >= settings.bins {
    return;
  }
  let prefix = atomicLoad(&scratch[settings.offsets + bin]);
  let base = settings.bins * ${NATIVE_EXECUTION_BIN_WORDS}u + prefix;
  var count = 0u;
  for (var shard = 0u; shard < settings.shards; shard++) {
    let at = 4u + shard * settings.bins + bin;
    let shard_count = atomicLoad(&scratch[at]);
    atomicStore(&scratch[at], base + count);
    count += shard_count;
  }
  let required_groups = (count + ${NATIVE_EXECUTION_WORKGROUP_SIZE - 1}u) / ${NATIVE_EXECUTION_WORKGROUP_SIZE}u;
  let dispatch_x = min(required_groups, settings.max_groups);
  let dispatch_y = select(0u, (required_groups + settings.max_groups - 1u) / settings.max_groups, required_groups != 0u);
  let record = bin * ${NATIVE_EXECUTION_BIN_WORDS}u;
  queue[record] = base;
  queue[record + 1u] = count;
  queue[record + 2u] = dispatch_x;
  queue[record + 3u] = dispatch_y;
  queue[record + 4u] = 1u;
  queue[record + 5u] = known_bins[bin].x;
  queue[record + 6u] = known_bins[bin].y;
  queue[record + 7u] = 0u;
}
`;

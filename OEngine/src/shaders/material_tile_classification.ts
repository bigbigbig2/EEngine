import {
  GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT,
  GPU_MATERIAL_TILE_WORK_WGSL
} from "../gpu/GpuMaterialTileWorkAbi.js";
import { GPU_MATERIAL_VISIBILITY_RECORD_WGSL } from "../gpu/GpuMaterialVisibilityAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";

/**
 * ADR-0009 Step 1 portable MaterialTileWork producer/consumer validation.
 *
 * Workgroup size is deliberately fixed at 8x8 for the first candidate. The
 * subgroup specialization must publish this exact ABI before it may replace
 * this workgroup-atomic implementation.
 */
export const MATERIAL_TILE_CLASSIFICATION_WGSL = /* wgsl */ `
${GPU_VISIBILITY_KEY_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_MATERIAL_VISIBILITY_RECORD_WGSL}
${GPU_MATERIAL_TILE_WORK_WGSL}

const TILE_WIDTH: u32 = 8u;
const TILE_HEIGHT: u32 = 8u;
const TILE_LANE_COUNT: u32 = TILE_WIDTH * TILE_HEIGHT;
const QUEUE_HEADER_WORD_STRIDE: u32 = 8u;
const QUEUE_HEADER_WORD_COUNT: u32 =
  OENGINE_MATERIAL_TILE_DISPATCH_CLASS_COUNT * QUEUE_HEADER_WORD_STRIDE;
const WORK_RECORD_WORD_STRIDE: u32 = 4u;
const INDIRECT_WORD_STRIDE: u32 = 3u;
const HEADER_ATTEMPTED: u32 = 0u;
const HEADER_WRITTEN: u32 = 1u;
const HEADER_CONSUMED: u32 = 2u;
const HEADER_CAPACITY: u32 = 3u;
const HEADER_OVERFLOW: u32 = 4u;
const HEADER_GENERATION: u32 = 5u;
const HEADER_INVALID: u32 = 6u;

struct MaterialTileSettings {
  width: u32,
  height: u32,
  tile_count: u32,
  generation: u32,
  counters_enabled: u32,
  _padding0: u32,
  _padding1: u32,
  _padding2: u32,
};

@group(0) @binding(0) var visibility_keys: texture_2d<u32>;
@group(0) @binding(1) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(2) var<storage, read> materials: array<OEngineMaterialVisibilityRecord>;
@group(0) @binding(3) var<storage, read_write> queue_words: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> indirect_words: array<u32>;
@group(0) @binding(5) var<storage, read_write> control: OEngineMaterialClassificationControl;
@group(0) @binding(6) var<uniform> settings: MaterialTileSettings;

var<workgroup> active_dispatch_classes:
  array<atomic<u32>, ${GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT}>;

fn header_word(dispatch_class: u32, field: u32) -> u32 {
  return dispatch_class * QUEUE_HEADER_WORD_STRIDE + field;
}

fn work_word(dispatch_class: u32, element: u32, field: u32) -> u32 {
  return QUEUE_HEADER_WORD_COUNT +
    (dispatch_class * settings.tile_count + element) * WORK_RECORD_WORD_STRIDE + field;
}

fn valid_pixel_dispatch_class(pixel: vec2u) -> u32 {
  let key = textureLoad(visibility_keys, vec2i(pixel), 0).r;
  if !oengine_visibility_key_is_valid(key) {
    return 0xffffffffu;
  }
  atomicAdd(&control.valid_pixel_count, 1u);
  let decoded = oengine_visibility_key_decode(key);
  let work_slot = decoded.meshlet_work_slot;
  if meshlet_work.header.generation == 0u ||
      work_slot >= min(meshlet_work.header.written_count, meshlet_work.header.capacity) ||
      work_slot >= arrayLength(&meshlet_work.elements) {
    atomicStore(&control.frame_invalid, 1u);
    return 0xfffffffeu;
  }
  let work = meshlet_work.elements[work_slot];
  if (work.packed_profile_lod >> 24u) != OENGINE_VISIBILITY_KEY_PARTITION ||
      work.material_slot_or_range >= arrayLength(&materials) {
    atomicStore(&control.frame_invalid, 1u);
    return 0xfffffffeu;
  }
  let material = materials[work.material_slot_or_range];
  if material.kernel_class >= OENGINE_MATERIAL_KERNEL_CLASS_COUNT ||
      material.texture_binding_set_id >= 4u {
    atomicStore(&control.frame_invalid, 1u);
    return 0xfffffffeu;
  }
  return oengine_material_dispatch_class_id(
    material.kernel_class,
    material.texture_binding_set_id
  );
}

@compute @workgroup_size(64)
fn initialize_material_tile_work(@builtin(local_invocation_index) lane: u32) {
  if lane < OENGINE_MATERIAL_TILE_DISPATCH_CLASS_COUNT {
    let base = lane * QUEUE_HEADER_WORD_STRIDE;
    atomicStore(&queue_words[base + HEADER_ATTEMPTED], 0u);
    atomicStore(&queue_words[base + HEADER_WRITTEN], 0u);
    atomicStore(&queue_words[base + HEADER_CONSUMED], 0u);
    atomicStore(&queue_words[base + HEADER_CAPACITY], settings.tile_count);
    atomicStore(&queue_words[base + HEADER_OVERFLOW], 0u);
    atomicStore(&queue_words[base + HEADER_GENERATION], settings.generation);
    atomicStore(&queue_words[base + HEADER_INVALID], 0u);
    atomicStore(&queue_words[base + 7u], 0u);
    let indirect = lane * INDIRECT_WORD_STRIDE;
    indirect_words[indirect] = 0u;
    indirect_words[indirect + 1u] = 1u;
    indirect_words[indirect + 2u] = 1u;
  }
  if lane == 0u {
    atomicStore(&control.valid_pixel_count, 0u);
    atomicStore(&control.shaded_pixel_count, 0u);
    atomicStore(&control.unassigned_pixel_count, 0u);
    atomicStore(&control.duplicate_shading_pixel_count, 0u);
    atomicStore(&control.overflow_queue_count, 0u);
    atomicStore(&control.frame_invalid, 0u);
    control.generation = settings.generation;
    control.dispatch_class_count = OENGINE_MATERIAL_TILE_DISPATCH_CLASS_COUNT;
  }
}

@compute @workgroup_size(8, 8, 1)
fn classify_material_tiles(
  @builtin(workgroup_id) group_id: vec3u,
  @builtin(local_invocation_id) local_id: vec3u,
  @builtin(local_invocation_index) lane: u32
) {
  if lane < OENGINE_MATERIAL_TILE_DISPATCH_CLASS_COUNT {
    atomicStore(&active_dispatch_classes[lane], 0u);
  }
  workgroupBarrier();

  let pixel = group_id.xy * vec2u(TILE_WIDTH, TILE_HEIGHT) + local_id.xy;
  if all(pixel < vec2u(settings.width, settings.height)) {
    let dispatch_class = valid_pixel_dispatch_class(pixel);
    if dispatch_class < OENGINE_MATERIAL_TILE_DISPATCH_CLASS_COUNT {
      atomicStore(&active_dispatch_classes[dispatch_class], 1u);
    }
  }
  workgroupBarrier();

  if lane < OENGINE_MATERIAL_TILE_DISPATCH_CLASS_COUNT &&
      atomicLoad(&active_dispatch_classes[lane]) != 0u {
    let attempted = atomicAdd(
      &queue_words[header_word(lane, HEADER_ATTEMPTED)],
      1u
    );
    let capacity = atomicLoad(&queue_words[header_word(lane, HEADER_CAPACITY)]);
    let slot = atomicAdd(&queue_words[header_word(lane, HEADER_WRITTEN)], 1u);
    if attempted >= capacity || slot >= capacity {
      atomicSub(&queue_words[header_word(lane, HEADER_WRITTEN)], 1u);
      atomicAdd(&queue_words[header_word(lane, HEADER_OVERFLOW)], 1u);
      atomicStore(&control.frame_invalid, 1u);
      return;
    }
    let tile_width = (settings.width + TILE_WIDTH - 1u) / TILE_WIDTH;
    let tile_linear_id = group_id.y * tile_width + group_id.x;
    let kernel_class = lane % OENGINE_MATERIAL_KERNEL_CLASS_COUNT;
    let binding_set = lane / OENGINE_MATERIAL_KERNEL_CLASS_COUNT;
    atomicStore(&queue_words[work_word(lane, slot, 0u)], tile_linear_id);
    atomicStore(&queue_words[work_word(lane, slot, 1u)], kernel_class);
    atomicStore(&queue_words[work_word(lane, slot, 2u)], binding_set);
    atomicStore(&queue_words[work_word(lane, slot, 3u)], settings.generation);
  }
}

@compute @workgroup_size(64)
fn build_material_tile_indirect(@builtin(local_invocation_index) lane: u32) {
  if lane == 0u {
    atomicStore(&control.overflow_queue_count, 0u);
  }
  workgroupBarrier();
  if lane < OENGINE_MATERIAL_TILE_DISPATCH_CLASS_COUNT {
    let overflow = atomicLoad(&queue_words[header_word(lane, HEADER_OVERFLOW)]);
    let invalid = atomicLoad(&queue_words[header_word(lane, HEADER_INVALID)]);
    let attempted = atomicLoad(&queue_words[header_word(lane, HEADER_ATTEMPTED)]);
    let written = atomicLoad(&queue_words[header_word(lane, HEADER_WRITTEN)]);
    if overflow != 0u || invalid != 0u || attempted != written {
      atomicAdd(&control.overflow_queue_count, 1u);
      atomicStore(&control.frame_invalid, 1u);
    }
  }
  workgroupBarrier();
  if lane < OENGINE_MATERIAL_TILE_DISPATCH_CLASS_COUNT {
    let indirect = lane * INDIRECT_WORD_STRIDE;
    let written = atomicLoad(&queue_words[header_word(lane, HEADER_WRITTEN)]);
    indirect_words[indirect] = select(
      written,
      0u,
      atomicLoad(&control.frame_invalid) != 0u
    );
    indirect_words[indirect + 1u] = 1u;
    indirect_words[indirect + 2u] = 1u;
  }
}

`;

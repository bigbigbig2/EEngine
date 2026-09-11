import {
  GPU_QUEUE_OVERFLOW_BITS,
  counterByteOffset
} from "../debug/GpuFrameCounters.js";
import {
  GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT,
  GPU_MATERIAL_TILE_WORK_WGSL
} from "../gpu/GpuMaterialTileWorkAbi.js";
import { GPU_MATERIAL_VISIBILITY_RECORD_WGSL } from "../gpu/GpuMaterialVisibilityAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { LIGHTING_DIRECT_CORE_WGSL } from "./lighting_direct.js";

/**
 * ADR-0009 Step 2 migration consumer.
 *
 * This is the production direct-lighting consumer of MaterialTileWork. It
 * deliberately still reads Surface V1 while the visibility-driven material
 * evaluation half of ShadeLighting is being cut over. The queue, indirect
 * dispatch, exactly-once claims, overflow policy and final-output invalidation
 * are already the final GPU-only contract; Surface V1 is the remaining Step 3
 * dependency, not a second authoritative lighting path.
 */
export const LIGHTING_DIRECT_COMPUTE_WGSL = /* wgsl */ `
${LIGHTING_DIRECT_CORE_WGSL}
${GPU_VISIBILITY_KEY_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_MATERIAL_VISIBILITY_RECORD_WGSL}
${GPU_MATERIAL_TILE_WORK_WGSL}

const TILE_WIDTH: u32 = 8u;
const TILE_HEIGHT: u32 = 8u;
const QUEUE_HEADER_WORD_STRIDE: u32 = 8u;
const QUEUE_HEADER_WORD_COUNT: u32 =
  OENGINE_MATERIAL_TILE_DISPATCH_CLASS_COUNT * QUEUE_HEADER_WORD_STRIDE;
const WORK_RECORD_WORD_STRIDE: u32 = 4u;
const HEADER_WRITTEN: u32 = 1u;
const HEADER_CONSUMED: u32 = 2u;
const HEADER_INVALID: u32 = 6u;
const COUNTER_MATERIAL_TILE_RECORDS: u32 = ${counterByteOffset("materialTileRecords") / 4}u;
const COUNTER_MATERIAL_TILE_VALID_PIXELS: u32 = ${counterByteOffset("materialTileValidPixels") / 4}u;
const COUNTER_MATERIAL_TILE_SHADED_PIXELS: u32 = ${counterByteOffset("materialTileShadedPixels") / 4}u;
const COUNTER_MATERIAL_TILE_UNASSIGNED_PIXELS: u32 = ${counterByteOffset("materialTileUnassignedPixels") / 4}u;
const COUNTER_MATERIAL_TILE_DUPLICATE_PIXELS: u32 = ${counterByteOffset("materialTileDuplicatePixels") / 4}u;
const COUNTER_MATERIAL_TILE_OVERFLOW_QUEUES: u32 = ${counterByteOffset("materialTileOverflowQueues") / 4}u;
const COUNTER_MATERIAL_TILE_FRAME_INVALID: u32 = ${counterByteOffset("materialTileFrameInvalid") / 4}u;
const COUNTER_QUEUE_OVERFLOW_MASK: u32 = ${counterByteOffset("queueOverflowMask") / 4}u;
const MATERIAL_TILE_OVERFLOW_BIT: u32 = ${GPU_QUEUE_OVERFLOW_BITS.materialTileWork}u;

struct MaterialTileSettings {
  dispatch_class: u32,
  _padding0: u32,
  _padding1: u32,
  _padding2: u32,
};

@group(3) @binding(0) var tile_visibility_keys: texture_2d<u32>;
@group(3) @binding(1) var<storage, read> tile_meshlet_work: OEngineMeshletWorkQueueRead;
@group(3) @binding(2) var<storage, read> tile_materials: array<OEngineMaterialVisibilityRecord>;
@group(3) @binding(3) var<storage, read_write> tile_queue_words: array<atomic<u32>>;
@group(3) @binding(4) var<storage, read_write> tile_control: OEngineMaterialClassificationControl;
@group(3) @binding(5) var<uniform> tile_settings: MaterialTileSettings;
@group(3) @binding(6) var<storage, read_write> tile_pixel_claims: array<atomic<u32>>;
@group(3) @binding(7) var<storage, read_write> tile_frame_counters: array<atomic<u32>>;
@group(3) @binding(8) var tile_hdr_output: texture_storage_2d<rgba16float, write>;

fn tile_header_word(dispatch_class: u32, field: u32) -> u32 {
  return dispatch_class * QUEUE_HEADER_WORD_STRIDE + field;
}

fn tile_work_word(dispatch_class: u32, element: u32, field: u32) -> u32 {
  let tile_count = ((view.width + TILE_WIDTH - 1u) / TILE_WIDTH) *
    ((view.height + TILE_HEIGHT - 1u) / TILE_HEIGHT);
  return QUEUE_HEADER_WORD_COUNT +
    (dispatch_class * tile_count + element) * WORK_RECORD_WORD_STRIDE + field;
}

fn invalidate_tile_queue(dispatch_class: u32) {
  atomicAdd(&tile_queue_words[tile_header_word(dispatch_class, HEADER_INVALID)], 1u);
  atomicStore(&tile_control.frame_invalid, 1u);
}

@compute @workgroup_size(8, 8, 1)
fn clear_direct_lighting(@builtin(global_invocation_id) global_id: vec3u) {
  let pixel = global_id.xy;
  if any(pixel >= vec2u(view.width, view.height)) { return; }
  textureStore(tile_hdr_output, vec2i(pixel), vec4f(0.0));
}

@compute @workgroup_size(8, 8, 1)
fn shade_direct_material_tiles(
  @builtin(workgroup_id) group_id: vec3u,
  @builtin(local_invocation_id) local_id: vec3u,
  @builtin(local_invocation_index) lane: u32
) {
  let dispatch_class = tile_settings.dispatch_class;
  if dispatch_class >= OENGINE_MATERIAL_TILE_DISPATCH_CLASS_COUNT { return; }
  let record_index = group_id.x;
  let written = atomicLoad(
    &tile_queue_words[tile_header_word(dispatch_class, HEADER_WRITTEN)]
  );
  if record_index >= written {
    if lane == 0u { invalidate_tile_queue(dispatch_class); }
    return;
  }
  let record_generation = atomicLoad(
    &tile_queue_words[tile_work_word(dispatch_class, record_index, 3u)]
  );
  let record_kernel = atomicLoad(
    &tile_queue_words[tile_work_word(dispatch_class, record_index, 1u)]
  );
  let record_set = atomicLoad(
    &tile_queue_words[tile_work_word(dispatch_class, record_index, 2u)]
  );
  if record_generation != tile_control.generation ||
      oengine_material_dispatch_class_id(record_kernel, record_set) != dispatch_class {
    if lane == 0u { invalidate_tile_queue(dispatch_class); }
    return;
  }
  let tile_linear_id = atomicLoad(
    &tile_queue_words[tile_work_word(dispatch_class, record_index, 0u)]
  );
  let tiles_x = (view.width + TILE_WIDTH - 1u) / TILE_WIDTH;
  let tile_origin = vec2u(tile_linear_id % tiles_x, tile_linear_id / tiles_x) *
    vec2u(TILE_WIDTH, TILE_HEIGHT);
  let pixel = tile_origin + local_id.xy;
  if any(pixel >= vec2u(view.width, view.height)) { return; }

  let key = textureLoad(tile_visibility_keys, vec2i(pixel), 0).r;
  if !oengine_visibility_key_is_valid(key) { return; }
  let decoded = oengine_visibility_key_decode(key);
  let work_slot = decoded.meshlet_work_slot;
  if tile_meshlet_work.header.generation == 0u ||
      work_slot >= min(
        tile_meshlet_work.header.written_count,
        tile_meshlet_work.header.capacity
      ) ||
      work_slot >= arrayLength(&tile_meshlet_work.elements) {
    atomicStore(&tile_control.frame_invalid, 1u);
    return;
  }
  let work = tile_meshlet_work.elements[work_slot];
  if work.material_slot_or_range >= arrayLength(&tile_materials) {
    atomicStore(&tile_control.frame_invalid, 1u);
    return;
  }
  let material = tile_materials[work.material_slot_or_range];
  if oengine_material_dispatch_class_id(
      material.kernel_class,
      material.texture_binding_set_id
    ) != dispatch_class {
    return;
  }
  let surface_word = textureLoad(surface_metadata, vec2i(pixel), 0).r;
  if !oengine_surface_has_flag(surface_word, OENGINE_SURFACE_FLAG_VALID) {
    atomicStore(&tile_control.frame_invalid, 1u);
    return;
  }

  textureStore(tile_hdr_output, vec2i(pixel), shade_direct_pixel(pixel));
}

@compute @workgroup_size(8, 8, 1)
fn validate_direct_lighting_pixels(@builtin(global_invocation_id) global_id: vec3u) {
  let pixel = global_id.xy;
  if any(pixel >= vec2u(view.width, view.height)) { return; }
  let key = textureLoad(tile_visibility_keys, vec2i(pixel), 0).r;
  if !oengine_visibility_key_is_valid(key) { return; }
  let claim_count = atomicLoad(
    &tile_pixel_claims[pixel.y * view.width + pixel.x]
  );
  atomicAdd(&tile_control.shaded_pixel_count, claim_count);
  if claim_count == 0u {
    atomicAdd(&tile_control.unassigned_pixel_count, 1u);
  } else if claim_count > 1u {
    atomicAdd(&tile_control.duplicate_shading_pixel_count, claim_count - 1u);
  }
}

@compute @workgroup_size(64)
fn finalize_direct_lighting(@builtin(local_invocation_index) lane: u32) {
  if lane < OENGINE_MATERIAL_TILE_DISPATCH_CLASS_COUNT {
    let written = atomicLoad(
      &tile_queue_words[tile_header_word(lane, HEADER_WRITTEN)]
    );
    let consumed = atomicLoad(
      &tile_queue_words[tile_header_word(lane, HEADER_CONSUMED)]
    );
    let invalid = atomicLoad(
      &tile_queue_words[tile_header_word(lane, HEADER_INVALID)]
    );
    if written != consumed || invalid != 0u {
      atomicStore(&tile_control.frame_invalid, 1u);
    }
  }
  workgroupBarrier();
  if lane == 0u && (
      atomicLoad(&tile_control.shaded_pixel_count) !=
        atomicLoad(&tile_control.valid_pixel_count) ||
      atomicLoad(&tile_control.unassigned_pixel_count) != 0u ||
      atomicLoad(&tile_control.duplicate_shading_pixel_count) != 0u ||
      atomicLoad(&tile_control.overflow_queue_count) != 0u
  ) {
    atomicStore(&tile_control.frame_invalid, 1u);
  }
  workgroupBarrier();
  if lane < OENGINE_MATERIAL_TILE_DISPATCH_CLASS_COUNT {
    atomicAdd(
      &tile_frame_counters[COUNTER_MATERIAL_TILE_RECORDS],
      atomicLoad(&tile_queue_words[tile_header_word(lane, HEADER_WRITTEN)])
    );
  }
  workgroupBarrier();
  if lane == 0u {
    let valid = atomicLoad(&tile_control.valid_pixel_count);
    let shaded = atomicLoad(&tile_control.shaded_pixel_count);
    let unassigned = atomicLoad(&tile_control.unassigned_pixel_count);
    let duplicate = atomicLoad(&tile_control.duplicate_shading_pixel_count);
    let overflow = atomicLoad(&tile_control.overflow_queue_count);
    let invalid = atomicLoad(&tile_control.frame_invalid);
    atomicStore(&tile_frame_counters[COUNTER_MATERIAL_TILE_VALID_PIXELS], valid);
    atomicStore(&tile_frame_counters[COUNTER_MATERIAL_TILE_SHADED_PIXELS], shaded);
    atomicStore(&tile_frame_counters[COUNTER_MATERIAL_TILE_UNASSIGNED_PIXELS], unassigned);
    atomicStore(&tile_frame_counters[COUNTER_MATERIAL_TILE_DUPLICATE_PIXELS], duplicate);
    atomicStore(&tile_frame_counters[COUNTER_MATERIAL_TILE_OVERFLOW_QUEUES], overflow);
    atomicStore(&tile_frame_counters[COUNTER_MATERIAL_TILE_FRAME_INVALID], invalid);
    if overflow != 0u || invalid != 0u {
      atomicOr(&tile_frame_counters[COUNTER_QUEUE_OVERFLOW_MASK], MATERIAL_TILE_OVERFLOW_BIT);
    }
  }
}
`;

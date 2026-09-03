import { GPU_MATERIAL_VISIBILITY_RECORD_WGSL } from "../gpu/GpuMaterialVisibilityAbi.js";
import { GPU_MATERIAL_KERNEL_CLASS_COUNT } from "../gpu/GpuMaterialKernelAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { GPU_RASTER_WORK_SCHEMA } from "../gpu/GpuWorkGenerationAbi.js";
import { counterByteOffset } from "../debug/GpuFrameCounters.js";

export const VISIBLE_PIXEL_CLASSIFICATION_WGSL = /* wgsl */ `
${GPU_MATERIAL_VISIBILITY_RECORD_WGSL}
${GPU_VISIBILITY_KEY_WGSL}
${GPU_RASTER_WORK_SCHEMA.wgsl}

const CLASS_COUNT: u32 = ${GPU_MATERIAL_KERNEL_CLASS_COUNT}u;
const BLOCK_SIZE: u32 = 256u;

struct QueueHeaderRead {
  written: u32, attempted: u32, peak: u32, overflow: u32,
  fallback: u32, capacity: u32, rejected0: u32, rejected1: u32,
}
struct RasterQueue {
  opaque: QueueHeaderRead,
  mask: QueueHeaderRead,
  elements: array<OEngineRasterWork>,
}
struct Settings { width: u32, height: u32, raster_class_capacity: u32, group_count: u32 }
struct ClassState { count: u32, offset: u32, _reserved: u32, overflow: atomic<u32> }
struct DrawIndirect { vertex_count: u32, instance_count: u32, first_vertex: u32, first_instance: u32 }

@group(0) @binding(0) var visibility_keys: texture_2d<u32>;
@group(0) @binding(1) var<storage, read> materials: array<OEngineMaterialVisibilityRecord>;
@group(0) @binding(2) var<storage, read> raster_work: RasterQueue;
@group(0) @binding(3) var<uniform> settings: Settings;
@group(0) @binding(4) var<storage, read_write> group_counts: array<u32>;
@group(0) @binding(5) var<storage, read_write> class_totals: array<atomic<u32>>;

var<workgroup> local_counts: array<atomic<u32>, ${GPU_MATERIAL_KERNEL_CLASS_COUNT}>;

fn key_addresses_published_work(key: u32) -> bool {
  let slot = oengine_visibility_key_raster_work_slot(key);
  let opaque_count = min(
    raster_work.opaque.written,
    min(raster_work.opaque.capacity, settings.raster_class_capacity)
  );
  let mask_count = min(
    raster_work.mask.written,
    min(raster_work.mask.capacity, settings.raster_class_capacity)
  );
  return slot < opaque_count ||
    (slot >= settings.raster_class_capacity &&
      slot - settings.raster_class_capacity < mask_count);
}

fn work_for_key(key: u32) -> OEngineRasterWork {
  return raster_work.elements[oengine_visibility_key_raster_work_slot(key)];
}

@compute @workgroup_size(256)
fn count_visible_pixels(
  @builtin(local_invocation_index) lane: u32,
  @builtin(workgroup_id) group: vec3u,
  @builtin(num_workgroups) grid: vec3u
) {
  if lane < CLASS_COUNT { atomicStore(&local_counts[lane], 0u); }
  workgroupBarrier();
  let group_index = group.y * grid.x + group.x;
  if group_index >= settings.group_count { return; }
  let linear_pixel = group_index * BLOCK_SIZE + lane;
  let pixel_count = settings.width * settings.height;
  if linear_pixel < pixel_count {
    let pixel = vec2i(i32(linear_pixel % settings.width), i32(linear_pixel / settings.width));
    let key = textureLoad(visibility_keys, pixel, 0).r;
    if oengine_visibility_key_is_valid(key) && key_addresses_published_work(key) {
      let work = work_for_key(key);
      if work.material_handle < arrayLength(&materials) {
        let kernel = min(materials[work.material_handle].kernel_class, CLASS_COUNT - 1u);
        atomicAdd(&local_counts[kernel], 1u);
      }
    }
  }
  workgroupBarrier();
  if lane < CLASS_COUNT {
    let value = atomicLoad(&local_counts[lane]);
    group_counts[lane * settings.group_count + group_index] = value;
    atomicAdd(&class_totals[lane], value);
  }
}

struct ScanSettings { element_count: u32, block_count: u32, _pad0: u32, _pad1: u32 }
@group(1) @binding(0) var<storage, read> scan_input: array<u32>;
@group(1) @binding(1) var<storage, read_write> scan_output: array<u32>;
@group(1) @binding(2) var<storage, read_write> scan_block_sums: array<u32>;
@group(1) @binding(3) var<uniform> scan_settings: ScanSettings;
var<workgroup> scan_values: array<u32, 256>;

@compute @workgroup_size(256)
fn scan_blocks(
  @builtin(local_invocation_index) lane: u32,
  @builtin(workgroup_id) group: vec3u
) {
  let class_id = group.y;
  let index = group.x * BLOCK_SIZE + lane;
  let base = class_id * scan_settings.element_count;
  scan_values[lane] = 0u;
  if index < scan_settings.element_count {
    scan_values[lane] = scan_input[base + index];
  }
  workgroupBarrier();
  var offset = 1u;
  var active_lane_count = BLOCK_SIZE >> 1u;
  while (active_lane_count > 0u) {
    if lane < active_lane_count {
      let right = (lane + 1u) * offset * 2u - 1u;
      scan_values[right] += scan_values[right - offset];
    }
    offset <<= 1u;
    active_lane_count >>= 1u;
    workgroupBarrier();
  }
  if lane == 0u {
    scan_block_sums[class_id * scan_settings.block_count + group.x] = scan_values[BLOCK_SIZE - 1u];
    scan_values[BLOCK_SIZE - 1u] = 0u;
  }
  workgroupBarrier();
  var down = 1u;
  offset = BLOCK_SIZE;
  while (down < BLOCK_SIZE) {
    offset >>= 1u;
    if lane < down {
      let right = (lane + 1u) * offset * 2u - 1u;
      let left = right - offset;
      let value = scan_values[left];
      scan_values[left] = scan_values[right];
      scan_values[right] += value;
    }
    down <<= 1u;
    workgroupBarrier();
  }
  if index < scan_settings.element_count { scan_output[base + index] = scan_values[lane]; }
}

@group(2) @binding(0) var<storage, read_write> add_child_prefix: array<u32>;
@group(2) @binding(1) var<storage, read> add_parent_prefix: array<u32>;
@group(2) @binding(2) var<uniform> add_settings: ScanSettings;

@compute @workgroup_size(256)
fn add_block_prefixes(@builtin(global_invocation_id) global: vec3u) {
  let index = global.x;
  let class_id = global.y;
  if index >= add_settings.element_count { return; }
  let block = index / BLOCK_SIZE;
  add_child_prefix[class_id * add_settings.element_count + index] +=
    add_parent_prefix[class_id * add_settings.block_count + block];
}

@group(3) @binding(0) var<storage, read> prepare_totals: array<u32>;
@group(3) @binding(1) var<storage, read_write> class_states: array<ClassState>;
@group(3) @binding(2) var<storage, read_write> draw_args: array<DrawIndirect>;

@compute @workgroup_size(1)
fn prepare_classes() {
  var offset = 0u;
  for (var class_id = 0u; class_id < CLASS_COUNT; class_id++) {
    let count = prepare_totals[class_id];
    class_states[class_id].count = count;
    class_states[class_id].offset = offset;
    class_states[class_id]._reserved = 0u;
    atomicStore(&class_states[class_id].overflow, 0u);
    draw_args[class_id] = DrawIndirect(count, 1u, offset, 0u);
    offset += count;
  }
}

@group(1) @binding(4) var<storage, read> group_prefixes: array<u32>;
@group(1) @binding(5) var<storage, read_write> scatter_states: array<ClassState>;
@group(1) @binding(6) var<storage, read_write> shade_work: array<u32>;
var<workgroup> local_scatter: array<atomic<u32>, ${GPU_MATERIAL_KERNEL_CLASS_COUNT}>;

@compute @workgroup_size(256)
fn scatter_visible_pixels(
  @builtin(local_invocation_index) lane: u32,
  @builtin(workgroup_id) group: vec3u,
  @builtin(num_workgroups) grid: vec3u
) {
  if lane < CLASS_COUNT { atomicStore(&local_scatter[lane], 0u); }
  workgroupBarrier();
  let group_index = group.y * grid.x + group.x;
  if group_index >= settings.group_count { return; }
  let linear_pixel = group_index * BLOCK_SIZE + lane;
  let pixel_count = settings.width * settings.height;
  if linear_pixel >= pixel_count { return; }
  let pixel = vec2i(i32(linear_pixel % settings.width), i32(linear_pixel / settings.width));
  let key = textureLoad(visibility_keys, pixel, 0).r;
  if !oengine_visibility_key_is_valid(key) || !key_addresses_published_work(key) { return; }
  let work = work_for_key(key);
  if work.material_handle >= arrayLength(&materials) { return; }
  let kernel = min(materials[work.material_handle].kernel_class, CLASS_COUNT - 1u);
  let local_rank = atomicAdd(&local_scatter[kernel], 1u);
  let destination = scatter_states[kernel].offset +
    group_prefixes[kernel * settings.group_count + group_index] + local_rank;
  let limit = scatter_states[kernel].offset + scatter_states[kernel].count;
  if destination < limit && destination < pixel_count {
    shade_work[destination] = linear_pixel;
  } else {
    atomicAdd(&scatter_states[kernel].overflow, 1u);
  }
}

@group(1) @binding(7) var<storage, read_write> publish_states: array<ClassState>;
@group(1) @binding(8) var<storage, read_write> publish_counters: array<atomic<u32>>;

const KERNEL_COUNTER_BEGIN: u32 = ${counterByteOffset("kernelBaseFactorPixels") / 4}u;
const SHADE_OVERFLOW_COUNTER: u32 = ${counterByteOffset("shadeWorkOverflow") / 4}u;

@compute @workgroup_size(1)
fn publish_classification_counters() {
  var overflow = 0u;
  for (var class_id = 0u; class_id < CLASS_COUNT; class_id++) {
    atomicAdd(&publish_counters[KERNEL_COUNTER_BEGIN + class_id], publish_states[class_id].count);
    overflow += atomicLoad(&publish_states[class_id].overflow);
  }
  atomicAdd(&publish_counters[SHADE_OVERFLOW_COUNTER], overflow);
}
`;

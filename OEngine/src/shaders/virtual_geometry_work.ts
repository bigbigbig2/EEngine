import { counterByteOffset } from "../debug/GpuFrameCounters.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import {
  GPU_MESHLET_RASTER_WORK_WGSL,
  GPU_MESHLET_DECODE_PROFILE,
  GPU_MESHLET_RASTER_FLAGS
} from "../gpu/GpuMeshletRasterWorkAbi.js";
import {
  GPU_VISIBLE_CLUSTER_RECORD_SCHEMA,
  GPU_WORK_GENERATION_WGSL
} from "../gpu/GpuWorkGenerationAbi.js";
import { VIRTUAL_GEOMETRY_PRODUCT_WGSL } from "./virtual_geometry_product.js";

const COUNTER_MESHLET_WORKS = counterByteOffset("geometryMeshletWorksProduced") / 4;
const COUNTER_QUEUE_BYTES = counterByteOffset("geometryQueueBytes") / 4;
const COUNTER_INVALID = counterByteOffset("meshletQueueInvalid") / 4;
const COUNTER_OVERFLOW = counterByteOffset("meshletQueueOverflow") / 4;

/**
 * Product S1 work producer. It consumes the existing VisibleCluster queue,
 * decodes Group/Meshlet headers from the resident Product bank, and publishes
 * the same bounded MeshletRasterWork ABI consumed by MeshletBucketRaster.
 *
 * Product work deliberately uses one fixed 128-triangle indirect route. The
 * vertex consumer clips padded lanes using the decoded triangle count; no CPU
 * visibility list or legacy V2 meshlet table is consulted.
 */
export const VIRTUAL_GEOMETRY_MESHLET_WORK_WGSL = /* wgsl */ `
${GPU_INSTANCE_RECORD_WGSL}
${GPU_WORK_GENERATION_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${VIRTUAL_GEOMETRY_PRODUCT_WGSL}

struct OEngineCandidateVisibleHeaderRead {
  written: u32,
  attempted: u32,
  peak: u32,
  overflow: u32,
  fallback: u32,
  capacity: u32,
  rejected_cone: u32,
  rejected_hzb: u32,
};
struct OEngineVisibleClusterQueueRead {
  header: OEngineCandidateVisibleHeaderRead,
  elements: array<OEngineVisibleClusterRecord>,
};
struct OEngineVirtualCandidateSettings {
  counters_enabled: u32,
  product_generation: u32,
  visible_capacity: u32,
  reserved: u32,
};
struct OEngineDrawIndirectArgs {
  vertex_count: u32,
  instance_count: atomic<u32>,
  first_vertex: u32,
  first_instance: u32,
};

@group(0) @binding(0) var<storage, read> product_visible: OEngineVisibleClusterQueueRead;
@group(0) @binding(1) var<storage, read_write> product_work: OEngineMeshletWorkQueue;
@group(0) @binding(2) var<uniform> product_settings: OEngineVirtualCandidateSettings;
@group(0) @binding(3) var<storage, read_write> product_counters: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> product_draw: OEngineDrawIndirectArgs;
@group(0) @binding(5) var<storage, read> product_heap: array<u32>;
@group(0) @binding(6) var<storage, read> product_bank_0: array<u32>;
@group(0) @binding(7) var<storage, read> product_bank_1: array<u32>;
@group(0) @binding(8) var<storage, read> product_bank_2: array<u32>;
@group(0) @binding(9) var<storage, read> product_bank_3: array<u32>;

var<workgroup> product_group_base: u32;
var<workgroup> product_group_count: u32;
var<workgroup> product_group_id: u32;
var<workgroup> product_group_page_bank: u32;
var<workgroup> product_group_page_byte: u32;
var<workgroup> product_group_meshlet_offset: u32;
var<workgroup> product_group_payload: u32;
var<workgroup> product_group_valid: u32;

fn product_bank_word(bank: u32, word: u32) -> u32 {
  if (bank == 0u) { return product_bank_0[word]; }
  if (bank == 1u) { return product_bank_1[word]; }
  if (bank == 2u) { return product_bank_2[word]; }
  return product_bank_3[word];
}

fn product_meshlet_counts(bank: u32, byte_offset: u32, header_offset: u32, local: u32) -> vec2u {
  let at = (byte_offset + header_offset + local * 48u) >> 2u;
  let counts = product_bank_word(bank, at);
  return vec2u(counts & 0xffffu, counts >> 16u);
}

fn product_reserve(count: u32) -> u32 {
  atomicAdd(&product_work.header.attempted_count, count);
  var observed = atomicLoad(&product_work.header.written_count);
  loop {
    if count == 0u || count > product_work.header.capacity -
      min(observed, product_work.header.capacity) {
      atomicAdd(&product_work.header.overflow_count, count);
      return 0xffffffffu;
    }
    let result = atomicCompareExchangeWeak(&product_work.header.written_count,
      observed, observed + count);
    if result.exchanged { return observed; }
    observed = result.old_value;
  }
}

@compute @workgroup_size(1)
fn prepare_virtual_geometry_work() {
  atomicStore(&product_work.header.attempted_count, 0u);
  atomicStore(&product_work.header.written_count, 0u);
  atomicStore(&product_work.header.consumed_count, 0u);
  atomicStore(&product_work.header.overflow_count, 0u);
  atomicStore(&product_work.header.invalid_count, 0u);
  let generation = atomicLoad(&product_work.header.generation) + 1u;
  atomicStore(&product_work.header.generation, select(generation, 1u, generation == 0u));
  atomicStore(&product_draw.instance_count, 0u);
  product_draw.vertex_count = 384u;
  product_draw.first_vertex = 0u;
  product_draw.first_instance = 0u;
}

@compute @workgroup_size(64)
fn generate_virtual_geometry_work(@builtin(workgroup_id) group: vec3u,
  @builtin(local_invocation_index) lane: u32) {
  let visible_count = min(product_visible.header.written, product_visible.header.capacity);
  if (group.x >= visible_count || group.x >= product_settings.visible_capacity) { return; }
  if (lane == 0u) {
    product_group_valid = 0u;
    let visible = product_visible.elements[group.x];
    let asset = oengine_geometry_product_resolve_asset_v1(
      &product_heap, visible.geometry_record_index, product_settings.product_generation);
    let group = oengine_virtual_group_v1(&product_heap, asset, visible.cluster_record_index);
    let location = oengine_geometry_product_lookup_page_heap_v1(
      &product_heap, asset, group.page_id);
    if (group.valid && location.valid && location.bank_index < 4u) {
      let header_at = (location.byte_offset + group.offset_in_page) >> 2u;
      let counts = product_bank_word(location.bank_index, header_at + 11u);
      let meshlets = counts & 0xffffu;
      let meshlet_offset = product_bank_word(location.bank_index, header_at + 12u);
      let payload = product_bank_word(location.bank_index, header_at + 15u);
      if (meshlets > 0u && meshlets <= 128u && meshlet_offset >= 64u &&
          meshlet_offset <= payload && meshlets <= (payload - meshlet_offset) / 48u) {
        product_group_id = visible.cluster_record_index;
        product_group_page_bank = location.bank_index;
        product_group_page_byte = location.byte_offset + group.offset_in_page;
        product_group_meshlet_offset = meshlet_offset;
        product_group_payload = payload;
        product_group_count = meshlets;
        product_group_base = product_reserve(meshlets);
        product_group_valid = select(0u, 1u, product_group_base != 0xffffffffu);
      }
    }
    if (product_group_valid == 0u) {
      atomicAdd(&product_work.header.invalid_count, 1u);
    }
  }
  workgroupBarrier();
  if (product_group_valid == 0u || lane >= product_group_count) { return; }
  let visible = product_visible.elements[group.x];
  let counts = product_meshlet_counts(product_group_page_bank, product_group_page_byte,
    product_group_meshlet_offset, lane);
  let triangle_count = counts.y;
  if (triangle_count == 0u || triangle_count > 128u) {
    if (lane == 0u) { atomicAdd(&product_work.header.invalid_count, 1u); }
    return;
  }
  let encoded_group_meshlet = (product_group_id << 7u) | lane;
  let packed = ${GPU_MESHLET_DECODE_PROFILE.VirtualGeometryProductV1}u |
    (0u << 8u) | (0u << 16u);
  product_work.elements[product_group_base + lane] = OEngineMeshletRasterWork(
    visible.instance_record_index, visible.geometry_record_index,
    encoded_group_meshlet, visible.material_handle, visible.raster_flags, packed);
}

@compute @workgroup_size(1)
fn finalize_virtual_geometry_work() {
  let invalid = atomicLoad(&product_work.header.invalid_count);
  let overflow = atomicLoad(&product_work.header.overflow_count);
  let written = min(atomicLoad(&product_work.header.written_count), product_work.header.capacity);
  if (invalid != 0u || overflow != 0u) { atomicStore(&product_draw.instance_count, 0u); }
  else { atomicStore(&product_draw.instance_count, written); }
  if (product_settings.counters_enabled != 0u) {
    atomicAdd(&product_counters[${COUNTER_MESHLET_WORKS}u], written);
    atomicAdd(&product_counters[${COUNTER_QUEUE_BYTES}u], written * 24u);
    atomicAdd(&product_counters[${COUNTER_INVALID}u], invalid);
    atomicAdd(&product_counters[${COUNTER_OVERFLOW}u], overflow);
  }
}
`;

export const VIRTUAL_GEOMETRY_MESHLET_WORK_VISIBLE_RECORD_STRIDE =
  GPU_VISIBLE_CLUSTER_RECORD_SCHEMA.stride;

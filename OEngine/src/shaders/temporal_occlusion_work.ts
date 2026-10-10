import {
  GPU_MESHLET_RASTER_WORK_WGSL,
  GPU_MESHLET_RASTER_FLAGS as F,
} from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { PACKED_CAMERA_TYPE } from "./packed_camera.js";
import { VIRTUAL_GEOMETRY_PRODUCT_WGSL } from "./virtual_geometry_product.js";
import { HZB_FOOTPRINT_WGSL } from "./hzb_footprint.js";

/** Prediction is never a final rejection. One source/current-cut namespace is
 * retained through both raster phases; only deferred source indices are queued. */
export const TEMPORAL_OCCLUSION_WORK_WGSL = /* wgsl */ `
${GPU_INSTANCE_RECORD_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${PACKED_CAMERA_TYPE.wgsl_declaration}
${VIRTUAL_GEOMETRY_PRODUCT_WGSL}
${HZB_FOOTPRINT_WGSL}
struct OcclusionControl {
  deferred: atomic<u32>, early: atomic<u32>, recovered: atomic<u32>, rejected: atomic<u32>,
  dispatch: vec3u, generation: u32, indices: array<u32>,
}
struct OcclusionSettings { capacity: u32, max_dimension: u32, prediction_valid: u32, reserved: u32, previous_clip: mat4x4f, }
@group(0) @binding(0) var<storage, read_write> work: OEngineMeshletWorkQueue;
@group(0) @binding(1) var<storage, read> instances: array<OEngineInstanceRecord>;
@group(0) @binding(2) var<storage, read> product_heap: array<u32>;
${Array.from({ length: 4 }, (_, i) => `@group(0) @binding(${3 + i}) var<storage, read> product_bank_${i}: array<u32>;`).join("\n")}
@group(0) @binding(7) var<storage, read_write> occlusion: OcclusionControl;
@group(0) @binding(8) var<uniform> settings: OcclusionSettings;
@group(0) @binding(9) var<uniform> camera: CommandEncoder;
@group(0) @binding(10) var hzb: texture_2d<f32>;
@group(1) @binding(0) var<storage, read_write> initial_dispatch: array<vec4u>;

fn group_header(bank: u32, location: OEngineGeometryPageLookupV1, group: OEngineVirtualGroupV1) -> OEngineVirtualGroupHeaderV1 {
${Array.from({ length: 4 }, (_, i) => `  if bank == ${i}u { return oengine_virtual_group_header_v1(&product_bank_${i}, location, group); }`).join("\n")}
  return oengine_virtual_group_header_v1(&product_bank_0, location, group);
}
fn meshlet_header(bank: u32, location: OEngineGeometryPageLookupV1, group: OEngineVirtualGroupV1, header: OEngineVirtualGroupHeaderV1, local: u32) -> OEngineVirtualMeshletHeaderV1 {
${Array.from({ length: 4 }, (_, i) => `  if bank == ${i}u { return oengine_virtual_meshlet_header_v1(&product_bank_${i}, location, group, header, local); }`).join("\n")}
  return oengine_virtual_meshlet_header_v1(&product_bank_0, location, group, header, local);
}
fn meshlet_occluded(record: OEngineMeshletRasterWork, previous: bool) -> bool {
  if record.instance_slot >= arrayLength(&instances) { return false; }
  let instance = instances[record.instance_slot];
  if previous && (!oengine_instance_motion_valid(instance) || settings.prediction_valid == 0u) { return false; }
  let asset = oengine_geometry_product_resolve_asset_v1(&product_heap, record.geometry_slot, oengine_instance_geometry_generation(instance));
  let group = oengine_virtual_group_v1(&product_heap, asset, record.meshlet_slot >> 7u);
  let location = oengine_geometry_product_lookup_page_heap_v1(&product_heap, asset, group.page_id);
  if !asset.valid || !group.valid || !location.valid || location.bank_index >= 4u { return false; }
  let header = group_header(location.bank_index, location, group);
  let meshlet = meshlet_header(location.bank_index, location, group, header, record.meshlet_slot & 127u);
  if !header.valid || !meshlet.valid { return false; }
  let transform = oengine_instance_current_object_to_world(instance);
  var uv_min = vec2f(1.0); var uv_max = vec2f(0.0); var nearest = 0.0;
  for (var corner = 0u; corner < 8u; corner++) {
    let local = vec3f(select(meshlet.bounds_min.x, meshlet.bounds_max.x, (corner & 1u) != 0u),
      select(meshlet.bounds_min.y, meshlet.bounds_max.y, (corner & 2u) != 0u),
      select(meshlet.bounds_min.z, meshlet.bounds_max.z, (corner & 4u) != 0u));
    var world = transform * vec4f(local, 1.0);
    var clip = camera.view_projection_matrix * world;
    if previous { world = oengine_instance_previous_from_current(instance) * world; clip = settings.previous_clip * world; }
    if any(clip != clip) || any(abs(clip) > vec4f(3.4e38)) || clip.w <= 1e-6 { return false; }
    let ndc = clip.xyz / clip.w;
    if any(ndc != ndc) || any(abs(ndc) > vec3f(3.4e38)) { return false; }
    let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    uv_min = min(uv_min, uv); uv_max = max(uv_max, uv); nearest = max(nearest, clamp(ndc.z, 0.0, 1.0));
  }
  // Raster coverage/FP boundaries must expand the query, never shrink it.
  // The production HZB begins at half resolution; guard one source pixel.
  let guard = vec2f(0.5) / vec2f(textureDimensions(hzb, 0));
  uv_min -= guard; uv_max += guard;
  if any(uv_max <= vec2f(0.0)) || any(uv_min >= vec2f(1.0)) { return false; }
  return nearest + 1e-6 < hzb_footprint_min_depth(hzb, clamp(uv_min, vec2f(0.0), vec2f(1.0)), clamp(uv_max, vec2f(0.0), vec2f(1.0)));
}
fn source_count() -> u32 { return min(atomicLoad(&work.header.written_count), min(work.header.capacity, settings.capacity)); }
@compute @workgroup_size(1)
fn begin_prediction() {
  atomicStore(&occlusion.deferred, 0u); atomicStore(&occlusion.early, 0u);
  atomicStore(&occlusion.recovered, 0u); atomicStore(&occlusion.rejected, 0u);
  occlusion.generation = atomicLoad(&work.header.generation);
  occlusion.dispatch = vec3u(0u, 1u, 1u);
  let groups = (source_count() + 63u) / 64u;
  initial_dispatch[0] = vec4u(min(groups, settings.max_dimension), max(1u, (groups + settings.max_dimension - 1u) / settings.max_dimension), 1u, 0u);
}
@compute @workgroup_size(64)
fn predict(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let slot = (group.y * settings.max_dimension + group.x) * 64u + lane;
  if slot >= source_count() { return; }
  var record = work.elements[slot];
  record.packed_raster_flags &= ~(${F.OcclusionDeferred}u | ${F.OcclusionRecovered}u);
  let valid = atomicLoad(&work.header.invalid_count) == 0u && atomicLoad(&work.header.overflow_count) == 0u;
  if valid && meshlet_occluded(record, true) {
    let index = atomicAdd(&occlusion.deferred, 1u);
    // One unique input slot per lane, count <= source capacity: cannot overflow.
    occlusion.indices[index] = slot;
    record.packed_raster_flags |= ${F.OcclusionDeferred}u;
  } else { atomicAdd(&occlusion.early, 1u); }
  work.elements[slot] = record;
}
@compute @workgroup_size(1)
fn begin_recovery() {
  let groups = (atomicLoad(&occlusion.deferred) + 63u) / 64u;
  occlusion.dispatch = vec3u(min(groups, settings.max_dimension), max(1u, (groups + settings.max_dimension - 1u) / settings.max_dimension), 1u);
  initial_dispatch[1] = vec4u(occlusion.dispatch, 0u);
}
@compute @workgroup_size(64)
fn recover(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let index = (group.y * settings.max_dimension + group.x) * 64u + lane;
  if index >= atomicLoad(&occlusion.deferred) { return; }
  let slot = occlusion.indices[index];
  var record = work.elements[slot];
  if meshlet_occluded(record, false) { atomicAdd(&occlusion.rejected, 1u); }
  else {
    record.packed_raster_flags = (record.packed_raster_flags & ~${F.OcclusionDeferred}u) | ${F.OcclusionRecovered}u;
    atomicAdd(&occlusion.recovered, 1u);
    work.elements[slot] = record;
  }
}
`;

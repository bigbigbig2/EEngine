import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_SHADING_MATERIAL_WGSL } from "../gpu/GpuShadingMaterialAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { SHADING_WORK_THREADS, SHADING_WORK_WGSL } from "../render/surface/ShadingWorkAbi.js";

/** Visibility creates one work item per covered sample. No CPU-visible list is built. */
export const SHADING_WORK_CLASSIFY_WGSL = /* wgsl */ `
${SHADING_WORK_WGSL}
${GPU_VISIBILITY_KEY_WGSL}
struct ShadingWorkView { width: u32, height: u32, capacity: u32, max_dispatch_x: u32, };
@group(0) @binding(0) var key_texture: texture_2d<u32>;
@group(0) @binding(1) var<storage, read_write> work: ShadingWorkQueue;
@group(0) @binding(2) var<uniform> view: ShadingWorkView;
@compute @workgroup_size(1)
fn initialize() {
  atomicStore(&work.header.attempted, 0u);
  atomicStore(&work.header.written, 0u);
  atomicStore(&work.header.overflow, 0u);
  work.header.capacity = view.capacity;
  work.header.dispatch_x = 0u;
}
@compute @workgroup_size(8, 8)
fn classify(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= view.width || id.y >= view.height { return; }
  let key = textureLoad(key_texture, vec2i(id.xy), 0).x;
  if !oengine_visibility_key_is_valid(key) { return; }
  let slot = atomicAdd(&work.header.attempted, 1u);
  if slot >= view.capacity {
    atomicAdd(&work.header.overflow, 1u);
    return;
  }
  work.records[slot] = ShadingWorkRecord(id.y * view.width + id.x, key);
  atomicAdd(&work.header.written, 1u);
}
`;

export const SHADING_WORK_FINALIZE_WGSL = /* wgsl */ `
${SHADING_WORK_WGSL}
struct ShadingWorkView { width: u32, height: u32, capacity: u32, max_dispatch_x: u32, };
@group(0) @binding(0) var<storage, read_write> work: ShadingWorkQueue;
@group(0) @binding(1) var<storage, read_write> indirect: array<u32, 3>;
@group(0) @binding(2) var<uniform> view: ShadingWorkView;
@compute @workgroup_size(1)
fn finalize() {
  let count = atomicLoad(&work.header.written);
  let groups = (count + ${SHADING_WORK_THREADS - 1}u) / ${SHADING_WORK_THREADS}u;
  let groups_y = max(1u, (groups + view.max_dispatch_x - 1u) / view.max_dispatch_x);
  let groups_x = (groups + groups_y - 1u) / groups_y;
  work.header.dispatch_x = groups_x;
  indirect[0] = groups_x;
  indirect[1] = groups_y;
  indirect[2] = 1u;
}
`;

/** Temporary publication diagnostic: reads actual GPU material records, not final Surface radiance. */
export const SHADING_WORK_MATERIAL_DIAGNOSTIC_WGSL = /* wgsl */ `
${SHADING_WORK_WGSL}
${GPU_VISIBILITY_KEY_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_SHADING_MATERIAL_WGSL}
struct ShadingWorkView { width: u32, height: u32, capacity: u32, max_dispatch_x: u32, };
@group(0) @binding(0) var<storage, read> work: ShadingWorkQueueRead;
@group(0) @binding(1) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(2) var<storage, read> materials: array<OEngineShadingMaterialRecord>;
@group(0) @binding(3) var output_color: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var<uniform> view: ShadingWorkView;
@compute @workgroup_size(${SHADING_WORK_THREADS})
fn consume(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let slot = (group.y * work.header.dispatch_x + group.x) * ${SHADING_WORK_THREADS}u + lane;
  if slot >= work.header.written { return; }
  let item = work.records[slot];
  let pixel = vec2i(i32(item.pixel % view.width), i32(item.pixel / view.width));
  let key = item.visibility_key;
  if !oengine_visibility_key_is_valid(key) {
    textureStore(output_color, pixel, vec4f(1.0, 0.0, 1.0, 1.0));
    return;
  }
  let work_slot = oengine_visibility_key_meshlet_work_slot(key);
  if work_slot >= meshlet_work.header.written_count || meshlet_work.header.generation == 0u {
    textureStore(output_color, pixel, vec4f(1.0, 0.0, 1.0, 1.0));
    return;
  }
  let material_slot = meshlet_work.elements[work_slot].material_slot_or_range;
  if material_slot >= arrayLength(&materials) {
    textureStore(output_color, pixel, vec4f(1.0, 0.0, 1.0, 1.0));
    return;
  }
  let material = materials[material_slot];
  let base = material.payload.base_color_factor;
  textureStore(output_color, pixel, vec4f(base.rgb, 1.0));
}
`;

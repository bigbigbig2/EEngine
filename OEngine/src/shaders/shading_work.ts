import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_SHADING_MATERIAL_WGSL } from "../gpu/GpuShadingMaterialAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { SHADING_WORK_CLASS_COUNT, SHADING_WORK_THREADS, SHADING_WORK_WGSL } from "../render/surface/ShadingWorkAbi.js";
import { SHADING_FREQUENCY_ANCHOR_WGSL } from "./shading_frequency.js";

/** Visibility creates one work item per covered sample. No CPU-visible list is built. */
export function shadingWorkClassifyWgsl(adaptive: boolean): string { return /* wgsl */ `
${SHADING_WORK_WGSL}
${GPU_VISIBILITY_KEY_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_SHADING_MATERIAL_WGSL}
struct ShadingWorkView { width: u32, height: u32, capacity: u32, max_dispatch_x: u32, };
@group(0) @binding(0) var key_texture: texture_2d<u32>;
@group(0) @binding(1) var<storage, read_write> work: ShadingWorkQueue;
@group(0) @binding(2) var<uniform> view: ShadingWorkView;
@group(0) @binding(3) var<storage, read_write> classes: ShadingWorkClasses;
@group(0) @binding(4) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(5) var<storage, read> materials: array<OEngineShadingMaterialRecord>;
${adaptive ? "@group(0) @binding(6) var<storage, read> frequency_plan: array<u32>;" : ""}
${adaptive ? SHADING_FREQUENCY_ANCHOR_WGSL : ""}
@compute @workgroup_size(1)
fn initialize() {
  atomicStore(&work.header.attempted, 0u);
  atomicStore(&work.header.written, 0u);
  atomicStore(&work.header.overflow, 0u);
  work.header.capacity = view.capacity;
  work.header.dispatch_x = 0u;
  for (var index = 0u; index < ${SHADING_WORK_CLASS_COUNT}u; index++) {
    atomicStore(&classes.entries[index].count, 0u);
    classes.entries[index].start = 0u;
    atomicStore(&classes.entries[index].cursor, 0u);
    classes.entries[index].dispatch_x = 0u;
  }
}
@compute @workgroup_size(8, 8)
fn classify(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= view.width || id.y >= view.height { return; }
  let key = textureLoad(key_texture, vec2i(id.xy), 0).x;
  if !oengine_visibility_key_is_valid(key) { return; }
  ${adaptive ? "if any(oengine_shading_anchor(id.xy, view.width) != id.xy) { return; }" : ""}
  let work_slot = oengine_visibility_key_meshlet_work_slot(key);
  if meshlet_work.header.generation == 0u || work_slot >= meshlet_work.header.written_count {
    atomicAdd(&work.header.overflow, 1u);
    return;
  }
  let meshlet = meshlet_work.elements[work_slot];
  let material_slot = meshlet.material_slot_or_range;
  if material_slot >= arrayLength(&materials) {
    atomicAdd(&work.header.overflow, 1u);
    return;
  }
  let material = materials[material_slot];
  let class_id = material.texture_binding_set_id * 16u + material.program_id;
  if class_id >= ${SHADING_WORK_CLASS_COUNT}u ||
      class_id != ((meshlet.packed_raster_flags >> 8u) & 63u) {
    atomicAdd(&work.header.overflow, 1u);
    return;
  }
  atomicAdd(&classes.entries[class_id].count, 1u);
  atomicAdd(&work.header.attempted, 1u);
}
`; }
export const SHADING_WORK_CLASSIFY_WGSL = shadingWorkClassifyWgsl(false);

export const SHADING_WORK_FINALIZE_WGSL = /* wgsl */ `
${SHADING_WORK_WGSL}
struct ShadingWorkView { width: u32, height: u32, capacity: u32, max_dispatch_x: u32, };
@group(0) @binding(0) var<storage, read_write> work: ShadingWorkQueue;
@group(0) @binding(1) var<storage, read_write> indirect: ShadingWorkIndirectArgs;
@group(0) @binding(2) var<uniform> view: ShadingWorkView;
@group(0) @binding(3) var<storage, read_write> classes: ShadingWorkClasses;
@compute @workgroup_size(1)
fn finalize() {
  var count = 0u;
  for (var index = 0u; index < ${SHADING_WORK_CLASS_COUNT}u; index++) {
    let class_count = atomicLoad(&classes.entries[index].count);
    classes.entries[index].start = count;
    atomicStore(&classes.entries[index].cursor, 0u);
    let class_groups = (class_count + ${SHADING_WORK_THREADS - 1}u) / ${SHADING_WORK_THREADS}u;
    let class_y = max(1u, (class_groups + view.max_dispatch_x - 1u) / view.max_dispatch_x);
    let class_x = (class_groups + class_y - 1u) / class_y;
    classes.entries[index].dispatch_x = class_x;
    indirect.per_class[index] = vec4u(class_x, class_y, 1u, 0u);
    count += class_count;
  }
  atomicStore(&work.header.written, count);
  if count > view.capacity { atomicAdd(&work.header.overflow, count - view.capacity); }
  let groups = (count + ${SHADING_WORK_THREADS - 1}u) / ${SHADING_WORK_THREADS}u;
  let groups_y = max(1u, (groups + view.max_dispatch_x - 1u) / view.max_dispatch_x);
  let groups_x = (groups + groups_y - 1u) / groups_y;
  work.header.dispatch_x = groups_x;
  indirect.global = vec4u(groups_x, groups_y, 1u, 0u);
}
`;

/** Second visibility scan writes one tightly packed record per classified hit. */
export function shadingWorkScatterWgsl(adaptive: boolean): string { return /* wgsl */ `
${SHADING_WORK_WGSL}
${GPU_VISIBILITY_KEY_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_SHADING_MATERIAL_WGSL}
struct ShadingWorkView { width: u32, height: u32, capacity: u32, max_dispatch_x: u32, };
@group(0) @binding(0) var key_texture: texture_2d<u32>;
@group(0) @binding(1) var<storage, read_write> work: ShadingWorkQueue;
@group(0) @binding(2) var<uniform> view: ShadingWorkView;
@group(0) @binding(3) var<storage, read_write> classes: ShadingWorkClasses;
@group(0) @binding(4) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(5) var<storage, read> materials: array<OEngineShadingMaterialRecord>;
${adaptive ? "@group(0) @binding(6) var<storage, read> frequency_plan: array<u32>;" : ""}
${adaptive ? SHADING_FREQUENCY_ANCHOR_WGSL : ""}
@compute @workgroup_size(8, 8)
fn scatter(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= view.width || id.y >= view.height { return; }
  let key = textureLoad(key_texture, vec2i(id.xy), 0).x;
  if !oengine_visibility_key_is_valid(key) { return; }
  ${adaptive ? "if any(oengine_shading_anchor(id.xy, view.width) != id.xy) { return; }" : ""}
  let work_slot = oengine_visibility_key_meshlet_work_slot(key);
  if meshlet_work.header.generation == 0u || work_slot >= meshlet_work.header.written_count { return; }
  let meshlet = meshlet_work.elements[work_slot];
  if meshlet.material_slot_or_range >= arrayLength(&materials) { return; }
  let material = materials[meshlet.material_slot_or_range];
  let class_id = material.texture_binding_set_id * 16u + material.program_id;
  if class_id >= ${SHADING_WORK_CLASS_COUNT}u ||
      class_id != ((meshlet.packed_raster_flags >> 8u) & 63u) { return; }
  let local = atomicAdd(&classes.entries[class_id].cursor, 1u);
  if local >= atomicLoad(&classes.entries[class_id].count) {
    atomicAdd(&work.header.overflow, 1u); return;
  }
  let slot = classes.entries[class_id].start + local;
  if slot >= view.capacity {
    atomicAdd(&work.header.overflow, 1u); return;
  }
  work.records[slot] = ShadingWorkRecord(id.y * view.width + id.x, key);
}
`; }
export const SHADING_WORK_SCATTER_WGSL = shadingWorkScatterWgsl(false);

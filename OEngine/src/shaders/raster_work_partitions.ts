import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_SHADING_MATERIAL_WGSL } from "../gpu/GpuShadingMaterialAbi.js";
import { GPU_MESHLET_RECORD_WGSL } from "../gpu/GpuGeometryAbi.js";
import { GPU_INSTANCE_FLAGS } from "../gpu/GpuInstanceAbi.js";

export const RASTER_PARTITIONS_PER_PROGRAM = 8;
export const RASTER_PARTITION_SETTINGS_STRIDE = 256;
export const RASTER_PARTITION_STATE_STRIDE = 16;
export const RASTER_PARTITION_INDIRECT_STRIDE = 16;
export const RASTER_PARTITION_WORKGROUP_SIZE = 64;
export function rasterPartitionWgsl(caster: boolean): string { return /* wgsl */ `
${caster ? `struct CasterHeader { attempted:u32,written_count:u32,overflow:u32,generation:u32 }
struct CasterRecord { instance_slot:u32,geometry_slot:u32,meshlet_slot:u32,material_slot_or_range:u32,
  page_slot:u32,virtual_page:u32,packed_raster_flags:u32,packed_profile_lod:u32 }
struct OEngineMeshletWorkQueueRead { header:CasterHeader,elements:array<CasterRecord> }` : GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_SHADING_MATERIAL_WGSL}
${GPU_MESHLET_RECORD_WGSL}
@group(0) @binding(0) var<storage,read> work: OEngineMeshletWorkQueueRead;
@group(0) @binding(1) var<storage,read> materials: array<OEngineShadingMaterialRecord>;
@group(0) @binding(2) var<storage,read> coverage: array<vec4u>;
@group(0) @binding(3) var<storage,read_write> states: array<atomic<u32>>;
@group(0) @binding(4) var<storage,read_write> indices: array<u32>;
@group(0) @binding(5) var<storage,read_write> draws: array<vec4u>;
@group(0) @binding(6) var<uniform> settings: vec4u;
@group(0) @binding(7) var<storage,read> meshlets: array<GpuMeshletRecord>;
@group(1) @binding(0) var<storage,read_write> dispatch: array<u32>;
fn partition(slot: u32) -> u32 {
  let record=work.elements[slot];
  let material=materials[record.material_slot_or_range].payload;
  if (material.flags & OENGINE_MATERIAL_VISIBILITY_VALID)==0u || material.alpha_mode==OENGINE_MATERIAL_ALPHA_BLEND { return 0xffffffffu; }
  var program=0u;
  if material.alpha_mode==OENGINE_MATERIAL_ALPHA_MASK { program=coverage[record.material_slot_or_range].w; }
  var size=3u;
  if settings.w==0u {
    let count=meshlets[record.meshlet_slot].triangle_count;
    size=select(select(select(3u,2u,count<=96u),1u,count<=64u),0u,count<=32u);
  }
  let side=select(0u,1u,(record.packed_raster_flags & ${GPU_INSTANCE_FLAGS.DoubleSided}u)!=0u);
  return program*${RASTER_PARTITIONS_PER_PROGRAM}u+size*2u+side;
}
@compute @workgroup_size(64)
fn begin(@builtin(global_invocation_id) id: vec3u) {
  if id.x<settings.y { for(var lane=0u;lane<4u;lane++){ atomicStore(&states[id.x*4u+lane],0u); } }
  if id.x==0u {
    let groups=(work.header.written_count+63u)/64u;
    let x=min(groups,settings.z);
    dispatch[0]=x; dispatch[1]=select(0u,(groups+max(x,1u)-1u)/max(x,1u),groups!=0u); dispatch[2]=1u;
  }
}
@compute @workgroup_size(64)
fn count(@builtin(global_invocation_id) id: vec3u) {
  let slot=id.x+id.y*settings.z*64u;
  if slot>=work.header.written_count { return; }
  let key=partition(slot);
  if key!=0xffffffffu { atomicAdd(&states[key*4u],1u); }
}
@compute @workgroup_size(1)
fn prefix() {
  var base=0u;
  for(var key=0u;key<settings.y;key++) {
    let count=atomicLoad(&states[key*4u]);
    atomicStore(&states[key*4u+1u],base);
    // Every valid source work has exactly one partition. Sum is bounded by
    // the admitted source capacity; the scatter cannot truncate geometry.
    draws[key]=vec4u(((key%${RASTER_PARTITIONS_PER_PROGRAM}u)/2u+1u)*96u,count,0u,0u);
    base+=count;
  }
}
@compute @workgroup_size(64)
fn scatter(@builtin(global_invocation_id) id: vec3u) {
  let slot=id.x+id.y*settings.z*64u;
  if slot>=work.header.written_count { return; }
  let key=partition(slot);
  if key==0xffffffffu { return; }
  let at=atomicLoad(&states[key*4u+1u])+atomicAdd(&states[key*4u+2u],1u);
  indices[at]=slot;
}
`;
}
export const RASTER_PARTITION_WGSL = rasterPartitionWgsl(false);

/** Preserve authoritative source-work slots and frame-geometry directories.
 * Only the draw's instance-index indirection is partitioned. */
export const RASTER_PARTITION_CONSUMER_WGSL = /* wgsl */ `
@group(0) @binding(26) var<storage,read> raster_work_indices: array<u32>;
@group(0) @binding(27) var<storage,read> raster_work_partitions: array<vec4u>;
@group(0) @binding(28) var<uniform> raster_partition: vec4u;
fn raster_source_work(instance: u32) -> u32 {
  return raster_work_indices[raster_work_partitions[raster_partition.x].y+instance];
}
`;

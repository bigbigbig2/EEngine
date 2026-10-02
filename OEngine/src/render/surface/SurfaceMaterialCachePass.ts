import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { APPEARANCE_SURFACE_CACHE_KEY_WORDS, APPEARANCE_SURFACE_LAYER_COUNT, SURFACE_PUBLICATION_IDENTITY_UNCACHEABLE,
  SURFACE_SIGNAL_DIFFUSE, SURFACE_SIGNAL_SPECULAR, SURFACE_SIGNAL_COAT, SURFACE_SIGNAL_IBL,
  SURFACE_SAMPLE_FLAG_FULL_RATE } from "../../gpu/GpuAppearanceCacheAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../../gpu/GpuVisibilityKeyAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_SHADING_MATERIAL_WGSL } from "../../gpu/GpuShadingMaterialAbi.js";
import { SURFACE_WORK_INDIRECT_OFFSET } from "../../gpu/GpuSurfaceWorkAbi.js";
import type { GpuAppearancePublication } from "../../gpu/GpuAppearancePublication.js";

export interface SurfaceMaterialProducts { readonly fields: ResourceId; readonly missQueue: ResourceId; readonly orderedMissQueue: ResourceId; readonly hitMask: ResourceId; readonly counters: ResourceId; readonly audit: ResourceId; }

const CACHE_WGSL = /* wgsl */ `
${GPU_VISIBILITY_KEY_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_SHADING_MATERIAL_WGSL}
struct Settings { width:u32, height:u32, record_count:u32, cache_capacity:u32, frame:u32, sample_offset:u32, program_count:u32, diagnostics_enabled:u32, view_revision:u32, nonlocal_revision:u32, reserved0:u32, reserved1:u32 }
fn hash_word(value:u32, seed:u32)->u32 { var x=seed^value; x*=16777619u; x^=x>>13u; x*=2246822519u; return x; }
fn cache_hash(identity:u32, material:u32, field:u32, residency:u32, publication:u32, footprint:u32, view:u32, nonlocal:u32)->u32 { var x=identity; x=hash_word(material,x); x=hash_word(field,x); x=hash_word(residency,x); x=hash_word(publication,x); x=hash_word(footprint,x); x=hash_word(view,x); return hash_word(nonlocal,x); }
fn surface_geometry_identity(item:OEngineMeshletRasterWork, primitive:u32, material:u32)->u32 { var x=item.geometry_slot*16777619u^item.meshlet_slot*2246822519u^item.instance_slot*3266489917u^primitive*668265263u^material; x^=x>>16u; x*=0x7feb352du; return x^(x>>15u); }
fn diagnostic_add(index:u32, value:u32) { if settings.diagnostics_enabled != 0u { atomicAdd(&counters[index], value); } }
@group(0) @binding(0) var<uniform> settings:Settings;
@group(0) @binding(1) var visibility:texture_2d<u32>;
@group(0) @binding(2) var<storage,read_write> work:array<u32>;
@group(0) @binding(3) var<storage,read> meshlet_work:OEngineMeshletWorkQueueRead;
@group(0) @binding(4) var<storage,read> field_versions:array<u32>;
@group(0) @binding(5) var<storage,read> residency_versions:array<u32>;
@group(0) @binding(6) var<storage,read_write> cache:array<u32>;
@group(0) @binding(7) var<storage,read_write> cache_values:array<vec4f>;
@group(0) @binding(8) var<storage,read_write> misses:array<vec2u>;
@group(0) @binding(9) var<storage,read_write> counters:array<atomic<u32>>;
@group(0) @binding(10) var<storage,read_write> hit_mask:array<u32>;
@group(0) @binding(11) var fields:texture_storage_2d_array<rgba16float,write>;
@group(0) @binding(12) var<storage,read> surface_counts:array<u32>;
@group(0) @binding(13) var<storage,read> material_lookup:array<u32>;
@group(0) @binding(14) var<storage,read> surface_identity:array<vec4u>;
@group(0) @binding(15) var<storage,read> materials:array<OEngineShadingMaterialRecord>;
@compute @workgroup_size(64)
fn lookup(@builtin(global_invocation_id) id:vec3u) {
  let record=id.x; if record>=settings.record_count || record>=surface_counts[0u]{return;}
  let sample_at=settings.sample_offset/4u+record*8u; let identity=work[sample_at+1u];
  let decoded=oengine_visibility_key_resolve(identity,meshlet_work.header.generation,meshlet_work.header.written_count); let valid=decoded.valid!=0u;
  if !valid { hit_mask[record]=0u; diagnostic_add(3u,1u); return; }
  let meshlet=meshlet_work.elements[decoded.meshlet_work_slot]; let material=meshlet.material_slot_or_range;
  if material>=arrayLength(&material_lookup) { hit_mask[record]=0u; diagnostic_add(3u,1u); return; }
  let entry=material_lookup[material]; if entry==0xffffffffu || entry>=arrayLength(&surface_identity) || material>=arrayLength(&materials) { hit_mask[record]=0u; diagnostic_add(3u,1u); return; }
  let stable=surface_identity[entry]; let material_record=materials[material]; let geometryIdentity=surface_geometry_identity(meshlet,decoded.local_primitive,material); let pixel_word=work[sample_at]; let winner_identity=work[sample_at+2u]; let footprint=hash_word(winner_identity,hash_word(pixel_word,2166136261u)); var field=2166136261u; for(var field_at=0u;field_at<arrayLength(&field_versions);field_at+=4u){ field=(field^field_versions[field_at])*16777619u; } var residency=2166136261u; for(var residency_at=0u;residency_at<arrayLength(&residency_versions);residency_at++){ residency=(residency^residency_versions[residency_at])*16777619u; }
  let key=cache_hash(geometryIdentity,material,field,residency,stable.x^stable.y^stable.z^stable.w,footprint,settings.view_revision,settings.nonlocal_revision); let cell=key&(settings.cache_capacity-1u); let cache_at=cell*${APPEARANCE_SURFACE_CACHE_KEY_WORDS}u;
  let cacheable=(stable.w & ${SURFACE_PUBLICATION_IDENTITY_UNCACHEABLE}u)==0u; let exact=cacheable && cache[cache_at+0u]==key && cache[cache_at+1u]==geometryIdentity && cache[cache_at+2u]==material && cache[cache_at+3u]==stable.x && cache[cache_at+4u]==stable.y && cache[cache_at+5u]==stable.z && cache[cache_at+6u]==stable.w && cache[cache_at+7u]==field && cache[cache_at+8u]==residency && cache[cache_at+9u]==meshlet.geometry_slot && cache[cache_at+10u]==meshlet.meshlet_slot && cache[cache_at+11u]==meshlet.instance_slot && cache[cache_at+12u]==decoded.local_primitive && cache[cache_at+13u]==footprint && cache[cache_at+14u]==settings.view_revision && cache[cache_at+15u]==settings.nonlocal_revision; let pixel=vec2i(pixel_word%settings.width,pixel_word/settings.width);
  var signal_mask=${SURFACE_SIGNAL_DIFFUSE}u; if material_record.family != 0u { signal_mask=signal_mask|${SURFACE_SIGNAL_SPECULAR}u|${SURFACE_SIGNAL_IBL}u; } if material_record.family == 2u || (material_record.feature_mask & ((1u<<7u)|(1u<<8u)|(1u<<9u))) != 0u { signal_mask=signal_mask|${SURFACE_SIGNAL_COAT}u; }
  var sample_flags=1u; if (material_record.feature_mask & ((1u<<1u)|(1u<<2u)|(1u<<5u)|(1u<<6u))) != 0u || (stable.w & ${SURFACE_PUBLICATION_IDENTITY_UNCACHEABLE}u) != 0u { sample_flags=sample_flags|${SURFACE_SAMPLE_FLAG_FULL_RATE}u; } work[sample_at+3u]=signal_mask; work[sample_at+7u]=sample_flags;
  if exact { hit_mask[record]=1u; diagnostic_add(0u,1u); for(var layer=0u;layer<${APPEARANCE_SURFACE_LAYER_COUNT}u;layer++){textureStore(fields,pixel,i32(layer),cache_values[cell*${APPEARANCE_SURFACE_LAYER_COUNT}u+layer]);} }
  else {
    hit_mask[record]=0u;
    let program=stable.w & 0x7fffffffu;
    if program>=settings.program_count { diagnostic_add(3u,1u); return; }
    diagnostic_add(1u,1u);
    let slot=atomicAdd(&counters[2],1u);
    if slot<settings.record_count {
      misses[slot]=vec2u(record,program);
      atomicAdd(&counters[4u+program*8u+4u],1u);
    }
  }
}
`;

const FINALIZE_WGSL = /* wgsl */ `
struct Settings { program_count:u32, record_count:u32, reserved0:u32, reserved1:u32 }
@group(0) @binding(0) var<uniform> settings:Settings;
@group(0) @binding(1) var<storage,read_write> counters:array<atomic<u32>>;
@group(0) @binding(2) var<storage,read_write> compact_indirect:array<atomic<u32>>;
@compute @workgroup_size(1)
fn finalize(){
  var prefix=0u;
  for(var program=0u;program<settings.program_count;program++){
    let count=min(atomicLoad(&counters[4u+program*8u+4u]),settings.record_count);
    let at=4u+program*8u;
    atomicStore(&counters[at],(count+63u)/64u); atomicStore(&counters[at+1u],1u); atomicStore(&counters[at+2u],1u); atomicStore(&counters[at+3u],count);
    atomicStore(&counters[at+5u],prefix); atomicStore(&counters[at+6u],0u); atomicStore(&counters[at+7u],(count+63u)/64u);
    prefix+=count;
  }
  let queued=min(atomicLoad(&counters[2u]),settings.record_count);
  atomicStore(&compact_indirect[0],(queued+63u)/64u); atomicStore(&compact_indirect[1],1u); atomicStore(&compact_indirect[2],1u); atomicStore(&compact_indirect[3],queued);
}
`;

const COMPACT_WGSL = /* wgsl */ `
struct Settings { program_count:u32, record_count:u32, reserved0:u32, reserved1:u32 }
@group(0) @binding(0) var<uniform> settings:Settings;
@group(0) @binding(1) var<storage,read> source:array<vec2u>;
@group(0) @binding(2) var<storage,read_write> counters:array<atomic<u32>>;
@group(0) @binding(3) var<storage,read_write> ordered:array<vec2u>;
@compute @workgroup_size(64)
fn compact(@builtin(global_invocation_id) id:vec3u){
  let slot=id.x; let queued=min(atomicLoad(&counters[2u]),settings.record_count);
  if slot>=queued{return;}
  let pair=source[slot]; let program=pair.y;
  if program>=settings.program_count{return;}
  let at=4u+program*8u; let dst=atomicAdd(&counters[at+6u],1u); let count=atomicLoad(&counters[at+4u]);
  if dst<count { ordered[atomicLoad(&counters[at+5u])+dst]=pair; }
}
`;

export class SurfaceMaterialCachePass {
  private readonly lookupLayout:GPUBindGroupLayout; private readonly lookupPipeline:GPUComputePipeline; private readonly finalizeLayout:GPUBindGroupLayout; private readonly finalizePipeline:GPUComputePipeline; private readonly compactLayout:GPUBindGroupLayout; private readonly compactPipeline:GPUComputePipeline; private readonly settings:GPUBuffer; private readonly finalizeSettings:GPUBuffer; private readonly cache:GPUBuffer; private readonly cacheValues:GPUBuffer; private readonly cacheCapacity:number;
  constructor(private readonly device:GPUDevice,cacheCapacity=1<<16){
    if((cacheCapacity&(cacheCapacity-1))!==0)throw new RangeError("Surface material cache capacity must be a power of two");
    const keyBytes=cacheCapacity*APPEARANCE_SURFACE_CACHE_KEY_WORDS*4, valueBytes=cacheCapacity*APPEARANCE_SURFACE_LAYER_COUNT*16;
    if(keyBytes>Number(device.limits.maxStorageBufferBindingSize)||valueBytes>Number(device.limits.maxStorageBufferBindingSize)||keyBytes>Number(device.limits.maxBufferSize)||valueBytes>Number(device.limits.maxBufferSize))throw new RangeError("Surface material cache exceeds negotiated storage limits");
    this.cacheCapacity=cacheCapacity;
    this.settings=device.createBuffer({label:"Surface material lookup settings",size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}); this.finalizeSettings=device.createBuffer({label:"Surface material miss finalize settings",size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}); this.cache=device.createBuffer({label:"Surface material stable cache keys",size:cacheCapacity*APPEARANCE_SURFACE_CACHE_KEY_WORDS*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}); this.cacheValues=device.createBuffer({label:"Surface material stable cache values",size:cacheCapacity*APPEARANCE_SURFACE_LAYER_COUNT*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
    this.lookupLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:"uniform",minBindingSize:48}},{binding:1,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:"uint",viewDimension:"2d"}},...[2,3,4,5,6,7,8,9,10,12,13,14,15].map(binding=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:(binding===4||binding===5||binding===12||binding===13||binding===14||binding===15?"read-only-storage":"storage") as GPUBufferBindingType}})),{binding:11,visibility:GPUShaderStage.COMPUTE,storageTexture:{access:"write-only",format:"rgba16float",viewDimension:"2d-array"}}]});
    this.lookupPipeline=device.createComputePipeline({label:"Surface/material publication lookup",layout:device.createPipelineLayout({bindGroupLayouts:[this.lookupLayout]}),compute:{module:device.createShaderModule({code:CACHE_WGSL}),entryPoint:"lookup"}});
    this.finalizeLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:"uniform",minBindingSize:16}},{binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:"storage"}},{binding:2,visibility:GPUShaderStage.COMPUTE,buffer:{type:"storage"}}]}); this.finalizePipeline=device.createComputePipeline({label:"Surface/material miss indirect finalize",layout:device.createPipelineLayout({bindGroupLayouts:[this.finalizeLayout]}),compute:{module:device.createShaderModule({code:FINALIZE_WGSL}),entryPoint:"finalize"}});
    this.compactLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:"uniform",minBindingSize:16}},{binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:"read-only-storage"}},{binding:2,visibility:GPUShaderStage.COMPUTE,buffer:{type:"storage"}},{binding:3,visibility:GPUShaderStage.COMPUTE,buffer:{type:"storage"}}]}); this.compactPipeline=device.createComputePipeline({label:"Surface/material miss queue compact",layout:device.createPipelineLayout({bindGroupLayouts:[this.compactLayout]}),compute:{module:device.createShaderModule({code:COMPACT_WGSL}),entryPoint:"compact"}});
  }
  addLookupToGraph(graph:FrameGraph,input:{visibility:ResourceId;work:ResourceId;meshletWork:ResourceId;fieldVersions:ResourceId;residencyVersions:ResourceId;counts:ResourceId;materialLookup:ResourceId;surfaceIdentity:ResourceId;materials:ResourceId;programCount:number;width:number;height:number;recordCount:number;sampleOffset:number;frame:number;diagnosticsEnabled:boolean;viewRevision:Readonly<{value:number}>;nonlocalRevision:Readonly<{value:number}>}):SurfaceMaterialProducts{
    let fields!:ResourceId,missQueue!:ResourceId,orderedMissQueue!:ResourceId,hitMask!:ResourceId,counters!:ResourceId,audit!:ResourceId,finalizedCounters!:ResourceId,compactedCounters!:ResourceId,compactIndirect!:ResourceId;
     const node=graph.add("Surface/Material publication lookup before geometry",input,(data,resources,context)=>{const command=context.encoder as ShadeGPUCommandContext; const settings=new Uint32Array([data.width,data.height,data.recordCount,this.cacheCapacity,data.frame,data.sampleOffset,data.programCount,data.diagnosticsEnabled ? 1 : 0,data.viewRevision.value >>> 0,data.nonlocalRevision.value >>> 0,0,0]); command.writeBuffer(this.settings,0,settings.buffer,0,settings.byteLength); command.writeBuffer(resources.get(counters) as GPUBuffer,0,new Uint32Array(4+data.programCount*8).buffer,0,(4+data.programCount*8)*4); command.writeBuffer(resources.get(audit) as GPUBuffer,0,new Uint32Array(4).buffer,0,16); const group=this.device.createBindGroup({layout:this.lookupLayout,entries:[{binding:0,resource:{buffer:this.settings}},{binding:1,resource:resolveTextureView(resources.get(data.visibility))},{binding:2,resource:{buffer:resources.get(data.work) as GPUBuffer}},{binding:3,resource:{buffer:resources.get(data.meshletWork) as GPUBuffer}},{binding:4,resource:{buffer:resources.get(data.fieldVersions) as GPUBuffer}},{binding:5,resource:{buffer:resources.get(data.residencyVersions) as GPUBuffer}},{binding:6,resource:{buffer:this.cache}},{binding:7,resource:{buffer:this.cacheValues}},{binding:8,resource:{buffer:resources.get(missQueue) as GPUBuffer}},{binding:9,resource:{buffer:resources.get(counters) as GPUBuffer}},{binding:10,resource:{buffer:resources.get(hitMask) as GPUBuffer}},{binding:11,resource:resolveTextureView(resources.get(fields))},{binding:12,resource:{buffer:resources.get(data.counts) as GPUBuffer}},{binding:13,resource:{buffer:resources.get(data.materialLookup) as GPUBuffer}},{binding:14,resource:{buffer:resources.get(data.surfaceIdentity) as GPUBuffer}},{binding:15,resource:{buffer:resources.get(data.materials) as GPUBuffer}}]}); const pass=command.beginComputePass({label:"Surface/material publication lookup"}); pass.setPipeline(this.lookupPipeline); pass.setBindGroup(0,group); pass.dispatchWorkgroupsIndirect(resources.get(data.counts) as GPUBuffer,SURFACE_WORK_INDIRECT_OFFSET); pass.end(); });
    for(const id of [input.visibility,input.work,input.meshletWork,input.fieldVersions,input.residencyVersions,input.counts,input.materialLookup,input.surfaceIdentity,input.materials])node.read(id); fields=node.create("Surface/material fields",{kind:"transient_texture",width:input.width,height:input.height,depthOrArrayLayers:APPEARANCE_SURFACE_LAYER_COUNT,format:"rgba16float",usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING,domain:"internal-full"}); missQueue=node.create("Surface/material bounded miss queue",{kind:"transient_buffer",size:Math.max(8,input.recordCount*8),usage:GPUBufferUsage.STORAGE,domain:"internal-full"}); hitMask=node.create("Surface/material hit mask",{kind:"transient_buffer",size:Math.max(4,input.recordCount*4),usage:GPUBufferUsage.STORAGE,domain:"internal-full"}); counters=node.create("Surface/material counters and indirect",{kind:"transient_buffer",size:(4+input.programCount*8)*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.INDIRECT|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST,domain:"internal-full"}); audit=node.create("Surface/material evaluator audit",{kind:"transient_buffer",size:16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST,domain:"internal-full"});
    const finalize=graph.add("Surface/Material miss indirect finalize",{counters,programCount:input.programCount,recordCount:input.recordCount},(data,resources,context)=>{const command=context.encoder as ShadeGPUCommandContext; command.writeBuffer(this.finalizeSettings,0,new Uint32Array([data.programCount,data.recordCount,0,0]).buffer,0,16); const group=this.device.createBindGroup({layout:this.finalizeLayout,entries:[{binding:0,resource:{buffer:this.finalizeSettings}},{binding:1,resource:{buffer:resources.get(data.counters) as GPUBuffer}},{binding:2,resource:{buffer:resources.get(compactIndirect) as GPUBuffer}}]}); const pass=command.beginComputePass({label:"Surface/material miss indirect finalize"}); pass.setPipeline(this.finalizePipeline); pass.setBindGroup(0,group); pass.dispatchWorkgroups(1); pass.end();}); finalize.read(counters); finalizedCounters=finalize.write(counters); compactIndirect=finalize.create("Surface/material compact indirect",{kind:"transient_buffer",size:16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.INDIRECT|GPUBufferUsage.COPY_DST,domain:"internal-full"});
    const compact=graph.add("Surface/Material miss queue compact",{counters:finalizedCounters,missQueue,compactIndirect,recordCount:input.recordCount},(data,resources,context)=>{const command=context.encoder as ShadeGPUCommandContext; const group=this.device.createBindGroup({layout:this.compactLayout,entries:[{binding:0,resource:{buffer:this.finalizeSettings}},{binding:1,resource:{buffer:resources.get(data.missQueue) as GPUBuffer}},{binding:2,resource:{buffer:resources.get(data.counters) as GPUBuffer}},{binding:3,resource:{buffer:resources.get(orderedMissQueue) as GPUBuffer}}]}); const pass=command.beginComputePass({label:"Surface/material miss queue compact"}); pass.setPipeline(this.compactPipeline); pass.setBindGroup(0,group); pass.dispatchWorkgroupsIndirect(resources.get(data.compactIndirect) as GPUBuffer,0); pass.end();}); compact.dependsOn(finalize); compact.read(missQueue); compact.read(finalizedCounters); compact.read(compactIndirect); orderedMissQueue=compact.create("Surface/material ordered miss queue",{kind:"transient_buffer",size:Math.max(8,input.recordCount*8),usage:GPUBufferUsage.STORAGE,domain:"internal-full"}); compactedCounters=compact.write(finalizedCounters);
    return {fields,missQueue,orderedMissQueue,hitMask,counters:compactedCounters,audit};
  }
    addEvaluateToGraph(graph:FrameGraph,input:SurfaceMaterialProducts&{geometry:ResourceId;geometryOffset:number;work:ResourceId;sampleOffset:number;fieldVersions:ResourceId;residencyVersions:ResourceId;counts:ResourceId;publication:GpuAppearancePublication;textureBanks:readonly (readonly ResourceId[])[];width:number;height:number;recordCount:number;frame:number;diagnosticsEnabled:boolean;viewRevision:Readonly<{value:number}>;nonlocalRevision:Readonly<{value:number}>}):SurfaceMaterialProducts{
      const node=graph.add("Surface/Material miss publication evaluation",input,(data,resources,context)=>{const command=context.encoder as ShadeGPUCommandContext; const textureBanks=data.textureBanks.map(set=>set.map(id=>resources.get(id) as GPUTextureView)); data.publication.encodeSurfaceMissEvaluation(command,{geometry:resources.get(data.geometry) as GPUBuffer,work:resources.get(data.work) as GPUBuffer,misses:resources.get(data.orderedMissQueue) as GPUBuffer,hitMask:resources.get(data.hitMask) as GPUBuffer,counters:resources.get(data.counters) as GPUBuffer,fields:resolveTextureView(resources.get(data.fields)),cache:this.cache,cacheValues:this.cacheValues,audit:resources.get(data.audit) as GPUBuffer,diagnosticsEnabled:data.diagnosticsEnabled,viewRevision:data.viewRevision.value,nonlocalRevision:data.nonlocalRevision.value,indirect:resources.get(data.counters) as GPUBuffer,fieldVersions:resources.get(data.fieldVersions) as GPUBuffer,residencyVersions:resources.get(data.residencyVersions) as GPUBuffer,width:data.width,height:data.height,recordCount:data.recordCount,geometryOffset:data.geometryOffset,cacheCapacity:this.cacheCapacity,sampleOffset:data.sampleOffset,textureBanks});}); for(const id of [input.geometry,input.work,input.orderedMissQueue,input.hitMask,input.counters,input.fields,input.audit,input.fieldVersions,input.residencyVersions])node.read(id); const fields=node.write(input.fields); const audit=node.write(input.audit);
    return {...input,fields,audit};
  }
  destroy():void{this.settings.destroy();this.finalizeSettings.destroy();this.cache.destroy();this.cacheValues.destroy();}
}

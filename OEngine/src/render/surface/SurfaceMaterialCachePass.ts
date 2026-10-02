import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { APPEARANCE_SURFACE_LAYER_COUNT, SURFACE_PUBLICATION_IDENTITY_UNCACHEABLE } from "../../gpu/GpuAppearanceCacheAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../../gpu/GpuVisibilityKeyAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../../gpu/GpuMeshletRasterWorkAbi.js";
import { SURFACE_WORK_INDIRECT_OFFSET } from "../../gpu/GpuSurfaceWorkAbi.js";
import type { GpuAppearancePublication } from "../../gpu/GpuAppearancePublication.js";

export interface SurfaceMaterialProducts { readonly fields: ResourceId; readonly missQueue: ResourceId; readonly hitMask: ResourceId; readonly counters: ResourceId; }

const CACHE_WGSL = /* wgsl */ `
${GPU_VISIBILITY_KEY_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
struct Settings { width:u32, height:u32, record_count:u32, cache_capacity:u32, frame:u32, sample_offset:u32, program_count:u32, reserved:u32 }
fn cache_hash(identity:u32, material:u32, field:u32, residency:u32, publication:u32)->u32 { var x=identity^(material*16777619u)^(field*2246822519u)^(residency*3266489917u)^publication; x^=x>>16u; x*=0x7feb352du; x^=x>>15u; x*=0x846ca68bu; return x^(x>>16u); }
fn surface_geometry_identity(item:OEngineMeshletRasterWork, primitive:u32, material:u32)->u32 { var x=item.geometry_slot*16777619u^item.meshlet_slot*2246822519u^item.instance_slot*3266489917u^primitive*668265263u^material; x^=x>>16u; x*=0x7feb352du; return x^(x>>15u); }
@group(0) @binding(0) var<uniform> settings:Settings;
@group(0) @binding(1) var visibility:texture_2d<u32>;
@group(0) @binding(2) var<storage,read> work:array<u32>;
@group(0) @binding(3) var<storage,read> meshlet_work:OEngineMeshletWorkQueueRead;
@group(0) @binding(4) var<storage,read> field_versions:array<u32>;
@group(0) @binding(5) var<storage,read> residency_versions:array<u32>;
@group(0) @binding(6) var<storage,read_write> cache:array<vec4u>;
@group(0) @binding(7) var<storage,read_write> cache_values:array<vec4f>;
@group(0) @binding(8) var<storage,read_write> misses:array<u32>;
@group(0) @binding(9) var<storage,read_write> counters:array<atomic<u32>>;
@group(0) @binding(10) var<storage,read_write> hit_mask:array<u32>;
@group(0) @binding(11) var fields:texture_storage_2d_array<rgba16float,write>;
@group(0) @binding(12) var<storage,read> surface_counts:array<u32>;
@group(0) @binding(13) var<storage,read> material_lookup:array<u32>;
@group(0) @binding(14) var<storage,read> surface_identity:array<vec4u>;
@compute @workgroup_size(64)
fn lookup(@builtin(global_invocation_id) id:vec3u) {
  let record=id.x; if record>=settings.record_count || record>=surface_counts[0u]{return;}
  let sample_at=settings.sample_offset/4u+record*8u; let identity=work[sample_at+1u];
  if !oengine_visibility_key_is_valid(identity) { hit_mask[record]=0u; return; }
  let decoded=oengine_visibility_key_decode(identity); let valid=decoded.valid!=0u && decoded.meshlet_work_slot<meshlet_work.header.written_count;
  let meshlet=meshlet_work.elements[decoded.meshlet_work_slot]; let material=select(0u,meshlet.material_slot_or_range,valid);
  if !valid || material>=arrayLength(&material_lookup) { hit_mask[record]=0u; return; }
  let entry=material_lookup[material]; if entry==0xffffffffu { hit_mask[record]=0u; return; }
  let stable=surface_identity[entry]; let geometryIdentity=surface_geometry_identity(meshlet,decoded.local_primitive,material); let field=select(0u,field_versions[0u],arrayLength(&field_versions)>0u); let residency=select(0u,residency_versions[0u],arrayLength(&residency_versions)>0u);
  let key=cache_hash(geometryIdentity,material,field,residency,stable.x^stable.y^stable.z^stable.w); let cell=key&(settings.cache_capacity-1u); let old=cache[cell];
  let cacheable=(stable.w & ${SURFACE_PUBLICATION_IDENTITY_UNCACHEABLE}u)==0u; let exact=cacheable && old.x==key && old.y==geometryIdentity && old.z==material && old.w==stable.z; let pixel=vec2i(work[sample_at]%settings.width,work[sample_at]/settings.width);
  if exact { hit_mask[record]=1u; atomicAdd(&counters[0],1u); for(var layer=0u;layer<${APPEARANCE_SURFACE_LAYER_COUNT}u;layer++){textureStore(fields,pixel,i32(layer),cache_values[cell*${APPEARANCE_SURFACE_LAYER_COUNT}u+layer]);} }
  else { hit_mask[record]=0u; atomicAdd(&counters[1],1u); let slot=atomicAdd(&counters[2],1u); if slot<settings.record_count { misses[slot]=record; } let program=stable.w & 0x7fffffffu; if program<settings.program_count { atomicAdd(&counters[4u+program*8u+4u],1u); } }
}
`;

const FINALIZE_WGSL = /* wgsl */ `
struct Settings { program_count:u32, record_count:u32, reserved0:u32, reserved1:u32 }
@group(0) @binding(0) var<uniform> settings:Settings;
@group(0) @binding(1) var<storage,read_write> counters:array<atomic<u32>>;
@compute @workgroup_size(1)
fn finalize(){ for(var program=0u;program<settings.program_count;program++){ let count=min(atomicLoad(&counters[4u+program*8u+4u]),settings.record_count); let at=4u+program*8u; atomicStore(&counters[at],(count+63u)/64u); atomicStore(&counters[at+1u],1u); atomicStore(&counters[at+2u],1u); atomicStore(&counters[at+3u],count); } }
`;

export class SurfaceMaterialCachePass {
  private readonly lookupLayout:GPUBindGroupLayout; private readonly lookupPipeline:GPUComputePipeline; private readonly finalizeLayout:GPUBindGroupLayout; private readonly finalizePipeline:GPUComputePipeline; private readonly settings:GPUBuffer; private readonly finalizeSettings:GPUBuffer; private readonly cache:GPUBuffer; private readonly cacheValues:GPUBuffer; private readonly cacheCapacity:number;
  constructor(private readonly device:GPUDevice,cacheCapacity=1<<16){
    if((cacheCapacity&(cacheCapacity-1))!==0)throw new RangeError("Surface material cache capacity must be a power of two"); this.cacheCapacity=cacheCapacity;
    this.settings=device.createBuffer({label:"Surface material lookup settings",size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}); this.finalizeSettings=device.createBuffer({label:"Surface material miss finalize settings",size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}); this.cache=device.createBuffer({label:"Surface material stable cache keys",size:cacheCapacity*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}); this.cacheValues=device.createBuffer({label:"Surface material stable cache values",size:cacheCapacity*APPEARANCE_SURFACE_LAYER_COUNT*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
    this.lookupLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:"uniform",minBindingSize:32}},{binding:1,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:"uint",viewDimension:"2d"}},...[2,3,4,5,6,7,8,9,10,12,13,14].map(binding=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:(binding===4||binding===5||binding===12||binding===13||binding===14?"read-only-storage":"storage") as GPUBufferBindingType}})),{binding:11,visibility:GPUShaderStage.COMPUTE,storageTexture:{access:"write-only",format:"rgba16float",viewDimension:"2d-array"}}]});
    this.lookupPipeline=device.createComputePipeline({label:"Surface/material publication lookup",layout:device.createPipelineLayout({bindGroupLayouts:[this.lookupLayout]}),compute:{module:device.createShaderModule({code:CACHE_WGSL}),entryPoint:"lookup"}});
    this.finalizeLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:"uniform",minBindingSize:16}},{binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:"storage"}}]}); this.finalizePipeline=device.createComputePipeline({label:"Surface/material miss indirect finalize",layout:device.createPipelineLayout({bindGroupLayouts:[this.finalizeLayout]}),compute:{module:device.createShaderModule({code:FINALIZE_WGSL}),entryPoint:"finalize"}});
  }
  addLookupToGraph(graph:FrameGraph,input:{visibility:ResourceId;work:ResourceId;meshletWork:ResourceId;fieldVersions:ResourceId;residencyVersions:ResourceId;counts:ResourceId;materialLookup:ResourceId;surfaceIdentity:ResourceId;programCount:number;width:number;height:number;recordCount:number;sampleOffset:number;frame:number}):SurfaceMaterialProducts{
    let fields!:ResourceId,missQueue!:ResourceId,hitMask!:ResourceId,counters!:ResourceId; const node=graph.add("Surface/Material publication lookup before geometry",input,(data,resources,context)=>{const command=context.encoder as ShadeGPUCommandContext; const settings=new Uint32Array([data.width,data.height,data.recordCount,this.cacheCapacity,data.frame,data.sampleOffset,data.programCount,0]); command.writeBuffer(this.settings,0,settings.buffer,0,settings.byteLength); command.writeBuffer(resources.get(counters) as GPUBuffer,0,new Uint32Array(4+data.programCount*8).buffer,0,(4+data.programCount*8)*4); const group=this.device.createBindGroup({layout:this.lookupLayout,entries:[{binding:0,resource:{buffer:this.settings}},{binding:1,resource:resolveTextureView(resources.get(data.visibility))},{binding:2,resource:{buffer:resources.get(data.work) as GPUBuffer}},{binding:3,resource:{buffer:resources.get(data.meshletWork) as GPUBuffer}},{binding:4,resource:{buffer:resources.get(data.fieldVersions) as GPUBuffer}},{binding:5,resource:{buffer:resources.get(data.residencyVersions) as GPUBuffer}},{binding:6,resource:{buffer:this.cache}},{binding:7,resource:{buffer:this.cacheValues}},{binding:8,resource:{buffer:resources.get(missQueue) as GPUBuffer}},{binding:9,resource:{buffer:resources.get(counters) as GPUBuffer}},{binding:10,resource:{buffer:resources.get(hitMask) as GPUBuffer}},{binding:11,resource:resolveTextureView(resources.get(fields))},{binding:12,resource:{buffer:resources.get(data.counts) as GPUBuffer}},{binding:13,resource:{buffer:resources.get(data.materialLookup) as GPUBuffer}},{binding:14,resource:{buffer:resources.get(data.surfaceIdentity) as GPUBuffer}}]}); const pass=command.beginComputePass({label:"Surface/material publication lookup"}); pass.setPipeline(this.lookupPipeline); pass.setBindGroup(0,group); pass.dispatchWorkgroupsIndirect(resources.get(data.counts) as GPUBuffer,SURFACE_WORK_INDIRECT_OFFSET); pass.end(); });
    for(const id of [input.visibility,input.work,input.meshletWork,input.fieldVersions,input.residencyVersions,input.counts,input.materialLookup,input.surfaceIdentity])node.read(id); fields=node.create("Surface/material fields",{kind:"transient_texture",width:input.width,height:input.height,depthOrArrayLayers:APPEARANCE_SURFACE_LAYER_COUNT,format:"rgba16float",usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING,domain:"internal-full"}); node.write(fields); missQueue=node.create("Surface/material bounded miss queue",{kind:"transient_buffer",size:Math.max(4,input.recordCount*4),usage:GPUBufferUsage.STORAGE,domain:"internal-full"}); node.write(missQueue); hitMask=node.create("Surface/material hit mask",{kind:"transient_buffer",size:Math.max(4,input.recordCount*4),usage:GPUBufferUsage.STORAGE,domain:"internal-full"}); node.write(hitMask); counters=node.create("Surface/material counters and indirect",{kind:"transient_buffer",size:(4+input.programCount*8)*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.INDIRECT|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST,domain:"internal-full"}); node.write(counters); return {fields,missQueue,hitMask,counters};
  }
  addEvaluateToGraph(graph:FrameGraph,input:SurfaceMaterialProducts&{geometry:ResourceId;work:ResourceId;sampleOffset:number;fieldVersions:ResourceId;residencyVersions:ResourceId;counts:ResourceId;publication:GpuAppearancePublication;textureBanks:readonly (readonly ResourceId[])[];width:number;height:number;recordCount:number;frame:number}):void{
    const finalize=graph.add("Surface/Material miss indirect finalize",{counters:input.counters,programCount:input.publication.surfaceProgramCount,recordCount:input.recordCount},(data,resources,context)=>{const command=context.encoder as ShadeGPUCommandContext; command.writeBuffer(this.finalizeSettings,0,new Uint32Array([data.programCount,data.recordCount,0,0]).buffer,0,16); const group=this.device.createBindGroup({layout:this.finalizeLayout,entries:[{binding:0,resource:{buffer:this.finalizeSettings}},{binding:1,resource:{buffer:resources.get(data.counters) as GPUBuffer}}]}); const pass=command.beginComputePass({label:"Surface/material miss indirect finalize"}); pass.setPipeline(this.finalizePipeline); pass.setBindGroup(0,group); pass.dispatchWorkgroups(1); pass.end();}); finalize.read(input.counters); finalize.write(input.counters);
    const node=graph.add("Surface/Material miss publication evaluation",input,(data,resources,context)=>{const command=context.encoder as ShadeGPUCommandContext; const textureBanks=data.textureBanks.map(set=>set.map(id=>resources.get(id) as GPUTextureView)); data.publication.encodeSurfaceMissEvaluation(command,{geometry:resources.get(data.geometry) as GPUBuffer,work:resources.get(data.work) as GPUBuffer,misses:resources.get(data.missQueue) as GPUBuffer,hitMask:resources.get(data.hitMask) as GPUBuffer,counters:resources.get(data.counters) as GPUBuffer,fields:resolveTextureView(resources.get(data.fields)),cache:this.cache,cacheValues:this.cacheValues,indirect:resources.get(data.counters) as GPUBuffer,fieldVersions:resources.get(data.fieldVersions) as GPUBuffer,residencyVersions:resources.get(data.residencyVersions) as GPUBuffer,width:data.width,height:data.height,recordCount:data.recordCount,cacheCapacity:this.cacheCapacity,sampleOffset:data.sampleOffset,textureBanks});}); node.dependsOn(finalize); for(const id of [input.geometry,input.work,input.missQueue,input.hitMask,input.counters,input.fields,input.fieldVersions,input.residencyVersions])node.read(id); node.write(input.fields);
  }
  destroy():void{this.settings.destroy();this.finalizeSettings.destroy();this.cache.destroy();this.cacheValues.destroy();}
}

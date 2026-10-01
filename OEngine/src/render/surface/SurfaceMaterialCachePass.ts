import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { APPEARANCE_SURFACE_LAYER_COUNT } from "../../gpu/GpuAppearanceCacheAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../../gpu/GpuVisibilityKeyAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../../gpu/GpuMeshletRasterWorkAbi.js";

export interface SurfaceMaterialProducts { readonly fields: ResourceId; readonly missQueue: ResourceId; readonly hitMask: ResourceId; readonly counters: ResourceId; }

const CACHE_WGSL = /* wgsl */ `
${GPU_VISIBILITY_KEY_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
struct Settings { width:u32, height:u32, record_count:u32, cache_capacity:u32, field_version:u32, residency_version:u32, frame:u32, sample_offset:u32, geometry_offset:u32, reserved0:u32, reserved1:u32, reserved2:u32 }
fn hash_word(v:u32)->u32 { var x=v^(v>>16u); x*=0x7feb352du; x^=x>>15u; x*=0x846ca68bu; return x^(x>>16u); }
fn cache_hash(identity:u32, material:u32, version:u32, residency:u32)->u32 { return hash_word(identity ^ hash_word(material,2166136261u) ^ version ^ residency*16777619u,2246822519u); }
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
@compute @workgroup_size(64)
fn lookup(@builtin(global_invocation_id) id:vec3u) {
  let record=id.x; if record>=settings.record_count{return;}
  let sample_at=settings.sample_offset/4u+record*8u; let identity=work[sample_at+1u];
  if !oengine_visibility_key_is_valid(identity) { hit_mask[record]=0u; return; }
  let decoded=oengine_visibility_key_decode(identity);
  let valid=decoded.valid!=0u && decoded.meshlet_work_slot<meshlet_work.header.written_count;
  let material=select(0u,meshlet_work.elements[decoded.meshlet_work_slot].material_slot_or_range,valid);
  let version=select(0u,field_versions[0u],arrayLength(&field_versions)>0u);
  let residency=select(0u,residency_versions[0u],arrayLength(&residency_versions)>0u);
  let key=cache_hash(identity,material,version,residency); let cell=key&(settings.cache_capacity-1u); let old=cache[cell];
  let exact=old.x==key && old.y==identity && old.z==material && old.w==(version^residency);
  let pixel=vec2i(work[sample_at]%settings.width,work[sample_at]/settings.width);
  if exact {
    hit_mask[record]=1u; atomicAdd(&counters[0],1u);
    for(var layer=0u;layer<${APPEARANCE_SURFACE_LAYER_COUNT}u;layer++) textureStore(fields,pixel,i32(layer),cache_values[cell*${APPEARANCE_SURFACE_LAYER_COUNT}u+layer]);
  } else { hit_mask[record]=0u; atomicAdd(&counters[1],1u); let slot=atomicAdd(&counters[2],1u); if slot<settings.record_count { misses[slot]=record; } }
}

@group(1) @binding(0) var<uniform> eval_settings:Settings;
@group(1) @binding(1) var<storage,read> geometry:array<vec4f>;
@group(1) @binding(2) var<storage,read> eval_hit_mask:array<u32>;
@group(1) @binding(3) var<storage,read> eval_field_versions:array<u32>;
@group(1) @binding(4) var<storage,read> eval_residency_versions:array<u32>;
@group(1) @binding(5) var<storage,read_write> eval_cache:array<vec4u>;
@group(1) @binding(6) var<storage,read_write> eval_cache_values:array<vec4f>;
@group(1) @binding(7) var eval_fields:texture_storage_2d_array<rgba16float,write>;
@compute @workgroup_size(64)
fn evaluate(@builtin(global_invocation_id) id:vec3u) {
  let record=id.x; if record>=eval_settings.record_count || eval_hit_mask[record]!=0u{return;}
  let base=record*12u; let pixel=vec2i(u32(geometry[base+3u].x),u32(geometry[base+3u].y));
  let identity=bitcast<u32>(geometry[base+8u].x); let material=bitcast<u32>(geometry[base+10u].y);
  let version=select(0u,eval_field_versions[0u],arrayLength(&eval_field_versions)>0u); let residency=select(0u,eval_residency_versions[0u],arrayLength(&eval_residency_versions)>0u);
  let key=cache_hash(identity,material,version,residency); let cell=key&(eval_settings.cache_capacity-1u);
  let albedo=clamp(vec3f(geometry[base+4u].z,geometry[base+4u].w,geometry[base+11u].y),vec3f(0.0),vec3f(1.0));
  let roughness=clamp(0.22+0.48*(1.0-abs(geometry[base+2u].z)),0.04,1.0); let normal=normalize(geometry[base+2u].xyz);
  let values=array<vec4f,${APPEARANCE_SURFACE_LAYER_COUNT}u>(vec4f(albedo,1.0),vec4f(0.0,0.0,0.0,1.0),vec4f(roughness,0.0,0.0,1.0),vec4f(1.0,0.0,0.0,1.0),vec4f(0.04,0.04,0.04,1.0),vec4f(normal,3.0));
  for(var layer=0u;layer<${APPEARANCE_SURFACE_LAYER_COUNT}u;layer++){let value=values[layer];textureStore(eval_fields,pixel,i32(layer),value);eval_cache_values[cell*${APPEARANCE_SURFACE_LAYER_COUNT}u+layer]=value;}
  eval_cache[cell]=vec4u(key,identity,material,version^residency); atomicAdd(&counters[3],1u);
}
`;

export class SurfaceMaterialCachePass {
  private readonly lookupLayout:GPUBindGroupLayout; private readonly evalLayout:GPUBindGroupLayout;
  private readonly lookupPipeline:GPUComputePipeline; private readonly evalPipeline:GPUComputePipeline;
  private readonly settings:GPUBuffer; private readonly evalSettings:GPUBuffer; private readonly cache:GPUBuffer; private readonly cacheValues:GPUBuffer; private readonly cacheCapacity:number;
  constructor(private readonly device:GPUDevice,cacheCapacity=1<<16){
    if((cacheCapacity&(cacheCapacity-1))!==0)throw new RangeError("Surface material cache capacity must be a power of two"); this.cacheCapacity=cacheCapacity;
    this.settings=device.createBuffer({label:"Surface material lookup settings",size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}); this.evalSettings=device.createBuffer({label:"Surface material evaluate settings",size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.cache=device.createBuffer({label:"Surface material stable cache keys",size:cacheCapacity*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}); this.cacheValues=device.createBuffer({label:"Surface material stable cache values",size:cacheCapacity*APPEARANCE_SURFACE_LAYER_COUNT*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
    this.lookupLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:"uniform",minBindingSize:48}},{binding:1,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:"uint",viewDimension:"2d"}},... [2,3,4,5,6,7,8,9,10].map(binding=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:(binding===4||binding===5?"read-only-storage":"storage") as GPUBufferBindingType}})),{binding:11,visibility:GPUShaderStage.COMPUTE,storageTexture:{access:"write-only",format:"rgba16float",viewDimension:"2d-array"}}]});
    this.evalLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:"uniform",minBindingSize:48}},{binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:"read-only-storage"}},{binding:2,visibility:GPUShaderStage.COMPUTE,buffer:{type:"read-only-storage"}},{binding:3,visibility:GPUShaderStage.COMPUTE,buffer:{type:"read-only-storage"}},{binding:4,visibility:GPUShaderStage.COMPUTE,buffer:{type:"read-only-storage"}},{binding:5,visibility:GPUShaderStage.COMPUTE,buffer:{type:"storage"}},{binding:6,visibility:GPUShaderStage.COMPUTE,buffer:{type:"storage"}},{binding:7,visibility:GPUShaderStage.COMPUTE,storageTexture:{access:"write-only",format:"rgba16float",viewDimension:"2d-array"}}]});
    this.lookupPipeline=device.createComputePipeline({label:"Surface/material stable-key lookup",layout:device.createPipelineLayout({bindGroupLayouts:[this.lookupLayout]}),compute:{module:device.createShaderModule({code:CACHE_WGSL}),entryPoint:"lookup"}}); this.evalPipeline=device.createComputePipeline({label:"Surface/material miss evaluation",layout:device.createPipelineLayout({bindGroupLayouts:[device.createBindGroupLayout({entries:[]}),this.evalLayout]}),compute:{module:device.createShaderModule({code:CACHE_WGSL}),entryPoint:"evaluate"}});
  }
  addLookupToGraph(graph:FrameGraph,input:{visibility:ResourceId;work:ResourceId;meshletWork:ResourceId;fieldVersions:ResourceId;residencyVersions:ResourceId;width:number;height:number;recordCount:number;sampleOffset:number;frame:number}):SurfaceMaterialProducts{
    let fields!:ResourceId,missQueue!:ResourceId,hitMask!:ResourceId,counters!:ResourceId; const node=graph.add("Surface/Material cache lookup before geometry",input,(data,resources,context)=>{
      const command=context.encoder as ShadeGPUCommandContext; const settings=new Uint32Array([data.width,data.height,data.recordCount,this.cacheCapacity,0,0,data.frame,data.sampleOffset,0,0,0,0]); command.writeBuffer(this.settings,0,settings.buffer,0,settings.byteLength); command.writeBuffer(resources.get(counters) as GPUBuffer,0,new Uint32Array(4).buffer,0,16);
      const group=this.device.createBindGroup({layout:this.lookupLayout,entries:[{binding:0,resource:{buffer:this.settings}},{binding:1,resource:resolveTextureView(resources.get(data.visibility))},{binding:2,resource:{buffer:resources.get(data.work) as GPUBuffer}},{binding:3,resource:{buffer:resources.get(data.meshletWork) as GPUBuffer}},{binding:4,resource:{buffer:resources.get(data.fieldVersions) as GPUBuffer}},{binding:5,resource:{buffer:resources.get(data.residencyVersions) as GPUBuffer}},{binding:6,resource:{buffer:this.cache}},{binding:7,resource:{buffer:this.cacheValues}},{binding:8,resource:{buffer:resources.get(missQueue) as GPUBuffer}},{binding:9,resource:{buffer:resources.get(counters) as GPUBuffer}},{binding:10,resource:{buffer:resources.get(hitMask) as GPUBuffer}},{binding:11,resource:resolveTextureView(resources.get(fields))}]});
      const pass=command.beginComputePass({label:"Surface/material lookup"});pass.setPipeline(this.lookupPipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(data.recordCount/64));pass.end();
    }); for(const id of [input.visibility,input.work,input.meshletWork,input.fieldVersions,input.residencyVersions])node.read(id);
    fields=node.create("Surface/material fields",{kind:"transient_texture",width:input.width,height:input.height,depthOrArrayLayers:APPEARANCE_SURFACE_LAYER_COUNT,format:"rgba16float",usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING,domain:"internal-full"});node.write(fields); missQueue=node.create("Surface/material miss queue",{kind:"transient_buffer",size:Math.max(4,input.recordCount*4),usage:GPUBufferUsage.STORAGE,domain:"internal-full"});node.write(missQueue); hitMask=node.create("Surface/material hit mask",{kind:"transient_buffer",size:Math.max(4,input.recordCount*4),usage:GPUBufferUsage.STORAGE,domain:"internal-full"});node.write(hitMask); counters=node.create("Surface/material counters",{kind:"transient_buffer",size:16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC,domain:"internal-full"});node.write(counters); return {fields,missQueue,hitMask,counters};
  }
  addEvaluateToGraph(graph:FrameGraph,input:SurfaceMaterialProducts&{geometry:ResourceId;fieldVersions:ResourceId;residencyVersions:ResourceId;width:number;height:number;recordCount:number;frame:number}):void{
    const node=graph.add("Surface/Material cache miss evaluation",input,(data,resources,context)=>{const command=context.encoder as ShadeGPUCommandContext;const settings=new Uint32Array([data.width,data.height,data.recordCount,this.cacheCapacity,0,0,data.frame,0,0,0,0,0]);command.writeBuffer(this.evalSettings,0,settings.buffer,0,settings.byteLength);const group=this.device.createBindGroup({layout:this.evalLayout,entries:[{binding:0,resource:{buffer:this.evalSettings}},{binding:1,resource:{buffer:resources.get(data.geometry) as GPUBuffer}},{binding:2,resource:{buffer:resources.get(data.hitMask) as GPUBuffer}},{binding:3,resource:{buffer:resources.get(data.fieldVersions) as GPUBuffer}},{binding:4,resource:{buffer:resources.get(data.residencyVersions) as GPUBuffer}},{binding:5,resource:{buffer:this.cache}},{binding:6,resource:{buffer:this.cacheValues}},{binding:7,resource:resolveTextureView(resources.get(data.fields))}]});const pass=command.beginComputePass({label:"Surface/material miss evaluate"});pass.setPipeline(this.evalPipeline);pass.setBindGroup(1,group);pass.dispatchWorkgroups(Math.ceil(data.recordCount/64));pass.end();});
    for(const id of [input.geometry,input.hitMask,input.fieldVersions,input.residencyVersions])node.read(id);node.read(input.fields);node.write(input.fields);
  }
  destroy():void{this.settings.destroy();this.evalSettings.destroy();this.cache.destroy();this.cacheValues.destroy();}
}

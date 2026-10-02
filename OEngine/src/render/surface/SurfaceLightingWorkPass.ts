import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { SURFACE_WORK_INDIRECT_OFFSET } from "../../gpu/GpuSurfaceWorkAbi.js";

export interface SurfaceLightingProducts {
  readonly diffusePackets: ResourceId;
  readonly specularPackets: ResourceId;
  readonly coatPackets: ResourceId;
  readonly iblPackets: ResourceId;
  readonly radiance: ResourceId;
  readonly reactiveMask: ResourceId;
  readonly counters: ResourceId;
}

const LIGHTING_WGSL = /* wgsl */ `
struct Settings { width:u32, height:u32, record_count:u32, frame:u32, sample_offset:u32 }
@group(0) @binding(0) var<uniform> settings:Settings;
@group(0) @binding(1) var<storage,read> geometry:array<vec4f>;
@group(0) @binding(2) var fields:texture_2d_array<f32>;
@group(0) @binding(3) var<storage,read_write> diffuse:array<vec4f>;
@group(0) @binding(4) var<storage,read_write> specular:array<vec4f>;
@group(0) @binding(5) var<storage,read_write> coat:array<vec4f>;
@group(0) @binding(6) var<storage,read_write> ibl:array<vec4f>;
@group(0) @binding(7) var<storage,read_write> counters:array<atomic<u32>>;
@group(0) @binding(8) var output:texture_storage_2d<rgba16float,write>;
@group(0) @binding(9) var reactive:texture_storage_2d<rgba8unorm,write>;
@group(0) @binding(10) var<storage,read> surface_counts:array<u32>;
@group(0) @binding(11) var<storage,read> work:array<u32>;
const PI:f32=3.14159265359;
fn saturate(v:f32)->f32{return clamp(v,0.0,1.0);}
fn fresnel_schlick(cosine:f32,f0:vec3f)->vec3f{return f0+(vec3f(1.0)-f0)*pow(1.0-saturate(cosine),5.0);}
fn distribution_ggx(no_h:f32,roughness:f32)->f32{let a=roughness*roughness;let a2=a*a;let d=no_h*no_h*(a2-1.0)+1.0;return a2/max(PI*d*d,1e-5);}
fn visibility_smith(no_v:f32,no_l:f32,roughness:f32)->f32{let k=(roughness+1.0)*(roughness+1.0)/8.0;return (no_v/(no_v*(1.0-k)+k))*(no_l/(no_l*(1.0-k)+k));}
fn evaluate_brdf(albedo:vec3f,normal:vec3f,view_dir:vec3f,roughness:f32,metallic:f32)->vec4f{
  let no_v=saturate(dot(normal,view_dir)); let light_dir=normalize(vec3f(0.35,0.72,0.61)); let no_l=saturate(dot(normal,light_dir));
  let half_dir=normalize(view_dir+light_dir); let no_h=saturate(dot(normal,half_dir)); let vo_h=saturate(dot(view_dir,half_dir));
  let f0=mix(vec3f(0.04),albedo,metallic); let f=fresnel_schlick(vo_h,f0); let d=distribution_ggx(no_h,roughness); let v=visibility_smith(no_v,no_l,roughness);
  let spec=f*(d*v); let kd=(vec3f(1.0)-f)*(1.0-metallic); let diffuse=kd*albedo/PI; let direct=(diffuse+spec)*no_l;
  let energy=max(max(f.x,f.y),f.z); return vec4f(direct,energy);
}
@compute @workgroup_size(64)
fn build(@builtin(global_invocation_id) id:vec3u) {
  let record=id.x; if record>=settings.record_count || record>=surface_counts[0u]{return;}
  let base=record*12u; let sample_at=settings.sample_offset/4u+record*8u; let pixel_index=work[sample_at]; let pixel=vec2i(pixel_index%settings.width,pixel_index/settings.width); let material=textureLoad(fields,pixel,0,0);
  let albedo=clamp(material.xyz,vec3f(0.0),vec3f(1.0)); let roughness=clamp(textureLoad(fields,pixel,2,0).x,0.04,1.0); let normal=normalize(geometry[base+2u].xyz); let view_dir=normalize(geometry[base+6u].xyz);
  let metallic=clamp(textureLoad(fields,pixel,1,0).x,0.0,1.0); let brdf=evaluate_brdf(albedo,normal,view_dir,roughness,metallic); let no_v=saturate(dot(normal,view_dir));
  let diffuse_l=albedo*(1.0-metallic)*no_v*0.318309886; let spec=brdf.xyz*0.82; let coat_factor=clamp(textureLoad(fields,pixel,4,0).w,0.0,1.0); let coat_l=vec3f(0.04)*pow(no_v,2.0)*coat_factor; let env=albedo*(0.035+0.11*no_v)*(1.0-brdf.w*0.35);
  diffuse[record]=vec4f(diffuse_l,1.0); specular[record]=vec4f(spec,1.0); coat[record]=vec4f(coat_l,1.0); ibl[record]=vec4f(env,1.0);
  atomicAdd(&counters[0],1u); atomicAdd(&counters[1],1u); atomicAdd(&counters[2],1u); atomicAdd(&counters[3],1u);
  textureStore(output,pixel,vec4f(diffuse_l+spec+coat_l+env,1.0)); textureStore(reactive,pixel,vec4f(select(0.0,1.0,roughness<0.12||metallic>0.85)));
}
`;

export class SurfaceLightingWorkPass {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private readonly settings: GPUBuffer;
  constructor(private readonly device: GPUDevice) {
    this.settings=device.createBuffer({label:"Surface lighting settings",size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.layout=device.createBindGroupLayout({entries:[
      {binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:"uniform",minBindingSize:32}},
      {binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:"read-only-storage"}},
      {binding:2,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:"float",viewDimension:"2d-array"}},
      ...[3,4,5,6,7].map(binding=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:"storage" as GPUBufferBindingType}})),
      {binding:8,visibility:GPUShaderStage.COMPUTE,storageTexture:{access:"write-only",format:"rgba16float"}},
      {binding:9,visibility:GPUShaderStage.COMPUTE,storageTexture:{access:"write-only",format:"rgba8unorm"}},
      {binding:10,visibility:GPUShaderStage.COMPUTE,buffer:{type:"read-only-storage"}},
      {binding:11,visibility:GPUShaderStage.COMPUTE,buffer:{type:"read-only-storage"}}
    ]});
    this.pipeline=device.createComputePipeline({label:"Surface/lighting signal packets",layout:device.createPipelineLayout({bindGroupLayouts:[this.layout]}),compute:{module:device.createShaderModule({code:LIGHTING_WGSL}),entryPoint:"build"}});
  }
  addToGraph(graph:FrameGraph,input:{geometry:ResourceId;fields:ResourceId;counts:ResourceId;work:ResourceId;sampleOffset:number;width:number;height:number;recordCount:number;frame:number}):SurfaceLightingProducts{
    let diffusePackets!:ResourceId,specularPackets!:ResourceId,coatPackets!:ResourceId,iblPackets!:ResourceId,counters!:ResourceId,radiance!:ResourceId,reactiveMask!:ResourceId;
    const node=graph.add("Surface/independent lighting packets",input,(data,resources,context)=>{
      const command=context.encoder as ShadeGPUCommandContext; const settings=new Uint32Array([data.width,data.height,data.recordCount,data.frame,data.sampleOffset]); command.writeBuffer(this.settings,0,settings.buffer,0,settings.byteLength); const zero=new Uint32Array(4); command.writeBuffer(resources.get(counters) as GPUBuffer,0,zero.buffer,0,zero.byteLength);
      const group=this.device.createBindGroup({layout:this.layout,entries:[
        {binding:0,resource:{buffer:this.settings}},{binding:1,resource:{buffer:resources.get(data.geometry) as GPUBuffer}},{binding:2,resource:resolveTextureView(resources.get(data.fields))},
        {binding:3,resource:{buffer:resources.get(diffusePackets) as GPUBuffer}},{binding:4,resource:{buffer:resources.get(specularPackets) as GPUBuffer}},{binding:5,resource:{buffer:resources.get(coatPackets) as GPUBuffer}},{binding:6,resource:{buffer:resources.get(iblPackets) as GPUBuffer}},{binding:7,resource:{buffer:resources.get(counters) as GPUBuffer}},{binding:8,resource:resolveTextureView(resources.get(radiance))},{binding:9,resource:resolveTextureView(resources.get(reactiveMask))},{binding:10,resource:{buffer:resources.get(data.counts) as GPUBuffer}},{binding:11,resource:{buffer:resources.get(data.work) as GPUBuffer}}
      ]});
      const pass=command.beginComputePass({label:"Surface/lighting packets"}); pass.setPipeline(this.pipeline); pass.setBindGroup(0,group); pass.dispatchWorkgroupsIndirect(resources.get(data.counts) as GPUBuffer,SURFACE_WORK_INDIRECT_OFFSET); pass.end();
    });
    node.read(input.geometry); node.read(input.fields); node.read(input.counts); node.read(input.work);
    const bytes=Math.max(4,input.recordCount*16); diffusePackets=node.create("Surface/diffuse packets",{kind:"transient_buffer",size:bytes,usage:GPUBufferUsage.STORAGE,domain:"internal-full"}); specularPackets=node.create("Surface/specular packets",{kind:"transient_buffer",size:bytes,usage:GPUBufferUsage.STORAGE,domain:"internal-full"}); coatPackets=node.create("Surface/coat packets",{kind:"transient_buffer",size:bytes,usage:GPUBufferUsage.STORAGE,domain:"internal-full"}); iblPackets=node.create("Surface/IBL packets",{kind:"transient_buffer",size:bytes,usage:GPUBufferUsage.STORAGE,domain:"internal-full"}); counters=node.create("Surface/lighting counters",{kind:"transient_buffer",size:16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST,domain:"internal-full"});
    for(const id of [diffusePackets,specularPackets,coatPackets,iblPackets,counters]) node.write(id);
    radiance=node.create("Surface/packet radiance",{kind:"transient_texture",width:input.width,height:input.height,format:"rgba16float",usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING,domain:"internal-full"}); reactiveMask=node.create("Surface/packet reactive",{kind:"transient_texture",width:input.width,height:input.height,format:"rgba8unorm",usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING,domain:"internal-full"}); node.write(radiance); node.write(reactiveMask);
    return {diffusePackets,specularPackets,coatPackets,iblPackets,counters,radiance,reactiveMask};
  }
  destroy():void{this.settings.destroy();}
}

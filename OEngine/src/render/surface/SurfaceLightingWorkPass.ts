import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";

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
struct Settings { width:u32, height:u32, record_count:u32, frame:u32 }
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
@compute @workgroup_size(64)
fn build(@builtin(global_invocation_id) id:vec3u) {
  let record=id.x; if record>=settings.record_count{return;}
  let base=record*12u; let n=normalize(geometry[base+5u].xyz); let albedo=textureLoad(fields,vec2i(u32(geometry[base+3u].x),u32(geometry[base+3u].y)),0,0).xyz;
  let diffuse_l=albedo*max(n.z,0.0); let spec=vec3f(pow(max(n.z,0.0),16.0)); let coat_l=vec3f(0.04)*pow(max(n.z,0.0),64.0); let env=albedo*0.08;
  diffuse[record]=vec4f(diffuse_l,1.0); specular[record]=vec4f(spec,1.0); coat[record]=vec4f(coat_l,1.0); ibl[record]=vec4f(env,1.0);
  atomicAdd(&counters[0],1u); atomicAdd(&counters[1],1u); atomicAdd(&counters[2],1u); atomicAdd(&counters[3],1u);
  let pixel=vec2i(u32(geometry[base+3u].x),u32(geometry[base+3u].y)); textureStore(output,pixel,vec4f(diffuse_l+spec+coat_l+env,1.0)); textureStore(reactive,pixel,vec4f(0.0));
}
`;

export class SurfaceLightingWorkPass {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private readonly settings: GPUBuffer;
  constructor(private readonly device: GPUDevice) {
    this.settings=device.createBuffer({label:"Surface lighting settings",size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.layout=device.createBindGroupLayout({entries:[
      {binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:"uniform",minBindingSize:16}},
      {binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:"read-only-storage"}},
      {binding:2,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:"float",viewDimension:"2d-array"}},
      ...[3,4,5,6,7].map(binding=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:"storage" as GPUBufferBindingType}})),
      {binding:8,visibility:GPUShaderStage.COMPUTE,storageTexture:{access:"write-only",format:"rgba16float"}},
      {binding:9,visibility:GPUShaderStage.COMPUTE,storageTexture:{access:"write-only",format:"rgba8unorm"}}
    ]});
    this.pipeline=device.createComputePipeline({label:"Surface/lighting signal packets",layout:device.createPipelineLayout({bindGroupLayouts:[this.layout]}),compute:{module:device.createShaderModule({code:LIGHTING_WGSL}),entryPoint:"build"}});
  }
  addToGraph(graph:FrameGraph,input:{geometry:ResourceId;fields:ResourceId;width:number;height:number;recordCount:number;frame:number}):SurfaceLightingProducts{
    let diffusePackets!:ResourceId,specularPackets!:ResourceId,coatPackets!:ResourceId,iblPackets!:ResourceId,counters!:ResourceId,radiance!:ResourceId,reactiveMask!:ResourceId;
    const node=graph.add("Surface/independent lighting packets",input,(data,resources,context)=>{
      const command=context.encoder as ShadeGPUCommandContext; command.writeBuffer(this.settings,0,new Uint32Array([data.width,data.height,data.recordCount,data.frame]).buffer); command.writeBuffer(resources.get(counters) as GPUBuffer,0,new Uint32Array(4).buffer);
      const group=this.device.createBindGroup({layout:this.layout,entries:[
        {binding:0,resource:{buffer:this.settings}},{binding:1,resource:{buffer:resources.get(data.geometry) as GPUBuffer}},{binding:2,resource:resolveTextureView(resources.get(data.fields))},
        {binding:3,resource:{buffer:resources.get(diffusePackets) as GPUBuffer}},{binding:4,resource:{buffer:resources.get(specularPackets) as GPUBuffer}},{binding:5,resource:{buffer:resources.get(coatPackets) as GPUBuffer}},{binding:6,resource:{buffer:resources.get(iblPackets) as GPUBuffer}},{binding:7,resource:{buffer:resources.get(counters) as GPUBuffer}},{binding:8,resource:resolveTextureView(resources.get(radiance))},{binding:9,resource:resolveTextureView(resources.get(reactiveMask))}
      ]});
      const pass=command.beginComputePass({label:"Surface/lighting packets"}); pass.setPipeline(this.pipeline); pass.setBindGroup(0,group); pass.dispatchWorkgroups(Math.ceil(data.recordCount/64)); pass.end();
    });
    node.read(input.geometry); node.read(input.fields);
    const bytes=Math.max(4,input.recordCount*16); diffusePackets=node.create("Surface/diffuse packets",{kind:"transient_buffer",size:bytes,usage:GPUBufferUsage.STORAGE,domain:"internal-full"}); specularPackets=node.create("Surface/specular packets",{kind:"transient_buffer",size:bytes,usage:GPUBufferUsage.STORAGE,domain:"internal-full"}); coatPackets=node.create("Surface/coat packets",{kind:"transient_buffer",size:bytes,usage:GPUBufferUsage.STORAGE,domain:"internal-full"}); iblPackets=node.create("Surface/IBL packets",{kind:"transient_buffer",size:bytes,usage:GPUBufferUsage.STORAGE,domain:"internal-full"}); counters=node.create("Surface/lighting counters",{kind:"transient_buffer",size:16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC,domain:"internal-full"});
    for(const id of [diffusePackets,specularPackets,coatPackets,iblPackets,counters]) node.write(id);
    radiance=node.create("Surface/packet radiance",{kind:"transient_texture",width:input.width,height:input.height,format:"rgba16float",usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING,domain:"internal-full"}); reactiveMask=node.create("Surface/packet reactive",{kind:"transient_texture",width:input.width,height:input.height,format:"rgba8unorm",usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING,domain:"internal-full"}); node.write(radiance); node.write(reactiveMask);
    return {diffusePackets,specularPackets,coatPackets,iblPackets,counters,radiance,reactiveMask};
  }
  destroy():void{this.settings.destroy();}
}

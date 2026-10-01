import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";

export interface SurfaceReconstructionProducts { readonly radiance: ResourceId; readonly reactiveMask: ResourceId; }

const RECONSTRUCT_WGSL = /* wgsl */ `
struct Settings { width:u32, height:u32, tiles_x:u32, record_count:u32 }
@group(0) @binding(0) var<uniform> settings:Settings;
@group(0) @binding(1) var<storage,read> diffuse:array<vec4f>;
@group(0) @binding(2) var<storage,read> specular:array<vec4f>;
@group(0) @binding(3) var<storage,read> coat:array<vec4f>;
@group(0) @binding(4) var<storage,read> ibl:array<vec4f>;
@group(0) @binding(5) var<storage,read> geometry:array<vec4f>;
@group(0) @binding(6) var<storage,read> source_reactive:texture_2d<f32>;
@group(0) @binding(7) var output:texture_storage_2d<rgba16float,write>;
@group(0) @binding(8) var reactive:texture_storage_2d<rgba8unorm,write>;
@compute @workgroup_size(8,8)
fn reconstruct(@builtin(global_invocation_id) id:vec3u){
  if id.x>=settings.width||id.y>=settings.height{return;}
  let tile=(id.y/8u)*settings.tiles_x+(id.x/8u); let record=min(tile,settings.record_count-1u); let color=diffuse[record].xyz+specular[record].xyz+coat[record].xyz+ibl[record].xyz;
  let reactive_value=textureLoad(source_reactive,vec2i(id.xy),0).x; textureStore(output,vec2i(id.xy),vec4f(color,1.0)); textureStore(reactive,vec2i(id.xy),vec4f(reactive_value));
}
`;

export class SurfaceReconstructionPass {
  private readonly layout:GPUBindGroupLayout; private readonly pipeline:GPUComputePipeline; private readonly settings:GPUBuffer;
  constructor(private readonly device:GPUDevice){
    this.settings=device.createBuffer({label:"Surface reconstruct settings",size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.layout=device.createBindGroupLayout({entries:[
      {binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:"uniform",minBindingSize:16}},
      ...[1,2,3,4,5].map(binding=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type:"read-only-storage" as GPUBufferBindingType}})),
      {binding:6,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:"float"}},
      {binding:7,visibility:GPUShaderStage.COMPUTE,storageTexture:{access:"write-only",format:"rgba16float"}},
      {binding:8,visibility:GPUShaderStage.COMPUTE,storageTexture:{access:"write-only",format:"rgba8unorm"}}
    ]});
    this.pipeline=device.createComputePipeline({label:"Surface/cheap reconstruct",layout:device.createPipelineLayout({bindGroupLayouts:[this.layout]}),compute:{module:device.createShaderModule({code:RECONSTRUCT_WGSL}),entryPoint:"reconstruct"}});
  }
  addToGraph(graph:FrameGraph,input:{diffuse:ResourceId;specular:ResourceId;coat:ResourceId;ibl:ResourceId;geometry:ResourceId;reactive:ResourceId;width:number;height:number;recordCount:number}):SurfaceReconstructionProducts{
    let radiance!:ResourceId,reactiveMask!:ResourceId;
    const node=graph.add("Surface/cheap full-resolution reconstruct",input,(data,resources,context)=>{
      const command=context.encoder as ShadeGPUCommandContext; command.writeBuffer(this.settings,0,new Uint32Array([data.width,data.height,Math.ceil(data.width/8),data.recordCount]).buffer);
      const group=this.device.createBindGroup({layout:this.layout,entries:[
        {binding:0,resource:{buffer:this.settings}},{binding:1,resource:{buffer:resources.get(data.diffuse) as GPUBuffer}},{binding:2,resource:{buffer:resources.get(data.specular) as GPUBuffer}},{binding:3,resource:{buffer:resources.get(data.coat) as GPUBuffer}},{binding:4,resource:{buffer:resources.get(data.ibl) as GPUBuffer}},{binding:5,resource:{buffer:resources.get(data.geometry) as GPUBuffer}},{binding:6,resource:resolveTextureView(resources.get(data.reactive))},{binding:7,resource:resolveTextureView(resources.get(radiance))},{binding:8,resource:resolveTextureView(resources.get(reactiveMask))}
      ]});
      const pass=command.beginComputePass({label:"Surface/reconstruct"}); pass.setPipeline(this.pipeline); pass.setBindGroup(0,group); pass.dispatchWorkgroups(Math.ceil(data.width/8),Math.ceil(data.height/8)); pass.end();
    });
    for(const id of [input.diffuse,input.specular,input.coat,input.ibl,input.geometry,input.reactive]) node.read(id);
    radiance=node.create("Surface/HDR reconstructed",{kind:"transient_texture",width:input.width,height:input.height,format:"rgba16float",usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING,domain:"internal-full"}); reactiveMask=node.create("Surface/reactive reconstructed",{kind:"transient_texture",width:input.width,height:input.height,format:"rgba8unorm",usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING,domain:"internal-full"}); node.write(radiance); node.write(reactiveMask);
    return {radiance,reactiveMask};
  }
  destroy():void{this.settings.destroy();}
}

import { FrameGraph, type PassBuilder } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";

const WGSL = /* wgsl */ `
struct Size { width:u32, height:u32, };
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var output:texture_storage_2d<rgba16float,write>;
@group(0) @binding(2) var<uniform> size:Size;
@group(0) @binding(3) var<storage,read> pre_exposure:array<f32>;
fn load_clamped(tex:texture_2d<f32>, p:vec2i)->vec3f {
  let d=vec2i(textureDimensions(tex)); return textureLoad(tex,clamp(p,vec2i(0),d-vec2i(1)),0).rgb;
}
fn bright(c:vec3f)->vec3f { let p=max(pre_exposure[0],1e-6); let scene=c/p; let l=dot(scene,vec3f(0.2627,0.6780,0.0593)); return max(scene-vec3f(max(1.0,l)),vec3f(0.0))*p; }
@compute @workgroup_size(8,8)
fn extract(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=size.width||id.y>=size.height){return;}
  let p=vec2i(id.xy)*2; var c=vec3f(0.0);
  for(var y=0;y<2;y++){for(var x=0;x<2;x++){c+=bright(load_clamped(source,p+vec2i(x,y)));}}
  textureStore(output,vec2i(id.xy),vec4f(c*0.25,1.0));
}
@compute @workgroup_size(8,8)
fn downsample(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=size.width||id.y>=size.height){return;}
  let p=vec2i(id.xy)*2; var c=vec3f(0.0);
  for(var y=-1;y<=2;y++){for(var x=-1;x<=2;x++){c+=load_clamped(source,p+vec2i(x,y));}}
  textureStore(output,vec2i(id.xy),vec4f(c/16.0,1.0));
}
@group(1) @binding(0) var low:texture_2d<f32>;
@group(1) @binding(1) var high:texture_2d<f32>;
@group(1) @binding(2) var up_output:texture_storage_2d<rgba16float,write>;
@group(1) @binding(3) var<uniform> up_size:Size;
@compute @workgroup_size(8,8)
fn upsample(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=up_size.width||id.y>=up_size.height){return;}
  let p=vec2i(id.xy); let h=load_clamped(high,p); let lp=vec2i(vec2f(p)*vec2f(textureDimensions(low))/vec2f(f32(up_size.width),f32(up_size.height)));
  var b=vec3f(0.0); for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){b+=load_clamped(low,lp+vec2i(x,y));}}
  textureStore(up_output,p,vec4f(h+b/9.0*0.85,1.0));
}
@group(2) @binding(0) var scene:texture_2d<f32>;
@group(2) @binding(1) var glow:texture_2d<f32>;
@group(2) @binding(2) var composite:texture_storage_2d<rgba16float,write>;
@group(2) @binding(3) var<uniform> composite_size:Size;
@compute @workgroup_size(8,8)
fn composite_main(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=composite_size.width||id.y>=composite_size.height){return;}
  let p=vec2i(id.xy); let gd=vec2f(textureDimensions(glow));
  let gp=vec2i(vec2f(p)*gd/vec2f(f32(composite_size.width),f32(composite_size.height)));
  textureStore(composite,p,vec4f(load_clamped(scene,p)+load_clamped(glow,gp),1.0));
}
`;

export class BloomPass {
  private readonly extractLayout: GPUBindGroupLayout;
  private readonly downLayout: GPUBindGroupLayout;
  private readonly upLayout: GPUBindGroupLayout;
  private readonly extractPipeline: GPUComputePipeline;
  private readonly downPipeline: GPUComputePipeline;
  private readonly upPipeline: GPUComputePipeline;
  private readonly compositePipeline: GPUComputePipeline;
  private readonly compositeLayout: GPUBindGroupLayout;
  constructor(private readonly device: GPUDevice) {
    const module=device.createShaderModule({ label:"Bloom High core", code:WGSL });
    this.extractLayout=device.createBindGroupLayout({entries:[
      {binding:0,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:"float"}},
      {binding:1,visibility:GPUShaderStage.COMPUTE,storageTexture:{access:"write-only",format:"rgba16float"}},
      {binding:2,visibility:GPUShaderStage.COMPUTE,buffer:{type:"uniform"}},
      {binding:3,visibility:GPUShaderStage.COMPUTE,buffer:{type:"read-only-storage"}}]});
    this.downLayout=this.extractLayout;
    this.upLayout=device.createBindGroupLayout({entries:[
      {binding:0,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:"float"}},
      {binding:1,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:"float"}},
      {binding:2,visibility:GPUShaderStage.COMPUTE,storageTexture:{access:"write-only",format:"rgba16float"}},
      {binding:3,visibility:GPUShaderStage.COMPUTE,buffer:{type:"uniform"}}]});
    this.compositeLayout=device.createBindGroupLayout({entries:[
      {binding:0,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:"float"}},
      {binding:1,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:"float"}},
      {binding:2,visibility:GPUShaderStage.COMPUTE,storageTexture:{access:"write-only",format:"rgba16float"}},
      {binding:3,visibility:GPUShaderStage.COMPUTE,buffer:{type:"uniform"}}]});
    this.extractPipeline=device.createComputePipeline({layout:device.createPipelineLayout({bindGroupLayouts:[this.extractLayout]}),compute:{module,entryPoint:"extract"}});
    this.downPipeline=device.createComputePipeline({layout:device.createPipelineLayout({bindGroupLayouts:[this.downLayout]}),compute:{module,entryPoint:"downsample"}});
    this.upPipeline=device.createComputePipeline({layout:device.createPipelineLayout({bindGroupLayouts:[this.upLayout]}),compute:{module,entryPoint:"upsample"}});
    this.compositePipeline=device.createComputePipeline({layout:device.createPipelineLayout({bindGroupLayouts:[this.compositeLayout]}),compute:{module,entryPoint:"composite_main"}});
  }

  addToGraph(graph:FrameGraph,input:{scene:ResourceId;preExposure:ResourceId;width:number;height:number}):ResourceId {
    const levels:ResourceId[]=[];
    const extent=(level:number)=>[Math.max(1,input.width>>level),Math.max(1,input.height>>level)] as const;
    const make=(node:PassBuilder,label:string,level:number)=>node.create(label,{kind:"transient_texture",width:extent(level)[0],height:extent(level)[1],format:"rgba16float",domain:"output-full",usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING});
    let extract=-1;
    const first=graph.add("Bloom/extract threshold",{width:extent(1)[0],height:extent(1)[1]},(data,res,ctx)=>{
      const c=ctx.encoder as ShadeGPUCommandContext; const u=c.allocateTransientBufferAndLoad(new Uint32Array([data.width,data.height]).buffer,GPUBufferUsage.UNIFORM);
      const g=this.device.createBindGroup({layout:this.extractLayout,entries:[{binding:0,resource:resolveTextureView(res.get(input.scene))},{binding:1,resource:resolveTextureView(res.get(extract))},{binding:2,resource:{buffer:u}},{binding:3,resource:{buffer:res.get(input.preExposure) as GPUBuffer}}]});
      const p=c.beginComputePass({label:"Bloom/extract threshold"});p.setPipeline(this.extractPipeline);p.setBindGroup(0,g);p.dispatchWorkgroups(Math.ceil(data.width/8),Math.ceil(data.height/8));p.end();
    }); extract=make(first,"Bloom/mip0",1); first.read(input.scene); first.read(input.preExposure); levels.push(extract);
    for(let level=2;level<=5;level++){
      const source=levels[level-2]!; let output=-1; const node=graph.add(`Bloom/downsample ${level-1}`,{width:extent(level)[0],height:extent(level)[1]},(data,res,ctx)=>{
        const c=ctx.encoder as ShadeGPUCommandContext; const u=c.allocateTransientBufferAndLoad(new Uint32Array([data.width,data.height]).buffer,GPUBufferUsage.UNIFORM);
        const g=this.device.createBindGroup({layout:this.downLayout,entries:[{binding:0,resource:resolveTextureView(res.get(source))},{binding:1,resource:resolveTextureView(res.get(output))},{binding:2,resource:{buffer:u}}]}); const p=c.beginComputePass({label:`Bloom/downsample ${level-1}`});p.setPipeline(this.downPipeline);p.setBindGroup(0,g);p.dispatchWorkgroups(Math.ceil(data.width/8),Math.ceil(data.height/8));p.end();
      }); output=make(node,`Bloom/mip${level-1}`,level);node.read(source);levels.push(output);
    }
    for(let level=4;level>=0;level--){const low=levels[level+1]!,high=levels[level]!;let output=-1;const node=graph.add(`Bloom/upsample ${level}`,{width:extent(level)[0],height:extent(level)[1]},(data,res,ctx)=>{const c=ctx.encoder as ShadeGPUCommandContext;const u=c.allocateTransientBufferAndLoad(new Uint32Array([data.width,data.height]).buffer,GPUBufferUsage.UNIFORM);const g=this.device.createBindGroup({layout:this.upLayout,entries:[{binding:0,resource:resolveTextureView(res.get(low))},{binding:1,resource:resolveTextureView(res.get(high))},{binding:2,resource:resolveTextureView(res.get(output))},{binding:3,resource:{buffer:u}}]});const p=c.beginComputePass({label:`Bloom/upsample ${level}`});p.setPipeline(this.upPipeline);p.setBindGroup(0,g);p.dispatchWorkgroups(Math.ceil(data.width/8),Math.ceil(data.height/8));p.end();});output=make(node,`Bloom/up${level}`,level);node.read(low);node.read(high);levels[level]=output;}
    let output=-1; const composite=graph.add("Bloom/composite HDR",{width:input.width,height:input.height},(data,res,ctx)=>{const c=ctx.encoder as ShadeGPUCommandContext;const u=c.allocateTransientBufferAndLoad(new Uint32Array([data.width,data.height]).buffer,GPUBufferUsage.UNIFORM);const g=this.device.createBindGroup({layout:this.compositeLayout,entries:[{binding:0,resource:resolveTextureView(res.get(input.scene))},{binding:1,resource:resolveTextureView(res.get(levels[0]!))},{binding:2,resource:resolveTextureView(res.get(output))},{binding:3,resource:{buffer:u}}]});const p=c.beginComputePass({label:"Bloom/composite HDR"});p.setPipeline(this.compositePipeline);p.setBindGroup(0,g);p.dispatchWorkgroups(Math.ceil(data.width/8),Math.ceil(data.height/8));p.end();});
    output=composite.create("Bloom/bloom HDR",{kind:"transient_texture",width:input.width,height:input.height,format:"rgba16float",domain:"output-full",usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING});
    composite.read(levels[0]!); composite.read(input.scene); return output;
  }
  destroy():void{}
}
export const BLOOM_WGSL=WGSL;

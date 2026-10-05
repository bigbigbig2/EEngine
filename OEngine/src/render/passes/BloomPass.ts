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
@group(0) @binding(4) var bloom_sampler:sampler;
fn load_clamped(tex:texture_2d<f32>, p:vec2i)->vec3f {
  let d=vec2i(textureDimensions(tex)); return textureLoad(tex,clamp(p,vec2i(0),d-vec2i(1)),0).rgb;
}
fn bright(c:vec3f)->vec3f {
  // Filament bloomDownsample2x: threshold after filtering, in scene units.
  let p=max(pre_exposure[0],1e-6);
  return max(c/p-vec3f(1.0),vec3f(0.0))*p;
}
@compute @workgroup_size(8,8)
fn extract(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=size.width||id.y>=size.height){return;}
  let p=vec2i(id.xy)*2; var c=vec3f(0.0);
  // Four bilinear Gaussian samples expand to this separable 4x4 kernel.
  let weights=array<f32,4>(1.0,3.0,3.0,1.0);
  for(var y=0;y<4;y++){for(var x=0;x<4;x++){
    c+=weights[x]*weights[y]*load_clamped(source,p+vec2i(x-1,y-1));
  }}
  textureStore(output,vec2i(id.xy),vec4f(bright(c/64.0),1.0));
}
@compute @workgroup_size(8,8)
fn downsample(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=size.width||id.y>=size.height){return;}
  let source_size=vec2f(textureDimensions(source));
  let uv=(vec2f(id.xy)+vec2f(0.5))/vec2f(f32(size.width),f32(size.height));
  let texel=1.0/source_size;
  var c=vec3f(0.0);
  if(u32(source_size.x)%2u==0u && u32(source_size.y)%2u==0u){
    // Filament bloomDownsample9: 6x6 support, nine bilinear taps.
    let shift=texel*(1.5+0.261629);
    let wa=7.46602/32.0; let wb=1.0-2.0*wa;
    c=textureSampleLevel(source,bloom_sampler,uv,0.0).rgb*(wb*wb);
    for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
      if(x==0 && y==0){continue;}
      let weight=select(wa,wb,x==0)*select(wa,wb,y==0);
      c+=textureSampleLevel(source,bloom_sampler,uv+vec2f(f32(x),f32(y))*shift,0.0).rgb*weight;
    }}
  }else{
    // Filament bloomDownsample: five weighted 4x4 boxes, 13 taps.
    let d=texel;
    let center=textureSampleLevel(source,bloom_sampler,uv,0.0).rgb;
    let lt=textureSampleLevel(source,bloom_sampler,uv+vec2f(-d.x,-d.y),0.0).rgb;
    let rt=textureSampleLevel(source,bloom_sampler,uv+vec2f(d.x,-d.y),0.0).rgb;
    let rb=textureSampleLevel(source,bloom_sampler,uv+vec2f(d.x,d.y),0.0).rgb;
    let lb=textureSampleLevel(source,bloom_sampler,uv+vec2f(-d.x,d.y),0.0).rgb;
    let lt2=textureSampleLevel(source,bloom_sampler,uv+vec2f(-2.0*d.x,-2.0*d.y),0.0).rgb;
    let rt2=textureSampleLevel(source,bloom_sampler,uv+vec2f(2.0*d.x,-2.0*d.y),0.0).rgb;
    let rb2=textureSampleLevel(source,bloom_sampler,uv+vec2f(2.0*d.x,2.0*d.y),0.0).rgb;
    let lb2=textureSampleLevel(source,bloom_sampler,uv+vec2f(-2.0*d.x,2.0*d.y),0.0).rgb;
    let left=textureSampleLevel(source,bloom_sampler,uv+vec2f(-2.0*d.x,0.0),0.0).rgb;
    let top=textureSampleLevel(source,bloom_sampler,uv+vec2f(0.0,-2.0*d.y),0.0).rgb;
    let right=textureSampleLevel(source,bloom_sampler,uv+vec2f(2.0*d.x,0.0),0.0).rgb;
    let bottom=textureSampleLevel(source,bloom_sampler,uv+vec2f(0.0,2.0*d.y),0.0).rgb;
    c=(lt+rt+rb+lb)*0.125+
      (4.0*center+2.0*(left+top+right+bottom)+lt2+rt2+rb2+lb2)*0.03125;
  }
  textureStore(output,vec2i(id.xy),vec4f(c,1.0));
}
@group(1) @binding(0) var low:texture_2d<f32>;
@group(1) @binding(1) var high:texture_2d<f32>;
@group(1) @binding(2) var up_output:texture_storage_2d<rgba16float,write>;
@group(1) @binding(3) var<uniform> up_size:Size;
@group(1) @binding(4) var up_sampler:sampler;
@compute @workgroup_size(8,8)
fn upsample(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=up_size.width||id.y>=up_size.height){return;}
  let p=vec2i(id.xy); let h=load_clamped(high,p);
  let uv=(vec2f(p)+vec2f(0.5))/vec2f(f32(up_size.width),f32(up_size.height));
  let d=1.0/vec2f(textureDimensions(high));
  // Filament High bloomUpsample: center 4, edges 2, corners 1.
  var b=4.0*textureSampleLevel(low,up_sampler,uv,0.0).rgb;
  for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
    if(x==0 && y==0){continue;}
    let weight=select(1.0,2.0,x==0 || y==0);
    b+=weight*textureSampleLevel(low,up_sampler,uv+vec2f(f32(x),f32(y))*d,0.0).rgb;
  }}
  textureStore(up_output,p,vec4f(h+b/16.0,1.0));
}
@group(2) @binding(0) var scene:texture_2d<f32>;
@group(2) @binding(1) var glow:texture_2d<f32>;
@group(2) @binding(2) var composite:texture_storage_2d<rgba16float,write>;
@group(2) @binding(3) var<uniform> composite_size:Size;
@group(2) @binding(4) var composite_sampler:sampler;
@compute @workgroup_size(8,8)
fn composite_main(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=composite_size.width||id.y>=composite_size.height){return;}
  let p=vec2i(id.xy);
  let uv=(vec2f(p)+vec2f(0.5))/vec2f(f32(composite_size.width),f32(composite_size.height));
  textureStore(composite,p,vec4f(load_clamped(scene,p)+
    textureSampleLevel(glow,composite_sampler,uv,0.0).rgb*0.1,1.0));
}
`;

export class BloomPass {
  private readonly sampler: GPUSampler;
  private readonly extractLayout: GPUBindGroupLayout;
  private readonly downLayout: GPUBindGroupLayout;
  private readonly upLayout: GPUBindGroupLayout;
  private readonly extractPipeline: GPUComputePipeline;
  private readonly downPipeline: GPUComputePipeline;
  private readonly upPipeline: GPUComputePipeline;
  private readonly compositePipeline: GPUComputePipeline;
  private readonly compositeLayout: GPUBindGroupLayout;
  constructor(private readonly device: GPUDevice) {
    this.sampler = device.createSampler({
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    const module = device.createShaderModule({ label: "Bloom High core", code: WGSL });
    this.extractLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "rgba16float" },
        },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
      ],
    });
    this.downLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "rgba16float" },
        },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
      ],
    });
    this.upLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "rgba16float" },
        },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
      ],
    });
    this.compositeLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "rgba16float" },
        },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
      ],
    });
    this.extractPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.extractLayout] }),
      compute: { module, entryPoint: "extract" },
    });
    this.downPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.downLayout] }),
      compute: { module, entryPoint: "downsample" },
    });
    const emptyLayout = device.createBindGroupLayout({ entries: [] });
    this.upPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [emptyLayout, this.upLayout] }),
      compute: { module, entryPoint: "upsample" },
    });
    this.compositePipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [emptyLayout, emptyLayout, this.compositeLayout],
      }),
      compute: { module, entryPoint: "composite_main" },
    });
  }

  addToGraph(
    graph: FrameGraph,
    input: { scene: ResourceId; preExposure: ResourceId; width: number; height: number; enabled?: boolean },
  ): ResourceId {
    if (input.enabled === false) return input.scene;
    const levels: ResourceId[] = [];
    const extent = (level: number) =>
      [Math.max(1, input.width >> level), Math.max(1, input.height >> level)] as const;
    const make = (node: PassBuilder, label: string, level: number) =>
      node.create(label, {
        kind: "transient_texture",
        width: extent(level)[0],
        height: extent(level)[1],
        format: "rgba16float",
        domain: "output-full",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
    let extract = -1;
    const first = graph.add(
      "Bloom/extract threshold",
      { width: extent(1)[0], height: extent(1)[1] },
      (data, res, ctx) => {
        const c = ctx.encoder as ShadeGPUCommandContext;
        const u = c.allocateTransientBufferAndLoad(
          new Uint32Array([data.width, data.height]).buffer,
          GPUBufferUsage.UNIFORM,
        );
        const g = this.device.createBindGroup({
          layout: this.extractLayout,
          entries: [
            { binding: 0, resource: resolveTextureView(res.get(input.scene)) },
            { binding: 1, resource: resolveTextureView(res.get(extract)) },
            { binding: 2, resource: { buffer: u } },
            { binding: 3, resource: { buffer: res.get(input.preExposure) as GPUBuffer } },
            { binding: 4, resource: this.sampler },
          ],
        });
        const p = c.beginComputePass({ label: "Bloom/extract threshold" });
        p.setPipeline(this.extractPipeline);
        p.setBindGroup(0, g);
        p.dispatchWorkgroups(Math.ceil(data.width / 8), Math.ceil(data.height / 8));
        p.end();
      },
    );
    extract = make(first, "Bloom/mip0", 1);
    first.read(input.scene);
    first.read(input.preExposure);
    levels.push(extract);
    for (let level = 2; level <= 5; level++) {
      const source = levels[level - 2]!;
      let output = -1;
      const node = graph.add(
        `Bloom/downsample ${level - 1}`,
        { width: extent(level)[0], height: extent(level)[1] },
        (data, res, ctx) => {
          const c = ctx.encoder as ShadeGPUCommandContext;
          const u = c.allocateTransientBufferAndLoad(
            new Uint32Array([data.width, data.height]).buffer,
            GPUBufferUsage.UNIFORM,
          );
          const g = this.device.createBindGroup({
            layout: this.downLayout,
            entries: [
              { binding: 0, resource: resolveTextureView(res.get(source)) },
              { binding: 1, resource: resolveTextureView(res.get(output)) },
              { binding: 2, resource: { buffer: u } },
              { binding: 4, resource: this.sampler },
            ],
          });
          const p = c.beginComputePass({ label: `Bloom/downsample ${level - 1}` });
          p.setPipeline(this.downPipeline);
          p.setBindGroup(0, g);
          p.dispatchWorkgroups(Math.ceil(data.width / 8), Math.ceil(data.height / 8));
          p.end();
        },
      );
      output = make(node, `Bloom/mip${level - 1}`, level);
      node.read(source);
      levels.push(output);
    }
    for (let level = 3; level >= 0; level--) {
      const low = levels[level + 1]!,
        high = levels[level]!;
      let output = -1;
      const targetLevel = level + 1;
      const node = graph.add(
        `Bloom/upsample ${level}`,
        { width: extent(targetLevel)[0], height: extent(targetLevel)[1] },
        (data, res, ctx) => {
          const c = ctx.encoder as ShadeGPUCommandContext;
          const u = c.allocateTransientBufferAndLoad(
            new Uint32Array([data.width, data.height]).buffer,
            GPUBufferUsage.UNIFORM,
          );
          const g = this.device.createBindGroup({
            layout: this.upLayout,
            entries: [
              { binding: 0, resource: resolveTextureView(res.get(low)) },
              { binding: 1, resource: resolveTextureView(res.get(high)) },
              { binding: 2, resource: resolveTextureView(res.get(output)) },
              { binding: 3, resource: { buffer: u } },
              { binding: 4, resource: this.sampler },
            ],
          });
          const p = c.beginComputePass({ label: `Bloom/upsample ${level}` });
          p.setPipeline(this.upPipeline);
          p.setBindGroup(1, g);
          p.dispatchWorkgroups(Math.ceil(data.width / 8), Math.ceil(data.height / 8));
          p.end();
        },
      );
      output = make(node, `Bloom/up${level}`, targetLevel);
      node.read(low);
      node.read(high);
      levels[level] = output;
    }
    let output = -1;
    const composite = graph.add(
      "Bloom/composite HDR",
      { width: input.width, height: input.height },
      (data, res, ctx) => {
        const c = ctx.encoder as ShadeGPUCommandContext;
        const u = c.allocateTransientBufferAndLoad(
          new Uint32Array([data.width, data.height]).buffer,
          GPUBufferUsage.UNIFORM,
        );
        const g = this.device.createBindGroup({
          layout: this.compositeLayout,
          entries: [
            { binding: 0, resource: resolveTextureView(res.get(input.scene)) },
            { binding: 1, resource: resolveTextureView(res.get(levels[0]!)) },
            { binding: 2, resource: resolveTextureView(res.get(output)) },
            { binding: 3, resource: { buffer: u } },
            { binding: 4, resource: this.sampler },
          ],
        });
        const p = c.beginComputePass({ label: "Bloom/composite HDR" });
        p.setPipeline(this.compositePipeline);
        p.setBindGroup(2, g);
        p.dispatchWorkgroups(Math.ceil(data.width / 8), Math.ceil(data.height / 8));
        p.end();
      },
    );
    output = composite.create("Bloom/bloom HDR", {
      kind: "transient_texture",
      width: input.width,
      height: input.height,
      format: "rgba16float",
      domain: "output-full",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    composite.read(levels[0]!);
    composite.read(input.scene);
    return output;
  }
  destroy(): void {}
}
export const BLOOM_WGSL = WGSL;

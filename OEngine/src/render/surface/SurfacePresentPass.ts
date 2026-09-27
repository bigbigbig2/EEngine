import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";

export const SURFACE_PRESENT_WGSL = /* wgsl */ `
@group(0) @binding(0) var surface_radiance:texture_2d<f32>;
@group(0) @binding(1) var<uniform> output_size:vec2u;
@group(0) @binding(2) var<storage,read> adapted_exposure:array<f32>;
@group(0) @binding(3) var display_lut:texture_3d<f32>;
@group(0) @binding(4) var display_lut_sampler:sampler;
@vertex fn vs(@builtin(vertex_index) index:u32)->@builtin(position) vec4f {
  return vec4f(f32((index<<1u)&2u)*2.0-1.0,
    f32(index&2u)*2.0-1.0,0.0,1.0);
}
@fragment fn fs(@builtin(position) position:vec4f)->@location(0) vec4f {
  let size=textureDimensions(surface_radiance);
  let pixel=min(vec2u(position.xy)*size/output_size,size-vec2u(1u));
  let hdr=textureLoad(surface_radiance,vec2i(pixel),0).rgb*adapted_exposure[0];
  let mapped=textureSampleLevel(display_lut,display_lut_sampler,
    clamp(tonemap_gt7(hdr,1000.0,100.0),vec3f(0.0),vec3f(1.0)),0.0).rgb;
  return vec4f(pow(clamp(mapped,vec3f(0.0),vec3f(1.0)),vec3f(1.0/2.2)),1.0);
}
fn gt7_channel(x:f32)->f32 {
  let peak=10.0; let mid=0.538; let linear=0.444; let toe=1.280;
  let dst=(linear-1.0)/(0.25-1.0);
  let ka=peak*linear+peak*dst;
  let kb=-peak*dst*exp(linear/dst);
  let kc=-1.0/(dst*peak);
  if(x<=0.0){return 0.0;}
  let t=smoothstep(0.0,mid,x);
  let toeValue=mid*pow(x/mid,toe);
  return select(ka+kb*exp(x*kc),mix(toeValue,x,t),x<linear*peak);
}
fn gt7(rgb:vec3f)->vec3f {
  let m=vec3f(gt7_channel(rgb.r),gt7_channel(rgb.g),gt7_channel(rgb.b));
  return m/(1.0+max(max(m.r,m.g),m.b)/10.0);
}
const REC709_TO_REC2020=mat3x3f(
  vec3f(0.6274040,0.0690970,0.0163916),
  vec3f(0.3292820,0.9195400,0.0880132),
  vec3f(0.0433136,0.0113612,0.8955950));
const REC2020_TO_REC709=mat3x3f(
  vec3f(1.6604910,-0.1245505,-0.0181508),
  vec3f(-0.5876411,1.1328999,-0.1005789),
  vec3f(-0.0728499,-0.0083494,1.1187297));
fn pq_encode(x:f32)->f32 {
  let y=pow(max(x,0.0),0.1593017578125);
  return exp2(78.84375*(log2(0.8359375+18.8515625*y)-log2(1.0+18.6875*y)));
}
fn pq_decode(x:f32)->f32 {
  let y=pow(clamp(x,0.0,1.0),1.0/78.84375);
  return pow(max(y-0.8359375,0.0)/(18.8515625-18.6875*y),1.0/0.1593017578125);
}
fn ictcp_to_rgb(v:vec3f)->vec3f {
  let l=pq_decode(v.x+0.00860904*v.y+0.11103*v.z);
  let m=pq_decode(v.x-0.00860904*v.y-0.11103*v.z);
  let s=pq_decode(v.x+0.560031*v.y-0.320627*v.z);
  return max(vec3f(3.43661*l-2.50645*m+0.0698454*s,
    -0.79133*l+1.9836*m-0.192271*s,
    -0.0259499*l-0.0989137*m+1.12486*s),vec3f(0.0));
}
fn rgb_to_ictcp(v:vec3f)->vec3f {
  let l=pq_encode((1688.0*v.r+2146.0*v.g+262.0*v.b)/4096.0);
  let m=pq_encode((683.0*v.r+2951.0*v.g+462.0*v.b)/4096.0);
  let s=pq_encode((99.0*v.r+309.0*v.g+3688.0*v.b)/4096.0);
  return vec3f((2048.0*l+2048.0*m)/4096.0,
    (6610.0*l-13613.0*m+7003.0*s)/4096.0,
    (17933.0*l-17390.0*m-543.0*s)/4096.0);
}
fn tonemap_gt7(rgb:vec3f,peak_nits:f32,paper_white_nits:f32)->vec3f {
  let t3=paper_white_nits/100.0;
  let cursor=REC709_TO_REC2020*rgb*t3;
  let format=peak_nits/100.0; let lin=0.444; let mid=0.538; let toe=1.280;
  let dst=(lin-1.0)/(0.25-1.0);
  let ka=format*lin+format*dst; let kb=-format*dst*exp(lin/dst);
  let kc=-1.0/(dst*format);
  let mapped=vec3f(gt7_channel(cursor.r),gt7_channel(cursor.g),gt7_channel(cursor.b));
  let ict=rgb_to_ictcp(cursor); let mappedIct=rgb_to_ictcp(mapped);
  let chroma=mix(ict.yz*(1.0-smoothstep(0.7,1.0,ict.x)),mappedIct.yz,0.7);
  return REC2020_TO_REC709*(ictcp_to_rgb(vec3f(mappedIct.x,chroma.x,chroma.y))/t3);
}
`;

/** Presents the completed Surface/FSR3 radiance; queue overflow is resolved in Surface. */
export class SurfacePresentPass {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPURenderPipeline;
  private readonly lutTexture: GPUTexture;
  private readonly lutView: GPUTextureView;
  private readonly lutSampler: GPUSampler;

  constructor(private readonly device: GPUDevice, format: GPUTextureFormat) {
    const lutSize = 16;
    this.lutTexture = device.createTexture({ label: "Presentation/SDR static display LUT",
      size: [lutSize, lutSize, lutSize], dimension: "3d", format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const lut = new Uint8Array(lutSize * lutSize * lutSize * 4);
    let offset = 0;
    for (let b = 0; b < lutSize; b++) for (let g = 0; g < lutSize; g++) {
      for (let r = 0; r < lutSize; r++) {
        // Static LUT slot: neutral grade for the pinned display profile.
        lut[offset++] = Math.round(r * 255 / (lutSize - 1));
        lut[offset++] = Math.round(g * 255 / (lutSize - 1));
        lut[offset++] = Math.round(b * 255 / (lutSize - 1));
        lut[offset++] = 255;
      }
    }
    device.queue.writeTexture({ texture: this.lutTexture }, lut,
      { bytesPerRow: lutSize * 4, rowsPerImage: lutSize },
      { width: lutSize, height: lutSize, depthOrArrayLayers: lutSize });
    this.lutView = this.lutTexture.createView({ dimension: "3d" });
    this.lutSampler = device.createSampler({ label: "Presentation/SDR LUT linear",
      minFilter: "linear", magFilter: "linear", addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge" });
    this.layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "unfilterable-float" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "3d" } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } }
    ] });
    const module = device.createShaderModule({ code: SURFACE_PRESENT_WGSL });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" }
    });
  }

  addToGraph(graph: FrameGraph, input: ResourceId, swapchain: ResourceId,
    exposure: ResourceId, width: number, height: number): ResourceId {
    const present = graph.add("Surface/present radiance", {}, (_data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const size = command.allocateTransientBufferAndLoad(
        new Uint32Array([width, height, 0, 0]).buffer, GPUBufferUsage.UNIFORM);
      const bind = this.device.createBindGroup({ layout: this.layout, entries: [
        { binding: 0, resource: resolveTextureView(resources.get(input)) },
        { binding: 1, resource: { buffer: size } }
        ,{ binding: 2, resource: { buffer: resources.get(exposure) as GPUBuffer } },
        { binding: 3, resource: this.lutView },
        { binding: 4, resource: this.lutSampler }
      ] });
      const pass = command.beginRenderPass({ label: "Surface/present radiance",
        colorAttachments: [{ view: resolveTextureView(resources.get(swapchain)),
          loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
      pass.setPipeline(this.pipeline); pass.setBindGroup(0, bind); pass.draw(3); pass.end();
    });
    present.read(input); present.read(exposure); present.write(swapchain);
    return swapchain;
  }

  destroy(): void { this.lutTexture.destroy(); }
}

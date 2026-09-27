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
    clamp(gt7(hdr),vec3f(0.0),vec3f(1.0)),0.0).rgb;
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

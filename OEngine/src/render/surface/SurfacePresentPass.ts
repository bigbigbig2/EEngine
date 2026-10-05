import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { GpuBindGroupResourceCache } from "../../gpu/GpuBindGroupResourceCache.js";
import { buildHdrDisplayLut, buildSdrDisplayLut, type SdrGradeOptions } from "./DisplayColorGrading.js";

export const SURFACE_PRESENT_WGSL = /* wgsl */ `
@group(0) @binding(0) var surface_radiance:texture_2d<f32>;
@group(0) @binding(1) var<uniform> output_size:vec2u;
@group(0) @binding(2) var<storage,read> adapted_exposure:array<f32>;
@group(0) @binding(3) var display_lut:texture_3d<f32>;
@group(0) @binding(4) var display_lut_sampler:sampler;
@group(0) @binding(5) var<storage,read> pre_exposure:array<f32>;
@vertex fn vs(@builtin(vertex_index) index:u32)->@builtin(position) vec4f {
  return vec4f(f32((index<<1u)&2u)*2.0-1.0,
    f32(index&2u)*2.0-1.0,0.0,1.0);
}
@fragment fn fs(@builtin(position) position:vec4f)->@location(0) vec4f {
  let size=textureDimensions(surface_radiance);
  let pixel=min(vec2u(position.xy)*size/output_size,size-vec2u(1u));
  let hdr=textureLoad(surface_radiance,vec2i(pixel),0).rgb*
    (adapted_exposure[0]/max(pre_exposure[0],1e-6));
  let encoded=clamp(vec3f(
    linear_to_logc(hdr.r),linear_to_logc(hdr.g),linear_to_logc(hdr.b)),
    vec3f(0.0),vec3f(1.0));
  let lut_size=f32(textureDimensions(display_lut).x);
  let uvw=(encoded*(lut_size-1.0)+vec3f(0.5))/lut_size;
  return vec4f(textureSampleLevel(display_lut,display_lut_sampler,uvw,0.0).rgb,1.0);
}
fn linear_to_logc(x:f32)->f32 {
  return 0.244161*log2(5.555556*max(0.0,x)+0.047996)/log2(10.0)+0.386036;
}
`;

/** EEngine HDR specialization: static Filament grade and GT7 live in an extended
 * rgba16float LUT. The canvas receives linear Display-P3 with 250-nit units. */
export const SURFACE_PRESENT_HDR_WGSL = /* wgsl */ `
@group(0) @binding(0) var surface_radiance:texture_2d<f32>;
@group(0) @binding(1) var<uniform> output_size:vec2u;
@group(0) @binding(2) var<storage,read> adapted_exposure:array<f32>;
@group(0) @binding(3) var display_lut:texture_3d<f32>;
@group(0) @binding(4) var display_lut_sampler:sampler;
@group(0) @binding(5) var<storage,read> pre_exposure:array<f32>;
fn linear_to_logc(x:f32)->f32 {
  return 0.244161*log2(5.555556*max(0.0,x)+0.047996)/log2(10.0)+0.386036;
}
@vertex fn vs(@builtin(vertex_index) index:u32)->@builtin(position) vec4f {
  return vec4f(f32((index<<1u)&2u)*2.0-1.0,
    f32(index&2u)*2.0-1.0,0.0,1.0);
}
@fragment fn fs_hdr(@builtin(position) position:vec4f)->@location(0) vec4f {
  let extent=textureDimensions(surface_radiance);
  let pixel=min(vec2u(position.xy)*extent/output_size,extent-vec2u(1u));
  let scene=textureLoad(surface_radiance,vec2i(pixel),0).rgb*
    (adapted_exposure[0]/max(pre_exposure[0],1e-6));
  let encoded=clamp(vec3f(linear_to_logc(scene.r),linear_to_logc(scene.g),
    linear_to_logc(scene.b)),vec3f(0.0),vec3f(1.0));
  let lut_size=f32(textureDimensions(display_lut).x);
  let uvw=(encoded*(lut_size-1.0)+vec3f(0.5))/lut_size;
  return vec4f(textureSampleLevel(display_lut,display_lut_sampler,uvw,0.0).rgb,1.0);
}
`;

/** Debug views are authored in display-linear colors, so they must bypass the
 * scene exposure and display LUT used by the production radiance path. */
export const SURFACE_PRESENT_DEBUG_WGSL = /* wgsl */ `
@group(0) @binding(0) var debug_color:texture_2d<f32>;
@group(0) @binding(1) var<uniform> output_size:vec2u;
@vertex fn vs(@builtin(vertex_index) index:u32)->@builtin(position) vec4f {
  return vec4f(f32((index<<1u)&2u)*2.0-1.0,
    f32(index&2u)*2.0-1.0,0.0,1.0);
}
@fragment fn fs(@builtin(position) position:vec4f)->@location(0) vec4f {
  let extent=textureDimensions(debug_color);
  let pixel=min(vec2u(position.xy)*extent/output_size,extent-vec2u(1u));
  return vec4f(clamp(textureLoad(debug_color,vec2i(pixel),0).rgb,
    vec3f(0.0),vec3f(1.0)),1.0);
}
`;

/** Presents the completed Surface/FSR3 radiance; queue overflow is resolved in Surface. */
export class SurfacePresentPass {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPURenderPipeline;
  private readonly debugLayout: GPUBindGroupLayout;
  private readonly debugPipeline: GPURenderPipeline;
  private readonly lutTexture: GPUTexture;
  private readonly lutView: GPUTextureView;
  private readonly lutSampler: GPUSampler;
  private readonly profile: "sdr" | "hdr";
  private readonly size: GPUBuffer;
  private readonly bindings = new GpuBindGroupResourceCache();
  private readonly debugBindings = new GpuBindGroupResourceCache();

  constructor(private readonly device: GPUDevice, format: GPUTextureFormat,
    profile: "sdr" | "hdr" = "sdr") {
    this.profile = profile;
    this.size = device.createBuffer({ label: "Surface/present size", size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const lutSize = 32;
    this.lutTexture = device.createTexture({ label: `Presentation/${profile} static display LUT`,
      size: [lutSize, lutSize, lutSize], dimension: "3d",
      format: profile === "hdr" ? "rgba16float" : "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const lut = profile === "hdr" ? buildHdrDisplayLut(lutSize) : buildSdrDisplayLut(lutSize);
    device.queue.writeTexture({ texture: this.lutTexture }, lut,
      { bytesPerRow: lutSize * (profile === "hdr" ? 8 : 4), rowsPerImage: lutSize },
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
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } }
    ] });
    const module = device.createShaderModule({
      code: profile === "hdr" ? SURFACE_PRESENT_HDR_WGSL : SURFACE_PRESENT_WGSL });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: profile === "hdr" ? "fs_hdr" : "fs",
        targets: [{ format }] },
      primitive: { topology: "triangle-list" }
    });
    this.debugLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "unfilterable-float" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }
    ] });
    const debugModule = device.createShaderModule({ code: SURFACE_PRESENT_DEBUG_WGSL });
    this.debugPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.debugLayout] }),
      vertex: { module: debugModule, entryPoint: "vs" },
      fragment: { module: debugModule, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" }
    });
  }

  /** Rebuild only when static color-grade parameters change. */
  setGrade(options: SdrGradeOptions): void {
    const size = 32;
    this.device.queue.writeTexture({ texture: this.lutTexture },
      this.profile === "hdr" ? buildHdrDisplayLut(size, options) : buildSdrDisplayLut(size, options),
      { bytesPerRow: size * (this.profile === "hdr" ? 8 : 4), rowsPerImage: size },
      { width: size, height: size, depthOrArrayLayers: size });
  }

  addToGraph(graph: FrameGraph, input: ResourceId, swapchain: ResourceId,
    exposure: ResourceId, preExposure: ResourceId, width: number, height: number,
    debug = false): ResourceId {
    const present = graph.add(debug ? "Surface/present debug color" : "Surface/present radiance", {}, (_data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const size = this.size;
      command.writeBuffer(size, 0, new Uint32Array([width, height, 0, 0]).buffer, 0, 16);
      const entries: GPUBindGroupEntry[] = debug
        ? [
          { binding: 0, resource: resolveTextureView(resources.get(input)) },
          { binding: 1, resource: { buffer: size } }
        ]
        : [
          { binding: 0, resource: resolveTextureView(resources.get(input)) },
          { binding: 1, resource: { buffer: size } },
          { binding: 2, resource: { buffer: resources.get(exposure) as GPUBuffer } },
          { binding: 3, resource: this.lutView },
          { binding: 4, resource: this.lutSampler },
          { binding: 5, resource: { buffer: resources.get(preExposure) as GPUBuffer } }
        ];
      const layout = debug ? this.debugLayout : this.layout;
      const bind = (debug ? this.debugBindings : this.bindings).obtain(entries.map(entry => entry.resource),
        () => this.device.createBindGroup({ layout, entries }));
      const pass = command.beginRenderPass({ label: debug ? "Surface/present debug color" : "Surface/present radiance",
        colorAttachments: [{ view: resolveTextureView(resources.get(swapchain)),
          loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
      pass.setPipeline(debug ? this.debugPipeline : this.pipeline); pass.setBindGroup(0, bind); pass.draw(3); pass.end();
    });
    present.read(input);
    if (!debug) { present.read(exposure); present.read(preExposure); }
    present.write(swapchain);
    return swapchain;
  }

  destroy(): void { this.lutTexture.destroy(); this.size.destroy(); this.bindings.clear(); this.debugBindings.clear(); }
}

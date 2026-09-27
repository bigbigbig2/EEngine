import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";

/** Presents the completed Surface/FSR3 radiance; queue overflow is resolved in Surface. */
export class SurfacePresentPass {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPURenderPipeline;

  constructor(private readonly device: GPUDevice, format: GPUTextureFormat) {
    this.layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "unfilterable-float" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }
    ] });
    const module = device.createShaderModule({ code: /* wgsl */ `
      @group(0) @binding(0) var surface_radiance:texture_2d<f32>;
      @group(0) @binding(1) var<uniform> output_size:vec2u;
      @vertex fn vs(@builtin(vertex_index) index:u32)->@builtin(position) vec4f {
        return vec4f(f32((index<<1u)&2u)*2.0-1.0,
          f32(index&2u)*2.0-1.0,0.0,1.0);
      }
      @fragment fn fs(@builtin(position) position:vec4f)->@location(0) vec4f {
        let size=textureDimensions(surface_radiance);
        let pixel=min(vec2u(position.xy)*size/output_size,size-vec2u(1u));
        return vec4f(textureLoad(surface_radiance,vec2i(pixel),0).rgb,1.0);
      }` });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" }
    });
  }

  addToGraph(graph: FrameGraph, input: ResourceId, swapchain: ResourceId,
    width: number, height: number): void {
    const present = graph.add("Surface/present radiance", {}, (_data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const size = command.allocateTransientBufferAndLoad(
        new Uint32Array([width, height, 0, 0]).buffer, GPUBufferUsage.UNIFORM);
      const bind = this.device.createBindGroup({ layout: this.layout, entries: [
        { binding: 0, resource: resolveTextureView(resources.get(input)) },
        { binding: 1, resource: { buffer: size } }
      ] });
      const pass = command.beginRenderPass({ label: "Surface/present radiance",
        colorAttachments: [{ view: resolveTextureView(resources.get(swapchain)),
          loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
      pass.setPipeline(this.pipeline); pass.setBindGroup(0, bind); pass.draw(3); pass.end();
    });
    present.read(input); present.write(swapchain);
  }
}

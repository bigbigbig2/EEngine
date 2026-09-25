import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { SHADING_WORK_WGSL } from "./ShadingWorkAbi.js";
import { SHADING_FREQUENCY_ANCHOR_WGSL } from "../../shaders/shading_frequency.js";

/** Presents the current Surface radiance and exposes queue overflow as an error color. */
export class SurfacePresentPass {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPURenderPipeline;
  private readonly adaptiveLayout: GPUBindGroupLayout;
  private readonly adaptivePipeline: GPURenderPipeline;

  constructor(private readonly device: GPUDevice, format: GPUTextureFormat) {
    this.layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } }
    ] });
    this.adaptiveLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } }
    ] });
    const source = (adaptive: boolean) => /* wgsl */ `
      ${SHADING_WORK_WGSL}
      @group(0) @binding(0) var surface_radiance: texture_2d<f32>;
      @group(0) @binding(1) var<uniform> output_size: vec2u;
      @group(0) @binding(2) var<storage, read> work: ShadingWorkQueueRead;
      ${adaptive ? "@group(0) @binding(3) var<storage, read> frequency_plan: array<u32>;" : ""}
      ${adaptive ? SHADING_FREQUENCY_ANCHOR_WGSL : ""}
      @vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
        return vec4f(f32((index << 1u) & 2u) * 2.0 - 1.0,
                     f32(index & 2u) * 2.0 - 1.0, 0.0, 1.0);
      }
      @fragment fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
        if work.header.overflow != 0u { return vec4f(1.0, 0.0, 1.0, 1.0); }
        let size = textureDimensions(surface_radiance);
        let pixel = min(vec2u(position.xy) * size / output_size, size - vec2u(1u));
        ${adaptive ? "let sample_pixel = oengine_shading_anchor(pixel, size.x);" : "let sample_pixel = pixel;"}
        return vec4f(textureLoad(surface_radiance, vec2i(sample_pixel), 0).rgb, 1.0);
      }
    `;
    const pipeline = (adaptive: boolean) => {
      const module = device.createShaderModule({ code: source(adaptive) });
      return device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [adaptive
        ? this.adaptiveLayout : this.layout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" }
      });
    };
    this.pipeline = pipeline(false);
    this.adaptivePipeline = pipeline(true);
  }

  addToGraph(graph: FrameGraph, input: ResourceId, queue: ResourceId, swapchain: ResourceId,
    width: number, height: number, frequencyPlan?: ResourceId): void {
    const present = graph.add("Surface/present radiance", {}, (_data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const size = command.allocateTransientBufferAndLoad(
        new Uint32Array([width, height, 0, 0]).buffer, GPUBufferUsage.UNIFORM
      );
      const bind = this.device.createBindGroup({ layout: frequencyPlan === undefined
        ? this.layout : this.adaptiveLayout, entries: [
        { binding: 0, resource: resolveTextureView(resources.get(input)) },
        { binding: 1, resource: { buffer: size } },
        { binding: 2, resource: { buffer: resources.get(queue) as GPUBuffer } },
        ...(frequencyPlan === undefined ? [] : [{ binding: 3,
          resource: { buffer: resources.get(frequencyPlan) as GPUBuffer } }])
      ] });
      const pass = command.gpu_encoder.beginRenderPass({ colorAttachments: [{
        view: resolveTextureView(resources.get(swapchain)), loadOp: "clear", storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 }
      }] });
      pass.setPipeline(frequencyPlan === undefined ? this.pipeline : this.adaptivePipeline);
      pass.setBindGroup(0, bind);
      pass.draw(3);
      pass.end();
    });
    present.read(input);
    present.read(queue);
    if (frequencyPlan !== undefined) present.read(frequencyPlan);
    present.write(swapchain);
  }
}

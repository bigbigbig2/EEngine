import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { SHADING_FREQUENCY_ANCHOR_WGSL } from "../../shaders/shading_frequency.js";

/** Materialize spatial Surface products before full-rate environment and temporal consumers. */
export class SurfaceFrequencyResolvePass {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;

  constructor(private readonly device: GPUDevice) {
    const module = device.createShaderModule({ label: "Surface frequency resolve", code: /* wgsl */ `
      @group(0) @binding(0) var radiance_source: texture_2d<f32>;
      @group(0) @binding(1) var motion_source: texture_2d<f32>;
      @group(0) @binding(2) var<storage, read> frequency_plan: array<u32>;
      @group(0) @binding(3) var radiance_destination: texture_storage_2d<rgba16float, write>;
      @group(0) @binding(4) var motion_destination: texture_storage_2d<rg16float, write>;
      ${SHADING_FREQUENCY_ANCHOR_WGSL}
      @compute @workgroup_size(8, 8, 1)
      fn main(@builtin(global_invocation_id) id: vec3u) {
        let size = textureDimensions(radiance_destination);
        if (any(id.xy >= size)) { return; }
        let anchor = oengine_shading_anchor(id.xy, size.x);
        textureStore(radiance_destination, vec2i(id.xy),
          textureLoad(radiance_source, vec2i(anchor), 0));
        textureStore(motion_destination, vec2i(id.xy),
          textureLoad(motion_source, vec2i(anchor), 0));
      }
    ` });
    this.layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: "write-only", format: "rgba16float" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: "write-only", format: "rg16float" } }
    ] });
    this.pipeline = device.createComputePipeline({
      label: "Surface frequency resolve",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module, entryPoint: "main" }
    });
  }

  addToGraph(graph: FrameGraph, radiance: ResourceId, motion: ResourceId,
    frequencyPlan: ResourceId, width: number, height: number): {
    radiance: ResourceId; motion: ResourceId;
  } {
    const builder = graph.add("Surface/materialize frequency result", {}, (_data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const bind = this.device.createBindGroup({ layout: this.layout, entries: [
        { binding: 0, resource: resolveTextureView(resources.get(radiance)) },
        { binding: 1, resource: resolveTextureView(resources.get(motion)) },
        { binding: 2, resource: { buffer: resources.get(frequencyPlan) as GPUBuffer } },
        { binding: 3, resource: resolveTextureView(resources.get(outputRadiance)) },
        { binding: 4, resource: resolveTextureView(resources.get(outputMotion)) }
      ] });
      const pass = command.beginComputePass({ label: "Surface/materialize frequency result" });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      pass.end();
    });
    const outputRadiance = builder.create("Surface/full-rate radiance", {
      kind: "transient_texture", width, height, format: "rgba16float", domain: "internal-full",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });
    const outputMotion = builder.create("Surface/full-rate motion", {
      kind: "transient_texture", width, height, format: "rg16float", domain: "internal-full",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });
    builder.read(radiance);
    builder.read(motion);
    builder.read(frequencyPlan);
    return { radiance: outputRadiance, motion: outputMotion };
  }
}

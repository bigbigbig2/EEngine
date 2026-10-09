import { GpuBindGroupCache } from "../../../gpu/GpuBindGroupResourceCache.js";
import type { FrameGraph } from "../../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../../RenderTargetViews.js";
import { FSR3_ACCUMULATE_WGSL } from "./Fsr3AccumulateShader.js";

export interface Fsr3AccumulatedOutput {
  readonly currentHistory: ResourceId;
  readonly color: ResourceId;
}

export class Fsr3AccumulatePass {
  private readonly bindGroups = new GpuBindGroupCache();
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private readonly sampler: GPUSampler;

  constructor(private readonly device: GPUDevice) {
    this.sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
    const module = device.createShaderModule({ label: "FSR3 Accumulate", code: FSR3_ACCUMULATE_WGSL });
    this.layout = device.createBindGroupLayout({
      entries: [
        ...[0, 1, 2, 3, 4, 5, 6].map((binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: "float" as const },
        })),
        { binding: 7, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
        { binding: 8, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
        { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        {
          binding: 10,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "rgba16float" },
        },
        {
          binding: 11,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "rgba16float" },
        },
      ],
    });
    this.pipeline = device.createComputePipeline({
      label: "FSR3 Accumulate",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module, entryPoint: "main" },
    });
  }

  addToGraph(
    graph: FrameGraph,
    input: {
      color: ResourceId;
      dilatedMotion: ResourceId;
      lumaInstability: ResourceId;
      farthestDepthMip1: ResourceId;
      dilatedReactive: ResourceId;
      newLocks: ResourceId;
      previousHistory: ResourceId;
      currentHistory: ResourceId;
      exposure: ResourceId;
      constants: ResourceId;
      width: number;
      height: number;
    },
  ): Fsr3AccumulatedOutput {
    const builder = graph.add("FSR3/Accumulate", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const bind = this.bindGroups.create(this.device, {
        layout: this.layout,
        entries: [
          { binding: 0, resource: resolveTextureView(resources.get(data.color)) },
          { binding: 1, resource: resolveTextureView(resources.get(data.dilatedMotion)) },
          { binding: 2, resource: resolveTextureView(resources.get(data.lumaInstability)) },
          { binding: 3, resource: resolveTextureView(resources.get(data.farthestDepthMip1)) },
          { binding: 4, resource: resolveTextureView(resources.get(data.dilatedReactive)) },
          { binding: 5, resource: resolveTextureView(resources.get(data.newLocks)) },
          { binding: 6, resource: resolveTextureView(resources.get(data.previousHistory)) },
          { binding: 7, resource: resolveTextureView(resources.get(data.exposure)) },
          { binding: 8, resource: this.sampler },
          { binding: 9, resource: { buffer: resources.get(data.constants) as GPUBuffer } },
          { binding: 10, resource: resolveTextureView(resources.get(data.currentHistory)) },
          { binding: 11, resource: resolveTextureView(resources.get(output)) },
        ],
      });
      const pass = command.beginComputePass({ label: "FSR3 Accumulate" });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(data.width / 8), Math.ceil(data.height / 8));
      pass.end();
    });
    const output = builder.create("FSR3/upscaled color", {
      kind: "transient_texture",
      width: input.width,
      height: input.height,
      format: "rgba16float",
      domain: "output-full",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    for (const resource of [
      input.color,
      input.dilatedMotion,
      input.lumaInstability,
      input.farthestDepthMip1,
      input.dilatedReactive,
      input.newLocks,
      input.previousHistory,
      input.exposure,
      input.constants,
    ])
      builder.read(resource);
    const currentHistory = builder.write(input.currentHistory);
    return { currentHistory, color: output };
  }
}

/** Bloom reconstruction consuming the shared FinalColorPyramid. */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { createNativeTextureView } from "../../gpu/GPUTextureDescriptors.js";
import {
  BLOOM_COMPOSITE_WGSL,
  BLOOM_EXTRACT_WGSL,
  BLOOM_FORMAT,
  BLOOM_MIP_COUNT,
  BLOOM_RECONSTRUCT_WGSL,
  BLOOM_UPSAMPLE_FACTOR,
  BLOOM_VERTEX_WGSL
} from "../../shaders/bloom.js";
import {
  LINEAR_CLAMP_SAMPLER_DESCRIPTOR,
  type GPUSamplerCache
} from "../../gpu/GPUSamplerCache.js";
import type { FinalColorPyramidFrame } from "../pipeline/FrameProducts.js";

export type BloomJob = {
  intensity?: number;
  mipCount?: number;
  samplers: GPUSamplerCache;
};

export type BloomOutputs = {
  composited: ResourceId;
  reconstructed: ResourceId;
  /** Normalization derived from the actual, resolution-clamped mip count. */
  normalization: number;
};

export class BloomPass {
  private readonly extractPipeline: CachedRenderPipelineDescriptor;
  private readonly reconstructPipeline: CachedRenderPipelineDescriptor;
  private readonly compositePipeline: CachedRenderPipelineDescriptor;

  lastReconstructPasses = 0;
  lastCompositePasses = 0;
  lastConsumedPyramidMips = 0;

  constructor(graphics: GraphicsContext) {
    if (graphics.device === null) {
      throw new Error("BloomPass: GraphicsContext has no device");
    }
    this.extractPipeline = createPipelineDescriptor(
      "Renderer/Bloom extract shared low mip",
      BLOOM_EXTRACT_WGSL,
      createBloomExtractGroupLayout()
    );
    this.reconstructPipeline = createPipelineDescriptor(
      "Renderer/Bloom reconstruct shared pyramid",
      BLOOM_RECONSTRUCT_WGSL,
      createBloomReconstructGroupLayout()
    );
    this.compositePipeline = createPipelineDescriptor(
      "Renderer/Bloom composite",
      BLOOM_COMPOSITE_WGSL,
      createBloomCompositeGroupLayout()
    );
  }

  addToGraph(
    graph: FrameGraph,
    input: FinalColorPyramidFrame,
    job: BloomJob,
    options: { readonly composite: boolean } = { composite: true }
  ): BloomOutputs {
    const availableLowMips = Math.max(1, input.mipLevelCount - 1);
    const mipCount = Math.max(
      1,
      Math.min(job.mipCount ?? BLOOM_MIP_COUNT, BLOOM_MIP_COUNT, availableLowMips)
    );
    const sourceBaseMip = input.mipLevelCount > 1 ? 1 : 0;
    const normalization = bloomWeightNormalization(mipCount);
    const width = Math.max(1, input.domain.width >> sourceBaseMip);
    const height = Math.max(1, input.domain.height >> sourceBaseMip);

    let reconstructed = -1;
    const reconstructBuilder = graph.add(
      "Bloom reconstruct from FinalColorPyramid",
      { mipCount, sourceBaseMip, samplers: job.samplers },
      (data, resources, context) => {
        const command = requireShadeCommandContext(context.encoder);
        const source = resolveTexture(resources.get(input.texture));
        const output = resolveTexture(resources.get(reconstructed));
        const sampler = data.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR);
        const smallest = data.mipCount - 1;
        this.draw(
          command,
          this.extractPipeline,
          "Bloom extract smallest shared mip",
          createNativeTextureView(output, { baseMipLevel: smallest, mipLevelCount: 1 }),
          [createNativeTextureView(source, {
            baseMipLevel: data.sourceBaseMip + smallest,
            mipLevelCount: 1
          })]
        );
        for (let mip = smallest - 1; mip >= 0; mip--) {
          this.draw(
            command,
            this.reconstructPipeline,
            `Bloom reconstruct mip ${mip}`,
            createNativeTextureView(output, { baseMipLevel: mip, mipLevelCount: 1 }),
            [
              createNativeTextureView(source, {
                baseMipLevel: data.sourceBaseMip + mip,
                mipLevelCount: 1
              }),
              createNativeTextureView(output, { baseMipLevel: mip + 1, mipLevelCount: 1 }),
              sampler
            ]
          );
        }
        this.lastReconstructPasses = data.mipCount;
        this.lastConsumedPyramidMips = data.mipCount;
      }
    );
    reconstructed = reconstructBuilder.create("Bloom reconstructed pyramid", {
      kind: "transient_texture",
      width,
      height,
      format: BLOOM_FORMAT,
      mipLevelCount: mipCount,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      domain: "output-full"
    });
    reconstructBuilder.read(input.texture);

    if (!options.composite) {
      this.lastCompositePasses = 0;
      return { composited: input.source, reconstructed, normalization };
    }

    let composited = -1;
    const compositeBuilder = graph.add(
      "Bloom composite shared pyramid",
      {
        intensity: job.intensity ?? 1,
        normalization,
        samplers: job.samplers
      },
      (data, resources, context) => {
        const command = requireShadeCommandContext(context.encoder);
        this.executeComposite(
          command,
          data.intensity / data.normalization,
          resolveTextureView(resources.get(reconstructed), { baseMipLevel: 0, mipLevelCount: 1 }),
          resolveTextureView(resources.get(input.source)),
          data.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR),
          resolveTextureView(resources.get(composited))
        );
        this.lastCompositePasses = 1;
      }
    );
    composited = compositeBuilder.create("Bloom composited", {
      kind: "transient_texture",
      width: input.domain.width,
      height: input.domain.height,
      format: BLOOM_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      domain: "output-full"
    });
    compositeBuilder.read(reconstructed);
    compositeBuilder.read(input.source);
    return { composited, reconstructed, normalization };
  }

  resetFrameEvidence(): void {
    this.lastReconstructPasses = 0;
    this.lastCompositePasses = 0;
    this.lastConsumedPyramidMips = 0;
  }

  private draw(
    command: ShadeGPUCommandContext,
    pipeline: CachedRenderPipelineDescriptor,
    label: string,
    output: GPUTextureView,
    resources: GPUBindingResource[]
  ): void {
    drawFullscreen(command, pipeline, [resources], output, label);
  }

  private executeComposite(
    command: ShadeGPUCommandContext,
    intensity: number,
    bloom: GPUTextureView,
    scene: GPUTextureView,
    sampler: GPUSampler,
    output: GPUTextureView
  ): void {
    const settingsBuffer = command.allocateTransientBufferAndLoad(
      new Float32Array([intensity]).buffer,
      GPUBufferUsage.UNIFORM
    );
    drawFullscreen(
      command,
      this.compositePipeline,
      [[bloom, scene, sampler, { buffer: settingsBuffer }]],
      output,
      "Bloom composite"
    );
  }

  destroy(): void {}
}

export function bloomWeightNormalization(mipCount = BLOOM_MIP_COUNT): number {
  let weight = 1;
  for (let mip = 1; mip < mipCount; mip++) {
    weight = BLOOM_UPSAMPLE_FACTOR * weight + 1;
  }
  return weight;
}

function createBloomExtractGroupLayout(): GPUBindGroupLayoutDescriptor {
  return {
    label: "Renderer/Bloom extract group0",
    entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } }]
  };
}

function createBloomReconstructGroupLayout(): GPUBindGroupLayoutDescriptor {
  return {
    label: "Renderer/Bloom reconstruct group0",
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } }
    ]
  };
}

function createBloomCompositeGroupLayout(): GPUBindGroupLayoutDescriptor {
  return {
    label: "Renderer/Bloom composite group0",
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }
    ]
  };
}

function createPipelineDescriptor(
  label: string,
  code: string,
  group0: GPUBindGroupLayoutDescriptor
): CachedRenderPipelineDescriptor {
  const vertexModule = { label: "", code: BLOOM_VERTEX_WGSL };
  const fragmentModule = { label: "", code };
  return {
    label,
    layout: { label: `${label} layout`, bindGroupLayouts: [group0] },
    vertex: { module: vertexModule, entryPoint: "main" },
    fragment: { module: fragmentModule, entryPoint: "main", targets: [{ format: BLOOM_FORMAT }] },
    primitive: { topology: "triangle-list", cullMode: "none" }
  };
}

function drawFullscreen(
  command: ShadeGPUCommandContext,
  pipeline: CachedRenderPipelineDescriptor,
  bindings: GPUBindingResource[][],
  output: GPUTextureView,
  label: string
): void {
  const pass = command.constructRenderPass({
    label,
    pipeline,
    bindings,
    colorAttachments: [{
      view: output,
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
      loadOp: "clear",
      storeOp: "store"
    }]
  });
  pass.draw(3, 1, 0, 0);
  pass.end();
}

function requireShadeCommandContext(value: unknown): ShadeGPUCommandContext {
  if (
    value && typeof value === "object" &&
    "isGPUCommandContext" in value &&
    (value as { isGPUCommandContext?: unknown }).isGPUCommandContext === true &&
    "constructRenderPass" in value
  ) return value as ShadeGPUCommandContext;
  throw new Error("BloomPass requires ShadeGPUCommandContext");
}

function resolveTexture(resource: unknown): GPUTexture {
  if (resource && typeof resource === "object") {
    if ("createView" in resource && typeof (resource as GPUTexture).createView === "function") return resource as GPUTexture;
    if ("gpu_texture" in resource) return (resource as { gpu_texture: GPUTexture }).gpu_texture;
  }
  throw new Error("BloomPass resource is not a GPUTexture");
}

function resolveTextureView(resource: unknown, descriptor?: GPUTextureViewDescriptor): GPUTextureView {
  if (resource && typeof resource === "object") {
    if ("createView" in resource && typeof (resource as GPUTexture).createView === "function") {
      return createNativeTextureView(resource as GPUTexture, descriptor);
    }
    if ("gpu_texture" in resource) {
      return createNativeTextureView((resource as { gpu_texture: GPUTexture }).gpu_texture, descriptor);
    }
  }
  if (!descriptor) return resource as GPUTextureView;
  throw new Error("BloomPass mip view requires a GPUTexture");
}

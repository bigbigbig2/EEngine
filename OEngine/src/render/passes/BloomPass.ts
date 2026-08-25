/**
 * BloomPass：实现渲染管线中的独立渲染阶段。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { createNativeTextureView } from "../../gpu/GPUTextureDescriptors.js";
import {
  BLOOM_COMPOSITE_WGSL,
  BLOOM_DOWNSAMPLE_WGSL,
  BLOOM_FORMAT,
  BLOOM_MIP_COUNT,
  BLOOM_PREFILTER_WGSL,
  BLOOM_UPSAMPLE_FACTOR,
  BLOOM_UPSAMPLE_WGSL,
  BLOOM_VERTEX_WGSL
} from "../../shaders/bloom.js";
import {
  LINEAR_CLAMP_SAMPLER_DESCRIPTOR,
  type GPUSamplerCache
} from "../../gpu/GPUSamplerCache.js";

export type BloomJob = {
  width: number;
  height: number;
  intensity?: number;
  mipCount?: number;
  samplers: GPUSamplerCache;
};

export type BloomOutputs = {
  composited: ResourceId;
  downsampled: ResourceId;
};

export class BloomPass {
  private readonly prefilterPipeline: CachedRenderPipelineDescriptor;
  private readonly downsamplePipeline: CachedRenderPipelineDescriptor;
  private readonly upsamplePipeline: CachedRenderPipelineDescriptor;
  private readonly compositePipeline: CachedRenderPipelineDescriptor;

  constructor(graphics: GraphicsContext) {
    if (graphics.device === null) {
      throw new Error("BloomPass: GraphicsContext has no device");
    }
    const downsampleGroup = createBloomDownsampleGroupLayout();
    this.prefilterPipeline = createPipelineDescriptor(
      "Renderer/Bloom kE",
      BLOOM_PREFILTER_WGSL,
      downsampleGroup
    );
    this.downsamplePipeline = createPipelineDescriptor(
      "Renderer/Bloom jE",
      BLOOM_DOWNSAMPLE_WGSL,
      downsampleGroup
    );
    this.upsamplePipeline = createPipelineDescriptor(
      "Renderer/Bloom RE",
      BLOOM_UPSAMPLE_WGSL,
      createBloomUpsampleGroupLayout()
    );
    this.compositePipeline = createPipelineDescriptor(
      "Renderer/Bloom GE",
      BLOOM_COMPOSITE_WGSL,
      createBloomCompositeGroupLayout()
    );
  }

  addToGraph(graph: FrameGraph, input: ResourceId, job: BloomJob): BloomOutputs {
    this.init();
    const mipCount = Math.max(1, Math.min(job.mipCount ?? BLOOM_MIP_COUNT, BLOOM_MIP_COUNT));
    const halfWidth = Math.max(1, job.width >> 1);
    const halfHeight = Math.max(1, job.height >> 1);

    let downsampled = -1;
    const downsampleBuilder = graph.add(
      "Bloom downsample kE/jE",
      { mipCount, samplers: job.samplers },
      (data, resources, context) => {
        const command = requireShadeCommandContext(context.encoder);
        const source = resolveTextureView(resources.get(input));
        const output = resolveTexture(resources.get(downsampled));
        const sampler = data.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR);
        this.draw(
          command,
          this.prefilterPipeline,
          "Bloom prefilter kE",
          createNativeTextureView(output, { baseMipLevel: 0, mipLevelCount: 1 }),
          [source, sampler]
        );
        let previous = createNativeTextureView(output, { baseMipLevel: 0, mipLevelCount: 1 });
        for (let mip = 1; mip < data.mipCount; mip++) {
          const target = createNativeTextureView(output, { baseMipLevel: mip, mipLevelCount: 1 });
          this.draw(command, this.downsamplePipeline, `Bloom downsample jE mip ${mip}`, target, [previous, sampler]);
          previous = target;
        }
      }
    );
    downsampled = downsampleBuilder.create("Bloom downscale map", {
      kind: "transient_texture",
      width: halfWidth,
      height: halfHeight,
      format: BLOOM_FORMAT,
      mipLevelCount: mipCount,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    downsampleBuilder.read(input);

    let upsampled = -1;
    const upsampleBuilder = graph.add(
      "Bloom upscale RE",
      { mipCount, samplers: job.samplers },
      (data, resources, context) => {
        const command = requireShadeCommandContext(context.encoder);
        const source = resolveTexture(resources.get(downsampled));
        const output = resolveTexture(resources.get(upsampled));
        const sampler = data.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR);
        let previous = createNativeTextureView(source, { baseMipLevel: data.mipCount - 1, mipLevelCount: 1 });
        for (let mip = data.mipCount - 2; mip >= 0; mip--) {
          const current = createNativeTextureView(source, { baseMipLevel: mip, mipLevelCount: 1 });
          const target = createNativeTextureView(output, { baseMipLevel: mip, mipLevelCount: 1 });
          this.draw(command, this.upsamplePipeline, `Bloom upscale RE mip ${mip}`, target, [current, previous, sampler]);
          previous = target;
        }
      }
    );
    upsampled = upsampleBuilder.create("Bloom upscale map", {
      kind: "transient_texture",
      width: halfWidth,
      height: halfHeight,
      format: BLOOM_FORMAT,
      mipLevelCount: mipCount,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    upsampleBuilder.read(downsampled);

    let composited = -1;
    const normalizedIntensity = (job.intensity ?? 1) / bloomWeightNormalization(mipCount);
    const compositeBuilder = graph.add(
      "Bloom composite GE",
      { normalizedIntensity, samplers: job.samplers },
      (data, resources, context) => {
        const command = requireShadeCommandContext(context.encoder);
        this.executeComposite(
          command,
          data.normalizedIntensity,
          resolveTextureView(resources.get(upsampled), { baseMipLevel: 0, mipLevelCount: 1 }),
          resolveTextureView(resources.get(input)),
          data.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR),
          resolveTextureView(resources.get(composited))
        );
      }
    );
    composited = compositeBuilder.create("Bloom composited", {
      kind: "transient_texture",
      width: job.width,
      height: job.height,
      format: BLOOM_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    compositeBuilder.read(upsampled);
    compositeBuilder.read(input);
    return { composited, downsampled };
  }

  private init(): void {}

  private draw(
    command: ShadeGPUCommandContext,
    pipeline: CachedRenderPipelineDescriptor,
    label: string,
    output: GPUTextureView,
    resources: Array<GPUTextureView | GPUSampler>
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
      "Bloom composite GE"
    );
  }

  destroy(): void {}
}

export function bloomWeightNormalization(mipCount = BLOOM_MIP_COUNT): number {
  let weight = 1;
  for (let mip = 0; mip < mipCount; mip++) weight = BLOOM_UPSAMPLE_FACTOR * weight + 1;
  return weight;
}

function createBloomDownsampleGroupLayout(): GPUBindGroupLayoutDescriptor {
  return {
    label: "Renderer/Bloom kE-jE group0",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float", viewDimension: "2d" }
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "filtering" }
      }
    ]
  };
}

function createBloomUpsampleGroupLayout(): GPUBindGroupLayoutDescriptor {
  return {
    label: "Renderer/Bloom RE group0",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float", viewDimension: "2d" }
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float", viewDimension: "2d" }
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "filtering" }
      }
    ]
  };
}

function createBloomCompositeGroupLayout(): GPUBindGroupLayoutDescriptor {
  return {
    label: "Renderer/Bloom GE group0",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float", viewDimension: "2d" }
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "unfilterable-float", viewDimension: "2d" }
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "filtering" }
      },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" }
      }
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
    layout: {
      label: `${label} layout`,
      bindGroupLayouts: [group0]
    },
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
    colorAttachments: [{ view: output, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }]
  });
  pass.draw(3, 1, 0, 0);
  pass.end();
}

function requireShadeCommandContext(value: unknown): ShadeGPUCommandContext {
  if (
    value &&
    typeof value === "object" &&
    "isGPUCommandContext" in value &&
    (value as { isGPUCommandContext?: unknown }).isGPUCommandContext === true &&
    "constructRenderPass" in value
  ) {
    return value as ShadeGPUCommandContext;
  }
  throw new Error("BloomPass: cached kE/jE/RE/GE require ShadeGPUCommandContext");
}

function resolveTexture(resource: unknown): GPUTexture {
  if (resource && typeof resource === "object") {
    if ("createView" in resource && typeof (resource as GPUTexture).createView === "function") return resource as GPUTexture;
    if ("gpu_texture" in resource) return (resource as { gpu_texture: GPUTexture }).gpu_texture;
  }
  throw new Error("BloomPass: resource is not a GPUTexture");
}

function resolveTextureView(resource: unknown, descriptor?: GPUTextureViewDescriptor): GPUTextureView {
  if (resource && typeof resource === "object") {
    if ("createView" in resource && typeof (resource as GPUTexture).createView === "function") {
      return createNativeTextureView(resource as GPUTexture, descriptor);
    }
    if ("gpu_texture" in resource) {
      return createNativeTextureView(
        (resource as { gpu_texture: GPUTexture }).gpu_texture,
        descriptor
      );
    }
  }
  if (!descriptor) return resource as GPUTextureView;
  throw new Error("BloomPass: mip view requires a GPUTexture");
}

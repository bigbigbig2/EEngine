/**
 * The unique FrameGraph producer for ADR-0009 shared HDR color pyramids.
 *
 * This owner never guesses that differently staged colors are interchangeable:
 * opaque and final products use separate graph resources and typed contracts.
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import {
  LINEAR_CLAMP_SAMPLER_DESCRIPTOR,
  type GPUSamplerCache
} from "../../gpu/GPUSamplerCache.js";
import { textureMipLevelCount } from "../../gpu/GPUTextureContext.js";
import { createNativeTextureView } from "../../gpu/GPUTextureDescriptors.js";
import {
  SHARED_COLOR_PYRAMID_COPY_WGSL,
  SHARED_COLOR_PYRAMID_DOWNSAMPLE_WGSL,
  SHARED_COLOR_PYRAMID_FORMAT,
  SHARED_OPAQUE_PYRAMID_DEPTH_AWARE_WGSL
} from "../../shaders/shared_color_pyramid.js";
import {
  finalColorPyramidFrame,
  opaqueColorPyramidFrame,
  textureDomain,
  type FinalColorPyramidFrame,
  type PreExposedOpaqueHdrBaselineFrame,
  type OpaqueColorPyramidFrame,
  type PreExposureContract
} from "../pipeline/FrameProducts.js";
import { resolveDepthAttachmentView, resolveTextureView } from "../RenderTargetViews.js";

export const SHARED_COLOR_PYRAMID_ABI_VERSION = 1;
export const OPAQUE_COLOR_PYRAMID_MAX_MIPS = 5;
export const FINAL_COLOR_PYRAMID_MAX_MIPS = 6;

export interface SharedColorPyramidJob {
  readonly width: number;
  readonly height: number;
  readonly mipLevelCount: number;
  readonly sourceGeneration: number;
  readonly preExposure: PreExposureContract;
  readonly samplers: GPUSamplerCache;
}

export interface SharedColorPyramidEvidence {
  readonly opaqueBuilds: number;
  readonly opaqueRenderPasses: number;
  readonly opaqueMipLevelCount: number;
  readonly finalBuilds: number;
  readonly finalRenderPasses: number;
  readonly finalMipLevelCount: number;
  readonly allocatedBytes: number;
}

export class SharedColorPyramidPass {
  private readonly copyPipeline: CachedRenderPipelineDescriptor;
  private readonly depthAwarePipeline: CachedRenderPipelineDescriptor;
  private readonly downsamplePipeline: CachedRenderPipelineDescriptor;

  private opaqueBuilds = 0;
  private opaqueRenderPasses = 0;
  private opaqueMipLevelCount = 0;
  private finalBuilds = 0;
  private finalRenderPasses = 0;
  private finalMipLevelCount = 0;
  private allocatedBytes = 0;

  constructor(graphics: GraphicsContext) {
    if (graphics.device === null) {
      throw new Error("SharedColorPyramidPass: GraphicsContext has no device");
    }
    this.copyPipeline = pipeline(
      "SharedColorPyramid/copy-mip0",
      SHARED_COLOR_PYRAMID_COPY_WGSL,
      copyLayout()
    );
    this.depthAwarePipeline = pipeline(
      "SharedColorPyramid/opaque-depth-aware-mip1",
      SHARED_OPAQUE_PYRAMID_DEPTH_AWARE_WGSL,
      depthAwareLayout()
    );
    this.downsamplePipeline = pipeline(
      "SharedColorPyramid/downsample",
      SHARED_COLOR_PYRAMID_DOWNSAMPLE_WGSL,
      downsampleLayout()
    );
  }

  addOpaqueToGraph(
    graph: FrameGraph,
    source: PreExposedOpaqueHdrBaselineFrame,
    depth: ResourceId,
    job: SharedColorPyramidJob
  ): OpaqueColorPyramidFrame {
    validateJob(job, source.domain.width, source.domain.height);
    const mipLevelCount = boundedMipCount(job, OPAQUE_COLOR_PYRAMID_MAX_MIPS);
    const texture = this.addProducer(
      graph,
      "OpaqueColorPyramid",
      source.hdr,
      depth,
      { ...job, mipLevelCount },
      true
    );
    return opaqueColorPyramidFrame({
      texture,
      mipLevelCount,
      stage: "post-screen-space-diffuse-pre-ssr",
      sourceGeneration: job.sourceGeneration,
      preExposure: job.preExposure,
      domain: source.domain
    });
  }

  addFinalToGraph(
    graph: FrameGraph,
    source: ResourceId,
    job: SharedColorPyramidJob
  ): FinalColorPyramidFrame {
    validateJob(job, job.width, job.height);
    const mipLevelCount = boundedMipCount(job, FINAL_COLOR_PYRAMID_MAX_MIPS);
    const texture = this.addProducer(
      graph,
      "FinalColorPyramid",
      source,
      null,
      { ...job, mipLevelCount },
      false
    );
    return finalColorPyramidFrame({
      // Preserve the exact pre-pyramid HDR resource. Bloom's optional
      // materialized composite and the no-composite identity path must not
      // silently substitute the copied pyramid mip 0 for their source.
      source,
      texture,
      mipLevelCount,
      stage: "post-transparency-temporal",
      sourceGeneration: job.sourceGeneration,
      preExposure: job.preExposure,
      domain: textureDomain("output-full", job.width, job.height, 1)
    });
  }

  resetFrameEvidence(): void {
    this.opaqueBuilds = 0;
    this.opaqueRenderPasses = 0;
    this.opaqueMipLevelCount = 0;
    this.finalBuilds = 0;
    this.finalRenderPasses = 0;
    this.finalMipLevelCount = 0;
    this.allocatedBytes = 0;
  }

  evidence(): SharedColorPyramidEvidence {
    return Object.freeze({
      opaqueBuilds: this.opaqueBuilds,
      opaqueRenderPasses: this.opaqueRenderPasses,
      opaqueMipLevelCount: this.opaqueMipLevelCount,
      finalBuilds: this.finalBuilds,
      finalRenderPasses: this.finalRenderPasses,
      finalMipLevelCount: this.finalMipLevelCount,
      allocatedBytes: this.allocatedBytes
    });
  }

  destroy(): void {}

  private addProducer(
    graph: FrameGraph,
    label: "OpaqueColorPyramid" | "FinalColorPyramid",
    source: ResourceId,
    depth: ResourceId | null,
    job: SharedColorPyramidJob,
    depthAwareFirstReduction: boolean
  ): ResourceId {
    let output = -1;
    const builder = graph.add(
      `${label} shared producer`,
      { ...job, depthAwareFirstReduction },
      (data, resources, context) => {
        const command = requireCommand(context.encoder);
        const sampler = data.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR);
        const texture = resolveTexture(resources.get(output), label);
        const sourceView = resolveTextureView(resources.get(source));
        this.draw(
          command,
          this.copyPipeline,
          `${label}/copy-mip0`,
          createNativeTextureView(texture, { baseMipLevel: 0, mipLevelCount: 1 }),
          [sourceView, sampler]
        );
        let renderPasses = 1;
        for (let mip = 1; mip < data.mipLevelCount; mip++) {
          const previous = createNativeTextureView(texture, {
            baseMipLevel: mip - 1,
            mipLevelCount: 1
          });
          const target = createNativeTextureView(texture, {
            baseMipLevel: mip,
            mipLevelCount: 1
          });
          if (mip === 1 && data.depthAwareFirstReduction) {
            this.draw(
              command,
              this.depthAwarePipeline,
              `${label}/depth-aware-mip1`,
              target,
              [previous, resolveDepthAttachmentView(resources.get(depth!))]
            );
          } else {
            this.draw(
              command,
              this.downsamplePipeline,
              `${label}/downsample-mip${mip}`,
              target,
              [previous, sampler]
            );
          }
          renderPasses++;
        }
        const bytes = pyramidBytes(data.width, data.height, data.mipLevelCount, 8);
        if (label === "OpaqueColorPyramid") {
          this.opaqueBuilds++;
          this.opaqueRenderPasses += renderPasses;
          this.opaqueMipLevelCount = Math.max(this.opaqueMipLevelCount, data.mipLevelCount);
        } else {
          this.finalBuilds++;
          this.finalRenderPasses += renderPasses;
          this.finalMipLevelCount = Math.max(this.finalMipLevelCount, data.mipLevelCount);
        }
        this.allocatedBytes += bytes;
      }
    );
    output = builder.create(label, {
      kind: "transient_texture",
      label,
      width: job.width,
      height: job.height,
      format: SHARED_COLOR_PYRAMID_FORMAT,
      mipLevelCount: job.mipLevelCount,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      domain: label === "OpaqueColorPyramid" ? "internal-full" : "output-full"
    });
    builder.read(source);
    if (depth !== null) builder.read(depth);
    return output;
  }

  private draw(
    command: ShadeGPUCommandContext,
    descriptor: CachedRenderPipelineDescriptor,
    label: string,
    output: GPUTextureView,
    bindings: GPUBindingResource[]
  ): void {
    const pass = command.constructRenderPass({
      label,
      pipeline: descriptor,
      bindings: [bindings],
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
}

function boundedMipCount(job: SharedColorPyramidJob, maximum: number): number {
  return Math.max(
    1,
    Math.min(job.mipLevelCount, maximum, textureMipLevelCount(job.width, job.height))
  );
}

function validateJob(job: SharedColorPyramidJob, width: number, height: number): void {
  if (!Number.isInteger(job.width) || job.width <= 0 ||
      !Number.isInteger(job.height) || job.height <= 0) {
    throw new RangeError("SharedColorPyramid dimensions must be positive integers");
  }
  if (job.width !== width || job.height !== height) {
    throw new Error("SharedColorPyramid job extent does not match its source domain");
  }
  if (!Number.isInteger(job.mipLevelCount) || job.mipLevelCount <= 0) {
    throw new RangeError("SharedColorPyramid mipLevelCount must be positive");
  }
  if (!Number.isSafeInteger(job.sourceGeneration) || job.sourceGeneration < 0) {
    throw new RangeError("SharedColorPyramid sourceGeneration must be non-negative");
  }
}

function pyramidBytes(width: number, height: number, mipCount: number, bytesPerPixel: number): number {
  let total = 0;
  for (let mip = 0; mip < mipCount; mip++) {
    total += Math.max(1, width >> mip) * Math.max(1, height >> mip) * bytesPerPixel;
  }
  return total;
}

function pipeline(
  label: string,
  code: string,
  group0: GPUBindGroupLayoutDescriptor
): CachedRenderPipelineDescriptor {
  const module = { label, code };
  return {
    label,
    layout: { label: `${label}/layout`, bindGroupLayouts: [group0] },
    vertex: { module, entryPoint: "vs_main" },
    fragment: {
      module,
      entryPoint: "fs_main",
      targets: [{ format: SHARED_COLOR_PYRAMID_FORMAT }]
    },
    primitive: { topology: "triangle-list", cullMode: "none" }
  };
}

function copyLayout(): GPUBindGroupLayoutDescriptor {
  return textureLayout("SharedColorPyramid/copy-group0", [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } }
  ]);
}

function depthAwareLayout(): GPUBindGroupLayoutDescriptor {
  return textureLayout("SharedColorPyramid/depth-aware-group0", [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } }
  ]);
}

function downsampleLayout(): GPUBindGroupLayoutDescriptor {
  return textureLayout("SharedColorPyramid/downsample-group0", [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } }
  ]);
}

function textureLayout(
  label: string,
  entries: GPUBindGroupLayoutEntry[]
): GPUBindGroupLayoutDescriptor {
  return { label, entries };
}

function resolveTexture(resource: unknown, label: string): GPUTexture {
  if (resource && typeof resource === "object") {
    if ("createView" in resource && typeof (resource as GPUTexture).createView === "function") {
      return resource as GPUTexture;
    }
    if ("gpu_texture" in resource) {
      return (resource as { gpu_texture: GPUTexture }).gpu_texture;
    }
  }
  throw new Error(`${label} is not a GPUTexture`);
}

function requireCommand(value: unknown): ShadeGPUCommandContext {
  if (
    value && typeof value === "object" &&
    "isGPUCommandContext" in value &&
    (value as { isGPUCommandContext?: unknown }).isGPUCommandContext === true &&
    "constructRenderPass" in value
  ) return value as ShadeGPUCommandContext;
  throw new Error("SharedColorPyramidPass requires ShadeGPUCommandContext");
}

/**
 * OcclusionConfidencePass：实现渲染管线中的独立渲染阶段。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { textureMipLevelCount } from "../../gpu/GPUTextureContext.js";
import { createNativeTextureView } from "../../gpu/GPUTextureDescriptors.js";
import {
  OCCLUSION_CONFIDENCE_FORMAT,
  OCCLUSION_CONFIDENCE_WGSL
} from "../../shaders/occlusion_confidence.js";
import { resolveTextureView } from "../RenderTargetViews.js";

export type OcclusionConfidenceInputs = {
  currentDepth: ResourceId;
  previousDepth: ResourceId;
  velocity: ResourceId;
  currentCamera: ResourceId;
  previousCamera: ResourceId;
};

export type OcclusionConfidenceOutput = {
  occlusionConfidence: ResourceId;
};

export type OcclusionConfidenceJob = {
  width: number;
  height: number;
};

export class OcclusionConfidencePass {
  private readonly pipeline: CachedRenderPipelineDescriptor;
  lastRan = false;

  constructor(graphics: GraphicsContext) {
    if (graphics.device === null) {
      throw new Error("OcclusionConfidencePass: GraphicsContext has no device");
    }
    const module = {
      label: "Renderer/Occlusion confidence yk",
      code: OCCLUSION_CONFIDENCE_WGSL
    };
    this.pipeline = {
      label: "Renderer/Occlusion confidence yk",
      layout: {
        label: "Renderer/Occlusion confidence yk layout",
        bindGroupLayouts: [createOcclusionConfidenceGroupLayout()]
      },
      vertex: { module, entryPoint: "vs_main" },
      fragment: {
        module,
        entryPoint: "fs_main",
        targets: [{ format: OCCLUSION_CONFIDENCE_FORMAT }]
      },
      primitive: { topology: "triangle-list", cullMode: "none" }
    };
  }

  init(): void {}

  addToGraph(
    graph: FrameGraph,
    job: OcclusionConfidenceJob,
    inputs: OcclusionConfidenceInputs
  ): OcclusionConfidenceOutput {
    this.init();
    const width = Math.max(1, job.width | 0);
    const height = Math.max(1, job.height | 0);
    const mipLevelCount = textureMipLevelCount(width, height);
    const output: OcclusionConfidenceOutput = { occlusionConfidence: -1 };
    const self = this;
    const builder = graph.add(
      "Occlusion confidence yk",
      job,
      (data, resources, context) => {
        const command = requireShadeCommandContext(context.encoder);
        const texture = resolveTexture(
          resources.get(output.occlusionConfidence),
          "occlusion confidence"
        );
        self.execute(command, texture, {
          currentDepth: resolveTextureView(resources.get(inputs.currentDepth)),
          previousDepth: resolveTextureView(resources.get(inputs.previousDepth)),
          velocity: resolveTextureView(resources.get(inputs.velocity)),
          currentCamera: resolveBuffer(
            resources.get(inputs.currentCamera),
            "current camera"
          ),
          previousCamera: resolveBuffer(
            resources.get(inputs.previousCamera),
            "previous camera"
          )
        });
      }
    );

    output.occlusionConfidence = builder.create("occlusion confidence", {
      kind: "transient_texture",
      label: "occlusion confidence yk",
      width,
      height,
      format: OCCLUSION_CONFIDENCE_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      mipLevelCount
    });
    builder.read(inputs.currentDepth);
    builder.read(inputs.previousDepth);
    builder.read(inputs.velocity);
    builder.read(inputs.currentCamera);
    builder.read(inputs.previousCamera);
    return output;
  }

  execute(
    command: ShadeGPUCommandContext,
    output: GPUTexture,
    resources: {
      currentDepth: GPUTextureView;
      previousDepth: GPUTextureView;
      velocity: GPUTextureView;
      currentCamera: GPUBuffer;
      previousCamera: GPUBuffer;
    }
  ): void {
    const pass = command.constructRenderPass({
      label: "Occlusion confidence yk mip 0",
      pipeline: this.pipeline,
      bindings: [[
        resources.currentDepth,
        resources.previousDepth,
        resources.velocity,
        { buffer: resources.currentCamera },
        { buffer: resources.previousCamera }
      ]],
      colorAttachments: [
        {
          view: createNativeTextureView(output, {
            baseMipLevel: 0,
            mipLevelCount: 1
          }),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store"
        }
      ]
    });
    pass.draw(3, 1, 0, 0);
    pass.end();
    this.lastRan = true;
  }

  destroy(): void {}
}

function createOcclusionConfidenceGroupLayout(): GPUBindGroupLayoutDescriptor {
  return {
    label: "Renderer/Occlusion confidence yk group0",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "unfilterable-float", viewDimension: "2d" }
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "unfilterable-float", viewDimension: "2d" }
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "unfilterable-float", viewDimension: "2d" }
      },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" }
      },
      {
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" }
      }
    ]
  };
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
  throw new Error("OcclusionConfidencePass: cached yk requires ShadeGPUCommandContext");
}

function resolveTexture(resource: unknown, label: string): GPUTexture {
  if (
    resource &&
    typeof resource === "object" &&
    "createView" in resource &&
    typeof (resource as { createView?: unknown }).createView === "function"
  ) {
    return resource as GPUTexture;
  }
  throw new Error(`OcclusionConfidencePass: missing ${label} texture`);
}

function resolveBuffer(resource: unknown, label: string): GPUBuffer {
  if (resource && typeof resource === "object") {
    if ("size" in resource && "usage" in resource) return resource as GPUBuffer;
    if ("buffer" in resource) {
      const buffer = (resource as { buffer?: unknown }).buffer;
      if (buffer && typeof buffer === "object") return buffer as GPUBuffer;
    }
  }
  throw new Error(`OcclusionConfidencePass: missing ${label} buffer`);
}

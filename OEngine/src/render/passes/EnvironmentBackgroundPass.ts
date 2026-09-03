/**
 * EnvironmentBackgroundPass：实现渲染管线中的独立渲染阶段。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { LINEAR_CLAMP_SAMPLER_DESCRIPTOR } from "../../gpu/GPUSamplerCache.js";
import {
  ENVIRONMENT_BACKGROUND_FORMAT,
  ENVIRONMENT_BACKGROUND_WGSL
} from "../../shaders/environment_ibl.js";
import {
  resolveDepthAttachmentView,
  resolveTextureView
} from "../RenderTargetViews.js";

const ENVIRONMENT_BACKGROUND_LAYOUT: GPUBindGroupLayoutDescriptor = {
  label: "Renderer/Ku/group0-layout",
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" }
    },
    {
      binding: 1,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" }
    },
    {
      binding: 2,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "float" }
    },
    {
      binding: 3,
      visibility: GPUShaderStage.FRAGMENT,
      sampler: { type: "filtering" }
    }
  ]
};

const ENVIRONMENT_BACKGROUND_MODULE: GPUShaderModuleDescriptor = {
  label: "Renderer/environment background Ku",
  code: ENVIRONMENT_BACKGROUND_WGSL
};

const ENVIRONMENT_BACKGROUND_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "Renderer/environment background Ku",
  layout: {
    label: "Renderer/Ku/pipeline-layout",
    bindGroupLayouts: [ENVIRONMENT_BACKGROUND_LAYOUT]
  },
  vertex: {
    module: ENVIRONMENT_BACKGROUND_MODULE,
    entryPoint: "vs_main"
  },
  fragment: {
    module: ENVIRONMENT_BACKGROUND_MODULE,
    entryPoint: "fs_main",
    targets: [{ format: ENVIRONMENT_BACKGROUND_FORMAT }]
  },
  primitive: { topology: "triangle-list", cullMode: "none" },
  depthStencil: {
    format: "depth32float",
    depthWriteEnabled: false,
    depthCompare: "equal"
  }
};

export type EnvironmentBackgroundInputs = {
  hdr: ResourceId;
  depth: ResourceId;
  camera: ResourceId;
  view: ResourceId;
  environment: ResourceId;
};

export type EnvironmentBackgroundOutput = {
  hdr: ResourceId;
};

export class EnvironmentBackgroundPass {
  private pipeline: GPURenderPipeline | null = null;
  lastRan = false;

  constructor(private readonly graphics: GraphicsContext) {}

  init(): void {
    this.pipeline ??= this.graphics.render_pipelines.obtain(
      ENVIRONMENT_BACKGROUND_PIPELINE
    );
  }

  addToGraph(
    graph: FrameGraph,
    inputs: EnvironmentBackgroundInputs
  ): EnvironmentBackgroundOutput {
    this.init();
    const output: EnvironmentBackgroundOutput = { hdr: -1 };
    const builder = graph.add(
      "Environment background Ku",
      inputs,
      (data, resources, context) => {
        const encoder = context.gpu_encoder;
        const pipeline = this.pipeline;
        if (!encoder) throw new Error("EnvironmentBackgroundPass: no encoder");
        if (!pipeline) throw new Error("EnvironmentBackgroundPass not initialized");

        const pass = encoder.beginRenderPass({
          label: "Environment background Ku",
          colorAttachments: [
            {
              view: texture(resources.get(output.hdr)),
              loadOp: "load",
              storeOp: "store"
            }
          ],
          depthStencilAttachment: {
            view: resolveDepthAttachmentView(resources.get(data.depth)),
            depthReadOnly: true
          }
        });
        pass.setPipeline(pipeline);
        this.graphics.setPipelineBindings(
          pass,
          ENVIRONMENT_BACKGROUND_PIPELINE,
          [[
            { buffer: buffer(resources.get(data.camera)) },
            { buffer: buffer(resources.get(data.view)) },
            texture(resources.get(data.environment)),
            this.graphics.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR)
          ]]
        );
        pass.draw(3);
        pass.end();
        this.lastRan = true;
      }
    );

    output.hdr = builder.write(inputs.hdr);
    builder.read(inputs.depth);
    builder.read(inputs.camera);
    builder.read(inputs.view);
    builder.read(inputs.environment);
    return output;
  }

  destroy(): void {
    this.pipeline = null;
  }
}

function texture(value: unknown): GPUTextureView {
  return resolveTextureView(value as GPUTexture | GPUTextureView);
}

function buffer(value: unknown): GPUBuffer {
  if (value && typeof value === "object" && "size" in value && "usage" in value) {
    return value as GPUBuffer;
  }
  throw new Error("EnvironmentBackgroundPass: expected GPUBuffer");
}

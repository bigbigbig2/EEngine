/**
 * IblDiffusePass：实现渲染管线中的独立渲染阶段。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import {
  IBL_DIFFUSE_FORMAT,
  IBL_DIFFUSE_WGSL
} from "../../shaders/environment_ibl.js";
import {
  resolveDepthAttachmentView,
  resolveTextureView
} from "../RenderTargetViews.js";

const IBL_DIFFUSE_LAYOUT: GPUBindGroupLayoutDescriptor = {
  label: "Renderer/uw/group0-layout",
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "uint" }
    },
    {
      binding: 1,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "float" }
    },
    {
      binding: 2,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "float" }
    }
  ]
};

const IBL_DIFFUSE_MODULE: GPUShaderModuleDescriptor = {
  label: "Renderer/IBL diffuse uw",
  code: IBL_DIFFUSE_WGSL
};

const IBL_DIFFUSE_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "Renderer/IBL diffuse uw",
  layout: {
    label: "Renderer/uw/pipeline-layout",
    bindGroupLayouts: [IBL_DIFFUSE_LAYOUT]
  },
  vertex: { module: IBL_DIFFUSE_MODULE, entryPoint: "vs_main" },
  fragment: {
    module: IBL_DIFFUSE_MODULE,
    entryPoint: "fs_main",
    targets: [{ format: IBL_DIFFUSE_FORMAT }]
  },
  primitive: { topology: "triangle-list", cullMode: "none" },
  depthStencil: {
    format: "depth32float",
    depthWriteEnabled: false,
    depthCompare: "not-equal"
  }
};

export type IblDiffuseInputs = {
  bentNormal: ResourceId;
  albedoAo: ResourceId;
  environment: ResourceId;
  depth: ResourceId;
};

export type IblDiffuseOutput = {
  indirectDiffuse: ResourceId;
};

export type IblDiffuseJob = {
  width: number;
  height: number;
};

export class IblDiffusePass {
  private pipeline: GPURenderPipeline | null = null;
  lastRan = false;

  constructor(private readonly graphics: GraphicsContext) {}

  init(): void {
    this.pipeline ??= this.graphics.render_pipelines.obtain(IBL_DIFFUSE_PIPELINE);
  }

  addToGraph(
    graph: FrameGraph,
    job: IblDiffuseJob,
    inputs: IblDiffuseInputs
  ): IblDiffuseOutput {
    this.init();
    const output: IblDiffuseOutput = { indirectDiffuse: -1 };
    const builder = graph.add(
      "IBL indirect diffuse uw",
      inputs,
      (data, resources, context) => {
        const encoder = context.gpu_encoder;
        const pipeline = this.pipeline;
        if (!encoder) throw new Error("IblDiffusePass: no encoder");
        if (!pipeline) throw new Error("IblDiffusePass not initialized");

        const pass = encoder.beginRenderPass({
          label: "IBL indirect diffuse uw",
          colorAttachments: [
            {
              view: texture(resources.get(output.indirectDiffuse)),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: "clear",
              storeOp: "store"
            }
          ],
          depthStencilAttachment: {
            view: resolveDepthAttachmentView(resources.get(data.depth)),
            depthReadOnly: true
          }
        });
        pass.setPipeline(pipeline);
        this.graphics.setPipelineBindings(pass, IBL_DIFFUSE_PIPELINE, [[
          texture(resources.get(data.bentNormal)),
          texture(resources.get(data.albedoAo)),
          texture(resources.get(data.environment))
        ]]);
        pass.draw(3);
        pass.end();
        this.lastRan = true;
      }
    );

    output.indirectDiffuse = builder.create("IBL indirect diffuse", {
      kind: "transient_texture",
      label: "IBL indirect diffuse",
      width: Math.max(1, job.width | 0),
      height: Math.max(1, job.height | 0),
      format: IBL_DIFFUSE_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    });
    builder.read(inputs.bentNormal);
    builder.read(inputs.albedoAo);
    builder.read(inputs.environment);
    builder.read(inputs.depth);
    return output;
  }

  destroy(): void {
    this.pipeline = null;
  }
}

function texture(value: unknown): GPUTextureView {
  return resolveTextureView(value as GPUTexture | GPUTextureView);
}

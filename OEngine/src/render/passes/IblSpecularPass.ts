/**
 * IblSpecularPass：实现渲染管线中的独立渲染阶段。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import {
  IBL_SPECULAR_FORMAT,
  IBL_SPECULAR_WGSL
} from "../../shaders/ibl_specular.js";
import {
  resolveDepthAttachmentView,
  resolveTextureView
} from "./MaterialExpandPass.js";

const IBL_SPECULAR_LAYOUT: GPUBindGroupLayoutDescriptor = {
  label: "Renderer/hw/group0-layout",
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "uint" }
    },
    {
      binding: 1,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "uint" }
    },
    {
      binding: 2,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "float" }
    },
    {
      binding: 3,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "float" }
    },
    {
      binding: 4,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "unfilterable-float" }
    },
    {
      binding: 5,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" }
    }
  ]
};

const IBL_SPECULAR_MODULE: GPUShaderModuleDescriptor = {
  label: "Renderer/IBL specular hw",
  code: IBL_SPECULAR_WGSL
};

const IBL_SPECULAR_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "Renderer/IBL specular hw",
  layout: {
    label: "Renderer/hw/pipeline-layout",
    bindGroupLayouts: [IBL_SPECULAR_LAYOUT]
  },
  vertex: { module: IBL_SPECULAR_MODULE, entryPoint: "vs_main" },
  fragment: {
    module: IBL_SPECULAR_MODULE,
    entryPoint: "fs_main",
    targets: [{ format: IBL_SPECULAR_FORMAT }]
  },
  primitive: { topology: "triangle-list", cullMode: "none" },
  depthStencil: {
    format: "depth32float",
    depthWriteEnabled: false,
    depthCompare: "not-equal"
  }
};

export type IblSpecularInputs = {
  bentNormal: ResourceId;
  normal: ResourceId;
  environment: ResourceId;
  pbr: ResourceId;
  depth: ResourceId;
  camera: ResourceId;
};

export type IblSpecularOutput = {
  indirectSpecular: ResourceId;
};

export type IblSpecularJob = {
  width: number;
  height: number;
};

export class IblSpecularPass {
  private pipeline: GPURenderPipeline | null = null;
  lastRan = false;

  constructor(private readonly graphics: GraphicsContext) {}

  init(): void {
    this.pipeline ??= this.graphics.render_pipelines.obtain(IBL_SPECULAR_PIPELINE);
  }

  addToGraph(
    graph: FrameGraph,
    job: IblSpecularJob,
    inputs: IblSpecularInputs
  ): IblSpecularOutput {
    this.init();
    const output: IblSpecularOutput = { indirectSpecular: -1 };
    const builder = graph.add(
      "IBL indirect specular hw",
      inputs,
      (data, resources, context) => {
        const encoder = context.gpu_encoder;
        const pipeline = this.pipeline;
        if (!encoder) throw new Error("IblSpecularPass: no encoder");
        if (!pipeline) throw new Error("IblSpecularPass not initialized");

        const pass = encoder.beginRenderPass({
          label: "IBL indirect specular hw",
          colorAttachments: [
            {
              view: texture(resources.get(output.indirectSpecular)),
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
        this.graphics.setPipelineBindings(pass, IBL_SPECULAR_PIPELINE, [[
          texture(resources.get(data.bentNormal)),
          texture(resources.get(data.normal)),
          texture(resources.get(data.environment)),
          texture(resources.get(data.pbr)),
          texture(resources.get(data.depth)),
          { buffer: buffer(resources.get(data.camera)) }
        ]]);
        pass.draw(3);
        pass.end();
        this.lastRan = true;
      }
    );

    output.indirectSpecular = builder.create("IBL indirect specular", {
      kind: "transient_texture",
      label: "IBL indirect specular",
      width: Math.max(1, job.width | 0),
      height: Math.max(1, job.height | 0),
      format: IBL_SPECULAR_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    });
    for (const resource of Object.values(inputs)) builder.read(resource);
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
  throw new Error("IblSpecularPass: expected GPUBuffer");
}

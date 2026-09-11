import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import { GPU_HDR_FORMAT } from "../../gpu/GpuHdrAbi.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { SPECULAR_CORRECTION_WGSL } from "../../shaders/specular_correction.js";
import { resolveDepthAttachmentView, resolveTextureView } from "../RenderTargetViews.js";

const GROUP0: GPUBindGroupLayoutDescriptor = {
  label: "Renderer/SpecularCorrection/group0",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }
  ]
};

const MODULE: GPUShaderModuleDescriptor = {
  label: "Renderer/SSR specular correction",
  code: SPECULAR_CORRECTION_WGSL
};

function descriptor(entryPoint: string): CachedRenderPipelineDescriptor {
  return {
    label: `Renderer/SSR specular correction/${entryPoint}`,
    layout: { label: "Renderer/SSR specular correction/layout", bindGroupLayouts: [GROUP0] },
    vertex: { module: MODULE, entryPoint: "vs_main" },
    fragment: {
      module: MODULE,
      entryPoint,
      targets: [{
        format: GPU_HDR_FORMAT,
        blend: {
          color: { operation: "add", srcFactor: "one", dstFactor: "one" },
          alpha: { operation: "add", srcFactor: "zero", dstFactor: "one" }
        }
      }]
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: { format: "depth32float", depthWriteEnabled: false, depthCompare: "not-equal" }
  };
}

const PIPELINE_DESCRIPTOR = descriptor("fs_main");

export interface SpecularCorrectionInputs {
  readonly hdr: ResourceId;
  readonly depth: ResourceId;
  readonly baselineSpecular: ResourceId;
  readonly resolvedSpecular: ResourceId;
  readonly metadata: ResourceId;
}

export class SpecularCorrectionPass {
  private pipeline: GPURenderPipeline | null = null;
  lastRan = false;

  constructor(private readonly graphics: GraphicsContext) {}

  addToGraph(graph: FrameGraph, inputs: SpecularCorrectionInputs): ResourceId {
    const pipeline = this.obtain();
    let output = -1;
    const builder = graph.add("SSR specular correction", inputs, (data, resources, context) => {
      const encoder = context.gpu_encoder;
      if (encoder === undefined) throw new Error("SpecularCorrectionPass: no encoder");
      const pass = encoder.beginRenderPass({
        label: "SSR specular correction",
        colorAttachments: [{ view: texture(resources.get(output)), loadOp: "load", storeOp: "store" }],
        depthStencilAttachment: {
          view: resolveDepthAttachmentView(resources.get(data.depth)),
          depthReadOnly: true
        }
      });
      pass.setPipeline(pipeline);
      this.graphics.setPipelineBindings(pass, PIPELINE_DESCRIPTOR, [[
        texture(resources.get(data.metadata)),
        texture(resources.get(data.baselineSpecular)),
        texture(resources.get(data.resolvedSpecular))
      ]]);
      pass.draw(3);
      pass.end();
      this.lastRan = true;
    });
    output = builder.write(inputs.hdr);
    for (const [name, resource] of Object.entries(inputs)) {
      if (name !== "hdr" && resource !== undefined) builder.read(resource);
    }
    return output;
  }

  private obtain(): GPURenderPipeline {
    if (this.pipeline !== null) return this.pipeline;
    this.pipeline = this.graphics.render_pipelines.obtain(PIPELINE_DESCRIPTOR);
    return this.pipeline;
  }

  destroy(): void {
    this.pipeline = null;
  }
}

function texture(value: unknown): GPUTextureView {
  return resolveTextureView(value as GPUTexture | GPUTextureView);
}

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { LINEAR_CLAMP_SAMPLER_DESCRIPTOR } from "../../gpu/GPUSamplerCache.js";
import { SPECULAR_CORRECTION_WGSL } from "../../shaders/specular_correction.js";
import { resolveDepthAttachmentView, resolveTextureView } from "./MaterialExpandPass.js";

const GROUP0: GPUBindGroupLayoutDescriptor = {
  label: "Renderer/SpecularCorrection/group0",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
    { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } }
  ]
};

const GROUP1: GPUBindGroupLayoutDescriptor = {
  label: "Renderer/SpecularCorrection/group1",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } }
  ]
};

const MODULE: GPUShaderModuleDescriptor = {
  label: "Renderer/SSR specular correction",
  code: SPECULAR_CORRECTION_WGSL
};

function descriptor(entryPoint: string): CachedRenderPipelineDescriptor {
  return {
    label: `Renderer/SSR specular correction/${entryPoint}`,
    layout: { label: "Renderer/SSR specular correction/layout", bindGroupLayouts: [GROUP0, GROUP1] },
    vertex: { module: MODULE, entryPoint: "vs_main" },
    fragment: {
      module: MODULE,
      entryPoint,
      targets: [{
        format: "rgba16float",
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

const DESCRIPTORS = {
  surfaceAo: descriptor("fs_main"),
  surface: descriptor("fs_main_no_ao"),
  legacyAo: descriptor("fs_main_legacy"),
  legacy: descriptor("fs_main_legacy_no_ao")
} as const;

export interface SpecularCorrectionInputs {
  readonly hdr: ResourceId;
  readonly depth: ResourceId;
  readonly normal: ResourceId;
  readonly bentNormal: ResourceId;
  readonly albedoAo: ResourceId;
  readonly pbr: ResourceId;
  readonly splitSum: ResourceId;
  readonly baselineSpecular: ResourceId;
  readonly resolvedSpecular: ResourceId;
  readonly camera: ResourceId;
  readonly ambientVisibility?: ResourceId;
  readonly metadata?: ResourceId;
}

export class SpecularCorrectionPass {
  private readonly pipelines = new Map<keyof typeof DESCRIPTORS, GPURenderPipeline>();
  lastRan = false;

  constructor(private readonly graphics: GraphicsContext) {}

  addToGraph(graph: FrameGraph, inputs: SpecularCorrectionInputs): ResourceId {
    const key: keyof typeof DESCRIPTORS = inputs.metadata !== undefined
      ? (inputs.ambientVisibility !== undefined ? "surfaceAo" : "surface")
      : (inputs.ambientVisibility !== undefined ? "legacyAo" : "legacy");
    const pipeline = this.obtain(key);
    const passDescriptor = DESCRIPTORS[key];
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
      this.graphics.setPipelineBindings(pass, passDescriptor, [
        [
          texture(resources.get(data.normal)),
          texture(resources.get(data.bentNormal)),
          texture(resources.get(data.albedoAo)),
          texture(resources.get(data.pbr)),
          texture(resources.get(data.depth)),
          texture(resources.get(data.metadata ?? data.normal))
        ],
        [
          { buffer: buffer(resources.get(data.camera)) },
          this.graphics.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR),
          texture(resources.get(data.splitSum)),
          texture(resources.get(data.baselineSpecular)),
          texture(resources.get(data.resolvedSpecular)),
          texture(resources.get(data.ambientVisibility ?? data.albedoAo))
        ]
      ]);
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

  private obtain(key: keyof typeof DESCRIPTORS): GPURenderPipeline {
    const existing = this.pipelines.get(key);
    if (existing !== undefined) return existing;
    const pipeline = this.graphics.render_pipelines.obtain(DESCRIPTORS[key]);
    this.pipelines.set(key, pipeline);
    return pipeline;
  }

  destroy(): void {
    this.pipelines.clear();
  }
}

function texture(value: unknown): GPUTextureView {
  return resolveTextureView(value as GPUTexture | GPUTextureView);
}

function buffer(value: unknown): GPUBuffer {
  if (value && typeof value === "object" && "size" in value && "usage" in value) return value as GPUBuffer;
  throw new Error("SpecularCorrectionPass: expected GPUBuffer");
}

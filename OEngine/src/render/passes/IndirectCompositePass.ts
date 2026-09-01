/**
 * IndirectCompositePass：实现渲染管线中的独立渲染阶段。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { LINEAR_CLAMP_SAMPLER_DESCRIPTOR } from "../../gpu/GPUSamplerCache.js";
import {
  INDIRECT_COMPOSITE_FORMAT,
  INDIRECT_COMPOSITE_WGSL
} from "../../shaders/indirect_composite.js";
import {
  resolveDepthAttachmentView,
  resolveTextureView
} from "./MaterialExpandPass.js";

const INDIRECT_COMPOSITE_GROUP0: GPUBindGroupLayoutDescriptor = {
  label: "Renderer/TB/group0-layout",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
    { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } }
  ]
};

const INDIRECT_COMPOSITE_LEGACY_GROUP0: GPUBindGroupLayoutDescriptor = {
  label: "Renderer/TB/legacy-group0-layout",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } }
  ]
};

const INDIRECT_COMPOSITE_GROUP1: GPUBindGroupLayoutDescriptor = {
  label: "Renderer/TB/group1-layout",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }
  ]
};

const INDIRECT_COMPOSITE_MODULE: GPUShaderModuleDescriptor = {
  label: "Renderer/Indirect composite TB",
  code: INDIRECT_COMPOSITE_WGSL
};

const INDIRECT_COMPOSITE_TARGETS: readonly GPUColorTargetState[] = [
  {
    format: INDIRECT_COMPOSITE_FORMAT,
    blend: {
      color: { operation: "add", srcFactor: "one", dstFactor: "one" },
      alpha: { operation: "add", srcFactor: "zero", dstFactor: "one" }
    }
  }
];

const INDIRECT_COMPOSITE_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "Renderer/Indirect composite TB",
  layout: {
    label: "Renderer/TB/pipeline-layout",
    bindGroupLayouts: [INDIRECT_COMPOSITE_GROUP0, INDIRECT_COMPOSITE_GROUP1]
  },
  vertex: { module: INDIRECT_COMPOSITE_MODULE, entryPoint: "vs_main" },
  fragment: {
    module: INDIRECT_COMPOSITE_MODULE,
    entryPoint: "fs_main",
    targets: INDIRECT_COMPOSITE_TARGETS
  },
  primitive: { topology: "triangle-list", cullMode: "none" },
  depthStencil: {
    format: "depth32float",
    depthWriteEnabled: false,
    depthCompare: "not-equal"
  }
};

const INDIRECT_COMPOSITE_LEGACY_PIPELINE: CachedRenderPipelineDescriptor = {
  ...INDIRECT_COMPOSITE_PIPELINE,
  label: "Renderer/Indirect composite TB legacy",
  layout: {
    label: "Renderer/TB/legacy-pipeline-layout",
    bindGroupLayouts: [INDIRECT_COMPOSITE_LEGACY_GROUP0, INDIRECT_COMPOSITE_GROUP1]
  },
  fragment: {
    module: INDIRECT_COMPOSITE_MODULE,
    entryPoint: "fs_main_legacy",
    targets: INDIRECT_COMPOSITE_TARGETS
  }
};

export type IndirectCompositeInputs = {
  hdr: ResourceId;
  depth: ResourceId;
  normal: ResourceId;
  bentNormal: ResourceId;
  albedoAo: ResourceId;
  pbr: ResourceId;
  splitSum: ResourceId;
  indirectDiffuse: ResourceId;
  indirectSpecular: ResourceId;
  camera: ResourceId;
  /** Packed Surface v1 metadata. Legacy Material Expand has no equivalent attachment. */
  metadata?: ResourceId;
};

export type IndirectCompositeOutput = {
  hdr: ResourceId;
};

export class IndirectCompositePass {
  private surfacePipeline: GPURenderPipeline | null = null;
  private legacyPipeline: GPURenderPipeline | null = null;
  lastRan = false;

  constructor(private readonly graphics: GraphicsContext) {}

  init(): void {
    this.surfacePipeline ??= this.graphics.render_pipelines.obtain(
      INDIRECT_COMPOSITE_PIPELINE
    );
    this.legacyPipeline ??= this.graphics.render_pipelines.obtain(
      INDIRECT_COMPOSITE_LEGACY_PIPELINE
    );
  }

  addToGraph(
    graph: FrameGraph,
    inputs: IndirectCompositeInputs
  ): IndirectCompositeOutput {
    this.init();
    const output: IndirectCompositeOutput = { hdr: -1 };
    const builder = graph.add(
      "Indirect composite TB",
      inputs,
      (data, resources, context) => {
        const encoder = context.gpu_encoder;
        const surfaceAware = data.metadata !== undefined;
        const pipeline = surfaceAware ? this.surfacePipeline : this.legacyPipeline;
        const descriptor = surfaceAware
          ? INDIRECT_COMPOSITE_PIPELINE
          : INDIRECT_COMPOSITE_LEGACY_PIPELINE;
        if (!encoder) throw new Error("IndirectCompositePass: no encoder");
        if (!pipeline) throw new Error("IndirectCompositePass not initialized");

        const pass = encoder.beginRenderPass({
          label: "Indirect composite TB",
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
          descriptor,
          [
            [
              texture(resources.get(data.normal)),
              texture(resources.get(data.bentNormal)),
              texture(resources.get(data.albedoAo)),
              texture(resources.get(data.pbr)),
              texture(resources.get(data.depth)),
              ...(data.metadata === undefined
                ? []
                : [texture(resources.get(data.metadata))])
            ],
            [
              { buffer: buffer(resources.get(data.camera)) },
              this.graphics.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR),
              texture(resources.get(data.splitSum)),
              texture(resources.get(data.indirectDiffuse)),
              texture(resources.get(data.indirectSpecular))
            ]
          ]
        );
        pass.draw(3);
        pass.end();
        this.lastRan = true;
      }
    );

    output.hdr = builder.write(inputs.hdr);
    for (const [name, resource] of Object.entries(inputs)) {
      if (name !== "hdr" && resource !== undefined) builder.read(resource);
    }
    return output;
  }

  destroy(): void {
    this.surfacePipeline = null;
    this.legacyPipeline = null;
  }
}

function texture(value: unknown): GPUTextureView {
  return resolveTextureView(value as GPUTexture | GPUTextureView);
}

function buffer(value: unknown): GPUBuffer {
  if (value && typeof value === "object" && "size" in value && "usage" in value) {
    return value as GPUBuffer;
  }
  throw new Error("IndirectCompositePass: expected GPUBuffer");
}

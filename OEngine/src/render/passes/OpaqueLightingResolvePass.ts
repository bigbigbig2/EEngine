/**
 * OpaqueLightingResolvePass：统一不透明 HDR 的 IBL/间接光解析阶段。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { LINEAR_CLAMP_SAMPLER_DESCRIPTOR } from "../../gpu/GPUSamplerCache.js";
import {
  OPAQUE_LIGHTING_RESOLVE_FORMAT,
  OPAQUE_LIGHTING_RESOLVE_WGSL
} from "../../shaders/opaque_lighting_resolve.js";
import {
  resolveDepthAttachmentView,
  resolveTextureView
} from "../RenderTargetViews.js";

const OPAQUE_LIGHTING_RESOLVE_GROUP0: GPUBindGroupLayoutDescriptor = {
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

const OPAQUE_LIGHTING_RESOLVE_LEGACY_GROUP0: GPUBindGroupLayoutDescriptor = {
  label: "Renderer/TB/legacy-group0-layout",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } }
  ]
};

const OPAQUE_LIGHTING_RESOLVE_GROUP1: GPUBindGroupLayoutDescriptor = {
  label: "Renderer/TB/group1-layout",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } }
  ]
};

const OPAQUE_LIGHTING_RESOLVE_MODULE: GPUShaderModuleDescriptor = {
  label: "Renderer/Opaque lighting resolve",
  code: OPAQUE_LIGHTING_RESOLVE_WGSL
};

const OPAQUE_LIGHTING_RESOLVE_TARGETS: readonly GPUColorTargetState[] = [
  {
    format: OPAQUE_LIGHTING_RESOLVE_FORMAT,
    blend: {
      color: { operation: "add", srcFactor: "one", dstFactor: "one" },
      alpha: { operation: "add", srcFactor: "zero", dstFactor: "one" }
    }
  }
];

const OPAQUE_LIGHTING_RESOLVE_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "Renderer/Opaque lighting resolve",
  layout: {
    label: "Renderer/TB/pipeline-layout",
    bindGroupLayouts: [OPAQUE_LIGHTING_RESOLVE_GROUP0, OPAQUE_LIGHTING_RESOLVE_GROUP1]
  },
  vertex: { module: OPAQUE_LIGHTING_RESOLVE_MODULE, entryPoint: "vs_main" },
  fragment: {
    module: OPAQUE_LIGHTING_RESOLVE_MODULE,
    entryPoint: "fs_main",
    targets: OPAQUE_LIGHTING_RESOLVE_TARGETS
  },
  primitive: { topology: "triangle-list", cullMode: "none" },
  depthStencil: {
    format: "depth32float",
    depthWriteEnabled: false,
    depthCompare: "not-equal"
  }
};

const OPAQUE_LIGHTING_RESOLVE_LEGACY_PIPELINE: CachedRenderPipelineDescriptor = {
  ...OPAQUE_LIGHTING_RESOLVE_PIPELINE,
  label: "Renderer/Opaque lighting resolve legacy",
  layout: {
    label: "Renderer/TB/legacy-pipeline-layout",
    bindGroupLayouts: [OPAQUE_LIGHTING_RESOLVE_LEGACY_GROUP0, OPAQUE_LIGHTING_RESOLVE_GROUP1]
  },
  fragment: {
    module: OPAQUE_LIGHTING_RESOLVE_MODULE,
    entryPoint: "fs_main_legacy",
    targets: OPAQUE_LIGHTING_RESOLVE_TARGETS
  }
};

const OPAQUE_LIGHTING_RESOLVE_NO_AO_PIPELINE: CachedRenderPipelineDescriptor = {
  ...OPAQUE_LIGHTING_RESOLVE_PIPELINE,
  label: "Renderer/Opaque lighting resolve no ambient AO",
  fragment: {
    module: OPAQUE_LIGHTING_RESOLVE_MODULE,
    entryPoint: "fs_main_no_ao",
    targets: OPAQUE_LIGHTING_RESOLVE_TARGETS
  }
};

const OPAQUE_LIGHTING_RESOLVE_LEGACY_NO_AO_PIPELINE: CachedRenderPipelineDescriptor = {
  ...OPAQUE_LIGHTING_RESOLVE_LEGACY_PIPELINE,
  label: "Renderer/Opaque lighting resolve legacy no ambient AO",
  fragment: {
    module: OPAQUE_LIGHTING_RESOLVE_MODULE,
    entryPoint: "fs_main_legacy_no_ao",
    targets: OPAQUE_LIGHTING_RESOLVE_TARGETS
  }
};

export type OpaqueLightingResolveInputs = {
  hdr: ResourceId;
  depth: ResourceId;
  normal: ResourceId;
  bentNormal: ResourceId;
  albedoAo: ResourceId;
  pbr: ResourceId;
  splitSum: ResourceId;
  indirectDiffuse: ResourceId;
  indirectSpecular: ResourceId;
  /** GTAO ambient visibility; material AO remains in albedoAo.a. */
  ambientVisibility?: ResourceId;
  camera: ResourceId;
  /** Packed Surface v1 metadata. Legacy Material Expand has no equivalent attachment. */
  metadata?: ResourceId;
};

export type OpaqueLightingResolveOutput = {
  hdr: ResourceId;
};

export class OpaqueLightingResolvePass {
  private surfacePipeline: GPURenderPipeline | null = null;
  private legacyPipeline: GPURenderPipeline | null = null;
  private surfaceNoAoPipeline: GPURenderPipeline | null = null;
  private legacyNoAoPipeline: GPURenderPipeline | null = null;
  lastRan = false;

  constructor(private readonly graphics: GraphicsContext) {}

  init(): void {
    this.surfacePipeline ??= this.graphics.render_pipelines.obtain(
      OPAQUE_LIGHTING_RESOLVE_PIPELINE
    );
    this.legacyPipeline ??= this.graphics.render_pipelines.obtain(
      OPAQUE_LIGHTING_RESOLVE_LEGACY_PIPELINE
    );
    this.surfaceNoAoPipeline ??= this.graphics.render_pipelines.obtain(
      OPAQUE_LIGHTING_RESOLVE_NO_AO_PIPELINE
    );
    this.legacyNoAoPipeline ??= this.graphics.render_pipelines.obtain(
      OPAQUE_LIGHTING_RESOLVE_LEGACY_NO_AO_PIPELINE
    );
  }

  addToGraph(
    graph: FrameGraph,
    inputs: OpaqueLightingResolveInputs
  ): OpaqueLightingResolveOutput {
    this.init();
    const output: OpaqueLightingResolveOutput = { hdr: -1 };
    const builder = graph.add(
      "Opaque lighting resolve",
      inputs,
      (data, resources, context) => {
        const encoder = context.gpu_encoder;
        const surfaceAware = data.metadata !== undefined;
        const aoAware = data.ambientVisibility !== undefined;
        const pipeline = surfaceAware
          ? (aoAware ? this.surfacePipeline : this.surfaceNoAoPipeline)
          : (aoAware ? this.legacyPipeline : this.legacyNoAoPipeline);
        const descriptor = surfaceAware
          ? (aoAware ? OPAQUE_LIGHTING_RESOLVE_PIPELINE : OPAQUE_LIGHTING_RESOLVE_NO_AO_PIPELINE)
          : (aoAware ? OPAQUE_LIGHTING_RESOLVE_LEGACY_PIPELINE : OPAQUE_LIGHTING_RESOLVE_LEGACY_NO_AO_PIPELINE);
        if (!encoder) throw new Error("OpaqueLightingResolvePass: no encoder");
        if (!pipeline) throw new Error("OpaqueLightingResolvePass not initialized");

        const pass = encoder.beginRenderPass({
          label: "Opaque lighting resolve",
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
              texture(resources.get(data.indirectSpecular)),
              texture(resources.get(data.ambientVisibility ?? data.albedoAo))
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
    this.surfaceNoAoPipeline = null;
    this.legacyNoAoPipeline = null;
  }
}

function texture(value: unknown): GPUTextureView {
  return resolveTextureView(value as GPUTexture | GPUTextureView);
}

function buffer(value: unknown): GPUBuffer {
  if (value && typeof value === "object" && "size" in value && "usage" in value) {
    return value as GPUBuffer;
  }
  throw new Error("OpaqueLightingResolvePass: expected GPUBuffer");
}

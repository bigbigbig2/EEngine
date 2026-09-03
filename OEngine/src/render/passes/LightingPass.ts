/**
 * 光照阶段：读取 G-Buffer、灯光簇、阴影和间接光数据，合成场景光照结果。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import {
  LINEAR_CLAMP_SAMPLER_DESCRIPTOR,
  SHADOW_COMPARISON_SAMPLER_DESCRIPTOR
} from "../../gpu/GPUSamplerCache.js";
import {
  LIGHTING_DIRECT_WGSL
} from "../../shaders/lighting_direct.js";
import { HDR_COLOR_FORMAT } from "../RenderTargets.js";
import {
  resolveDepthAttachmentView,
  resolveTextureView
} from "../RenderTargetViews.js";

export const LIGHTING_MIGRATION_GAP = [
  "authored lighting_direct.ts owns the runtime pipeline"
] as const;

export const LIGHTING_STEPS = [
  "obtain Ch filtering/comparison samplers through kP",
  "create hdr_color / lighting X",
  "obtain Ch iu layouts and GB render pipeline",
  "bind Ch group0 GBuffer",
  "bind Ch group1 Tl/environment/cluster/shadow atlas",
  "bind Ch group2 Yu view + Td camera",
  "fullscreen draw(3) with Vu depth not-equal/read-only"
] as const;

export type LightingJob = {
  width: number;
  height: number;
  surfaceMetadataAvailable: boolean;
};

export type LightingInputs = {
  gPbr: ResourceId;
  gNormal: ResourceId;
  gAlbedo: ResourceId;
  gEmissive: ResourceId;
  gMetadata: ResourceId;
  depth: ResourceId;
  lightDatabase: ResourceId;
  environment: ResourceId;
  clusterParameters: ResourceId;
  clusterLookup: ResourceId;
  clusterData: ResourceId;
  activeLightList: ResourceId;
  shadowAtlas: ResourceId;
  camera: ResourceId;
  view: ResourceId;
};

export type LightingGraphOutputs = { hdr: ResourceId };

const CH_GROUP_0_LAYOUT: GPUBindGroupLayoutDescriptor = {
  label: "",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
    { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
    { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } }
  ]
};

const CH_GROUP_1_LAYOUT: GPUBindGroupLayoutDescriptor = {
  label: "",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
    { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
    { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
    { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
    { binding: 7, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } }
  ]
};

const CH_GROUP_2_LAYOUT: GPUBindGroupLayoutDescriptor = {
  label: "",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }
  ]
};

const CH_COLOR_TARGET = {
  label: "",
  format: HDR_COLOR_FORMAT
} as GPUColorTargetState & { label: string };

const CH_PIPELINE = createLightingPipeline(LIGHTING_DIRECT_WGSL);
const CH_LEGACY_PIPELINE = createLightingPipeline(
  LIGHTING_DIRECT_WGSL.replace(
    "const OENGINE_LIGHTING_HAS_SURFACE_METADATA: bool = true;",
    "const OENGINE_LIGHTING_HAS_SURFACE_METADATA: bool = false;"
  )
);

function createLightingPipeline(
  code: string
): CachedRenderPipelineDescriptor {
  return {
  label: "",
  layout: {
    label: "",
    bindGroupLayouts: [
      CH_GROUP_0_LAYOUT,
      CH_GROUP_1_LAYOUT,
      CH_GROUP_2_LAYOUT
    ]
  },
  primitive: { topology: "triangle-list", cullMode: "none" },
  depthStencil: {
    format: "depth32float",
    depthWriteEnabled: false,
    depthCompare: "not-equal"
  },
  vertex: {
    module: { label: "", code },
    entryPoint: "vs_main",
    buffers: []
  },
  multisample: {},
  fragment: {
    module: { label: "", code },
    entryPoint: "fs_main",
    targets: [CH_COLOR_TARGET]
  }
  };
}

/** 汇总材质表面、灯光簇、阴影和环境光数据，输出 HDR 光照结果。 */
export class LightingPass {
  lastRan = false;

  constructor(private readonly graphics: GraphicsContext) {}

  init(): void {}

  /** 把光照计算加入帧图，并声明所有 G-Buffer 与光照资源依赖。 */
  addToGraph(
    graph: FrameGraph,
    job: LightingJob,
    inputs: LightingInputs
  ): LightingGraphOutputs {
    const width = Math.max(1, job.width | 0);
    const height = Math.max(1, job.height | 0);
    let hdr = -1;
    const builder = graph.add(
      "Direct lighting Ch",
      job,
      (passJob, resources, context) => {
        const encoder = context.gpu_encoder;
        if (!encoder) throw new Error("LightingPass: no GPU command encoder");

        const bindings: readonly (readonly GPUBindingResource[])[] = [
          [
            texture(resources.get(inputs.depth)),
            texture(resources.get(inputs.gPbr)),
            texture(resources.get(inputs.gNormal)),
            texture(resources.get(inputs.gAlbedo)),
            texture(resources.get(inputs.gEmissive)),
            this.graphics.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR),
            texture(resources.get(inputs.gMetadata))
          ],
          [
            { buffer: buffer(resources.get(inputs.lightDatabase)) },
            texture(resources.get(inputs.environment)),
            { buffer: buffer(resources.get(inputs.clusterParameters)) },
            { buffer: buffer(resources.get(inputs.clusterLookup)) },
            { buffer: buffer(resources.get(inputs.clusterData)) },
            texture(resources.get(inputs.shadowAtlas)),
            this.graphics.samplers.obtain(SHADOW_COMPARISON_SAMPLER_DESCRIPTOR),
            { buffer: buffer(resources.get(inputs.activeLightList)) }
          ],
          [
            { buffer: buffer(resources.get(inputs.view)) },
            { buffer: buffer(resources.get(inputs.camera)) }
          ]
        ];
        const hdrView = texture(resources.get(hdr));
        const depthView = resolveDepthAttachmentView(
          resources.get(inputs.depth)
        );
        const descriptor = passJob.surfaceMetadataAvailable
          ? CH_PIPELINE
          : CH_LEGACY_PIPELINE;
        const pipeline = this.graphics.render_pipelines.obtain(descriptor);
        const pass = encoder.beginRenderPass({
          label: "Direct lighting Ch",
          colorAttachments: [{
            view: hdrView,
            clearValue: [0, 0, 0, 0],
            loadOp: "clear",
            storeOp: "store"
          }],
          depthStencilAttachment: {
            view: depthView,
            depthReadOnly: true
          }
        });
        pass.setPipeline(pipeline);
        this.graphics.setPipelineBindings(pass, descriptor, bindings);
        pass.draw(3);
        pass.end();
        this.lastRan = true;
      }
    );
    hdr = builder.create("hdr_color / lighting X", {
      kind: "transient_texture",
      label: "hdr_color / lighting X",
      width,
      height,
      format: HDR_COLOR_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST
    });
    for (const resource of Object.values(inputs)) builder.read(resource);
    return { hdr };
  }

  destroy(): void {}
}

function texture(value: unknown): GPUTextureView {
  return resolveTextureView(value as GPUTexture | GPUTextureView);
}

function buffer(value: unknown): GPUBuffer {
  if (value && typeof value === "object" && "size" in value && "usage" in value) {
    return value as GPUBuffer;
  }
  throw new Error("LightingPass: expected GPUBuffer");
}

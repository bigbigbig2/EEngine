/**
 * Brick4IndirectPass：实现渲染管线中的独立渲染阶段。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import { LINEAR_CLAMP_SAMPLER_DESCRIPTOR } from "../../gpu/GPUSamplerCache.js";
import {
  BRICK4_DIFFUSE_WGSL,
  BRICK4_FUSED_WGSL,
  BRICK4_INDIRECT_FORMAT,
  BRICK4_SPECULAR_WGSL
} from "../../shaders/brick4_indirect.js";
import {
  resolveDepthAttachmentView,
  resolveTextureView
} from "./MaterialExpandPass.js";

const UINT_TEXTURE = {
  visibility: GPUShaderStage.FRAGMENT,
  texture: { sampleType: "uint" as const }
};
const FLOAT_TEXTURE = {
  visibility: GPUShaderStage.FRAGMENT,
  texture: { sampleType: "float" as const }
};
const UNFILTERABLE_TEXTURE = {
  visibility: GPUShaderStage.FRAGMENT,
  texture: { sampleType: "unfilterable-float" as const }
};
const STBN_TEXTURE = {
  visibility: GPUShaderStage.FRAGMENT,
  texture: {
    sampleType: "unfilterable-float" as const,
    viewDimension: "3d" as const
  }
};
const UNIFORM_BUFFER = {
  visibility: GPUShaderStage.FRAGMENT,
  buffer: { type: "uniform" as const }
};
const STORAGE_BUFFER = {
  visibility: GPUShaderStage.FRAGMENT,
  buffer: { type: "read-only-storage" as const }
};

const BRICK4_DIFFUSE_GROUP0: GPUBindGroupLayoutDescriptor = {
  label: "Renderer/Vb/group0-layout",
  entries: [
    { binding: 0, ...UNFILTERABLE_TEXTURE },
    { binding: 1, ...UINT_TEXTURE },
    { binding: 2, ...FLOAT_TEXTURE },
    { binding: 3, ...STBN_TEXTURE },
    { binding: 4, ...UNIFORM_BUFFER },
    { binding: 5, ...UNIFORM_BUFFER }
  ]
};

const BRICK4_SPECULAR_GROUP0: GPUBindGroupLayoutDescriptor = {
  label: "Renderer/_w/group0-layout",
  entries: [
    { binding: 0, ...UNFILTERABLE_TEXTURE },
    { binding: 1, ...UINT_TEXTURE },
    { binding: 2, ...FLOAT_TEXTURE },
    { binding: 3, ...STBN_TEXTURE },
    { binding: 4, ...UNIFORM_BUFFER },
    { binding: 5, ...UNIFORM_BUFFER }
  ]
};

const BRICK4_FUSED_GROUP0: GPUBindGroupLayoutDescriptor = {
  label: "Renderer/sw/group0-layout",
  entries: [
    { binding: 0, ...UNFILTERABLE_TEXTURE },
    { binding: 1, ...UINT_TEXTURE },
    { binding: 2, ...UINT_TEXTURE },
    { binding: 3, ...FLOAT_TEXTURE },
    { binding: 4, ...FLOAT_TEXTURE },
    { binding: 5, ...STBN_TEXTURE },
    { binding: 6, ...UNIFORM_BUFFER },
    { binding: 7, ...UNIFORM_BUFFER }
  ]
};

const BRICK4_STORAGE_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "Renderer/Brick4/storage-group-layout",
  entries: [{ binding: 0, ...STORAGE_BUFFER }]
};

const BRICK4_FUSED_STORAGE_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "Renderer/sw/storage-group-layout",
  entries: [
    { binding: 0, ...STORAGE_BUFFER },
    {
      binding: 1,
      visibility: GPUShaderStage.FRAGMENT,
      sampler: { type: "filtering" }
    },
    { binding: 2, ...FLOAT_TEXTURE }
  ]
};

const DEPTH_STATE: GPUDepthStencilState = {
  format: "depth32float",
  depthWriteEnabled: false,
  depthCompare: "not-equal"
};

const BRICK4_DIFFUSE_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "Renderer/Brick4 diffuse Vb",
  layout: {
    label: "Renderer/Vb/pipeline-layout",
    bindGroupLayouts: [BRICK4_DIFFUSE_GROUP0, BRICK4_STORAGE_GROUP]
  },
  vertex: {
    module: { label: "Renderer/Brick4 diffuse Vb", code: BRICK4_DIFFUSE_WGSL },
    entryPoint: "vs_main"
  },
  fragment: {
    module: { label: "Renderer/Brick4 diffuse Vb", code: BRICK4_DIFFUSE_WGSL },
    entryPoint: "fs_main",
    targets: [{ format: BRICK4_INDIRECT_FORMAT }]
  },
  primitive: { topology: "triangle-list", cullMode: "none" },
  depthStencil: DEPTH_STATE
};

const BRICK4_SPECULAR_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "Renderer/Brick4 specular _w",
  layout: {
    label: "Renderer/_w/pipeline-layout",
    bindGroupLayouts: [BRICK4_SPECULAR_GROUP0, BRICK4_STORAGE_GROUP]
  },
  vertex: {
    module: { label: "Renderer/Brick4 specular _w", code: BRICK4_SPECULAR_WGSL },
    entryPoint: "vs_main"
  },
  fragment: {
    module: { label: "Renderer/Brick4 specular _w", code: BRICK4_SPECULAR_WGSL },
    entryPoint: "fs_main",
    targets: [{ format: BRICK4_INDIRECT_FORMAT }]
  },
  primitive: { topology: "triangle-list", cullMode: "none" },
  depthStencil: DEPTH_STATE
};

const BRICK4_FUSED_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "Renderer/Brick4 fused indirect sw",
  layout: {
    label: "Renderer/sw/pipeline-layout",
    bindGroupLayouts: [BRICK4_FUSED_GROUP0, BRICK4_FUSED_STORAGE_GROUP]
  },
  vertex: {
    module: { label: "Renderer/Brick4 fused indirect sw", code: BRICK4_FUSED_WGSL },
    entryPoint: "vs_main"
  },
  fragment: {
    module: { label: "Renderer/Brick4 fused indirect sw", code: BRICK4_FUSED_WGSL },
    entryPoint: "fs_main",
    targets: [
      {
        format: BRICK4_INDIRECT_FORMAT,
        blend: {
          color: { operation: "add", srcFactor: "one", dstFactor: "one" },
          alpha: { operation: "add", srcFactor: "zero", dstFactor: "one" }
        }
      }
    ]
  },
  primitive: { topology: "triangle-list", cullMode: "none" },
  depthStencil: DEPTH_STATE
};

export type Brick4BaseInputs = {
  depth: ResourceId;
  stbn: ResourceId;
  view: ResourceId;
  camera: ResourceId;
  lightMap: ResourceId;
};

export type Brick4DiffuseInputs = Brick4BaseInputs & {
  normal: ResourceId;
  albedoAo: ResourceId;
};

export type Brick4SpecularInputs = Brick4BaseInputs & {
  normal: ResourceId;
  pbr: ResourceId;
};

export type Brick4FusedInputs = Brick4BaseInputs & {
  hdr: ResourceId;
  normal: ResourceId;
  bentNormal: ResourceId;
  albedoAo: ResourceId;
  pbr: ResourceId;
  splitSum: ResourceId;
};

export type Brick4IndirectJob = {
  width: number;
  height: number;
};

export class Brick4DiffusePass {
  private pipeline: GPURenderPipeline | null = null;
  lastRan = false;

  constructor(private readonly graphics: GraphicsContext) {}

  addToGraph(
    graph: FrameGraph,
    job: Brick4IndirectJob,
    inputs: Brick4DiffuseInputs
  ): ResourceId {
    this.pipeline ??= this.graphics.render_pipelines.obtain(
      BRICK4_DIFFUSE_PIPELINE
    );
    let output = -1;
    const builder = graph.add("Brick4 indirect diffuse Vb", inputs, (data, resources, context) => {
      const encoder = context.gpu_encoder;
      if (!encoder || !this.pipeline) {
        throw new Error("Brick4DiffusePass: missing encoder or pipeline");
      }
      const pass = encoder.beginRenderPass({
        label: "Brick4 indirect diffuse Vb",
        colorAttachments: [clearAttachment(resources.get(output))],
        depthStencilAttachment: depthAttachment(resources.get(data.depth))
      });
      pass.setPipeline(this.pipeline);
      this.graphics.setPipelineBindings(pass, BRICK4_DIFFUSE_PIPELINE, [
        [
          texture(resources.get(data.depth)),
          texture(resources.get(data.normal)),
          texture(resources.get(data.albedoAo)),
          texture(resources.get(data.stbn)),
          { buffer: buffer(resources.get(data.view)) },
          { buffer: buffer(resources.get(data.camera)) }
        ],
        [{ buffer: buffer(resources.get(data.lightMap)) }]
      ]);
      pass.draw(3);
      pass.end();
      this.lastRan = true;
    });
    output = createOutput(builder, "Brick4 indirect diffuse", job);
    for (const resource of Object.values(inputs)) builder.read(resource);
    return output;
  }
}

export class Brick4SpecularPass {
  private pipeline: GPURenderPipeline | null = null;
  lastRan = false;

  constructor(private readonly graphics: GraphicsContext) {}

  addToGraph(
    graph: FrameGraph,
    job: Brick4IndirectJob,
    inputs: Brick4SpecularInputs
  ): ResourceId {
    this.pipeline ??= this.graphics.render_pipelines.obtain(
      BRICK4_SPECULAR_PIPELINE
    );
    let output = -1;
    const builder = graph.add("Brick4 indirect specular _w", inputs, (data, resources, context) => {
      const encoder = context.gpu_encoder;
      if (!encoder || !this.pipeline) {
        throw new Error("Brick4SpecularPass: missing encoder or pipeline");
      }
      const pass = encoder.beginRenderPass({
        label: "Brick4 indirect specular _w",
        colorAttachments: [clearAttachment(resources.get(output))],
        depthStencilAttachment: depthAttachment(resources.get(data.depth))
      });
      pass.setPipeline(this.pipeline);
      this.graphics.setPipelineBindings(pass, BRICK4_SPECULAR_PIPELINE, [
        [
          texture(resources.get(data.depth)),
          texture(resources.get(data.normal)),
          texture(resources.get(data.pbr)),
          texture(resources.get(data.stbn)),
          { buffer: buffer(resources.get(data.view)) },
          { buffer: buffer(resources.get(data.camera)) }
        ],
        [{ buffer: buffer(resources.get(data.lightMap)) }]
      ]);
      pass.draw(3);
      pass.end();
      this.lastRan = true;
    });
    output = createOutput(builder, "Brick4 indirect specular", job);
    for (const resource of Object.values(inputs)) builder.read(resource);
    return output;
  }
}

export class Brick4FusedIndirectPass {
  private pipeline: GPURenderPipeline | null = null;
  lastRan = false;

  constructor(private readonly graphics: GraphicsContext) {}

  addToGraph(graph: FrameGraph, inputs: Brick4FusedInputs): ResourceId {
    this.pipeline ??= this.graphics.render_pipelines.obtain(BRICK4_FUSED_PIPELINE);
    let output = inputs.hdr;
    const builder = graph.add("Brick4 fused indirect sw", inputs, (data, resources, context) => {
      const encoder = context.gpu_encoder;
      if (!encoder || !this.pipeline) {
        throw new Error("Brick4FusedIndirectPass: missing encoder or pipeline");
      }
      const pass = encoder.beginRenderPass({
        label: "Brick4 fused indirect sw",
        colorAttachments: [loadAttachment(resources.get(output))],
        depthStencilAttachment: depthAttachment(resources.get(data.depth))
      });
      pass.setPipeline(this.pipeline);
      this.graphics.setPipelineBindings(pass, BRICK4_FUSED_PIPELINE, [
        [
          texture(resources.get(data.depth)),
          texture(resources.get(data.normal)),
          texture(resources.get(data.bentNormal)),
          texture(resources.get(data.albedoAo)),
          texture(resources.get(data.pbr)),
          texture(resources.get(data.stbn)),
          { buffer: buffer(resources.get(data.view)) },
          { buffer: buffer(resources.get(data.camera)) }
        ],
        [
          { buffer: buffer(resources.get(data.lightMap)) },
          this.graphics.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR),
          texture(resources.get(data.splitSum))
        ]
      ]);
      pass.draw(3);
      pass.end();
      this.lastRan = true;
    });
    output = builder.write(inputs.hdr);
    for (const [name, resource] of Object.entries(inputs)) {
      if (name !== "hdr") builder.read(resource);
    }
    return output;
  }
}

function createOutput(
  builder: { create(name: string, descriptor: {
    kind: "transient_texture";
    label: string;
    width: number;
    height: number;
    format: GPUTextureFormat;
    usage: GPUTextureUsageFlags;
  }): ResourceId },
  label: string,
  job: Brick4IndirectJob
): ResourceId {
  return builder.create(label, {
    kind: "transient_texture",
    label,
    width: Math.max(1, job.width | 0),
    height: Math.max(1, job.height | 0),
    format: BRICK4_INDIRECT_FORMAT,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
  });
}

function clearAttachment(resource: unknown): GPURenderPassColorAttachment {
  return {
    view: texture(resource),
    clearValue: [0, 0, 0, 0],
    loadOp: "clear",
    storeOp: "store"
  };
}

function loadAttachment(resource: unknown): GPURenderPassColorAttachment {
  return { view: texture(resource), loadOp: "load", storeOp: "store" };
}

function depthAttachment(resource: unknown): GPURenderPassDepthStencilAttachment {
  return { view: resolveDepthAttachmentView(resource), depthReadOnly: true };
}

function texture(value: unknown): GPUTextureView {
  return resolveTextureView(value as GPUTexture | GPUTextureView);
}

function buffer(value: unknown): GPUBuffer {
  if (value && typeof value === "object" && "size" in value && "usage" in value) {
    return value as GPUBuffer;
  }
  throw new Error("Brick4IndirectPass: expected GPUBuffer");
}

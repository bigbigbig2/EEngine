import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { PACKED_MATERIAL_CLASS_DEPTH_WGSL } from "../../shaders/packed_material_class_depth.js";
import { resolveDepthAttachmentView, resolveTextureView } from "../RenderTargetViews.js";

const GROUP: GPUBindGroupLayoutDescriptor = {
  label: "MaterialClassDepth/visibility",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } }
  ]
};

const PIPELINE: CachedRenderPipelineDescriptor = {
  label: "MaterialClassDepth/fullscreen",
  layout: { label: "MaterialClassDepth/layout", bindGroupLayouts: [GROUP] },
  vertex: {
    module: { label: "MaterialClassDepth", code: PACKED_MATERIAL_CLASS_DEPTH_WGSL },
    entryPoint: "packed_material_class_depth_vs"
  },
  fragment: {
    module: { label: "MaterialClassDepth", code: PACKED_MATERIAL_CLASS_DEPTH_WGSL },
    entryPoint: "packed_material_class_depth_fs",
    targets: []
  },
  primitive: { topology: "triangle-list", cullMode: "none" },
  depthStencil: {
    format: "depth32float",
    depthWriteEnabled: true,
    depthCompare: "always"
  }
};

export interface PackedMaterialClassDepthJob {
  readonly visibilityKey: ResourceId;
  readonly meshletWork: ResourceId;
  readonly materials: GPUBuffer;
  readonly width: number;
  readonly height: number;
}


/** Produces a transient depth attachment used to select material fullscreen kernels. */
export class PackedMaterialClassDepthPass {
  constructor(private readonly graphics: GraphicsContext) {}

  addToGraph(graph: FrameGraph, job: PackedMaterialClassDepthJob): ResourceId {
    let depth = -1;
    const builder = graph.add("MaterialClassDepth/classify visibility", job, (data, resources, context) => {
      const command = requireCommand(context.encoder);
      const bindGroup = this.graphics.bind_groups.obtain({
        layout: GROUP,
        entries: [
          resolveTextureView(resources.get(data.visibilityKey)),
          { buffer: requireBuffer(resources.get(data.meshletWork), "MeshletWork") },
          { buffer: data.materials }
        ]
      });
      const pass = command.beginRenderPass({
        label: "MaterialClassDepth/classify visibility",
        colorAttachments: [],
        depthStencilAttachment: {
          view: resolveDepthAttachmentView(resources.get(depth)),
          depthClearValue: 0,
          depthLoadOp: "clear",
          depthStoreOp: "store"
        }
      });
      pass.setPipeline(this.graphics.render_pipelines.obtain(PIPELINE));
      pass.setBindGroup(0, bindGroup);
      pass.draw(3, 1, 0, 0);
      pass.end();
    });
    builder.read(job.visibilityKey);
    builder.read(job.meshletWork);
    depth = builder.create("material-class-depth", {
      kind: "transient_texture",
      label: "MaterialClassDepth/depth32float",
      width: Math.max(1, job.width | 0),
      height: Math.max(1, job.height | 0),
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT
    });
    builder.make_side_effect();
    return depth;
  }

  destroy(): void {}
}

function requireCommand(value: unknown): ShadeGPUCommandContext {
  if (value && typeof value === "object" && "isGPUCommandContext" in value) {
    return value as ShadeGPUCommandContext;
  }
  throw new Error("PackedMaterialClassDepthPass requires ShadeGPUCommandContext");
}

function requireBuffer(value: unknown, label: string): GPUBuffer {
  if (value && typeof value === "object" && "size" in value && "usage" in value) {
    return value as GPUBuffer;
  }
  throw new Error(`PackedMaterialClassDepthPass expected ${label} GPUBuffer`);
}

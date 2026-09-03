/**
 * LpvIndirectDiffusePass：实现渲染管线中的独立渲染阶段。
 */

import type { PerspectiveCamera } from "../../camera/PerspectiveCamera.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import {
  LINEAR_CLAMP_SAMPLER_DESCRIPTOR,
  type GPUSamplerCache
} from "../../gpu/GPUSamplerCache.js";
import {
  LPV_INDIRECT_DIFFUSE_FORMAT,
  LPV_INDIRECT_DIFFUSE_WGSL
} from "../../shaders/lpv_indirect_diffuse.js";
import { PackedCameraUniform } from "../PackedCameraUniform.js";
import {
  resolveDepthAttachmentView,
  resolveTextureView
} from "../RenderTargetViews.js";

export type LpvIndirectDiffuseInputs = {
  depth: ResourceId;
  normal: ResourceId;
  albedoAo: ResourceId;
  atlasRadiance: ResourceId;
  atlasDepth: ResourceId;
  meshBvh: ResourceId;
  metadata: ResourceId;
  tetrahedra: ResourceId;
  probes: ResourceId;
};

export type LpvIndirectDiffuseOutput = {
  indirectDiffuse: ResourceId;
};

export type LpvIndirectDiffuseJob = {
  camera: PerspectiveCamera;
  samplers: GPUSamplerCache;
  width: number;
  height: number;
};

export class LpvIndirectDiffusePass {
  private readonly pipeline: CachedRenderPipelineDescriptor;
  private cameraUniform: PackedCameraUniform | null = null;
  private readonly device: GPUDevice;
  lastRan = false;

  constructor(graphics: GraphicsContext) {
    if (graphics.device === null) {
      throw new Error("LpvIndirectDiffusePass: GraphicsContext has no device");
    }
    this.device = graphics.device;
    this.pipeline = createLpvPipelineDescriptor();
  }

  init(): void {
    if (this.cameraUniform !== null) return;
    this.cameraUniform = new PackedCameraUniform(
      this.device,
      "Renderer/LPV camera Td"
    );
  }

  addToGraph(
    graph: FrameGraph,
    job: LpvIndirectDiffuseJob,
    inputs: LpvIndirectDiffuseInputs
  ): LpvIndirectDiffuseOutput {
    this.init();
    const output: LpvIndirectDiffuseOutput = { indirectDiffuse: -1 };
    const self = this;
    const builder = graph.add(
      "LPV indirect diffuse FB",
      job,
      (data, resources, context) => {
        const command = requireShadeCommandContext(context.encoder);
        self.execute(
          command,
          data.camera,
          data.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR),
          {
            output: resolveTextureView(resources.get(output.indirectDiffuse)),
            depth: resolveTextureView(resources.get(inputs.depth)),
            depthAttachment: resolveDepthAttachmentView(resources.get(inputs.depth)),
            normal: resolveTextureView(resources.get(inputs.normal)),
            albedoAo: resolveTextureView(resources.get(inputs.albedoAo)),
            atlasRadiance: resolveTextureView(resources.get(inputs.atlasRadiance)),
            atlasDepth: resolveTextureView(resources.get(inputs.atlasDepth)),
            meshBvh: resolveBuffer(resources.get(inputs.meshBvh), "mesh BVH"),
            metadata: resolveBuffer(resources.get(inputs.metadata), "metadata"),
            tetrahedra: resolveBuffer(resources.get(inputs.tetrahedra), "tetrahedra"),
            probes: resolveBuffer(resources.get(inputs.probes), "probes")
          }
        );
      }
    );

    output.indirectDiffuse = builder.create("LPV indirect diffuse", {
      kind: "transient_texture",
      label: "LPV indirect diffuse",
      width: Math.max(1, job.width | 0),
      height: Math.max(1, job.height | 0),
      format: LPV_INDIRECT_DIFFUSE_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    });

    builder.read(inputs.depth);
    builder.read(inputs.normal);
    builder.read(inputs.albedoAo);
    builder.read(inputs.atlasRadiance);
    builder.read(inputs.atlasDepth);
    builder.read(inputs.meshBvh);
    builder.read(inputs.metadata);
    builder.read(inputs.tetrahedra);
    builder.read(inputs.probes);
    return output;
  }

  execute(
    command: ShadeGPUCommandContext,
    camera: PerspectiveCamera,
    sampler: GPUSampler,
    resources: {
      output: GPUTextureView;
      depth: GPUTextureView;
      depthAttachment: GPUTextureView;
      normal: GPUTextureView;
      albedoAo: GPUTextureView;
      atlasRadiance: GPUTextureView;
      atlasDepth: GPUTextureView;
      meshBvh: GPUBuffer;
      metadata: GPUBuffer;
      tetrahedra: GPUBuffer;
      probes: GPUBuffer;
    }
  ): void {
    if (this.cameraUniform === null) {
      throw new Error("LpvIndirectDiffusePass not initialized");
    }
    this.cameraUniform.update(camera);
    const pass = command.constructRenderPass({
      label: "LPV indirect diffuse FB",
      pipeline: this.pipeline,
      bindings: [
        [
          { buffer: this.cameraUniform.buffer },
          resources.depth,
          resources.normal,
          resources.albedoAo
        ],
        [
          { buffer: resources.meshBvh },
          { buffer: resources.metadata },
          { buffer: resources.tetrahedra },
          { buffer: resources.probes }
        ],
        [sampler, resources.atlasRadiance, resources.atlasDepth]
      ],
      colorAttachments: [
        {
          view: resources.output,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store"
        }
      ],
      depthStencilAttachment: {
        view: resources.depthAttachment,
        depthReadOnly: true
      }
    });
    pass.draw(3, 1, 0, 0);
    pass.end();
    this.lastRan = true;
  }

  destroy(): void {
    this.cameraUniform?.destroy();
    this.cameraUniform = null;
  }
}

function createLpvPipelineDescriptor(): CachedRenderPipelineDescriptor {
  const label = "Renderer/LPV indirect diffuse FB";
  const module = { label, code: LPV_INDIRECT_DIFFUSE_WGSL };
  return {
    label,
    layout: {
      label: `${label} layout`,
      bindGroupLayouts: [
        createLpvGBufferLayout(),
        createLpvBufferLayout(),
        createLpvAtlasLayout()
      ]
    },
    vertex: { module, entryPoint: "vs_main" },
    fragment: {
      module,
      entryPoint: "fs_main",
      targets: [{ format: LPV_INDIRECT_DIFFUSE_FORMAT }]
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth32float",
      depthWriteEnabled: false,
      depthCompare: "not-equal"
    }
  };
}

function createLpvGBufferLayout(): GPUBindGroupLayoutDescriptor {
  const fragment = GPUShaderStage.FRAGMENT;
  return {
    label: "Renderer/LPV FB group0",
    entries: [
      { binding: 0, visibility: fragment, buffer: { type: "uniform" } },
      { binding: 1, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 2, visibility: fragment, texture: { sampleType: "uint", viewDimension: "2d" } },
      { binding: 3, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } }
    ]
  };
}

function createLpvBufferLayout(): GPUBindGroupLayoutDescriptor {
  const fragment = GPUShaderStage.FRAGMENT;
  return {
    label: "Renderer/LPV FB group1",
    entries: [
      { binding: 0, visibility: fragment, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: fragment, buffer: { type: "uniform" } },
      { binding: 2, visibility: fragment, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: fragment, buffer: { type: "read-only-storage" } }
    ]
  };
}

function createLpvAtlasLayout(): GPUBindGroupLayoutDescriptor {
  const fragment = GPUShaderStage.FRAGMENT;
  return {
    label: "Renderer/LPV FB group2",
    entries: [
      { binding: 0, visibility: fragment, sampler: { type: "filtering" } },
      { binding: 1, visibility: fragment, texture: { sampleType: "uint", viewDimension: "2d" } },
      { binding: 2, visibility: fragment, texture: { sampleType: "float", viewDimension: "2d" } }
    ]
  };
}

function requireShadeCommandContext(value: unknown): ShadeGPUCommandContext {
  if (
    value &&
    typeof value === "object" &&
    "isGPUCommandContext" in value &&
    (value as { isGPUCommandContext?: unknown }).isGPUCommandContext === true &&
    "constructRenderPass" in value
  ) {
    return value as ShadeGPUCommandContext;
  }
  throw new Error("LpvIndirectDiffusePass: cached FB requires ShadeGPUCommandContext");
}

function resolveBuffer(resource: unknown, label: string): GPUBuffer {
  if (resource && typeof resource === "object") {
    if ("size" in resource && "usage" in resource) return resource as GPUBuffer;
    if ("buffer" in resource) {
      const buffer = (resource as { buffer?: unknown }).buffer;
      if (buffer && typeof buffer === "object" && "size" in buffer) {
        return buffer as GPUBuffer;
      }
    }
  }
  throw new Error(`LpvIndirectDiffusePass: ${label} is not a GPUBuffer`);
}

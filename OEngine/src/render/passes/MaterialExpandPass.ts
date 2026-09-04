/**
 * 材质展开阶段：根据可见性缓冲区恢复表面属性，并写入后续光照使用的 G-Buffer。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { GpuCounterAtomicAdder } from "../../debug/GpuCounterAtomicAdder.js";
import {
  MATERIAL_EXPAND_GROUP1,
  MATERIAL_EXPAND_GROUP2,
  type GPUMaterialContext,
  type GPUMaterialRegistry
} from "../../gpu/GPUMaterialContext.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import { createNativeTextureView } from "../../gpu/GPUTextureDescriptors.js";
import { ShadeTransparencyMode } from "../../material/enums.js";
import type { Scene } from "../../scene/Scene.js";
import {
  GBUF_ALBEDO_FORMAT,
  GBUF_EMISSIVE_FORMAT,
  GBUF_NORMAL_FORMAT,
  GBUF_PBR_FORMAT,
  MATERIAL_DEPTH_FORMAT
} from "../RenderTargets.js";
import {
  surfaceFrame,
  textureDomain,
  type SurfaceFrame
} from "../pipeline/FrameProducts.js";

export const GBUFFER_LAYOUT = {
  g_pbr: { format: "rg8unorm" as const, label: "g-buffer / PBR" },
  g_normal: { format: "rgba16uint" as const, label: "g-buffer / Normal" },
  g_albedo: { format: "rgba8unorm" as const, label: "g-buffer / Albedo" },
  g_emissive: { format: "r32uint" as const, label: "g-buffer / Emissive" },
  material_depth: { format: "depth32float" as const, label: "material depth texture" }
} as const;

export const MATERIAL_EXPAND_MIGRATION_GAP = [] as const;

export const MATERIAL_EXPAND_STEPS = [
  "#Sr mesh id -> material depth",
  "bind original fm material group from fz/_z",
  "bind nz: triangle/mesh/Yu/Td",
  "bind rz: scene database/geometries/meshlet headers/data",
  "draw fullscreen triangle once per non-transparent material"
] as const;

export type BufferBindingSlice = {
  buffer: GPUBuffer;
  offset?: number;
  size?: number;
};

export type MaterialExpandJob = {
  scene: Scene;
  materials: GPUMaterialRegistry | null;
  width: number;
  height: number;
};

export type MaterialExpandInputs = {
  meshId: ResourceId;
  triangleId: ResourceId;
  sceneDatabase: ResourceId;
  geometries: ResourceId;
  meshletHeaders: ResourceId;
  meshletData: ResourceId;
  view: ResourceId;
  camera: ResourceId;
  counters?: ResourceId;
};

export type MaterialExpandGraphOutputs = {
  gPbr: ResourceId;
  gNormal: ResourceId;
  gAlbedo: ResourceId;
  gEmissive: ResourceId;
  materialDepth: ResourceId;
  /** 迁移期间的统一 Surface 产品；legacy producer 不拥有 metadata。 */
  surface: SurfaceFrame;
  counters: ResourceId | null;
};

export function resolveTextureView(
  resource: unknown,
  descriptor?: GPUTextureViewDescriptor
): GPUTextureView {
  if (!resource || typeof resource !== "object") {
    throw new Error("MaterialExpand: missing texture resource");
  }
  const value = resource as {
    createView?: (descriptor?: GPUTextureViewDescriptor) => GPUTextureView;
    isGPUTextureContext?: boolean;
  };
  if (typeof value.createView !== "function") return resource as GPUTextureView;
  return value.isGPUTextureContext
    ? value.createView(descriptor)
    : createNativeTextureView(resource as GPUTexture, descriptor);
}

const DEPTH_ATTACHMENT_VIEW_DESCRIPTOR: GPUTextureViewDescriptor = {
  dimension: "2d",
  baseMipLevel: 0,
  mipLevelCount: 1,
  baseArrayLayer: 0,
  arrayLayerCount: 1
};

export function resolveDepthAttachmentView(resource: unknown): GPUTextureView {
  return resolveTextureView(resource, DEPTH_ATTACHMENT_VIEW_DESCRIPTOR);
}

/**
 * 将可见性缓冲区中的几何与材质索引展开为完整表面属性，供后续光照阶段读取。
 */
export class MaterialExpandPass {
  private readonly gpuCounterAdder = new GpuCounterAtomicAdder();
  lastDrawCount = 0;
  lastSrRan = false;
  lastUsedNzRzSplit = false;
  lastUsedMaterialTextures = false;
  lastUploadedTextureCount = 0;
  lastUsedBarycentricUv = true;

  constructor(
    private readonly graphics: GraphicsContext,
    private readonly materials: GPUMaterialRegistry
  ) {
    const device = graphics.device;
    if (device === null) {
      throw new Error("MaterialExpandPass: GraphicsContext has no device");
    }
  }

  init(): void {}

  /** 登记材质展开所需的可见性、深度、场景数据库和 G-Buffer 资源。 */
  addToGraph(
    graph: FrameGraph,
    job: MaterialExpandJob,
    inputs: MaterialExpandInputs
  ): MaterialExpandGraphOutputs {
    const width = Math.max(1, job.width | 0);
    const height = Math.max(1, job.height | 0);
    const outputs: MaterialExpandGraphOutputs = {
      gPbr: -1,
      gNormal: -1,
      gAlbedo: -1,
      gEmissive: -1,
      materialDepth: -1,
      surface: null as unknown as SurfaceFrame,
      counters: null
    };

    const builder = graph.add(
      "Material Draw",
      job,
      (passJob, resources, context) => {
        const encoder = context.gpu_encoder;
        if (!encoder) throw new Error("MaterialExpandPass: no GPU command encoder");
        const srPipeline = this.materials.material_depth_pipeline;

        const meshView = texture(resources.get(inputs.meshId));
        const triangleView = texture(resources.get(inputs.triangleId));
        const sceneDatabase = buffer(resources.get(inputs.sceneDatabase));
        const geometries = buffer(resources.get(inputs.geometries));
        const meshletHeaders = buffer(resources.get(inputs.meshletHeaders));
        const meshletData = buffer(resources.get(inputs.meshletData));
        const viewBuffer = buffer(resources.get(inputs.view));
        const cameraBuffer = buffer(resources.get(inputs.camera));
        const materialDepth = texture(resources.get(outputs.materialDepth));

        this.lastDrawCount = 0;
        this.lastSrRan = false;
        this.lastUsedNzRzSplit = false;
        this.lastUsedMaterialTextures = false;
        this.lastUploadedTextureCount = 0;

        this.runMaterialDepth(
          encoder,
          srPipeline,
          meshView,
          sceneDatabase,
          materialDepth
        );
        this.lastSrRan = true;

        const pass = encoder.beginRenderPass({
          label: "Material Expand/gbuffer",
          colorAttachments: [
            colorAttachment(texture(resources.get(outputs.gPbr))),
            colorAttachment(texture(resources.get(outputs.gNormal))),
            colorAttachment(texture(resources.get(outputs.gAlbedo))),
            colorAttachment(texture(resources.get(outputs.gEmissive)))
          ],
          depthStencilAttachment: {
            view: materialDepth,
            depthReadOnly: true
          },
          primitive: { topology: "triangle-list", cullMode: "none" }
        } as GPURenderPassDescriptor & { primitive: GPUPrimitiveState });
        const nz = this.graphics.bind_groups.obtain({
          layout: MATERIAL_EXPAND_GROUP1,
          entries: [
            triangleView,
            meshView,
            { buffer: viewBuffer },
            { buffer: cameraBuffer }
          ]
        });
        const rz = this.graphics.bind_groups.obtain({
          layout: MATERIAL_EXPAND_GROUP2,
          entries: [
            { buffer: sceneDatabase },
            { buffer: geometries },
            { buffer: meshletHeaders },
            { buffer: meshletData }
          ]
        });
        pass.setBindGroup(1, nz);
        pass.setBindGroup(2, rz);
        this.lastUsedNzRzSplit = true;
        const drawableMaterials = this.collectMaterials(passJob);
        let previousPipeline: GPURenderPipeline | null = null;
        for (const material of drawableMaterials) {
          const pipeline = material.pipeline;
          if (pipeline === null) continue;
          if (previousPipeline !== pipeline) {
            pass.setPipeline(pipeline);
            previousPipeline = pipeline;
          }
          pass.setBindGroup(0, material.obtainMaterialExpandBindGroup(pipeline));
          pass.draw(3);
          this.lastDrawCount++;
          if (material.source.textures.length > 0) {
            this.lastUsedMaterialTextures = true;
          }
        }
        pass.end();
        if (inputs.counters !== undefined) {
          this.gpuCounterAdder.encode(
            requireShadeCommandContext(context.encoder),
            buffer(resources.get(inputs.counters)),
            "activeMaterials",
            this.lastDrawCount
          );
        }
      }
    );

    const colorUsage =
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING;
    outputs.gPbr = builder.create(GBUFFER_LAYOUT.g_pbr.label, textureDescriptor(
      width, height, GBUF_PBR_FORMAT, colorUsage
    ));
    outputs.gNormal = builder.create(GBUFFER_LAYOUT.g_normal.label, textureDescriptor(
      width, height, GBUF_NORMAL_FORMAT, colorUsage
    ));
    outputs.gAlbedo = builder.create(GBUFFER_LAYOUT.g_albedo.label, textureDescriptor(
      width, height, GBUF_ALBEDO_FORMAT, colorUsage
    ));
    outputs.gEmissive = builder.create(GBUFFER_LAYOUT.g_emissive.label, textureDescriptor(
      width, height, GBUF_EMISSIVE_FORMAT, colorUsage
    ));
    outputs.materialDepth = builder.create(
      GBUFFER_LAYOUT.material_depth.label,
      textureDescriptor(
        width,
        height,
        MATERIAL_DEPTH_FORMAT,
        GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING
      )
    );
    outputs.surface = surfaceFrame({
      depth: null,
      pbr: outputs.gPbr,
      normal: outputs.gNormal,
      albedoAo: outputs.gAlbedo,
      emissive: outputs.gEmissive,
      velocity: null,
      metadata: null,
      domain: textureDomain("internal-full", width, height, 1)
    });
    for (const resource of Object.values(inputs)) {
      if (resource !== undefined) builder.read(resource);
    }
    outputs.counters = inputs.counters === undefined
      ? null
      : builder.write(inputs.counters);
    builder.make_side_effect();
    return outputs;
  }

  private collectMaterials(job: MaterialExpandJob): GPUMaterialContext[] {
    const registry = job.materials;
    if (registry === null) return [];
    const contexts: GPUMaterialContext[] = [];
    for (const source of job.scene.instances.materials) {
      if (source.transparency_mode === ShadeTransparencyMode.Transparent) continue;
      const context = registry.contexts.get(source);
      if (context !== undefined && context.is_built) contexts.push(context);
    }
    return contexts;
  }

  private runMaterialDepth(
    encoder: GPUCommandEncoder,
    pipeline: GPURenderPipeline,
    meshView: GPUTextureView,
    sceneDatabase: GPUBuffer,
    depthView: GPUTextureView
  ): void {
    const group0 = this.materials.obtainMaterialDepthMeshBindGroup(meshView);
    const group1 = this.materials.obtainMaterialDepthSceneBindGroup(
      sceneDatabase
    );
    const pass = encoder.beginRenderPass({
      label: "Material Expand/depth",
      colorAttachments: [],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "store"
      },
      primitive: { topology: "triangle-list", cullMode: "none" }
    } as GPURenderPassDescriptor & { primitive: GPUPrimitiveState });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group0);
    pass.setBindGroup(1, group1);
    pass.draw(3);
    pass.end();
  }

  destroy(): void {}
}

function texture(value: unknown): GPUTextureView {
  return resolveTextureView(value);
}

function buffer(value: unknown): GPUBuffer {
  if (value && typeof value === "object" && "size" in value && "usage" in value) {
    return value as GPUBuffer;
  }
  throw new Error("MaterialExpandPass: expected GPUBuffer");
}

function requireShadeCommandContext(value: unknown): ShadeGPUCommandContext {
  if (
    value &&
    typeof value === "object" &&
    "allocateTransientBufferAndLoad" in value &&
    "constructComputePass" in value
  ) {
    return value as ShadeGPUCommandContext;
  }
  throw new Error("MaterialExpandPass: GPU counters require ShadeGPUCommandContext");
}

function colorAttachment(view: GPUTextureView): GPURenderPassColorAttachment {
  return {
    view,
    loadOp: "clear",
    storeOp: "store"
  };
}

function textureDescriptor(
  width: number,
  height: number,
  format: GPUTextureFormat,
  usage: GPUTextureUsageFlags
) {
  return {
    kind: "transient_texture" as const,
    label: format,
    width,
    height,
    format,
    usage
  };
}

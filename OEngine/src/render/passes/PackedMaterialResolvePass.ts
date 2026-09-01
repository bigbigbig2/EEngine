import { GpuCounterAtomicAdder } from "../../debug/GpuCounterAtomicAdder.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GpuAssetBindings } from "../../gpu/GpuAssetStore.js";
import type { GpuSceneBindings } from "../../gpu/GpuScene.js";
import type { PackedSceneRuntime } from "../../gpu/GpuPackedSceneRegistry.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import {
  GPU_SURFACE_BYTES_PER_PIXEL,
  GPU_SURFACE_FORMATS
} from "../../gpu/GpuSurfaceAbi.js";
import { writeGpuBuffer } from "../../gpu/GpuQueueEvidence.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { ShadeTransparencyMode } from "../../material/enums.js";
import { PACKED_MATERIAL_RESOLVE_WGSL } from "../../shaders/packed_material_resolve.js";
import type { PackedVisibilityDebugSource } from "./PackedVisibilityPass.js";
import { resolveTextureView } from "./MaterialExpandPass.js";
import {
  prepareVelocityMatrices,
  type VelocityCameraMatrices
} from "./VelocityPass.js";

/** R4-B compatibility name; the attachment stores R5 Surface metadata. */
export const PACKED_SURFACE_FLAGS_FORMAT = GPU_SURFACE_FORMATS.metadata;

const INPUT_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "R4-B Material Resolve/input group0",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: 64 } },
    {
      binding: 3,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "float", viewDimension: "2d-array" }
    },
    ...Array.from({ length: 3 }, (_, index) => ({
      binding: index + 4,
      visibility: GPUShaderStage.FRAGMENT,
      sampler: { type: "filtering" as GPUSamplerBindingType }
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      binding: index + 7,
      visibility: GPUShaderStage.FRAGMENT,
      sampler: { type: "non-filtering" as GPUSamplerBindingType }
    })),
    {
      binding: 10,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "read-only-storage" }
    },
    {
      binding: 11,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "float", viewDimension: "2d-array" }
    }
  ]
};

const LOOKUP_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "R4-B Material Resolve/lookup group1",
  entries: Array.from({ length: 9 }, (_, binding) => ({
    binding,
    visibility: GPUShaderStage.FRAGMENT,
    buffer: { type: "read-only-storage" as GPUBufferBindingType }
  }))
};

const PIPELINE: CachedRenderPipelineDescriptor = {
  label: "R4-B Single Material Resolve",
  layout: {
    label: "R4-B Single Material Resolve/layout",
    bindGroupLayouts: [INPUT_GROUP, LOOKUP_GROUP]
  },
  vertex: {
    module: { label: "R4-B Single Material Resolve", code: PACKED_MATERIAL_RESOLVE_WGSL },
    entryPoint: "packed_material_vs"
  },
  fragment: {
    module: { label: "R4-B Single Material Resolve", code: PACKED_MATERIAL_RESOLVE_WGSL },
    entryPoint: "packed_material_fs",
    targets: [
      { format: GPU_SURFACE_FORMATS.pbr },
      { format: GPU_SURFACE_FORMATS.normal },
      { format: GPU_SURFACE_FORMATS.albedoAo },
      { format: GPU_SURFACE_FORMATS.emissive },
      { format: GPU_SURFACE_FORMATS.velocity },
      { format: GPU_SURFACE_FORMATS.metadata }
    ]
  },
  primitive: { topology: "triangle-list", cullMode: "none" }
};

export interface PackedMaterialResolveJob {
  readonly runtime: PackedSceneRuntime;
  readonly assets: GpuAssetBindings;
  readonly scene: GpuSceneBindings;
  readonly visibility: PackedVisibilityDebugSource;
  readonly width: number;
  readonly height: number;
  readonly currentCamera: VelocityCameraMatrices;
  readonly previousCamera: VelocityCameraMatrices;
}

export interface PackedMaterialResolveOutputs {
  readonly gPbr: ResourceId;
  readonly gNormal: ResourceId;
  readonly gAlbedo: ResourceId;
  readonly gEmissive: ResourceId;
  readonly velocity: ResourceId;
  /** R4-B compatibility property; resource semantic is Surface metadata. */
  readonly surfaceFlags: ResourceId;
  readonly counters: ResourceId | null;
}

/** One visible-pixel draw; active material count affects data only, never draw count. */
export class PackedMaterialResolvePass {
  private readonly counterAdder = new GpuCounterAtomicAdder();
  private readonly previousViewProjection = new Float32Array(16);
  private readonly inverseCurrent = new Float32Array(16);
  private readonly unusedRotation = new Float32Array(16);
  private readonly previousViewProjectionBuffer: GPUBuffer;
  private readonly samplers: readonly GPUSampler[];
  lastDrawCount = 0;
  lastActiveMaterialCount = 0;
  readonly surfaceBytesPerPixel = GPU_SURFACE_BYTES_PER_PIXEL;

  constructor(private readonly graphics: GraphicsContext) {
    this.previousViewProjectionBuffer = graphics.device.createBuffer({
      label: "R4-B Material Resolve/previous view projection",
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.samplers = Object.freeze([
      createSampler(graphics.device, "repeat", "linear"),
      createSampler(graphics.device, "clamp-to-edge", "linear"),
      createSampler(graphics.device, "mirror-repeat", "linear"),
      createSampler(graphics.device, "repeat", "nearest"),
      createSampler(graphics.device, "clamp-to-edge", "nearest"),
      createSampler(graphics.device, "mirror-repeat", "nearest")
    ]);
  }

  addToGraph(
    graph: FrameGraph,
    job: PackedMaterialResolveJob,
    inputs: { visibilityKey: ResourceId; view: ResourceId; counters?: ResourceId }
  ): PackedMaterialResolveOutputs {
    const width = Math.max(1, job.width | 0);
    const height = Math.max(1, job.height | 0);
    const output = {
      gPbr: -1,
      gNormal: -1,
      gAlbedo: -1,
      gEmissive: -1,
      velocity: -1,
      surfaceFlags: -1,
      counters: null as ResourceId | null
    };
    const builder = graph.add(
      "R4-B Single Material Resolve",
      job,
      (data, resources, context) => {
        const command = requireCommand(context.encoder);
        prepareVelocityMatrices(
          this.unusedRotation,
          this.inverseCurrent,
          this.previousViewProjection,
          data.currentCamera,
          data.previousCamera,
          data.width,
          data.height
        );
        writeGpuBuffer(
          this.graphics.device.queue,
          "R4-B Material Resolve/previous view projection",
          this.previousViewProjectionBuffer,
          0,
          this.previousViewProjection
        );
        const visibility = data.visibility.resolve();
        const pipeline = this.graphics.render_pipelines.obtain(PIPELINE);
        const group0 = this.graphics.bind_groups.obtain({
          layout: INPUT_GROUP,
          entries: [
            resolveTextureView(resources.get(inputs.visibilityKey)),
            { buffer: requireBuffer(resources.get(inputs.view), "view") },
            { buffer: this.previousViewProjectionBuffer },
            data.runtime.materialVisibility.textureArray,
            ...this.samplers,
            { buffer: data.runtime.materialVisibility.materialRecords },
            data.runtime.materialVisibility.highResolutionTextureArray
          ]
        });
        const group1 = this.graphics.bind_groups.obtain({
          layout: LOOKUP_GROUP,
          entries: [
            { buffer: data.scene.instances },
            { buffer: data.assets.geometryRecords },
            { buffer: data.assets.meshletRecords },
            { buffer: data.assets.meshletVertexIndices },
            { buffer: data.assets.meshletTriangleIndices },
            { buffer: data.assets.vertexStreamDescriptors },
            { buffer: data.assets.vertexStreamData },
            { buffer: visibility.visibleClusters },
            { buffer: visibility.rasterWork }
          ]
        });
        const pass = command.beginRenderPass({
          label: "R4-B Single Material Resolve/surface+velocity",
          colorAttachments: [
            attachment(resources, output.gPbr),
            attachment(resources, output.gNormal),
            attachment(resources, output.gAlbedo),
            attachment(resources, output.gEmissive),
            attachment(resources, output.velocity),
            attachment(resources, output.surfaceFlags)
          ]
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group0);
        pass.setBindGroup(1, group1);
        pass.draw(3, 1, 0, 0);
        pass.end();
        this.lastDrawCount = 1;
        this.lastActiveMaterialCount = data.runtime.materials.filter(
          (material) => material.transparency_mode !== ShadeTransparencyMode.Transparent
        ).length;
        if (inputs.counters !== undefined) {
          this.counterAdder.encode(
            command,
            requireBuffer(resources.get(inputs.counters), "GPU counters"),
            "activeMaterials",
            this.lastActiveMaterialCount
          );
        }
      }
    );
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    output.gPbr = builder.create(
      "surface/PBR",
      texture(width, height, GPU_SURFACE_FORMATS.pbr, usage)
    );
    output.gNormal = builder.create(
      "surface/normal",
      texture(width, height, GPU_SURFACE_FORMATS.normal, usage)
    );
    output.gAlbedo = builder.create(
      "surface/albedo+AO",
      texture(width, height, GPU_SURFACE_FORMATS.albedoAo, usage)
    );
    output.gEmissive = builder.create(
      "surface/emissive",
      texture(width, height, GPU_SURFACE_FORMATS.emissive, usage)
    );
    output.velocity = builder.create(
      "surface/velocity",
      texture(width, height, GPU_SURFACE_FORMATS.velocity, usage)
    );
    output.surfaceFlags = builder.create(
      "surface/metadata",
      texture(width, height, GPU_SURFACE_FORMATS.metadata, usage)
    );
    builder.read(inputs.visibilityKey);
    builder.read(inputs.view);
    if (inputs.counters !== undefined) {
      builder.read(inputs.counters);
      output.counters = builder.write(inputs.counters);
    }
    return output;
  }

  destroy(): void {
    this.previousViewProjectionBuffer.destroy();
  }
}

function createSampler(
  device: GPUDevice,
  addressMode: GPUAddressMode,
  filter: GPUFilterMode
): GPUSampler {
  return device.createSampler({
    label: `R4-B Material Resolve/${addressMode}-${filter}`,
    addressModeU: addressMode,
    addressModeV: addressMode,
    minFilter: filter,
    magFilter: filter,
    mipmapFilter: filter
  });
}

function attachment(
  resources: { get(id: ResourceId): unknown },
  id: ResourceId
): GPURenderPassColorAttachment {
  return {
    view: resolveTextureView(resources.get(id)),
    clearValue: { r: 0, g: 0, b: 0, a: 0 },
    loadOp: "clear",
    storeOp: "store"
  };
}

function texture(
  width: number,
  height: number,
  format: GPUTextureFormat,
  usage: GPUTextureUsageFlags
) {
  return { kind: "transient_texture" as const, label: format, width, height, format, usage };
}

function requireCommand(value: unknown): ShadeGPUCommandContext {
  if (value && typeof value === "object" && "isGPUCommandContext" in value) {
    return value as ShadeGPUCommandContext;
  }
  throw new Error("PackedMaterialResolvePass requires ShadeGPUCommandContext");
}

function requireBuffer(value: unknown, label: string): GPUBuffer {
  if (value && typeof value === "object" && "size" in value && "usage" in value) {
    return value as GPUBuffer;
  }
  throw new Error(`PackedMaterialResolvePass expected ${label} GPUBuffer`);
}

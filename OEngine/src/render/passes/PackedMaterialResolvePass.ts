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
  GPU_SURFACE_FORMATS,
  gpuSurfaceBytesPerPixel
} from "../../gpu/GpuSurfaceAbi.js";
import { writeGpuBuffer } from "../../gpu/GpuQueueEvidence.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { PACKED_MATERIAL_RESOLVE_WGSL } from "../../shaders/packed_material_resolve.js";
import {
  GPU_MATERIAL_KERNEL_CLASS_COUNT,
  GPU_SHADE_DRAW_INDIRECT_STRIDE
} from "../../gpu/GpuMaterialKernelAbi.js";
import { VisiblePixelClassifier } from "../VisiblePixelClassifier.js";
import type { PackedVisibilityDebugSource } from "./PackedVisibilityPass.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import {
  surfaceFrame,
  textureDomain,
  type SurfaceFrame
} from "../pipeline/FrameProducts.js";
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
    {
      binding: 1,
      visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" }
    },
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
    },
    {
      binding: 12,
      visibility: GPUShaderStage.VERTEX,
      buffer: { type: "read-only-storage" }
    }
  ]
};

const LOOKUP_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "R4-B Material Resolve/lookup group1",
  entries: Array.from({ length: 8 }, (_, binding) => ({
    binding,
    visibility: GPUShaderStage.FRAGMENT,
    buffer: { type: "read-only-storage" as GPUBufferBindingType }
  }))
};

function materialKernelPipeline(
  kernelClass: number,
  velocityEnabled: boolean
): CachedRenderPipelineDescriptor {
  return {
    label: `Material Resolve/kernel ${kernelClass}`,
    layout: {
      label: "Material Resolve/specialized kernel layout",
      bindGroupLayouts: [INPUT_GROUP, LOOKUP_GROUP]
    },
    vertex: {
      module: { label: "Material Resolve/specialized", code: PACKED_MATERIAL_RESOLVE_WGSL },
      entryPoint: "packed_material_vs"
    },
    fragment: {
      module: { label: "Material Resolve/specialized", code: PACKED_MATERIAL_RESOLVE_WGSL },
      entryPoint: "packed_material_fs",
      constants: {
        OENGINE_ACTIVE_KERNEL_CLASS: kernelClass,
        OENGINE_VELOCITY_ENABLED: velocityEnabled ? 1 : 0
      },
      targets: [
        { format: GPU_SURFACE_FORMATS.pbr },
        { format: GPU_SURFACE_FORMATS.normal },
        { format: GPU_SURFACE_FORMATS.albedoAo },
        { format: GPU_SURFACE_FORMATS.emissive },
        velocityEnabled ? { format: GPU_SURFACE_FORMATS.velocity } : null,
        { format: GPU_SURFACE_FORMATS.metadata }
      ]
    },
    primitive: { topology: "point-list", cullMode: "none" }
  };
}

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
  readonly velocity: ResourceId | null;
  /** R4-B compatibility property; resource semantic is Surface metadata. */
  readonly surfaceFlags: ResourceId;
  /** Surface ABI v1 的不可变产品视图，避免调用方按 attachment 顺序重组。 */
  readonly surface: SurfaceFrame;
  readonly counters: ResourceId | null;
}

/** Count/prefix/scatter visible pixels, then issue one bounded indirect draw per kernel class. */
export class PackedMaterialResolvePass {
  private readonly counterAdder = new GpuCounterAtomicAdder();
  private readonly classifier: VisiblePixelClassifier;
  private readonly pipelines: readonly (readonly CachedRenderPipelineDescriptor[])[];
  private readonly previousViewProjection = new Float32Array(16);
  private readonly inverseCurrent = new Float32Array(16);
  private readonly unusedRotation = new Float32Array(16);
  private readonly previousViewProjectionBuffer: GPUBuffer;
  private readonly samplers: readonly GPUSampler[];
  lastKernelDrawCount = 0;
  lastActiveMaterialCount = 0;
  private currentSurfaceBytesPerPixel = GPU_SURFACE_BYTES_PER_PIXEL;

  get surfaceBytesPerPixel(): number {
    return this.currentSurfaceBytesPerPixel;
  }

  constructor(private readonly graphics: GraphicsContext) {
    this.classifier = new VisiblePixelClassifier(graphics.device);
    this.pipelines = Object.freeze([false, true].map((velocityEnabled) =>
      Object.freeze(Array.from(
        { length: GPU_MATERIAL_KERNEL_CLASS_COUNT },
        (_, kernelClass) => materialKernelPipeline(kernelClass, velocityEnabled)
      ))
    ));
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
    inputs: { visibilityKey: ResourceId; view: ResourceId; counters?: ResourceId },
    options: Readonly<{ velocity: boolean }> = { velocity: true }
  ): PackedMaterialResolveOutputs {
    const width = Math.max(1, job.width | 0);
    const height = Math.max(1, job.height | 0);
    const output = {
      gPbr: -1,
      gNormal: -1,
      gAlbedo: -1,
      gEmissive: -1,
      velocity: null as ResourceId | null,
      surfaceFlags: -1,
      surface: null as unknown as SurfaceFrame,
      counters: null as ResourceId | null
    };
    const builder = graph.add(
      "Material Resolve/classified visible pixels",
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
        const classified = this.classifier.encode(command, {
          visibilityKeys: resolveTextureView(resources.get(inputs.visibilityKey)),
          materials: data.runtime.materialResources,
          visibility,
          width: data.width,
          height: data.height,
          counterBuffer: inputs.counters === undefined
            ? undefined
            : requireBuffer(resources.get(inputs.counters), "GPU counters")
        });
        const group0 = this.graphics.bind_groups.obtain({
          layout: INPUT_GROUP,
          entries: [
            resolveTextureView(resources.get(inputs.visibilityKey)),
            { buffer: requireBuffer(resources.get(inputs.view), "view") },
            { buffer: this.previousViewProjectionBuffer },
            data.runtime.materialResources.textureArray,
            ...this.samplers,
            { buffer: data.runtime.materialResources.materialRecords },
            data.runtime.materialResources.highResolutionTextureArray,
            { buffer: classified.shadeWork }
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
            { buffer: visibility.rasterWork }
          ]
        });
        const pass = command.beginRenderPass({
          label: "Material Resolve/specialized Surface",
          colorAttachments: [
            attachment(resources, output.gPbr),
            attachment(resources, output.gNormal),
            attachment(resources, output.gAlbedo),
            attachment(resources, output.gEmissive),
            output.velocity === null ? null : attachment(resources, output.velocity),
            attachment(resources, output.surfaceFlags)
          ]
        });
        for (let kernelClass = 0; kernelClass < GPU_MATERIAL_KERNEL_CLASS_COUNT; kernelClass++) {
          pass.setPipeline(this.graphics.render_pipelines.obtain(
            this.pipelines[options.velocity ? 1 : 0]![kernelClass]!
          ));
          pass.setBindGroup(0, group0);
          pass.setBindGroup(1, group1);
          pass.drawIndirect(
            classified.drawIndirect,
            kernelClass * GPU_SHADE_DRAW_INDIRECT_STRIDE
          );
        }
        pass.end();
        this.lastKernelDrawCount = GPU_MATERIAL_KERNEL_CLASS_COUNT;
        this.lastActiveMaterialCount = data.runtime.opaqueMaterialCount;
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
    if (options.velocity) {
      output.velocity = builder.create(
        "surface/velocity",
        texture(width, height, GPU_SURFACE_FORMATS.velocity, usage)
      );
    }
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
    this.currentSurfaceBytesPerPixel = gpuSurfaceBytesPerPixel(options);
    output.surface = surfaceFrame({
      depth: null,
      pbr: output.gPbr,
      normal: output.gNormal,
      albedoAo: output.gAlbedo,
      emissive: output.gEmissive,
      velocity: output.velocity,
      metadata: output.surfaceFlags,
      domain: textureDomain("internal-full", width, height, 1)
    });
    return Object.freeze(output);
  }

  destroy(): void {
    this.classifier.destroy();
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

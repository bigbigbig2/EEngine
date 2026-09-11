import { GpuCounterAtomicAdder } from "../../debug/GpuCounterAtomicAdder.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GpuAssetBindings } from "../../gpu/GpuAssetStore.js";
import type { GpuSceneBindings } from "../../gpu/GpuScene.js";
import type { GpuRenderWorldRuntime } from "../../gpu/GpuRenderWorld.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import {
  GPU_SURFACE_BYTES_PER_PIXEL,
  GPU_SURFACE_FORMATS,
  GPU_SURFACE_ABI_V1_PROFILE,
  type GpuSurfaceAbiProfile,
  gpuSurfaceNormalPipelineConstants
} from "../../gpu/GpuSurfaceAbi.js";
import { writeGpuBuffer } from "../../gpu/GpuQueueEvidence.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { PACKED_MATERIAL_RESOLVE_WGSL } from "../../shaders/packed_material_resolve.js";
import { PACKED_TRIANGLE_SETUP_EVIDENCE_WGSL } from "../../shaders/packed_triangle_setup_evidence.js";
import {
  GPU_MATERIAL_KERNEL_CLASS_COUNT
} from "../../gpu/GpuMaterialKernelAbi.js";
import {
  isMaterialResolveBackend,
  type MaterialResolveBackend as MaterialResolveBackendType
} from "../MaterialResolveBackend.js";
import { PackedMaterialClassDepthPass } from "./PackedMaterialClassDepthPass.js";
import { resolveDepthAttachmentView, resolveTextureView } from "../RenderTargetViews.js";
import {
  surfaceFrame,
  materialClassificationFrame,
  textureDomain,
  type SurfaceFrame,
  type VisibilityFrame,
  type MaterialClassificationFrame
} from "../pipeline/FrameProducts.js";
import {
  prepareVelocityMatrices,
  type VelocityCameraMatrices
} from "../VelocityMatrices.js";

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
    ...Array.from({ length: 7 }, (_, index) => ({
      binding: index + 12,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "float" as GPUTextureSampleType, viewDimension: "2d-array" as GPUTextureViewDimension }
    }))
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

const SETUP_EVIDENCE_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "R4-B Material Resolve/TriangleSetup evidence group",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
  ]
};

function materialKernelPipeline(
  kernelClass: number,
  velocityEnabled: boolean,
  backend: MaterialResolveBackendType,
  surfaceProfile: GpuSurfaceAbiProfile
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
        OENGINE_VELOCITY_ENABLED: velocityEnabled ? 1 : 0,
        OENGINE_CLASS_DISCARD: backend === "class-discard" ? 1 : 0,
        ...gpuSurfaceNormalPipelineConstants(surfaceProfile.normalEncoding)
      },
      targets: [
        { format: surfaceProfile.formats.pbr },
        { format: surfaceProfile.formats.normal },
        { format: surfaceProfile.formats.albedoAo },
        { format: surfaceProfile.formats.emissive },
        velocityEnabled ? { format: surfaceProfile.formats.velocity } : null,
        { format: surfaceProfile.formats.metadata }
      ]
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
        format: "depth32float" as GPUTextureFormat,
        depthWriteEnabled: false,
        depthCompare: (backend === "class-depth" ? "equal" : "always") as GPUCompareFunction
    }
  };
}

export interface PackedMaterialResolveJob {
  readonly runtime: GpuRenderWorldRuntime;
  readonly assets: GpuAssetBindings;
  readonly scene: GpuSceneBindings;
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
  readonly classification: MaterialClassificationFrame | null;
  readonly counters: ResourceId | null;
}

/** Resolve Surface with one bounded fullscreen draw per active kernel class. */
export class PackedMaterialResolvePass {
  private readonly counterAdder = new GpuCounterAtomicAdder();
  private readonly classDepthPass: PackedMaterialClassDepthPass;
  private setupEvidencePipeline: GPUComputePipeline | null = null;
  private readonly backend: MaterialResolveBackendType;
  private readonly surfaceProfile: GpuSurfaceAbiProfile;
  private readonly pipelines: readonly (readonly CachedRenderPipelineDescriptor[])[];
  private readonly previousViewProjection = new Float32Array(16);
  private readonly inverseCurrent = new Float32Array(16);
  private readonly unusedRotation = new Float32Array(16);
  private readonly previousViewProjectionBuffer: GPUBuffer;
  private readonly zeroTriangleSetupBuffer: GPUBuffer;
  private readonly samplers: readonly GPUSampler[];
  private cachedLookupGroup: GPUBindGroup | null = null;
  private cachedLookupInputs: PackedMaterialLookupInputs | null = null;
  lastKernelDrawCount = 0;
  lastActiveMaterialCount = 0;
  private currentSurfaceBytesPerPixel = GPU_SURFACE_BYTES_PER_PIXEL;

  get surfaceBytesPerPixel(): number {
    return this.currentSurfaceBytesPerPixel;
  }

  get materialResolveBackend(): MaterialResolveBackendType {
    return this.backend;
  }

  constructor(
    private readonly graphics: GraphicsContext,
    backend: MaterialResolveBackendType = "class-depth",
    surfaceProfile: GpuSurfaceAbiProfile = GPU_SURFACE_ABI_V1_PROFILE
  ) {
    if (!isMaterialResolveBackend(backend)) throw new Error(`Unknown material resolve backend: ${backend}`);
    this.backend = backend;
    this.surfaceProfile = surfaceProfile;
    this.classDepthPass = new PackedMaterialClassDepthPass(graphics);
    this.pipelines = Object.freeze([false, true].map((velocityEnabled) =>
      Object.freeze(Array.from(
        { length: GPU_MATERIAL_KERNEL_CLASS_COUNT },
        (_, kernelClass) => materialKernelPipeline(
          kernelClass,
          velocityEnabled,
          this.backend,
          this.surfaceProfile
        )
      ))
    ));
    this.previousViewProjectionBuffer = graphics.device.createBuffer({
      label: "R4-B Material Resolve/previous view projection",
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.zeroTriangleSetupBuffer = graphics.device.createBuffer({
      label: "R4-B Material Resolve/disabled TriangleSetup record",
      size: 40,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    graphics.device.queue.writeBuffer(this.zeroTriangleSetupBuffer, 0, new Uint8Array(40));
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
    inputs: { visibility: VisibilityFrame; view: ResourceId; counters?: ResourceId },
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
      classification: null as MaterialClassificationFrame | null,
      counters: null as ResourceId | null
    };
    let classDepth: ResourceId | null = null;
    if (this.backend === "class-depth") {
      classDepth = this.classDepthPass.addToGraph(graph, {
        visibilityKey: inputs.visibility.visibilityKey,
        meshletWork: inputs.visibility.meshletWork.records,
        materials: job.runtime.materialResources.materialRecords,
        width,
        height
      });
      output.classification = materialClassificationFrame({
        classDepth,
        format: "depth32float",
        domain: textureDomain("internal-full", width, height, 1)
      });
    }
    const builder = graph.add(
      "Material Resolve/fullscreen kernels",
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
        const meshletWork = requireBuffer(
          resources.get(inputs.visibility.meshletWork.records),
          "MeshletWork"
        );
        const setupRecords = inputs.visibility.triangleSetup.records === null
          ? this.zeroTriangleSetupBuffer
          : requireBuffer(
            resources.get(inputs.visibility.triangleSetup.records),
            "TriangleSetup records"
          );
        const group0 = this.graphics.bind_groups.obtain({
          layout: INPUT_GROUP,
          entries: [
            resolveTextureView(resources.get(inputs.visibility.visibilityKey)),
            { buffer: requireBuffer(resources.get(inputs.view), "view") },
            { buffer: this.previousViewProjectionBuffer },
            data.runtime.materialResources.textureBanks[0],
            ...this.samplers,
            { buffer: data.runtime.materialResources.materialRecords },
            ...data.runtime.materialResources.textureBanks.slice(1)
          ]
        });
        const lookupInputs: PackedMaterialLookupInputs = {
          instances: data.scene.instances,
          geometryRecords: data.assets.geometryRecords,
          meshletRecords: data.assets.meshletRecords,
          meshletVertexIndices: data.assets.meshletVertexIndices,
          meshletTriangleIndices: data.assets.meshletTriangleIndices,
          vertexStreamDescriptors: data.assets.vertexStreamDescriptors,
          vertexStreamData: data.assets.vertexStreamData,
          meshletWork,
          setupRecords
        };
        if (!sameLookupInputs(this.cachedLookupInputs, lookupInputs)) {
          this.cachedLookupInputs = lookupInputs;
          this.cachedLookupGroup = this.graphics.bind_groups.obtain({
            layout: LOOKUP_GROUP,
            entries: [
              { buffer: lookupInputs.instances },
              { buffer: lookupInputs.geometryRecords },
              { buffer: lookupInputs.meshletRecords },
              { buffer: lookupInputs.meshletVertexIndices },
              { buffer: lookupInputs.meshletTriangleIndices },
              { buffer: lookupInputs.vertexStreamDescriptors },
              { buffer: lookupInputs.vertexStreamData },
              { buffer: lookupInputs.meshletWork },
              { buffer: lookupInputs.setupRecords }
            ]
          });
        }
        const group1 = this.cachedLookupGroup!;
        const pass = command.beginRenderPass({
          label: "Material Resolve/specialized Surface",
          colorAttachments: [
            attachment(resources, output.gPbr),
            attachment(resources, output.gNormal),
            attachment(resources, output.gAlbedo),
            attachment(resources, output.gEmissive),
            output.velocity === null ? null : attachment(resources, output.velocity),
            attachment(resources, output.surfaceFlags)
          ],
          depthStencilAttachment: {
            view: resolveDepthAttachmentView(resources.get(classDepth ?? inputs.visibility.depth)),
            depthReadOnly: true
          }
        });
        for (let kernelClass = 0; kernelClass < GPU_MATERIAL_KERNEL_CLASS_COUNT; kernelClass++) {
          if ((data.runtime.activeKernelMask & (1 << kernelClass)) === 0) continue;
          pass.setPipeline(this.graphics.render_pipelines.obtain(
            this.pipelines[options.velocity ? 1 : 0]![kernelClass]!
          ));
          pass.setBindGroup(0, group0);
          pass.setBindGroup(1, group1);
          pass.draw(3, 1, 0, 0);
        }
        pass.end();
        if (inputs.counters !== undefined && inputs.visibility.triangleSetup.capacity > 0) {
          const setupEvidence = this.ensureSetupEvidencePipeline();
          const evidenceGroup = this.graphics.bind_groups.obtain({
            layout: SETUP_EVIDENCE_GROUP,
            entries: [
              resolveTextureView(resources.get(inputs.visibility.visibilityKey)),
              { buffer: meshletWork },
              { buffer: setupRecords },
              { buffer: requireBuffer(resources.get(inputs.counters), "GPU counters") }
            ]
          });
          const evidence = command.beginComputePass({
            label: "Material Resolve/TriangleSetup evidence"
          });
          evidence.setPipeline(setupEvidence.pipeline);
          evidence.setBindGroup(0, evidenceGroup);
          evidence.dispatchWorkgroups(
            Math.ceil(width / 8),
            Math.ceil(height / 8),
            1
          );
          evidence.end();
        }
        this.lastKernelDrawCount = countActiveKernelClasses(data.runtime.activeKernelMask);
        this.lastActiveMaterialCount = data.runtime.opaqueMaterialCount;
        if (inputs.counters !== undefined) {
          this.counterAdder.encode(
            command,
            requireBuffer(resources.get(inputs.counters), "GPU counters"),
            "activeMaterials",
            this.lastActiveMaterialCount
          );
          this.counterAdder.encode(
            command,
            requireBuffer(resources.get(inputs.counters), "GPU counters"),
            "classDraws",
            this.lastKernelDrawCount
          );
        }
      }
    );
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    output.gPbr = builder.create(
      "surface/PBR",
      texture(width, height, this.surfaceProfile.formats.pbr, usage)
    );
    output.gNormal = builder.create(
      "surface/normal",
      texture(width, height, this.surfaceProfile.formats.normal, usage)
    );
    output.gAlbedo = builder.create(
      "surface/albedo+AO",
      texture(width, height, this.surfaceProfile.formats.albedoAo, usage)
    );
    output.gEmissive = builder.create(
      "surface/emissive",
      texture(width, height, this.surfaceProfile.formats.emissive, usage)
    );
    if (options.velocity) {
      output.velocity = builder.create(
        "surface/velocity",
        texture(width, height, this.surfaceProfile.formats.velocity, usage)
      );
    }
    output.surfaceFlags = builder.create(
      "surface/metadata",
      texture(width, height, this.surfaceProfile.formats.metadata, usage)
    );
    builder.read(inputs.visibility.visibilityKey);
    builder.read(inputs.visibility.meshletWork.records);
    if (inputs.visibility.triangleSetup.records !== null) {
      builder.read(inputs.visibility.triangleSetup.records);
    }
    if (classDepth !== null) builder.read(classDepth);
    if (this.backend === "class-discard") builder.read(inputs.visibility.depth);
    builder.read(inputs.view);
    if (inputs.counters !== undefined) {
      builder.read(inputs.counters);
      output.counters = builder.write(inputs.counters);
    }
    this.currentSurfaceBytesPerPixel = options.velocity
      ? this.surfaceProfile.bytesPerPixelWithVelocity
      : this.surfaceProfile.bytesPerPixelWithoutVelocity;
    output.surface = surfaceFrame({
      abiVersion: this.surfaceProfile.version,
      depth: inputs.visibility.depth,
      pbr: output.gPbr,
      normal: output.gNormal,
      albedoAo: output.gAlbedo,
      emissive: output.gEmissive,
      velocity: output.velocity,
      metadata: output.surfaceFlags,
      domain: textureDomain("internal-full", width, height, 1)
    }, this.surfaceProfile.version);
    return Object.freeze(output);
  }

  destroy(): void {
    this.classDepthPass.destroy();
    this.previousViewProjectionBuffer.destroy();
    this.zeroTriangleSetupBuffer.destroy();
    this.cachedLookupGroup = null;
    this.cachedLookupInputs = null;
  }

  private ensureSetupEvidencePipeline(): Readonly<{
    pipeline: GPUComputePipeline;
  }> {
    if (this.setupEvidencePipeline !== null) {
      return { pipeline: this.setupEvidencePipeline };
    }
    const pipeline = this.graphics.compute_pipelines.obtain({
      label: "R4-B Material Resolve/TriangleSetup evidence",
      layout: {
        label: "R4-B Material Resolve/TriangleSetup evidence layout",
        bindGroupLayouts: [SETUP_EVIDENCE_GROUP]
      },
      compute: {
        module: {
          label: "R4-B Material Resolve/TriangleSetup evidence",
          code: PACKED_TRIANGLE_SETUP_EVIDENCE_WGSL
        },
        entryPoint: "packed_triangle_setup_evidence"
      }
    });
    this.setupEvidencePipeline = pipeline;
    return { pipeline };
  }
}

interface PackedMaterialLookupInputs {
  readonly instances: GPUBuffer;
  readonly geometryRecords: GPUBuffer;
  readonly meshletRecords: GPUBuffer;
  readonly meshletVertexIndices: GPUBuffer;
  readonly meshletTriangleIndices: GPUBuffer;
  readonly vertexStreamDescriptors: GPUBuffer;
  readonly vertexStreamData: GPUBuffer;
  readonly meshletWork: GPUBuffer;
  readonly setupRecords: GPUBuffer;
}

function sameLookupInputs(
  previous: PackedMaterialLookupInputs | null,
  next: PackedMaterialLookupInputs
): boolean {
  return previous !== null &&
    previous.instances === next.instances &&
    previous.geometryRecords === next.geometryRecords &&
    previous.meshletRecords === next.meshletRecords &&
    previous.meshletVertexIndices === next.meshletVertexIndices &&
    previous.meshletTriangleIndices === next.meshletTriangleIndices &&
    previous.vertexStreamDescriptors === next.vertexStreamDescriptors &&
    previous.vertexStreamData === next.vertexStreamData &&
    previous.meshletWork === next.meshletWork &&
    previous.setupRecords === next.setupRecords;
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

function countActiveKernelClasses(mask: number): number {
  let value = mask >>> 0;
  let count = 0;
  while (value !== 0) {
    count += value & 1;
    value >>>= 1;
  }

  return count;
}

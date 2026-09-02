import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GeometryHierarchyView } from "../../geometry/GeometryHierarchy.js";
import type { GpuAssetBindings } from "../../gpu/GpuAssetStore.js";
import type { GpuSceneBindings } from "../../gpu/GpuScene.js";
import { GPU_INSTANCE_FLAGS } from "../../gpu/GpuInstanceAbi.js";
import type { PackedSceneRuntime } from "../../gpu/GpuPackedSceneRegistry.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import {
  GPU_VISIBILITY_KEY_EMPTY,
  assertGpuVisibilityRasterWorkCapacity,
  visibilityRasterWorkBufferByteLength,
  type GpuVisibilityBufferLimits
} from "../../gpu/GpuVisibilityKeyAbi.js";
import { LPV_CAMERA_TYPE } from "../../shaders/lpv_indirect_diffuse.js";
import {
  PACKED_HIERARCHY_VISIBILITY_RASTER_WGSL,
  PACKED_OPAQUE_VISIBILITY_RASTER_WGSL,
  PACKED_HIERARCHY_VISIBILITY_VERTICES_PER_TRIANGLE
} from "../../shaders/packed_visibility.js";
import {
  HierarchicalWorkGenerator,
  type PreparedHierarchyWork
} from "../HierarchicalWorkGenerator.js";
import { VIS_MESH_CLEAR_SENTINEL } from "../VisibilityBufferContract.js";
import {
  resolveDepthAttachmentView,
  resolveTextureView
} from "./MaterialExpandPass.js";
import {
  ExactTriangleFilter,
  type PreparedExactTriangleFilter
} from "../ExactTriangleFilter.js";

const OPAQUE_RASTER_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "Packed Visibility position-only OPAQUE group0",
  entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform", minBindingSize: LPV_CAMERA_TYPE.size } },
    ...Array.from({ length: 7 }, (_, index) => ({
      binding: index + 1,
      visibility: GPUShaderStage.VERTEX,
      buffer: { type: "read-only-storage" as GPUBufferBindingType }
    }))
  ]
};

const OPAQUE_RASTER_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "Packed Visibility position-only OPAQUE consumer",
  layout: {
    label: "Packed Visibility position-only OPAQUE layout",
    bindGroupLayouts: [OPAQUE_RASTER_GROUP]
  },
  vertex: {
    module: { label: "Packed Visibility OPAQUE", code: PACKED_OPAQUE_VISIBILITY_RASTER_WGSL },
    entryPoint: "raster_opaque_exact"
  },
  fragment: {
    module: { label: "Packed Visibility OPAQUE", code: PACKED_OPAQUE_VISIBILITY_RASTER_WGSL },
    entryPoint: "write_opaque_visibility",
    targets: [{ format: "r32uint" }]
  },
  primitive: { topology: "triangle-list", cullMode: "none" },
  depthStencil: {
    format: "depth32float",
    depthWriteEnabled: true,
    depthCompare: "greater"
  }
};

const HIERARCHY_RASTER_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "Packed Visibility MASK alpha group0",
  entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform", minBindingSize: LPV_CAMERA_TYPE.size } },
    ...Array.from({ length: 7 }, (_, index) => ({
      binding: index + 1,
      visibility: GPUShaderStage.VERTEX,
      buffer: { type: "read-only-storage" as GPUBufferBindingType }
    })),
    {
      binding: 8,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "read-only-storage" }
    },
    {
      binding: 9,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "unfilterable-float", viewDimension: "2d-array" }
    },
    {
      binding: 10,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "unfilterable-float", viewDimension: "2d-array" }
    }
  ]
};

const HIERARCHY_RASTER_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "Packed Visibility MASK alpha consumer",
  layout: {
    label: "Packed Visibility MASK alpha layout",
    bindGroupLayouts: [HIERARCHY_RASTER_GROUP]
  },
  vertex: {
    module: {
      label: "Packed Visibility MASK alpha consumer",
      code: PACKED_HIERARCHY_VISIBILITY_RASTER_WGSL
    },
    entryPoint: "raster_hierarchy_meshlets"
  },
  fragment: {
    module: {
      label: "Packed Visibility MASK alpha consumer",
      code: PACKED_HIERARCHY_VISIBILITY_RASTER_WGSL
    },
    entryPoint: "write_hierarchy_visibility",
    targets: [{ format: "r32uint" }]
  },
  primitive: { topology: "triangle-list", cullMode: "none" },
  depthStencil: {
    format: "depth32float",
    depthWriteEnabled: true,
    depthCompare: "greater"
  }
};

export interface PackedVisibilityJob {
  readonly runtime: PackedSceneRuntime;
  readonly assets: GpuAssetBindings;
  readonly scene: GpuSceneBindings;
  readonly countersEnabled: boolean;
  readonly width: number;
  readonly height: number;
  readonly hierarchyView: GeometryHierarchyView;
  readonly sseThreshold: number;
  readonly coneEnabled: boolean;
  readonly previousHzb: Readonly<{
    view: GPUTextureView;
    width: number;
    height: number;
    mipLevelCount: number;
    worldToClipMatrix: ArrayLike<number>;
  }> | null;
}

export interface PackedVisibilityInputs {
  readonly camera: ResourceId;
  readonly counters: ResourceId;
  readonly previousHzb?: ResourceId;
  readonly depth: ResourceId;
}

export interface PackedVisibilityOutputs {
  readonly counters: ResourceId;
  readonly visibilityKey: ResourceId;
  readonly debugResolve: PackedVisibilityDebugSource;
}

export interface PackedVisibilityDebugBindings {
  readonly instances: GPUBuffer;
  readonly meshlets: GPUBuffer;
  readonly rasterWork: GPUBuffer;
  readonly materials: GPUBuffer;
  readonly instanceCount: number;
  readonly geometryRecordCount: number;
  readonly meshletRecordCount: number;
  readonly materialCapacity: number;
  readonly classCapacity: number;
}

export interface PackedVisibilityDebugSource {
  /** Valid only while the compiled graph executes after Packed Visibility. */
  resolve(): PackedVisibilityDebugBindings;
}

export interface PackedVisibilityPreparationEvidence {
  readonly requiredCapacity: number;
  readonly requiredByteLength: number;
  readonly keyCapacity: number;
  readonly adapterCapacity: number;
  readonly effectiveCapacity: number;
  readonly effectiveByteLimit: number;
}

type PackedVisibilityHierarchyGenerator = Pick<
  HierarchicalWorkGenerator,
  "prepare" | "encode" | "release" | "destroy"
>;

type PackedVisibilityExactFilter = Pick<
  ExactTriangleFilter,
  "prepare" | "encode" | "release" | "destroy"
>;

export const PACKED_VISIBILITY_FRAGMENT_EVIDENCE = Object.freeze({
  submittedFragments: Object.freeze({
    status: "unsupported" as const,
    blockerTaskId: "WEBGPU-01-PIPELINE-STATISTICS",
    reason: "OEngine WebGPU baseline has no negotiated pipeline statistics producer"
  }),
  usefulFragments: Object.freeze({
    status: "supported" as const,
    counter: "shadedPixels" as const,
    producer: "VisibilityCounterPass/direct VisibilityKey final-pixel reducer"
  }),
  invalidKeys: Object.freeze({
    status: "supported" as const,
    counter: "invalidVisibilityKeys" as const,
    producer: "VisibilityCounterPass/direct VisibilityKey invalid reducer"
  })
});

/** R3 hierarchy production path. The temporary R2 flat producer was deleted in R3-D. */
export class PackedVisibilityPass {
  lastDrawIndirect = false;
  lastCandidateCapacity = 0;
  lastVerticesPerTriangle = PACKED_HIERARCHY_VISIBILITY_VERTICES_PER_TRIANGLE;
  lastVisibilityKeyAttachmentBytes = 0;
  readonly lastImplementation = "hierarchy" as const;
  lastPreparation: Readonly<PackedVisibilityPreparationEvidence> | null = null;
  private readonly hierarchyGenerator: PackedVisibilityHierarchyGenerator;
  private readonly exactFilter: PackedVisibilityExactFilter;
  private readonly hierarchyPrepared = new Map<
    PackedSceneRuntime,
    Map<GPUBuffer, HierarchyPreparedCacheEntry>
  >();
  private readonly debugBindings = new Map<
    PackedSceneRuntime,
    PackedVisibilityDebugBindings
  >();

  constructor(
    private readonly graphics: GraphicsContext,
    hierarchyGenerator?: PackedVisibilityHierarchyGenerator,
    exactFilter?: PackedVisibilityExactFilter
  ) {
    this.hierarchyGenerator = hierarchyGenerator ??
      new HierarchicalWorkGenerator(graphics.device);
    this.exactFilter = exactFilter ?? new ExactTriangleFilter(graphics.device);
  }

  addToGraph(
    graph: FrameGraph,
    job: PackedVisibilityJob,
    inputs: PackedVisibilityInputs
  ): PackedVisibilityOutputs {
    const output = { visibilityKey: -1 };
    const builder = graph.add(
      "Packed Visibility/exact OPAQUE+MASK producer",
      job,
      (data, resources, context) => {
        const command = requireCommand(context.encoder);
        const camera = requireBuffer(resources.get(inputs.camera), "camera");
        const counters = requireBuffer(resources.get(inputs.counters), "GPU counters");
        this.encodeHierarchy(
          data,
          command,
          camera,
          counters,
          resolveTextureView(resources.get(output.visibilityKey)),
          resolveDepthAttachmentView(resources.get(inputs.depth))
        );
      }
    );
    builder.read(inputs.camera);
    builder.read(inputs.counters);
    if (inputs.previousHzb !== undefined) builder.read(inputs.previousHzb);
    builder.write(inputs.depth);
    const counters = builder.write(inputs.counters);
    output.visibilityKey = builder.create(
      "Packed VisibilityKey",
      packedVisibilityAttachmentDescriptor(job.width, job.height)
    );
    builder.make_side_effect();
    const debugResolve = Object.freeze({
      resolve: (): PackedVisibilityDebugBindings =>
        this.requireDebugBindings(job.runtime)
    });
    return Object.freeze({ counters, visibilityKey: output.visibilityKey, debugResolve });
  }

  /** Retires all prepared hierarchy bindings for a Packed Scene in queue order. */
  release(runtime: PackedSceneRuntime, command: ShadeGPUCommandContext): void {
    const entries = this.hierarchyPrepared.get(runtime);
    this.debugBindings.delete(runtime);
    if (entries === undefined) return;
    this.hierarchyPrepared.delete(runtime);
    for (const entry of entries.values()) this.retirePrepared(entry, command);
  }

  destroy(): void {
    this.debugBindings.clear();
    this.hierarchyPrepared.clear();
    this.hierarchyGenerator.destroy();
    this.exactFilter.destroy();
  }

  private encodeHierarchy(
    job: PackedVisibilityJob,
    command: ShadeGPUCommandContext,
    camera: GPUBuffer,
    counters: GPUBuffer,
    visibilityKey: GPUTextureView,
    depth: GPUTextureView
  ): void {
    const entry = this.prepareHierarchy(job, counters, camera, command);
    const prepared = entry.prepared;
    const generated = this.hierarchyGenerator.encode(
      command.gpu_encoder,
      prepared,
      job.hierarchyView,
      {
        coneEnabled: job.coneEnabled,
        excludedInstanceFlags: GPU_INSTANCE_FLAGS.Transparent,
        previousHzb: job.previousHzb
      }
    );
    const exact = this.exactFilter.encode(
      command.gpu_encoder,
      entry.exact,
      job.width,
      job.height
    );
    this.debugBindings.set(job.runtime, Object.freeze({
      instances: job.scene.instances,
      meshlets: job.assets.meshletRecords,
      rasterWork: exact.rasterWork,
      materials: job.runtime.materialResources.materialRecords,
      instanceCount: job.scene.highWaterCount,
      geometryRecordCount: job.assets.highWaterCounts.geometryRecords,
      meshletRecordCount: job.assets.highWaterCounts.meshletRecords,
      materialCapacity: job.runtime.materialResources.materialCapacity,
      classCapacity: exact.classCapacity
    }));
    const opaquePipeline = this.graphics.render_pipelines.obtain(
      OPAQUE_RASTER_PIPELINE
    );
    const maskPipeline = this.graphics.render_pipelines.obtain(
      HIERARCHY_RASTER_PIPELINE
    );
    const opaqueGroup = this.graphics.bind_groups.obtain({
      layout: OPAQUE_RASTER_GROUP,
      entries: [
        { buffer: camera },
        { buffer: job.scene.instances },
        { buffer: job.assets.meshletRecords },
        { buffer: job.assets.meshletVertexIndices },
        { buffer: job.assets.meshletTriangleIndices },
        { buffer: job.assets.vertexStreamData },
        { buffer: job.assets.geometryRecords },
        { buffer: exact.rasterWork }
      ]
    });
    const maskGroup = this.graphics.bind_groups.obtain({
      layout: HIERARCHY_RASTER_GROUP,
      entries: [
        { buffer: camera },
        { buffer: job.scene.instances },
        { buffer: job.assets.meshletRecords },
        { buffer: job.assets.meshletVertexIndices },
        { buffer: job.assets.meshletTriangleIndices },
        { buffer: job.assets.vertexStreamData },
        { buffer: job.assets.geometryRecords },
        { buffer: exact.rasterWork },
        { buffer: job.runtime.materialResources.materialRecords },
        job.runtime.materialResources.alphaAtlas,
        job.runtime.materialResources.highResolutionAlphaAtlas
      ]
    });
    const render = command.beginRenderPass({
      label: "Packed VisibilityKey/depth exact drawIndirect",
      colorAttachments: [
        {
          view: visibilityKey,
          clearValue: { r: GPU_VISIBILITY_KEY_EMPTY, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store"
        }
      ],
      depthStencilAttachment: {
        view: depth,
        depthClearValue: 0,
        depthLoadOp: "clear",
        depthStoreOp: "store"
      }
    });
    render.setPipeline(opaquePipeline);
    render.setBindGroup(0, opaqueGroup);
    render.drawIndirect(exact.drawIndirect, exact.opaqueDrawOffset);
    render.setPipeline(maskPipeline);
    render.setBindGroup(0, maskGroup);
    render.drawIndirect(exact.drawIndirect, exact.maskDrawOffset);
    render.end();
    this.lastDrawIndirect = true;
    this.lastCandidateCapacity = job.runtime.hierarchyRasterWorkCapacity;
    this.lastVisibilityKeyAttachmentBytes = job.width * job.height * 4;
  }

  /** Validates capacity before allocating or encoding producer work. */
  prepareHierarchy(
    job: PackedVisibilityJob,
    counters: GPUBuffer,
    camera: GPUBuffer,
    command: ShadeGPUCommandContext
  ): HierarchyPreparedCacheEntry {
    this.lastPreparation = validatePackedVisibilityPreparation(
      job.runtime.hierarchyRasterWorkCapacity,
      {
        maxBufferSize: Number(this.graphics.device.limits.maxBufferSize),
        maxStorageBufferBindingSize: Number(
          this.graphics.device.limits.maxStorageBufferBindingSize
        )
      }
    );
    let byCounter = this.hierarchyPrepared.get(job.runtime);
    if (byCounter === undefined) {
      byCounter = new Map();
      this.hierarchyPrepared.set(job.runtime, byCounter);
    }
    const existing = byCounter.get(counters);
    if (existing !== undefined &&
      existing.assetEpoch === job.assets.epoch &&
      existing.sceneEpoch === job.scene.epoch &&
      existing.sseThreshold === job.sseThreshold &&
      existing.countersEnabled === job.countersEnabled &&
      existing.camera === camera) {
      return existing;
    }
    const prepared = this.hierarchyGenerator.prepare({
      assets: job.assets,
      scene: job.scene,
      instanceBegin: job.runtime.instanceBegin,
      instanceCount: job.runtime.instanceCount,
      maxHierarchyDepth: job.runtime.hierarchyMaxDepth,
      traversalWorkCapacity: job.runtime.hierarchyTraversalCapacity,
      visibleClusterCapacity: job.runtime.hierarchyVisibleClusterCapacity,
      rasterWorkCapacity: job.runtime.hierarchyRasterWorkCapacity,
      counterBuffer: counters
    }, {
      sseThreshold: job.sseThreshold,
      countersEnabled: job.countersEnabled
    });
    let exact: PreparedExactTriangleFilter;
    try {
      exact = this.exactFilter.prepare({
        camera,
        candidates: prepared.generated.rasterWork,
        candidateCapacity: prepared.generated.rasterWorkCapacity,
        assets: job.assets,
        scene: job.scene,
        counterBuffer: counters,
        countersEnabled: job.countersEnabled
      });
    } catch (error) {
      this.hierarchyGenerator.release(prepared);
      throw error;
    }
    const next: HierarchyPreparedCacheEntry = {
      prepared,
      exact,
      camera,
      assetEpoch: job.assets.epoch,
      sceneEpoch: job.scene.epoch,
      sseThreshold: job.sseThreshold,
      countersEnabled: job.countersEnabled
    };
    byCounter.set(counters, next);
    if (existing !== undefined) this.retirePrepared(existing, command);
    return next;
  }

  private retirePrepared(
    entry: HierarchyPreparedCacheEntry,
    command: ShadeGPUCommandContext
  ): void {
    command.destroyAfterGpuDone({
      destroy: () => {
        this.exactFilter.release(entry.exact);
        this.hierarchyGenerator.release(entry.prepared);
      }
    });
  }

  private requireDebugBindings(
    runtime: PackedSceneRuntime
  ): PackedVisibilityDebugBindings {
    const bindings = this.debugBindings.get(runtime);
    if (bindings === undefined) {
      throw new Error(
        "Packed Visibility debug resolve executed before work was produced"
      );
    }
    return bindings;
  }
}

/** Internal Packed Visibility prepare contract; intentionally not public. */
export function validatePackedVisibilityPreparation(
  requiredCapacity: number,
  limits: GpuVisibilityBufferLimits
): Readonly<PackedVisibilityPreparationEvidence> {
  const capacity = assertGpuVisibilityRasterWorkCapacity(
    requiredCapacity,
    limits
  );
  return Object.freeze({
    requiredCapacity,
    requiredByteLength: visibilityRasterWorkBufferByteLength(requiredCapacity),
    keyCapacity: capacity.keyCapacity,
    adapterCapacity: capacity.adapterCapacity,
    effectiveCapacity: capacity.effectiveCapacity,
    effectiveByteLimit: capacity.effectiveByteLimit
  });
}

export function packedVisibilityAttachmentDescriptor(
  width: number,
  height: number
) {
  assertPositiveDimension(width, "width");
  assertPositiveDimension(height, "height");
  return Object.freeze({
    kind: "transient_texture" as const,
    label: "Packed VisibilityKey r32uint",
    width,
    height,
    format: "r32uint" as const,
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC
  });
}

interface HierarchyPreparedCacheEntry {
  readonly prepared: PreparedHierarchyWork;
  readonly exact: PreparedExactTriangleFilter;
  readonly camera: GPUBuffer;
  readonly assetEpoch: number;
  readonly sceneEpoch: number;
  readonly sseThreshold: number;
  readonly countersEnabled: boolean;
}

function requireCommand(value: unknown): ShadeGPUCommandContext {
  if (value && typeof value === "object" && "isGPUCommandContext" in value) {
    return value as ShadeGPUCommandContext;
  }
  throw new Error("PackedVisibilityPass requires ShadeGPUCommandContext");
}

function requireBuffer(value: unknown, label: string): GPUBuffer {
  if (value && typeof value === "object" && "size" in value && "usage" in value) {
    return value as GPUBuffer;
  }
  throw new Error(`PackedVisibilityPass expected ${label} GPUBuffer`);
}

function assertPositiveDimension(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`Packed Visibility ${label} must be a positive integer`);
  }
}

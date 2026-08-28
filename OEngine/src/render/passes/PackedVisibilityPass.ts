import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GeometryHierarchyView } from "../../geometry/GeometryHierarchy.js";
import type { GpuAssetBindings } from "../../gpu/GpuAssetStore.js";
import type { GpuSceneBindings } from "../../gpu/GpuScene.js";
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
  PACKED_HIERARCHY_VISIBILITY_FIXED_VERTEX_COUNT
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
import { encodePackedVisibilityAlphaCounter } from "./PackedVisibilityAlphaCounterPass.js";

const HIERARCHY_RASTER_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "R4-A-03 Packed Visibility material alpha group0",
  entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform", minBindingSize: LPV_CAMERA_TYPE.size } },
    ...Array.from({ length: 8 }, (_, index) => ({
      binding: index + 1,
      visibility: GPUShaderStage.VERTEX,
      buffer: { type: "read-only-storage" as GPUBufferBindingType }
    })),
    {
      binding: 9,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "read-only-storage" }
    },
    {
      binding: 10,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "unfilterable-float", viewDimension: "2d-array" }
    }
  ]
};

const HIERARCHY_RASTER_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "R4-A-03 Packed Visibility material alpha consumer",
  layout: {
    label: "R4-A-03 Packed Visibility material alpha layout",
    bindGroupLayouts: [HIERARCHY_RASTER_GROUP]
  },
  vertex: {
    module: {
      label: "R4-A-03 Packed Visibility material alpha consumer",
      code: PACKED_HIERARCHY_VISIBILITY_RASTER_WGSL
    },
    entryPoint: "raster_hierarchy_meshlets"
  },
  fragment: {
    module: {
      label: "R4-A-03 Packed Visibility material alpha consumer",
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
  readonly visibleClusters: GPUBuffer;
  readonly rasterWork: GPUBuffer;
  readonly materials: GPUBuffer;
  readonly instanceCount: number;
  readonly geometryRecordCount: number;
  readonly clusterRecordCount: number;
  readonly meshletRecordCount: number;
  readonly materialCapacity: number;
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

export const PACKED_VISIBILITY_FRAGMENT_EVIDENCE = Object.freeze({
  submittedFragments: Object.freeze({
    status: "unsupported" as const,
    blockerTaskId: "WEBGPU-01-PIPELINE-STATISTICS",
    reason: "OEngine WebGPU baseline has no negotiated pipeline statistics producer"
  }),
  usefulFragments: Object.freeze({
    status: "supported" as const,
    counter: "shadedPixels" as const,
    producer: "VisibilityCounterPass/VisibilityKey v1 final-pixel reducer"
  }),
  invalidKeys: Object.freeze({
    status: "supported" as const,
    counter: "invalidVisibilityKeys" as const,
    producer: "VisibilityCounterPass/VisibilityKey v1 invalid reducer"
  })
});

/** R3 hierarchy production path. The temporary R2 flat producer was deleted in R3-D. */
export class PackedVisibilityPass {
  lastDrawIndirect = false;
  lastCandidateCapacity = 0;
  lastFixedVertexCount = PACKED_HIERARCHY_VISIBILITY_FIXED_VERTEX_COUNT;
  lastVisibilityKeyAttachmentBytes = 0;
  readonly lastImplementation = "hierarchy" as const;
  lastPreparation: Readonly<PackedVisibilityPreparationEvidence> | null = null;
  private readonly hierarchyGenerator: PackedVisibilityHierarchyGenerator;
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
    hierarchyGenerator?: PackedVisibilityHierarchyGenerator
  ) {
    this.hierarchyGenerator = hierarchyGenerator ??
      new HierarchicalWorkGenerator(graphics.device);
  }

  addToGraph(
    graph: FrameGraph,
    job: PackedVisibilityJob,
    inputs: PackedVisibilityInputs
  ): PackedVisibilityOutputs {
    const output = { visibilityKey: -1 };
    const builder = graph.add(
      "Packed Visibility/R4-A-03 Material Visibility alpha producer",
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
      "R4 VisibilityKey v1",
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
    for (const entry of entries.values()) this.retirePrepared(entry.prepared, command);
  }

  destroy(): void {
    this.debugBindings.clear();
    this.hierarchyPrepared.clear();
    this.hierarchyGenerator.destroy();
  }

  private encodeHierarchy(
    job: PackedVisibilityJob,
    command: ShadeGPUCommandContext,
    camera: GPUBuffer,
    counters: GPUBuffer,
    visibilityKey: GPUTextureView,
    depth: GPUTextureView
  ): void {
    const prepared = this.prepareHierarchy(job, counters, command);
    const generated = this.hierarchyGenerator.encode(
      command.gpu_encoder,
      prepared,
      job.hierarchyView,
      {
        coneEnabled: job.coneEnabled,
        previousHzb: job.previousHzb
      }
    );
    if (job.countersEnabled) {
      encodePackedVisibilityAlphaCounter(command, {
        visibleClusters: generated.visibleClusters,
        rasterWork: generated.rasterWork,
        materials: job.runtime.materialVisibility.materialRecords,
        counters,
        rasterWorkCapacity: generated.rasterWorkCapacity
      });
    }
    this.debugBindings.set(job.runtime, Object.freeze({
      instances: job.scene.instances,
      meshlets: job.assets.meshletRecords,
      visibleClusters: generated.visibleClusters,
      rasterWork: generated.rasterWork,
      materials: job.runtime.materialVisibility.materialRecords,
      instanceCount: job.scene.highWaterCount,
      geometryRecordCount: job.assets.highWaterCounts.geometryRecords,
      clusterRecordCount: job.assets.highWaterCounts.clusterRecords,
      meshletRecordCount: job.assets.highWaterCounts.meshletRecords,
      materialCapacity: job.runtime.materialVisibility.materialCapacity
    }));
    const pipeline = this.graphics.render_pipelines.obtain(
      HIERARCHY_RASTER_PIPELINE
    );
    const group = this.graphics.bind_groups.obtain({
      layout: HIERARCHY_RASTER_GROUP,
      entries: [
        { buffer: camera },
        { buffer: job.scene.instances },
        { buffer: job.assets.meshletRecords },
        { buffer: job.assets.meshletVertexIndices },
        { buffer: job.assets.meshletTriangleIndices },
        { buffer: job.assets.vertexStreamData },
        { buffer: job.assets.geometryRecords },
        { buffer: generated.visibleClusters },
        { buffer: generated.rasterWork },
        { buffer: job.runtime.materialVisibility.materialRecords },
        job.runtime.materialVisibility.alphaAtlas
      ]
    });
    const render = command.beginRenderPass({
      label: "R4-A-03 Packed VisibilityKey/depth alpha drawIndirect",
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
    render.setPipeline(pipeline);
    render.setBindGroup(0, group);
    render.drawIndirect(generated.drawIndirect, 0);
    render.end();
    this.lastDrawIndirect = true;
    this.lastCandidateCapacity = job.runtime.hierarchyRasterWorkCapacity;
    this.lastVisibilityKeyAttachmentBytes = job.width * job.height * 4;
  }

  /** Validates capacity before allocating or encoding producer work. */
  prepareHierarchy(
    job: PackedVisibilityJob,
    counters: GPUBuffer,
    command: ShadeGPUCommandContext
  ): PreparedHierarchyWork {
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
      existing.countersEnabled === job.countersEnabled) {
      return existing.prepared;
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
    byCounter.set(counters, {
      prepared,
      assetEpoch: job.assets.epoch,
      sceneEpoch: job.scene.epoch,
      sseThreshold: job.sseThreshold,
      countersEnabled: job.countersEnabled
    });
    if (existing !== undefined) this.retirePrepared(existing.prepared, command);
    return prepared;
  }

  private retirePrepared(
    prepared: PreparedHierarchyWork,
    command: ShadeGPUCommandContext
  ): void {
    command.destroyAfterGpuDone({
      destroy: () => this.hierarchyGenerator.release(prepared)
    });
  }

  private requireDebugBindings(
    runtime: PackedSceneRuntime
  ): PackedVisibilityDebugBindings {
    const bindings = this.debugBindings.get(runtime);
    if (bindings === undefined) {
      throw new Error(
        "R4-A-04 debug resolve executed before Packed Visibility produced work"
      );
    }
    return bindings;
  }
}

/** Internal R4 prepare contract; intentionally not exported from src/index.ts. */
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
    label: "R4 VisibilityKey v1 r32uint",
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

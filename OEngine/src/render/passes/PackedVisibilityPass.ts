import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GeometryHierarchyView } from "../../geometry/GeometryHierarchy.js";
import type { GpuAssetBindings } from "../../gpu/GpuAssetStore.js";
import type { GpuSceneBindings } from "../../gpu/GpuScene.js";
import { GPU_INSTANCE_FLAGS } from "../../gpu/GpuInstanceAbi.js";
import type { GpuRenderWorldRuntime } from "../../gpu/GpuRenderWorld.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import {
  DEFAULT_GEOMETRY_WORK_BUDGET,
  normalizeGeometryWorkBudget,
  type GeometryWorkBudget
} from "../GeometryWorkBudget.js";
import {
  GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_CAPACITY,
  type GpuVisibilityBufferLimits
} from "../../gpu/GpuVisibilityKeyAbi.js";
import {
  GPU_MESHLET_RASTER_WORK_RECORD_STRIDE,
  GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE,
  gpuMeshletWorkQueueByteLength
} from "../../gpu/GpuMeshletRasterWorkAbi.js";
import {
  HierarchicalWorkGenerator,
  type PreparedHierarchyWork
} from "../HierarchicalWorkGenerator.js";
import { VIS_MESH_CLEAR_SENTINEL } from "../VisibilityBufferContract.js";
import {
  resolveDepthAttachmentView,
  resolveTextureView
} from "../RenderTargetViews.js";
import {
  triangleSetupFrame,
  meshletWorkFrame,
  textureDomain,
  visibilityFrame,
  type VisibilityFrame
} from "../pipeline/FrameProducts.js";
import {
  visibilityBindingSet,
  type VisibilityBindingSet
} from "../VisibilityBindingSet.js";
import {
  MeshletWorkCandidate,
  type PreparedMeshletWorkCandidate
} from "../MeshletWorkCandidate.js";
import { MeshletBucketRaster } from "../MeshletBucketRaster.js";
import {
  LargeTriangleSetupCache,
  type PreparedLargeTriangleSetup
} from "../LargeTriangleSetupCache.js";
import {
  sameVisibilityWorkSetKey,
  visibilityWorkSet,
  visibilityWorkSetKey,
  type VisibilityWorkSet
} from "../VisibilityWorkSet.js";

export interface PackedVisibilityPrepareJob {
  readonly runtime: GpuRenderWorldRuntime;
  readonly assets: GpuAssetBindings;
  readonly scene: GpuSceneBindings;
  readonly countersEnabled: boolean;
  readonly width: number;
  readonly height: number;
  readonly hierarchyView: GeometryHierarchyView;
  readonly sseThreshold: number;
  readonly geometryWorkBudget?: GeometryWorkBudget;
  readonly coneEnabled: boolean;
  /** Positive test pressure override; omitted uses the proven triangle capacity upper bound. */
  readonly meshletWorkCandidateCapacity?: number;
  /** Step-2 specialization policy; auto selects subgroup only when negotiated. */
  readonly meshletWorkCompactionPath?: "auto" | "portable" | "subgroup";
  /** auto consumes primitive-index when negotiated; portable forces the flat varying oracle. */
  readonly primitiveIndexPath?: "auto" | "portable";
  /** Evidence-gated TriangleSetup candidate cache; false keeps fallback-only Surface reconstruction. */
  readonly triangleSetupEnabled?: boolean;
  readonly triangleSetupThresholdPixels?: number;
  readonly previousHzb: Readonly<{
    view: GPUTextureView;
    width: number;
    height: number;
    mipLevelCount: number;
    worldToClipMatrix: ArrayLike<number>;
  }> | null;
}

export interface PackedVisibilityJob extends PackedVisibilityPrepareJob {
  readonly prepared: PreparedPackedVisibility;
}

export interface PackedVisibilityInputs {
  readonly camera: ResourceId;
  readonly counters: ResourceId;
  readonly previousHzb?: ResourceId;
  readonly meshletWorkRecords: ResourceId;
  readonly setupRecords?: ResourceId;
  readonly depth: ResourceId;
}

export interface PackedVisibilityOutputs {
  readonly counters: ResourceId;
  readonly frame: VisibilityFrame;
  readonly debugResolve: PackedVisibilityDebugSource;
}

export interface PackedVisibilityDebugBindings {
  readonly instances: GPUBuffer;
  readonly meshlets: GPUBuffer;
  readonly meshletWork: GPUBuffer;
  readonly materials: GPUBuffer;
  readonly instanceCount: number;
  readonly geometryRecordCount: number;
  readonly meshletRecordCount: number;
  readonly materialCapacity: number;
  readonly meshletWorkCapacity: number;
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
  "prepare" | "rebind" | "encode" | "release" | "destroy"
>;

type PackedVisibilityMeshletCandidate = Pick<
  MeshletWorkCandidate,
  "prepare" | "rebind" | "encode" | "release" | "destroy"
>;

export interface PreparedPackedVisibility {
  readonly workSet: VisibilityWorkSet;
  readonly bindings: VisibilityBindingSet;
}

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
  lastMeshletWorkCapacity = 0;
  lastVerticesPerTriangle = 3;
  lastVisibilityKeyAttachmentBytes = 0;
  readonly lastImplementation = "hierarchy" as const;
  lastPreparation: Readonly<PackedVisibilityPreparationEvidence> | null = null;
  private readonly hierarchyGenerator: PackedVisibilityHierarchyGenerator;
  private readonly meshletCandidate: PackedVisibilityMeshletCandidate;
  private readonly meshletBucketRaster: MeshletBucketRaster;
  private readonly largeTriangleSetup: LargeTriangleSetupCache;
  private readonly hierarchyPrepared = new Map<GpuRenderWorldRuntime, VisibilityWorkSet>();
  private readonly debugBindings = new Map<
    GpuRenderWorldRuntime,
    PackedVisibilityDebugBindings
  >();

  constructor(
    private readonly graphics: GraphicsContext,
    hierarchyGenerator?: PackedVisibilityHierarchyGenerator,
    meshletCandidate?: PackedVisibilityMeshletCandidate
  ) {
    this.hierarchyGenerator = hierarchyGenerator ??
      new HierarchicalWorkGenerator(
        graphics.device,
        graphics.resource_accounting,
        "VisibilityWorkSet"
      );
    this.meshletCandidate = meshletCandidate ?? new MeshletWorkCandidate(
      graphics.device,
      graphics.resource_accounting
    );
    this.meshletBucketRaster = new MeshletBucketRaster(graphics);
    this.largeTriangleSetup = new LargeTriangleSetupCache(
      graphics.device,
      graphics.resource_accounting
    );
  }

  addToGraph(
    graph: FrameGraph,
    job: PackedVisibilityJob,
    inputs: PackedVisibilityInputs
  ): PackedVisibilityOutputs {
    const output = { visibilityKey: -1 };
    const builder = graph.add(
      "Packed Visibility/MeshletWork bucket producer",
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
    const depth = builder.write(inputs.depth);
    const meshletWorkRecords = builder.write(inputs.meshletWorkRecords);
    const setupRecords = inputs.setupRecords === undefined
      ? null
      : builder.write(inputs.setupRecords);
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
    const frame = visibilityFrame({
      visibilityKey: output.visibilityKey,
      depth,
      meshletWork: meshletWorkFrame({
        records: meshletWorkRecords,
        capacity: requireMeshletWork(job.prepared.workSet).capacity,
        partition: 0,
        generation: "queue-header"
      }),
      triangleSetup: triangleSetupFrame({
        records: setupRecords,
        capacity: job.prepared.workSet.setupCapacity
      }),
      domain: textureDomain("internal-full", job.width, job.height, 1)
    });
    return Object.freeze({ counters, frame, debugResolve });
  }

  /** Retires all prepared hierarchy bindings for a Packed Scene in queue order. */
  release(runtime: GpuRenderWorldRuntime, command: ShadeGPUCommandContext): void {
    const workSet = this.hierarchyPrepared.get(runtime);
    this.debugBindings.delete(runtime);
    if (workSet === undefined) return;
    this.hierarchyPrepared.delete(runtime);
    this.retirePrepared(workSet, command);
  }

  destroy(): void {
    this.debugBindings.clear();
    this.hierarchyPrepared.clear();
    this.hierarchyGenerator.destroy();
    this.meshletCandidate.destroy();
    this.largeTriangleSetup.destroy();
  }

  private encodeHierarchy(
    job: PackedVisibilityJob,
    command: ShadeGPUCommandContext,
    camera: GPUBuffer,
    counters: GPUBuffer,
    visibilityKey: GPUTextureView,
    depth: GPUTextureView
  ): void {
    const prepared = job.prepared;
    const workSet = prepared.workSet;
    this.hierarchyGenerator.encode(
      command.gpu_encoder,
      workSet.hierarchy,
      job.hierarchyView,
      {
        coneEnabled: job.coneEnabled,
        excludedInstanceFlags: GPU_INSTANCE_FLAGS.Transparent,
        previousHzb: job.previousHzb
      }
    );
    const meshletWork = requireMeshletWork(workSet);
    this.meshletCandidate.encode(command, meshletWork);
    if (workSet.largeTriangleSetup !== null) {
      this.largeTriangleSetup.encode(
        command.gpu_encoder,
        workSet.largeTriangleSetup,
        job.width,
        job.height
      );
    }
    this.meshletBucketRaster.encodeRaster(command.gpu_encoder, {
        prepared: meshletWork,
        camera,
        assets: job.assets,
        scene: job.scene,
        runtime: job.runtime,
        visibilityKey,
        depth
      }, job.primitiveIndexPath ?? "auto");
    this.debugBindings.set(job.runtime, Object.freeze({
      instances: job.scene.instances,
      meshlets: job.assets.meshletRecords,
      meshletWork: meshletWork.queue,
      materials: job.runtime.materialResources.materialRecords,
      instanceCount: job.scene.highWaterCount,
      geometryRecordCount: job.assets.highWaterCounts.geometryRecords,
      meshletRecordCount: job.assets.highWaterCounts.meshletRecords,
      materialCapacity: job.runtime.materialResources.materialCapacity,
      meshletWorkCapacity: meshletWork.capacity
    }));
    this.lastDrawIndirect = true;
    this.lastMeshletWorkCapacity = meshletWork.capacity;
    this.lastVisibilityKeyAttachmentBytes = job.width * job.height * 4;
  }

  /** Validates capacity before allocating or encoding producer work. */
  prepareHierarchy(
    job: PackedVisibilityPrepareJob,
    counters: GPUBuffer,
    camera: GPUBuffer,
    command: ShadeGPUCommandContext
  ): PreparedPackedVisibility {
    this.lastPreparation = validatePackedVisibilityPreparation(
      job.runtime.hierarchyRasterWorkCapacity,
      {
        maxBufferSize: Number(this.graphics.device.limits.maxBufferSize),
        maxStorageBufferBindingSize: Number(
          this.graphics.device.limits.maxStorageBufferBindingSize
        )
      }
    );
    const triangleSetupEnabled = job.triangleSetupEnabled ?? false;
    const geometryWorkBudget = normalizeGeometryWorkBudget(
      job.geometryWorkBudget ?? DEFAULT_GEOMETRY_WORK_BUDGET
    );
    // Step 4 promotes MeshletWork + bucket raster to the normal producer.
    const meshletWorkCandidateCapacity = Math.min(
      normalizeMeshletCandidateCapacity(
        job.meshletWorkCandidateCapacity,
        job.runtime.hierarchyRasterWorkCapacity
      ),
      geometryWorkBudget.maxMeshletWork
    );
    if (meshletWorkCandidateCapacity === 0) {
      throw new RangeError("GeometryWorkBudget leaves no MeshletWork capacity");
    }
    const traversalCapacity = Math.min(
      job.runtime.hierarchyTraversalCapacity,
      geometryWorkBudget.maxTestedHierarchyNodes
    );
    const key = visibilityWorkSetKey({
      runtime: job.runtime,
      assetEpoch: job.assets.epoch,
      sceneResourceEpoch: job.scene.resourceEpoch,
      instanceBegin: job.runtime.instanceBegin,
      instanceCount: job.runtime.instanceCount,
      maxHierarchyDepth: job.runtime.hierarchyMaxDepth,
      traversalCapacity,
      visibleClusterCapacity: job.runtime.hierarchyVisibleClusterCapacity,
      meshletWorkCandidateCapacity,
      meshletWorkCompactionPath: job.meshletWorkCompactionPath ?? "auto",
      triangleSetupEnabled,
      triangleSetupThresholdPixels: triangleSetupEnabled
        ? normalizeTriangleSetupThreshold(job.triangleSetupThresholdPixels)
        : 0,
      triangleSetupMaxBytes: triangleSetupEnabled
        ? geometryWorkBudget.maxSetupBytes
        : 0
    });
    const bindings = visibilityBindingSet({
      camera,
      counters,
      countersEnabled: job.countersEnabled,
      sseThreshold: job.sseThreshold
    });
    const existing = this.hierarchyPrepared.get(job.runtime);
    if (existing !== undefined && sameVisibilityWorkSetKey(existing.key, key)) {
      this.hierarchyGenerator.rebind(existing.hierarchy, {
        counterBuffer: bindings.counters,
        countersEnabled: bindings.countersEnabled,
        sseThreshold: bindings.sseThreshold
      });
      if (existing.meshletWorkCandidate !== null) {
        this.meshletCandidate.rebind(existing.meshletWorkCandidate, {
          camera: bindings.camera,
          counterBuffer: bindings.counters,
          countersEnabled: bindings.countersEnabled
        });
      }
      if (existing.largeTriangleSetup !== null) {
        this.largeTriangleSetup.rebind(existing.largeTriangleSetup, {
          camera: bindings.camera,
          counters: bindings.counters,
          countersEnabled: bindings.countersEnabled
        });
      }
      return Object.freeze({ workSet: existing, bindings });
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
      countersEnabled: job.countersEnabled,
      rasterExpansionEnabled: false,
      traversalWorkCapacity: key.traversalCapacity
    });
    let meshletWorkCandidate: PreparedMeshletWorkCandidate | null = null;
    let largeTriangleSetup: PreparedLargeTriangleSetup | null = null;
    try {
      meshletWorkCandidate = this.meshletCandidate.prepare({
          camera,
          visibleClusters: prepared.generated.visibleClusters,
          visibleClusterCapacity: prepared.generated.visibleClusterCapacity,
          capacity: key.meshletWorkCandidateCapacity,
          assets: job.assets,
          scene: job.scene,
          counterBuffer: counters,
          countersEnabled: job.countersEnabled,
          compactionPath: key.meshletWorkCompactionPath
        });
      if (key.triangleSetupEnabled) {
        largeTriangleSetup = this.largeTriangleSetup.prepare({
          camera,
          counters,
          countersEnabled: job.countersEnabled,
          work: meshletWorkCandidate.queue,
          workCapacity: meshletWorkCandidate.capacity,
          thresholdPixels: key.triangleSetupThresholdPixels,
          maxBytes: key.triangleSetupMaxBytes,
          assets: job.assets,
          scene: job.scene
        });
      }
    } catch (error) {
      if (largeTriangleSetup !== null) this.largeTriangleSetup.release(largeTriangleSetup);
      if (meshletWorkCandidate !== null) {
        this.meshletCandidate.release(meshletWorkCandidate);
      }
      this.hierarchyGenerator.release(prepared);
      throw error;
    }
    const next = visibilityWorkSet({
      key,
      hierarchy: prepared,
      meshletWorkCandidate,
      largeTriangleSetup,
      setupRecords: largeTriangleSetup?.records ?? null,
      setupCapacity: largeTriangleSetup?.capacity ?? 0
    });
    this.hierarchyPrepared.set(job.runtime, next);
    if (existing !== undefined) this.retirePrepared(existing, command);
    return Object.freeze({ workSet: next, bindings });
  }

  private retirePrepared(
    workSet: VisibilityWorkSet,
    command: ShadeGPUCommandContext
  ): void {
    command.destroyAfterGpuDone({
      destroy: () => {
        if (workSet.largeTriangleSetup !== null) {
          this.largeTriangleSetup.release(workSet.largeTriangleSetup);
        }
        if (workSet.meshletWorkCandidate !== null) {
          this.meshletCandidate.release(workSet.meshletWorkCandidate);
        }
        this.hierarchyGenerator.release(workSet.hierarchy);
      }
    });
  }

  private requireDebugBindings(
    runtime: GpuRenderWorldRuntime
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
  if (!Number.isSafeInteger(requiredCapacity) || requiredCapacity <= 0 ||
      requiredCapacity > GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_CAPACITY) {
    throw new RangeError("Required MeshletWork capacity exceeds VisibilityKey V2");
  }
  const effectiveByteLimit = Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize);
  const adapterCapacity = effectiveByteLimit < GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE
    ? 0
    : Math.floor((effectiveByteLimit - GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE) /
      GPU_MESHLET_RASTER_WORK_RECORD_STRIDE);
  const effectiveCapacity = Math.min(GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_CAPACITY, adapterCapacity);
  if (requiredCapacity > effectiveCapacity) {
    throw new RangeError(`Required MeshletWork capacity ${requiredCapacity} exceeds effective capacity ${effectiveCapacity}`);
  }
  return Object.freeze({
    requiredCapacity,
    requiredByteLength: gpuMeshletWorkQueueByteLength(requiredCapacity),
    keyCapacity: GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_CAPACITY,
    adapterCapacity,
    effectiveCapacity,
    effectiveByteLimit
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

function requireCommand(value: unknown): ShadeGPUCommandContext {
  if (value && typeof value === "object" && "isGPUCommandContext" in value) {
    return value as ShadeGPUCommandContext;
  }
  throw new Error("PackedVisibilityPass requires ShadeGPUCommandContext");
}

function normalizeTriangleSetupThreshold(value: number | undefined): number {
  if (value === undefined) return 32;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("Packed Visibility TriangleSetup threshold must be finite and non-negative");
  }
  return Math.min(0xffffffff, Math.floor(value));
}

function normalizeMeshletCandidateCapacity(
  value: number | undefined,
  defaultCapacity: number
): number {
  if (value === undefined || value === 0) return defaultCapacity;
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError("MeshletWork capacity must be a positive u32 or zero for default");
  }
  return value;
}

function requireBuffer(value: unknown, label: string): GPUBuffer {
  if (value && typeof value === "object" && "size" in value && "usage" in value) {
    return value as GPUBuffer;
  }
  throw new Error(`PackedVisibilityPass expected ${label} GPUBuffer`);
}

function requireMeshletWork(workSet: VisibilityWorkSet): PreparedMeshletWorkCandidate {
  if (workSet.meshletWorkCandidate === null) {
    throw new Error("VisibilityKey V2 normal producer requires MeshletWork");
  }
  return workSet.meshletWorkCandidate;
}

function assertPositiveDimension(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`Packed Visibility ${label} must be a positive integer`);
  }
}

import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GeometryHierarchyView } from "../../geometry/GeometryHierarchy.js";
import type { GpuAssetBindings } from "../../gpu/GpuAssetStore.js";
import type { GpuSceneBindings } from "../../gpu/GpuScene.js";
import { GPU_INSTANCE_FLAGS } from "../../gpu/GpuInstanceAbi.js";
import { gpuShadingBinVisibilityAttachmentContract } from "../../gpu/GpuShadingBinVisibilityContract.js";
import type { GpuRenderWorldRuntime } from "../../gpu/GpuRenderWorld.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { GeometryProductGpuBindingsV1 } from "../../gpu/VirtualGeometryResidency.js";
import type { GeometryPageStreamingRuntimeV1 } from "../../gpu/GeometryPageStreamingRuntime.js";
import type { GpuShadingExecutionMode } from "../../gpu/GpuShadingExecutionMode.js";
import {
  DEFAULT_GEOMETRY_WORK_BUDGET,
  normalizeGeometryWorkBudget,
  type GeometryWorkBudget,
} from "../GeometryWorkBudget.js";
import {
  GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_CAPACITY,
  type GpuVisibilityBufferLimits,
} from "../../gpu/GpuVisibilityKeyAbi.js";
import {
  GPU_MESHLET_RASTER_WORK_RECORD_STRIDE,
  GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE,
  gpuMeshletWorkQueueByteLength,
} from "../../gpu/GpuMeshletRasterWorkAbi.js";
import { HierarchicalWorkGenerator, type PreparedHierarchyWork } from "../HierarchicalWorkGenerator.js";
import { VIS_MESH_CLEAR_SENTINEL } from "../VisibilityBufferContract.js";
import { resolveDepthAttachmentView, resolveTextureView } from "../RenderTargetViews.js";
import {
  meshletWorkFrame,
  textureDomain,
  visibilityFrame,
  type VisibilityFrame,
} from "../pipeline/FrameProducts.js";
import { visibilityBindingSet, type VisibilityBindingSet } from "../VisibilityBindingSet.js";
import {
  MeshletWorkCandidate,
  VirtualGeometryMeshletWorkCandidate,
  type PreparedMeshletWorkCandidate,
} from "../MeshletWorkCandidate.js";
import { MeshletBucketRaster } from "../MeshletBucketRaster.js";
import type { FrameInstanceTransforms, PreparedFrameInstances } from "../FrameInstanceTransforms.js";
import { GPU_INSTANCE_RECORD_STRIDE } from "../../gpu/GpuInstanceAbi.js";
import type { FrameGeometryVertices, PreparedFrameVertices } from "../FrameGeometryVertices.js";
import type { FrameGeometryArena, PreparedFrameGeometryArena } from "../FrameGeometryArena.js";
import type { FrameGeometryArenaBudget } from "../../gpu/GpuFrameGeometryArenaAbi.js";
import {
  sameVisibilityWorkSetKey,
  visibilityWorkSet,
  visibilityWorkSetKey,
  type VisibilityWorkSet,
} from "../VisibilityWorkSet.js";
import {
  CurrentHzbLateRecheckGpu,
  type CurrentHzbLateRecheckGpuPrepareInput,
  type PreparedCurrentHzbLateRecheck,
} from "../CurrentHzbLateRecheck.js";

export interface PackedVisibilityPrepareJob {
  readonly runtime: GpuRenderWorldRuntime;
  readonly assets: GpuAssetBindings;
  readonly scene: GpuSceneBindings;
  readonly countersEnabled: boolean;
  readonly width: number;
  readonly height: number;
  readonly hierarchyView: GeometryHierarchyView;
  readonly virtualGeometry?: GeometryProductGpuBindingsV1;
  readonly sseThreshold: number;
  readonly geometryWorkBudget?: GeometryWorkBudget;
  /** Independent frame geometry capacities, never workCapacity times 128. */
  readonly frameGeometryBudget?: Omit<FrameGeometryArenaBudget, "workCapacity" | "filteredWorkCapacity">;
  readonly coneEnabled: boolean;
  /** Positive test pressure override; omitted uses the proven triangle capacity upper bound. */
  readonly meshletWorkCandidateCapacity?: number;
  /** Step-2 specialization policy; auto selects subgroup only when negotiated. */
  readonly meshletWorkCompactionPath?: "auto" | "portable" | "subgroup";
  /** auto consumes primitive-index when negotiated; portable forces the flat varying oracle. */
  readonly primitiveIndexPath?: "auto" | "portable";
  /** Publication-selected visibility ABI; single MRT is used for direct/none. */
  readonly executionMode?: GpuShadingExecutionMode | "none";
  readonly previousHzb: Readonly<{
    view: GPUTextureView;
    width: number;
    height: number;
    mipLevelCount: number;
    worldToClipMatrix: ArrayLike<number>;
  }> | null;
  readonly demandFrameRevisionLow?: number;
  /** Optional delayed demand consumer; its copy is encoded into this frame. */
  readonly streamingRuntime?: GeometryPageStreamingRuntimeV1;
  /** Monotonic frame identity required when streamingRuntime is supplied. */
  readonly demandFrameIndex?: number;
  /** Optional same-frame Product filter. Null/off allocates no work buffers;
   * finite Product PSOs are prepared at Scene publication for later toggles. */
  readonly currentHzbLateRecheck?: Readonly<{
    readonly width: number;
    readonly height: number;
    readonly mipLevelCount: number;
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
  readonly frameInstances: ResourceId;
  readonly frameGeometry: ResourceId;
  readonly frameAttributes: ResourceId;
  readonly depth: ResourceId;
}

export interface PackedVisibilityOutputs {
  readonly counters: ResourceId;
  readonly frame: VisibilityFrame;
  readonly debugResolve: PackedVisibilityDebugSource;
}

export interface PackedVisibilityLateRecheckInputs {
  readonly camera: ResourceId;
  readonly counters: ResourceId;
  readonly currentHzb: ResourceId;
  readonly sourceMeshletWork: ResourceId;
  readonly filteredMeshletWork: ResourceId;
  readonly filteredDrawIndirect: ResourceId;
  readonly visibilityKey: ResourceId;
  readonly shadingBinId: ResourceId | null;
  readonly depth: ResourceId;
  readonly sourceFrame: VisibilityFrame;
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
  readonly currentHzbLateRecheck: PreparedCurrentHzbLateRecheck | null;
}

export const PACKED_VISIBILITY_FRAGMENT_EVIDENCE = Object.freeze({
  submittedFragments: Object.freeze({
    status: "unsupported" as const,
    blockerTaskId: "WEBGPU-01-PIPELINE-STATISTICS",
    reason: "OEngine WebGPU baseline has no negotiated pipeline statistics producer",
  }),
  usefulFragments: Object.freeze({
    status: "supported" as const,
    counter: "shadedPixels" as const,
    producer: "VisibilityCounterPass/direct VisibilityKey final-pixel reducer",
  }),
  invalidKeys: Object.freeze({
    status: "supported" as const,
    counter: "invalidVisibilityKeys" as const,
    producer: "VisibilityCounterPass/direct VisibilityKey invalid reducer",
  }),
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
  private readonly virtualMeshletCandidate: VirtualGeometryMeshletWorkCandidate;
  private readonly meshletBucketRaster: MeshletBucketRaster;
  private readonly instanceTransforms: FrameInstanceTransforms;
  private readonly vertexTransforms: FrameGeometryVertices;
  private readonly geometryArena: FrameGeometryArena;
  private readonly hierarchyPrepared = new Map<GpuRenderWorldRuntime, VisibilityWorkSet>();
  private currentHzbLateRecheck: CurrentHzbLateRecheckGpu | null = null;
  private readonly currentHzbPrepared = new Map<GpuRenderWorldRuntime, PreparedCurrentHzbLateRecheck>();
  private readonly debugBindings = new Map<GpuRenderWorldRuntime, PackedVisibilityDebugBindings>();

  constructor(
    private readonly graphics: GraphicsContext,
    hierarchyGenerator?: PackedVisibilityHierarchyGenerator,
    meshletCandidate?: PackedVisibilityMeshletCandidate,
  ) {
    this.instanceTransforms = graphics.frame_instances;
    this.vertexTransforms = graphics.frame_vertices;
    this.geometryArena = graphics.frame_geometry_arena;
    this.hierarchyGenerator =
      hierarchyGenerator ??
      new HierarchicalWorkGenerator(graphics.device, graphics.resource_accounting, "VisibilityWorkSet");
    this.meshletCandidate =
      meshletCandidate ?? new MeshletWorkCandidate(graphics.device, graphics.resource_accounting);
    this.virtualMeshletCandidate = new VirtualGeometryMeshletWorkCandidate(graphics.device);
    this.meshletBucketRaster = new MeshletBucketRaster(graphics);
  }

  addToGraph(
    graph: FrameGraph,
    job: PackedVisibilityJob,
    inputs: PackedVisibilityInputs,
  ): PackedVisibilityOutputs {
    const output: { visibilityKey: ResourceId; shadingBinId: ResourceId | null } = {
      visibilityKey: -1,
      shadingBinId: null,
    };
    const includeShadingBinId = (job.executionMode ?? "sparse-microtile") === "sparse-microtile";
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
          output.shadingBinId === null ? null : resolveTextureView(resources.get(output.shadingBinId)),
          job.executionMode ?? "sparse-microtile",
          resolveDepthAttachmentView(resources.get(inputs.depth)),
        );
      },
    );
    builder.read(inputs.camera);
    builder.read(inputs.counters);
    if (inputs.previousHzb !== undefined) builder.read(inputs.previousHzb);
    const depth = builder.write(inputs.depth);
    const meshletWorkRecords = builder.write(inputs.meshletWorkRecords);
    const frameInstances = builder.write(inputs.frameInstances);
    const frameGeometry = builder.write(inputs.frameGeometry);
    const frameAttributes = builder.write(inputs.frameAttributes);
    const counters = builder.write(inputs.counters);
    output.visibilityKey = builder.create(
      "Packed VisibilityKey",
      packedVisibilityAttachmentDescriptor(job.width, job.height),
    );
    if (includeShadingBinId) {
      output.shadingBinId = builder.create(
        "Packed ShadingBinId",
        packedShadingBinAttachmentDescriptor(job.width, job.height),
      );
    }
    builder.make_side_effect();
    const debugResolve = Object.freeze({
      resolve: (): PackedVisibilityDebugBindings => this.requireDebugBindings(job.runtime),
    });
    const frame = visibilityFrame({
      visibilityKey: output.visibilityKey,
      shadingBinId: output.shadingBinId,
      depth,
      frameInstances,
      frameGeometry,
      frameAttributes,
      meshletWork: meshletWorkFrame({
        records: meshletWorkRecords,
        capacity: requireMeshletWork(job.prepared.workSet).capacity,
        partition: 0,
        generation: "queue-header",
      }),
      domain: textureDomain("internal-full", job.width, job.height, 1),
    });
    return Object.freeze({ counters, frame, debugResolve });
  }

  /** current HZB compute filter -> filtered Product MeshletWork indirect raster. */
  addCurrentHzbLateRecheckToGraph(
    graph: FrameGraph,
    job: PackedVisibilityJob,
    inputs: PackedVisibilityLateRecheckInputs,
  ): PackedVisibilityOutputs {
    const prepared = job.prepared.currentHzbLateRecheck;
    if (prepared === null || !job.prepared.workSet.meshletWorkCandidate?.productMode) {
      throw new Error("Current HZB late recheck requires prepared Product MeshletWork");
    }
    if (this.currentHzbLateRecheck === null) {
      throw new Error("Current HZB late-recheck owner is unavailable");
    }
    const owner = this.currentHzbLateRecheck;
    const builder = graph.add(
      "Packed Visibility/current-HZB late recheck + filtered raster",
      job,
      (data, resources, context) => {
        const command = requireCommand(context.encoder);
        const currentHzb = resolveTextureView(resources.get(inputs.currentHzb));
        owner.encode(command.gpu_encoder, data.prepared.currentHzbLateRecheck!, currentHzb);
        const workSet = data.prepared.workSet;
        const sourcePrepared = requireMeshletWork(workSet);
        this.meshletBucketRaster.encodeFilteredVirtualRaster(
          command.gpu_encoder,
          {
            prepared: sourcePrepared,
            camera: requireBuffer(resources.get(inputs.camera), "camera"),
            assets: data.assets,
            scene: data.scene,
            frameInstances: workSet.frameInstances.records,
            frameVertices: workSet.frameVertices,
            runtime: data.runtime,
            visibilityKey: resolveTextureView(resources.get(inputs.visibilityKey)),
            shadingBinId:
              inputs.shadingBinId === null ? null : resolveTextureView(resources.get(inputs.shadingBinId)),
            depth: resolveDepthAttachmentView(resources.get(inputs.depth)),
            virtualGeometry: data.virtualGeometry ?? null,
          },
          data.prepared.currentHzbLateRecheck!.queue,
        );
        const debug = this.requireDebugBindings(data.runtime);
        this.debugBindings.set(
          data.runtime,
          Object.freeze({
            ...debug,
            meshletWork: data.prepared.currentHzbLateRecheck!.queue,
            meshletWorkCapacity: data.prepared.currentHzbLateRecheck!.capacity,
          }),
        );
      },
    );
    builder.read(inputs.camera);
    builder.read(inputs.currentHzb);
    builder.read(inputs.sourceMeshletWork);
    builder.read(inputs.sourceFrame.frameInstances);
    builder.read(inputs.sourceFrame.frameGeometry);
    builder.read(inputs.sourceFrame.frameAttributes);
    const frameGeometry = builder.write(inputs.sourceFrame.frameGeometry);
    const counters = builder.write(inputs.counters);
    const meshletWorkRecords = builder.write(inputs.filteredMeshletWork);
    builder.write(inputs.filteredDrawIndirect);
    const visibilityKey = builder.write(inputs.visibilityKey);
    const shadingBinId = inputs.shadingBinId === null ? null : builder.write(inputs.shadingBinId);
    const depth = builder.write(inputs.depth);
    builder.make_side_effect();
    const source = inputs.sourceFrame;
    const frame = visibilityFrame({
      visibilityKey,
      shadingBinId,
      depth,
      meshletWork: meshletWorkFrame({
        records: meshletWorkRecords,
        capacity: prepared.capacity,
        partition: 0,
        generation: "queue-header",
      }),
      frameInstances: source.frameInstances,
      frameGeometry,
      frameAttributes: source.frameAttributes,
      domain: source.domain,
    });
    return Object.freeze({
      counters,
      frame,
      debugResolve: Object.freeze({ resolve: () => this.requireDebugBindings(job.runtime) }),
    });
  }

  /** Retires all prepared hierarchy bindings for a Packed Scene in queue order. */
  release(runtime: GpuRenderWorldRuntime, command: ShadeGPUCommandContext): void {
    const late = this.currentHzbPrepared.get(runtime);
    if (late !== undefined) {
      this.currentHzbPrepared.delete(runtime);
      const owner = this.currentHzbLateRecheck;
      command.destroyAfterGpuDone({
        destroy: () => {
          this.graphics.raster_partitions.release(late.queue);
          owner?.release(late);
        },
      });
    }
    const workSet = this.hierarchyPrepared.get(runtime);
    this.debugBindings.delete(runtime);
    if (workSet === undefined) return;
    this.hierarchyPrepared.delete(runtime);
    this.retirePrepared(workSet, command);
  }

  destroy(): void {
    this.debugBindings.clear();
    for (const work of this.hierarchyPrepared.values()) {
      if (work.meshletWorkCandidate) this.graphics.raster_partitions.release(work.meshletWorkCandidate.queue);
      this.instanceTransforms.release(work.frameInstances);
      this.vertexTransforms.release(work.frameVertices);
      this.geometryArena.release(work.frameGeometry);
    }
    this.hierarchyPrepared.clear();
    for (const late of this.currentHzbPrepared.values()) {
      this.graphics.raster_partitions.release(late.queue);
      this.currentHzbLateRecheck?.release(late);
    }
    this.currentHzbPrepared.clear();
    this.currentHzbLateRecheck = null;
    this.hierarchyGenerator.destroy();
    this.meshletCandidate.destroy();
    this.virtualMeshletCandidate.destroy();
  }

  private encodeHierarchy(
    job: PackedVisibilityJob,
    command: ShadeGPUCommandContext,
    camera: GPUBuffer,
    counters: GPUBuffer,
    visibilityKey: GPUTextureView,
    shadingBinId: GPUTextureView | null,
    executionMode: GpuShadingExecutionMode | "none",
    depth: GPUTextureView,
  ): void {
    const prepared = job.prepared;
    const workSet = prepared.workSet;
    const generated = this.hierarchyGenerator.encode(
      command.gpu_encoder,
      workSet.hierarchy,
      job.hierarchyView,
      {
        coneEnabled: job.coneEnabled,
        excludedInstanceFlags: GPU_INSTANCE_FLAGS.Transparent,
        // A changing refine cut cannot safely reject against the previous cut
        // without Nyx's disocclusion recovery pass. Current-HZB recheck stays live.
        previousHzb: job.virtualGeometry === undefined ? job.previousHzb : null,
        demandFrameRevisionLow: job.demandFrameRevisionLow,
      },
    );
    if (job.streamingRuntime !== undefined) {
      if (generated.pageDemand === null) {
        throw new Error("Geometry page streaming requires virtual geometry work");
      }
      const demandFrameIndex = job.demandFrameIndex;
      if (demandFrameIndex === undefined || !Number.isSafeInteger(demandFrameIndex) || demandFrameIndex < 0) {
        throw new RangeError("Geometry page streaming requires a non-negative demand frame index");
      }
      job.streamingRuntime.encodeDemandReadback(command.gpu_encoder, generated.pageDemand, demandFrameIndex);
    }
    const meshletWork = requireMeshletWork(workSet);
    if (meshletWork.productMode) {
      this.virtualMeshletCandidate.encode(command, meshletWork);
    } else {
      this.meshletCandidate.encode(command, meshletWork);
    }
    this.instanceTransforms.encode(command.gpu_encoder, workSet.frameInstances);
    if (!this.geometryArena.metadataPublished(workSet.frameGeometry)) {
      command.onFinished.addOne(
        this.geometryArena.encodeMetadataPublication(command.gpu_encoder, workSet.frameGeometry),
      );
    }
    this.vertexTransforms.encode(command.gpu_encoder, workSet.frameVertices);
    this.meshletBucketRaster.encodeRaster(
      command.gpu_encoder,
      {
        prepared: meshletWork,
        camera,
        assets: job.assets,
        scene: job.scene,
        frameInstances: workSet.frameInstances.records,
        frameVertices: workSet.frameVertices,
        runtime: job.runtime,
        visibilityKey,
        shadingBinId,
        depth,
        virtualGeometry: job.virtualGeometry ?? null,
      },
      job.executionMode ?? "sparse-microtile",
      job.primitiveIndexPath ?? "auto",
    );
    this.debugBindings.set(
      job.runtime,
      Object.freeze({
        instances: job.scene.instances,
        meshlets: job.assets.meshletRecords,
        meshletWork: meshletWork.queue,
        materials: job.runtime.materialResources.materialRecords,
        instanceCount: job.scene.highWaterCount,
        geometryRecordCount: job.assets.highWaterCounts.geometryRecords,
        meshletRecordCount: job.assets.highWaterCounts.meshletRecords,
        materialCapacity: job.runtime.materialResources.materialCapacity,
        meshletWorkCapacity: meshletWork.capacity,
      }),
    );
    this.lastDrawIndirect = true;
    this.lastMeshletWorkCapacity = meshletWork.capacity;
    this.lastVisibilityKeyAttachmentBytes = job.width * job.height * 4;
  }

  /** Validates capacity before allocating or encoding producer work. */
  prepareHierarchy(
    job: PackedVisibilityPrepareJob,
    counters: GPUBuffer,
    camera: GPUBuffer,
    command: ShadeGPUCommandContext,
  ): PreparedPackedVisibility {
    this.lastPreparation = validatePackedVisibilityPreparation(job.runtime.hierarchyRasterWorkCapacity, {
      maxBufferSize: Number(this.graphics.device.limits.maxBufferSize),
      maxStorageBufferBindingSize: Number(this.graphics.device.limits.maxStorageBufferBindingSize),
    });
    const geometryWorkBudget = normalizeGeometryWorkBudget(
      job.geometryWorkBudget ?? DEFAULT_GEOMETRY_WORK_BUDGET,
    );
    // Step 4 promotes MeshletWork + bucket raster to the normal producer.
    const meshletWorkCandidateCapacity = Math.min(
      normalizeMeshletCandidateCapacity(
        job.meshletWorkCandidateCapacity,
        job.runtime.hierarchyRasterWorkCapacity,
      ),
      geometryWorkBudget.maxMeshletWork,
    );
    if (meshletWorkCandidateCapacity === 0) {
      throw new RangeError("GeometryWorkBudget leaves no MeshletWork capacity");
    }
    const traversalCapacity = Math.min(
      job.runtime.hierarchyTraversalCapacity,
      geometryWorkBudget.maxTestedHierarchyNodes,
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
      virtualProductGeneration: job.virtualGeometry?.productGeneration ?? 0,
      virtualProductBankCount: job.virtualGeometry?.banks.length ?? 0,
      meshletWorkCandidateCapacity,
      meshletWorkCompactionPath: job.meshletWorkCompactionPath ?? "auto",
      frameGeometryBudget: Object.freeze({
        vertexCapacity: 1 << 20,
        triangleCapacity: 1 << 20,
        dictionaryCapacity: 1 << 18,
        coefficientCapacity: 1 << 17,
        probeLimit: 16,
        maxBytes: 128 * 1024 * 1024,
        ...job.frameGeometryBudget,
        workCapacity: meshletWorkCandidateCapacity,
        filteredWorkCapacity:
          job.virtualGeometry !== undefined && job.currentHzbLateRecheck != null
            ? meshletWorkCandidateCapacity
            : 0,
      }),
    });
    const bindings = visibilityBindingSet({
      camera,
      counters,
      countersEnabled: job.countersEnabled,
      sseThreshold: job.sseThreshold,
    });
    const existing = this.hierarchyPrepared.get(job.runtime);
    if (existing !== undefined && sameVisibilityWorkSetKey(existing.key, key)) {
      this.instanceTransforms.rebind(existing.frameInstances, camera);
      this.hierarchyGenerator.rebind(existing.hierarchy, {
        counterBuffer: bindings.counters,
        countersEnabled: bindings.countersEnabled,
        sseThreshold: bindings.sseThreshold,
      });
      if (existing.meshletWorkCandidate !== null) {
        if (existing.meshletWorkCandidate.productMode) {
          this.virtualMeshletCandidate.rebind(existing.meshletWorkCandidate, {
            counterBuffer: bindings.counters,
            countersEnabled: bindings.countersEnabled,
          });
        } else {
          this.meshletCandidate.rebind(existing.meshletWorkCandidate, {
            camera: bindings.camera,
            counterBuffer: bindings.counters,
            countersEnabled: bindings.countersEnabled,
          });
        }
      }
      return Object.freeze({
        workSet: existing,
        bindings,
        currentHzbLateRecheck: this.prepareCurrentHzbLateRecheck(job, existing, camera, counters, command),
      });
    }
    const prepared = this.hierarchyGenerator.prepare(
      {
        assets: job.assets,
        scene: job.scene,
        instanceBegin: job.runtime.instanceBegin,
        instanceCount: job.runtime.instanceCount,
        maxHierarchyDepth: job.runtime.hierarchyMaxDepth,
        traversalWorkCapacity: job.runtime.hierarchyTraversalCapacity,
        visibleClusterCapacity: job.runtime.hierarchyVisibleClusterCapacity,
        rasterWorkCapacity: job.runtime.hierarchyRasterWorkCapacity,
        counterBuffer: counters,
        virtualGeometry: job.virtualGeometry,
      },
      {
        sseThreshold: job.sseThreshold,
        countersEnabled: job.countersEnabled,
        // Runtime evidence comes from the sampled frame counter pass. Retaining
        // test-only queue snapshots across counter-buffer rebinding would copy
        // from the disabled sink on subsequent unsampled frames.
        diagnosticsEnabled: false,
        rasterExpansionEnabled: false,
        traversalWorkCapacity: key.traversalCapacity,
      },
    );
    let meshletWorkCandidate: PreparedMeshletWorkCandidate | null = null;
    let frameInstances: PreparedFrameInstances | null = null;
    let frameGeometry: PreparedFrameGeometryArena | null = null;
    let frameVertices: PreparedFrameVertices | null = null;
    try {
      if (job.virtualGeometry !== undefined) {
        meshletWorkCandidate = this.virtualMeshletCandidate.prepare({
          virtualGeometry: job.virtualGeometry,
          viewUniform: prepared.generated.viewUniform,
          visibleClusters: prepared.generated.visibleClusters,
          visibleClusterCapacity: prepared.generated.visibleClusterCapacity,
          capacity: key.meshletWorkCandidateCapacity,
          counterBuffer: counters,
          countersEnabled: job.countersEnabled,
          scene: job.scene,
        });
      } else {
        meshletWorkCandidate = this.meshletCandidate.prepare({
          camera,
          visibleClusters: prepared.generated.visibleClusters,
          visibleClusterCapacity: prepared.generated.visibleClusterCapacity,
          capacity: key.meshletWorkCandidateCapacity,
          assets: job.assets,
          scene: job.scene,
          counterBuffer: counters,
          countersEnabled: job.countersEnabled,
          compactionPath: key.meshletWorkCompactionPath,
        });
      }
      frameInstances = this.instanceTransforms.prepare({
        camera,
        source: job.scene.instances,
        work: meshletWorkCandidate.queue,
        workCapacity: meshletWorkCandidate.capacity,
        instanceCapacity: Math.floor(job.scene.instances.size / GPU_INSTANCE_RECORD_STRIDE),
      });
      frameGeometry = this.geometryArena.prepare(
        job.assets.sparseShading.assetMetadataHeap,
        job.assets.sparseShading.assetMetadataBytes,
        key.frameGeometryBudget,
      );
      frameVertices = this.vertexTransforms.prepare({
        arena: frameGeometry,
        instances: frameInstances,
        work: meshletWorkCandidate.queue,
        assets: job.assets,
        product: meshletWorkCandidate.productBindings,
        productBanks: meshletWorkCandidate.productBanks,
      });
      this.meshletBucketRaster.prepare(job.runtime, meshletWorkCandidate, job.assets);
    } catch (error) {
      if (frameVertices !== null) this.vertexTransforms.release(frameVertices);
      if (frameGeometry !== null) this.geometryArena.release(frameGeometry);
      if (frameInstances !== null) this.instanceTransforms.release(frameInstances);
      if (meshletWorkCandidate !== null) {
        this.graphics.raster_partitions.release(meshletWorkCandidate.queue);
        if (meshletWorkCandidate.productMode) {
          this.virtualMeshletCandidate.release(meshletWorkCandidate);
        } else {
          this.meshletCandidate.release(meshletWorkCandidate);
        }
      }
      this.hierarchyGenerator.release(prepared);
      throw error;
    }
    const next = visibilityWorkSet({
      key,
      hierarchy: prepared,
      frameInstances,
      frameGeometry,
      frameVertices,
      meshletWorkCandidate,
    });
    let currentHzbLateRecheck: PreparedCurrentHzbLateRecheck | null;
    try {
      currentHzbLateRecheck = this.prepareCurrentHzbLateRecheck(job, next, camera, counters, command);
    } catch (error) {
      this.graphics.raster_partitions.release(meshletWorkCandidate!.queue);
      this.vertexTransforms.release(next.frameVertices);
      this.geometryArena.release(next.frameGeometry);
      this.instanceTransforms.release(next.frameInstances);
      if (meshletWorkCandidate!.productMode) this.virtualMeshletCandidate.release(meshletWorkCandidate!);
      else this.meshletCandidate.release(meshletWorkCandidate!);
      this.hierarchyGenerator.release(prepared);
      throw error;
    }
    this.hierarchyPrepared.set(job.runtime, next);
    if (existing !== undefined) this.retirePrepared(existing, command);
    return Object.freeze({
      workSet: next,
      bindings,
      currentHzbLateRecheck,
    });
  }

  private prepareCurrentHzbLateRecheck(
    job: PackedVisibilityPrepareJob,
    workSet: VisibilityWorkSet,
    camera: GPUBuffer,
    counters: GPUBuffer,
    command: ShadeGPUCommandContext,
  ): PreparedCurrentHzbLateRecheck | null {
    const config = job.currentHzbLateRecheck ?? null;
    const work = workSet.meshletWorkCandidate;
    if (
      config === null ||
      work === null ||
      !work.productMode ||
      work.productBindings === undefined ||
      work.productBanks === undefined
    ) {
      const previous = this.currentHzbPrepared.get(job.runtime);
      if (previous !== undefined) {
        this.currentHzbPrepared.delete(job.runtime);
        const owner = this.currentHzbLateRecheck;
        command.destroyAfterGpuDone({
          destroy: () => {
            this.graphics.raster_partitions.release(previous.queue);
            owner?.release(previous);
          },
        });
      }
      return null;
    }
    this.currentHzbLateRecheck ??= this.graphics.current_hzb_recheck;
    const input: CurrentHzbLateRecheckGpuPrepareInput = {
      sourceQueue: work.queue,
      sourceGeometry: workSet.frameGeometry.sourceDirectory,
      filteredGeometry: workSet.frameGeometry.filteredDirectory,
      capacity: work.capacity,
      camera,
      instances: job.scene.instances,
      virtualGeometry: work.productBindings,
      productBanks: work.productBanks,
      counters,
      countersEnabled: job.countersEnabled,
      width: config.width,
      height: config.height,
      mipLevelCount: config.mipLevelCount,
    };
    const previous = this.currentHzbPrepared.get(job.runtime);
    if (previous !== undefined && this.currentHzbLateRecheck.matches(previous, input)) return previous;
    const prepared = this.currentHzbLateRecheck.prepare(input);
    try {
      this.meshletBucketRaster.prepare(job.runtime, work, job.assets, prepared.queue);
    } catch (error) {
      this.currentHzbLateRecheck.release(prepared);
      throw error;
    }
    this.currentHzbPrepared.set(job.runtime, prepared);
    if (previous !== undefined) {
      const owner = this.currentHzbLateRecheck;
      command.destroyAfterGpuDone({
        destroy: () => {
          this.graphics.raster_partitions.release(previous.queue);
          owner.release(previous);
        },
      });
    }
    return prepared;
  }

  private retirePrepared(workSet: VisibilityWorkSet, command: ShadeGPUCommandContext): void {
    command.destroyAfterGpuDone({
      destroy: () => {
        this.instanceTransforms.release(workSet.frameInstances);
        this.vertexTransforms.release(workSet.frameVertices);
        this.geometryArena.release(workSet.frameGeometry);
        if (workSet.meshletWorkCandidate !== null) {
          this.graphics.raster_partitions.release(workSet.meshletWorkCandidate.queue);
          if (workSet.meshletWorkCandidate.productMode) {
            this.virtualMeshletCandidate.release(workSet.meshletWorkCandidate);
          } else {
            this.meshletCandidate.release(workSet.meshletWorkCandidate);
          }
        }
        this.hierarchyGenerator.release(workSet.hierarchy);
      },
    });
  }

  private requireDebugBindings(runtime: GpuRenderWorldRuntime): PackedVisibilityDebugBindings {
    const bindings = this.debugBindings.get(runtime);
    if (bindings === undefined) {
      throw new Error("Packed Visibility debug resolve executed before work was produced");
    }
    return bindings;
  }
}

/** Internal Packed Visibility prepare contract; intentionally not public. */
export function validatePackedVisibilityPreparation(
  requiredCapacity: number,
  limits: GpuVisibilityBufferLimits,
): Readonly<PackedVisibilityPreparationEvidence> {
  if (
    !Number.isSafeInteger(requiredCapacity) ||
    requiredCapacity <= 0 ||
    requiredCapacity > GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_CAPACITY
  ) {
    throw new RangeError("Required MeshletWork capacity exceeds VisibilityKey V2");
  }
  const effectiveByteLimit = Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize);
  const adapterCapacity =
    effectiveByteLimit < GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE
      ? 0
      : Math.floor(
          (effectiveByteLimit - GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE) / GPU_MESHLET_RASTER_WORK_RECORD_STRIDE,
        );
  const effectiveCapacity = Math.min(GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_CAPACITY, adapterCapacity);
  if (requiredCapacity > effectiveCapacity) {
    throw new RangeError(
      `Required MeshletWork capacity ${requiredCapacity} exceeds effective capacity ${effectiveCapacity}`,
    );
  }
  return Object.freeze({
    requiredCapacity,
    requiredByteLength: gpuMeshletWorkQueueByteLength(requiredCapacity),
    keyCapacity: GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_CAPACITY,
    adapterCapacity,
    effectiveCapacity,
    effectiveByteLimit,
  });
}

export function packedVisibilityAttachmentDescriptor(width: number, height: number) {
  assertPositiveDimension(width, "width");
  assertPositiveDimension(height, "height");
  return Object.freeze({
    kind: "transient_texture" as const,
    label: "Packed VisibilityKey r32uint",
    width,
    height,
    format: "r32uint" as const,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
  });
}

export function packedShadingBinAttachmentDescriptor(width: number, height: number) {
  const contract = gpuShadingBinVisibilityAttachmentContract(width, height);
  return Object.freeze({
    kind: "transient_texture" as const,
    label: contract.label,
    width: contract.width,
    height: contract.height,
    format: contract.format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
}

function requireCommand(value: unknown): ShadeGPUCommandContext {
  if (value && typeof value === "object" && "isGPUCommandContext" in value) {
    return value as ShadeGPUCommandContext;
  }
  throw new Error("PackedVisibilityPass requires ShadeGPUCommandContext");
}

function normalizeMeshletCandidateCapacity(value: number | undefined, defaultCapacity: number): number {
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

import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GeometryHierarchyView } from "../../geometry/GeometryHierarchy.js";
import type { GpuAssetBindings } from "../../gpu/GpuAssetStore.js";
import type { GpuSceneBindings } from "../../gpu/GpuScene.js";
import { GPU_INSTANCE_FLAGS } from "../../gpu/GpuInstanceAbi.js";
import type { GpuRenderWorldRuntime } from "../../gpu/GpuRenderWorld.js";
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
} from "../RenderTargetViews.js";
import {
  exactRasterFrame,
  textureDomain,
  visibilityFrame,
  type VisibilityFrame
} from "../pipeline/FrameProducts.js";
import {
  ExactTriangleFilter,
  type PreparedExactTriangleFilter
} from "../ExactTriangleFilter.js";
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
  sameVisibilityWorkSetKey,
  visibilityWorkSet,
  visibilityWorkSetKey,
  type VisibilityWorkSet
} from "../VisibilityWorkSet.js";

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
    },
    ...Array.from({ length: 3 }, (_, index) => ({
      binding: index + 11,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "unfilterable-float" as GPUTextureSampleType, viewDimension: "2d-array" as GPUTextureViewDimension }
    }))
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

export interface PackedVisibilityPrepareJob {
  readonly runtime: GpuRenderWorldRuntime;
  readonly assets: GpuAssetBindings;
  readonly scene: GpuSceneBindings;
  readonly countersEnabled: boolean;
  readonly width: number;
  readonly height: number;
  readonly hierarchyView: GeometryHierarchyView;
  readonly sseThreshold: number;
  readonly coneEnabled: boolean;
  /** Step-2 GPU-only compact/bucket/indirect producer seam; never a raster consumer. */
  readonly meshletWorkCandidateEnabled?: boolean;
  /** Positive test pressure override; omitted uses the proven triangle capacity upper bound. */
  readonly meshletWorkCandidateCapacity?: number;
  /** Step-2 specialization policy; auto selects subgroup only when negotiated. */
  readonly meshletWorkCompactionPath?: "auto" | "portable" | "subgroup";
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
  readonly exactRasterRecords: ResourceId;
  readonly exactDrawIndirect: ResourceId;
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
  "prepare" | "rebind" | "encode" | "release" | "destroy"
>;

type PackedVisibilityExactFilter = Pick<
  ExactTriangleFilter,
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
  lastCandidateCapacity = 0;
  lastVerticesPerTriangle = PACKED_HIERARCHY_VISIBILITY_VERTICES_PER_TRIANGLE;
  lastVisibilityKeyAttachmentBytes = 0;
  readonly lastImplementation = "hierarchy" as const;
  lastPreparation: Readonly<PackedVisibilityPreparationEvidence> | null = null;
  private readonly hierarchyGenerator: PackedVisibilityHierarchyGenerator;
  private readonly exactFilter: PackedVisibilityExactFilter;
  private readonly meshletCandidate: PackedVisibilityMeshletCandidate;
  private readonly meshletBucketRaster: MeshletBucketRaster;
  private readonly hierarchyPrepared = new Map<GpuRenderWorldRuntime, VisibilityWorkSet>();
  private readonly rasterBindings = new WeakMap<
    VisibilityWorkSet,
    Readonly<{ camera: GPUBuffer; opaqueGroup: GPUBindGroup; maskGroup: GPUBindGroup }>
  >();
  private readonly debugBindings = new Map<
    GpuRenderWorldRuntime,
    PackedVisibilityDebugBindings
  >();

  constructor(
    private readonly graphics: GraphicsContext,
    hierarchyGenerator?: PackedVisibilityHierarchyGenerator,
    exactFilter?: PackedVisibilityExactFilter,
    meshletCandidate?: PackedVisibilityMeshletCandidate
  ) {
    this.hierarchyGenerator = hierarchyGenerator ??
      new HierarchicalWorkGenerator(
        graphics.device,
        graphics.resource_accounting,
        "VisibilityWorkSet"
      );
    this.exactFilter = exactFilter ?? new ExactTriangleFilter(
      graphics.device,
      graphics.resource_accounting,
      "VisibilityWorkSet"
    );
    this.meshletCandidate = meshletCandidate ?? new MeshletWorkCandidate(
      graphics.device,
      graphics.resource_accounting
    );
    this.meshletBucketRaster = new MeshletBucketRaster(graphics);
  }

  addToGraph(
    graph: FrameGraph,
    job: PackedVisibilityJob,
    inputs: PackedVisibilityInputs
  ): PackedVisibilityOutputs {
    const output = { visibilityKey: -1 };
    let meshletIdentity = -1;
    let meshletDepth = -1;
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
          resolveDepthAttachmentView(resources.get(inputs.depth)),
          meshletIdentity < 0 ? null : resolveTextureView(resources.get(meshletIdentity)),
          meshletDepth < 0 ? null : resolveDepthAttachmentView(resources.get(meshletDepth))
        );
      }
    );
    builder.read(inputs.camera);
    builder.read(inputs.counters);
    if (inputs.previousHzb !== undefined) builder.read(inputs.previousHzb);
    const depth = builder.write(inputs.depth);
    const exactRasterRecords = builder.write(inputs.exactRasterRecords);
    const exactDrawIndirect = builder.write(inputs.exactDrawIndirect);
    const setupRecords = inputs.setupRecords === undefined
      ? null
      : builder.write(inputs.setupRecords);
    const counters = builder.write(inputs.counters);
    output.visibilityKey = builder.create(
      "Packed VisibilityKey",
      packedVisibilityAttachmentDescriptor(job.width, job.height)
    );
    if (job.prepared.workSet.meshletWorkCandidate !== null) {
      meshletIdentity = builder.create("ADR-0008 Meshlet bucket semantic identity", {
        kind: "transient_texture",
        label: "ADR-0008 Meshlet bucket semantic identity rgba32uint",
        width: job.width,
        height: job.height,
        format: "rgba32uint",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
      });
      meshletDepth = builder.create("ADR-0008 Meshlet bucket reverse-Z depth", {
        kind: "transient_texture",
        label: "ADR-0008 Meshlet bucket reverse-Z depth32float",
        width: job.width,
        height: job.height,
        format: "depth32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT
      });
    }
    builder.make_side_effect();
    const debugResolve = Object.freeze({
      resolve: (): PackedVisibilityDebugBindings =>
        this.requireDebugBindings(job.runtime)
    });
    const frame = visibilityFrame({
      visibilityKey: output.visibilityKey,
      depth,
      exactRaster: exactRasterFrame({
        records: exactRasterRecords,
        drawIndirect: exactDrawIndirect,
        classCapacity: job.prepared.workSet.classCapacity,
        setupRecords,
        setupCapacity: job.prepared.workSet.setupCapacity,
        setupCount: null
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
    this.exactFilter.destroy();
    this.meshletCandidate.destroy();
  }

  private encodeHierarchy(
    job: PackedVisibilityJob,
    command: ShadeGPUCommandContext,
    camera: GPUBuffer,
    counters: GPUBuffer,
    visibilityKey: GPUTextureView,
    depth: GPUTextureView,
    meshletIdentity: GPUTextureView | null,
    meshletDepth: GPUTextureView | null
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
        previousHzb: job.previousHzb
      }
    );
    if (workSet.meshletWorkCandidate !== null) {
      this.meshletCandidate.encode(command, workSet.meshletWorkCandidate);
      if (meshletIdentity === null || meshletDepth === null) {
        throw new Error("Meshlet bucket raster targets are missing for an enabled candidate");
      }
      this.meshletBucketRaster.encodeRaster(command.gpu_encoder, {
        prepared: workSet.meshletWorkCandidate,
        camera,
        assets: job.assets,
        scene: job.scene,
        runtime: job.runtime,
        identity: meshletIdentity,
        depth: meshletDepth
      });
    }
    const exact = this.exactFilter.encode(
      command.gpu_encoder,
      workSet.exact,
      job.width,
      job.height
    );
    const { opaqueGroup, maskGroup } = this.ensureBindGroups(workSet, job, camera);
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
    if (workSet.meshletWorkCandidate !== null) {
      this.graphics.device.queue.writeBuffer(
        workSet.meshletWorkCandidate.paritySettings,
        0,
        new Uint32Array([job.width, job.height, 0, 0])
      );
      this.meshletBucketRaster.encodeParity(command.gpu_encoder, {
        candidateIdentity: meshletIdentity!,
        productionKey: visibilityKey,
        exactWork: exact.rasterWork,
        settings: workSet.meshletWorkCandidate.paritySettings,
        counters,
        width: job.width,
        height: job.height
      });
    }
    this.lastDrawIndirect = true;
    this.lastCandidateCapacity = job.runtime.hierarchyRasterWorkCapacity;
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
    const meshletWorkCandidateEnabled = job.meshletWorkCandidateEnabled ?? false;
    const meshletWorkCandidateCapacity = meshletWorkCandidateEnabled
      ? normalizeMeshletCandidateCapacity(
          job.meshletWorkCandidateCapacity,
          job.runtime.hierarchyRasterWorkCapacity
        )
      : 0;
    const key = visibilityWorkSetKey({
      runtime: job.runtime,
      assetEpoch: job.assets.epoch,
      sceneResourceEpoch: job.scene.resourceEpoch,
      instanceBegin: job.runtime.instanceBegin,
      instanceCount: job.runtime.instanceCount,
      maxHierarchyDepth: job.runtime.hierarchyMaxDepth,
      traversalCapacity: job.runtime.hierarchyTraversalCapacity,
      visibleClusterCapacity: job.runtime.hierarchyVisibleClusterCapacity,
      rasterWorkCapacity: job.runtime.hierarchyRasterWorkCapacity,
      meshletWorkCandidateEnabled,
      meshletWorkCandidateCapacity,
      meshletWorkCompactionPath: job.meshletWorkCompactionPath ?? "auto",
      triangleSetupEnabled,
      triangleSetupThresholdPixels: triangleSetupEnabled
        ? normalizeTriangleSetupThreshold(job.triangleSetupThresholdPixels)
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
      this.exactFilter.rebind(existing.exact, {
        camera: bindings.camera,
        counterBuffer: bindings.counters,
        countersEnabled: bindings.countersEnabled
      });
      if (existing.meshletWorkCandidate !== null) {
        this.meshletCandidate.rebind(existing.meshletWorkCandidate, {
          counterBuffer: bindings.counters,
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
      countersEnabled: job.countersEnabled
    });
    let meshletWorkCandidate: PreparedMeshletWorkCandidate | null = null;
    let exact: PreparedExactTriangleFilter;
    try {
      if (key.meshletWorkCandidateEnabled) {
        meshletWorkCandidate = this.meshletCandidate.prepare({
          visibleClusters: prepared.generated.visibleClusters,
          visibleClusterCapacity: prepared.generated.visibleClusterCapacity,
          capacity: key.meshletWorkCandidateCapacity,
          assets: job.assets,
          scene: job.scene,
          counterBuffer: counters,
          countersEnabled: job.countersEnabled,
          compactionPath: key.meshletWorkCompactionPath
        });
      }
      exact = this.exactFilter.prepare({
        camera,
        candidates: prepared.generated.rasterWork,
        candidateCapacity: prepared.generated.rasterWorkCapacity,
        assets: job.assets,
        scene: job.scene,
        counterBuffer: counters,
        countersEnabled: job.countersEnabled,
        setupEnabled: key.triangleSetupEnabled,
        setupThresholdPixels: key.triangleSetupThresholdPixels
      });
    } catch (error) {
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
      exact,
      exactRasterRecords: exact.output.rasterWork,
      exactDrawIndirect: exact.output.drawIndirect,
      setupRecords: exact.output.setupRecords,
      setupCapacity: exact.output.setupCapacity,
      classCapacity: exact.output.classCapacity
    });
    this.hierarchyPrepared.set(job.runtime, next);
    if (existing !== undefined) this.retirePrepared(existing, command);
    return Object.freeze({ workSet: next, bindings });
  }

  private ensureBindGroups(
    workSet: VisibilityWorkSet,
    job: PackedVisibilityJob,
    camera: GPUBuffer
  ): { opaqueGroup: GPUBindGroup; maskGroup: GPUBindGroup } {
    const cached = this.rasterBindings.get(workSet);
    if (cached !== undefined && cached.camera === camera) {
      return cached;
    }
    const rasterWork = workSet.exactRasterRecords;
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
        { buffer: rasterWork }
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
        { buffer: rasterWork },
        { buffer: job.runtime.materialResources.materialRecords },
        ...job.runtime.materialResources.textureBanks
      ]
    });
    const next = Object.freeze({ camera, opaqueGroup, maskGroup });
    this.rasterBindings.set(workSet, next);
    return next;
  }

  private retirePrepared(
    workSet: VisibilityWorkSet,
    command: ShadeGPUCommandContext
  ): void {
    command.destroyAfterGpuDone({
      destroy: () => {
        this.exactFilter.release(workSet.exact);
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
    throw new RangeError("MeshletWork candidate capacity must be a positive u32 or zero for default");
  }
  return value;
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

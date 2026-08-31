import type { GeometryHierarchyView } from "../geometry/GeometryHierarchy.js";
import { counterByteOffset } from "../debug/GpuFrameCounters.js";
import type { FrameGraph } from "../framegraph/FrameGraph.js";
import { resolveGpuEncoder } from "../framegraph/FrameGraph.js";
import type { GpuAssetBindings } from "../gpu/GpuAssetStore.js";
import { GPU_GEOMETRY_ABI_VERSION } from "../gpu/GpuGeometryAbi.js";
import { GPU_INSTANCE_ABI_VERSION } from "../gpu/GpuInstanceAbi.js";
import type { GpuSceneBindings } from "../gpu/GpuScene.js";
import {
  GPU_DISPATCH_INDIRECT_ARGS_SIZE,
  GPU_DRAW_INDIRECT_ARGS_SIZE,
  GPU_RASTER_WORK_SCHEMA,
  GPU_TRAVERSAL_WORK_SCHEMA,
  GPU_VISIBLE_CLUSTER_RECORD_SCHEMA,
  GPU_WORK_QUEUE_HEADER_SCHEMA
} from "../gpu/GpuWorkGenerationAbi.js";
import { writeGpuBuffer } from "../gpu/GpuQueueEvidence.js";
import {
  HIERARCHICAL_VIEW_OFFSETS,
  HIERARCHICAL_VIEW_UNIFORM_SIZE,
  HIERARCHICAL_HZB_WORK_GENERATION_WGSL,
  HIERARCHICAL_WORK_GENERATION_WGSL,
  HIERARCHICAL_WORKGROUP_SIZE
} from "../shaders/hierarchical_work_generation.js";

const PREPARED_HIERARCHY_WORK_BRAND: unique symbol = Symbol(
  "OEngine.PreparedHierarchyWork"
);

// WebGPU validates a runtime-sized storage array against the fixed prefix plus
// one element, even though an empty logical queue is represented by written=0.
const TRAVERSAL_QUEUE_MIN_BINDING_SIZE =
  GPU_WORK_QUEUE_HEADER_SCHEMA.stride + GPU_TRAVERSAL_WORK_SCHEMA.stride;
const VISIBLE_CLUSTER_QUEUE_MIN_BINDING_SIZE =
  GPU_WORK_QUEUE_HEADER_SCHEMA.stride + GPU_VISIBLE_CLUSTER_RECORD_SCHEMA.stride;
const RASTER_WORK_QUEUE_MIN_BINDING_SIZE =
  GPU_WORK_QUEUE_HEADER_SCHEMA.stride + GPU_RASTER_WORK_SCHEMA.stride;

// First production crossover is deliberately bounded to the measured C case
// (144 instances / 144 proven RasterWork capacity, 127 actually emitted).
// Broaden only with another same-condition wavefront-vs-fused GPU sweep; the
// fused shader serializes Meshlets per lane.
export const FUSED_LEAF_INSTANCE_THRESHOLD = 144;
export const FUSED_LEAF_RASTER_WORK_THRESHOLD = 144;
export type HierarchicalWorkImplementation = "wavefront" | "fused-leaf";

export interface HierarchicalWorkSceneDescriptor {
  readonly assets: GpuAssetBindings;
  readonly scene: GpuSceneBindings;
  readonly instanceBegin: number;
  readonly instanceCount: number;
  /** Zero-based deepest reachable Cluster depth. */
  readonly maxHierarchyDepth: number;
  readonly traversalWorkCapacity: number;
  readonly visibleClusterCapacity: number;
  readonly rasterWorkCapacity: number;
  /** Real profiler counters or the Packed Scene disabled sink. */
  readonly counterBuffer: GPUBuffer;
}

export interface HierarchicalWorkConfig {
  readonly sseThreshold: number;
  readonly countersEnabled: boolean;
  /** Sampling/test-only queue headers. Defaults to countersEnabled. */
  readonly diagnosticsEnabled?: boolean;
  /** Test-only escape hatch; production uses the static crossover decision. */
  readonly fusedLeafEnabled?: boolean;
  /** Test/pressure override. Production defaults to the proven scene capacity. */
  readonly traversalWorkCapacity?: number;
}

export interface HierarchicalWorkFeatures {
  readonly coneEnabled?: boolean;
  /** Every selected instance must contain these bits; zero keeps the main view behavior. */
  readonly requiredInstanceFlags?: number;
  /** Null means history is invalid and the traversal must fail open. */
  readonly previousHzb?: Readonly<{
    view: GPUTextureView;
    width: number;
    height: number;
    mipLevelCount: number;
    /** Matrix used when the committed HZB was built. Column-major. */
    worldToClipMatrix: ArrayLike<number>;
  }> | null;
}

export interface HierarchicalWorkEvidenceLayout {
  readonly headerStride: number;
  readonly rootHeaderIndex: 0;
  readonly traversalHeaderBegin: 1;
  readonly traversalHeaderCount: number;
  readonly selectedHeaderIndex: number;
  readonly rasterHeaderIndex: number;
  readonly totalHeaderCount: number;
}

export interface GeneratedHierarchyWork {
  /** Header begins at byte 0; VisibleCluster records begin at byte 32. */
  readonly visibleClusters: GPUBuffer;
  readonly visibleClusterCapacity: number;
  /** Header begins at byte 0; RasterWork records begin at byte 32. */
  readonly rasterWork: GPUBuffer;
  readonly rasterWorkCapacity: number;
  /** Complete 16 B drawIndirect record written by the GPU every frame. */
  readonly drawIndirect: GPUBuffer;
  /** Sampling-only root, round output, selected and RasterWork headers. */
  readonly evidence: GPUBuffer | null;
  readonly evidenceLayout: HierarchicalWorkEvidenceLayout;
  readonly encodedRoundCount: number;
  readonly implementation: HierarchicalWorkImplementation;
}

export interface PreparedHierarchyWork {
  readonly [PREPARED_HIERARCHY_WORK_BRAND]: true;
  readonly generated: GeneratedHierarchyWork;
}

export interface HierarchicalWorkGraphJob {
  readonly prepared: PreparedHierarchyWork;
  /** Called at graph execution so compiled graphs do not capture stale view data. */
  readonly view: () => GeometryHierarchyView;
}

interface PreparedState {
  readonly owner: HierarchicalWorkGenerator;
  readonly scene: HierarchicalWorkSceneDescriptor;
  readonly sseThreshold: number;
  readonly traversalCapacity: number;
  readonly roundCount: number;
  readonly implementation: HierarchicalWorkImplementation;
  readonly traversalQueues: readonly [GPUBuffer, GPUBuffer] | null;
  readonly selectedQueue: GPUBuffer;
  readonly rasterQueue: GPUBuffer;
  readonly drawIndirect: GPUBuffer;
  readonly dispatchArgs: readonly [GPUBuffer, GPUBuffer, GPUBuffer] | null;
  readonly evidence: GPUBuffer | null;
  readonly evidenceLayout: HierarchicalWorkEvidenceLayout;
  readonly viewUniform: GPUBuffer;
  readonly rootBindGroup: GPUBindGroup | null;
  readonly hzbRootBindGroups: WeakMap<GPUTextureView, GPUBindGroup>;
  readonly traversalBindGroups: readonly [GPUBindGroup, GPUBindGroup] | null;
  readonly hzbTraversalBindGroups: WeakMap<GPUTextureView, readonly [GPUBindGroup, GPUBindGroup]>;
  readonly expansionBindGroup: GPUBindGroup | null;
  readonly dispatchPreparationBindGroup: GPUBindGroup | null;
  readonly leafBindGroup: GPUBindGroup | null;
  readonly hzbLeafBindGroups: WeakMap<GPUTextureView, GPUBindGroup>;
  readonly countersEnabled: boolean;
  readonly diagnosticsEnabled: boolean;
  readonly buffers: readonly GPUBuffer[];
  destroyed: boolean;
}

const PREPARED_STATE = new WeakMap<object, PreparedState>();

const INSTANCE_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "R3-D Hierarchy/fused root group0",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: HIERARCHICAL_VIEW_UNIFORM_SIZE } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: TRAVERSAL_QUEUE_MIN_BINDING_SIZE } },
    { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: VISIBLE_CLUSTER_QUEUE_MIN_BINDING_SIZE } },
    { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_DISPATCH_INDIRECT_ARGS_SIZE } },
    { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: 256 } }
  ]
};

const HZB_INSTANCE_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "R3-D Hierarchy/fused root + previous HZB group0",
  entries: [
    ...INSTANCE_GROUP.entries,
    {
      binding: 10,
      visibility: GPUShaderStage.COMPUTE,
      texture: { sampleType: "unfilterable-float", viewDimension: "2d" }
    }
  ]
};

const TRAVERSAL_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "R3-B Hierarchy/traversal group1",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: HIERARCHICAL_VIEW_UNIFORM_SIZE } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: TRAVERSAL_QUEUE_MIN_BINDING_SIZE } },
    { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: TRAVERSAL_QUEUE_MIN_BINDING_SIZE } },
    { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: VISIBLE_CLUSTER_QUEUE_MIN_BINDING_SIZE } },
    { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_DISPATCH_INDIRECT_ARGS_SIZE } },
    { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: 256 } }
  ]
};

const HZB_TRAVERSAL_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "R3-D Hierarchy/traversal + previous HZB group1",
  entries: [
    ...TRAVERSAL_GROUP.entries,
    {
      binding: 10,
      visibility: GPUShaderStage.COMPUTE,
      texture: { sampleType: "unfilterable-float", viewDimension: "2d" }
    }
  ]
};

const EXPANSION_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "R3-C Hierarchy/RasterWork expansion group2",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: HIERARCHICAL_VIEW_UNIFORM_SIZE } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: VISIBLE_CLUSTER_QUEUE_MIN_BINDING_SIZE } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: RASTER_WORK_QUEUE_MIN_BINDING_SIZE } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_DRAW_INDIRECT_ARGS_SIZE } },
    { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: 256 } }
  ]
};

const DISPATCH_PREPARATION_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "R3-C Hierarchy/RasterWork dispatch preparation group2",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: HIERARCHICAL_VIEW_UNIFORM_SIZE } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: VISIBLE_CLUSTER_QUEUE_MIN_BINDING_SIZE } },
    { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_DISPATCH_INDIRECT_ARGS_SIZE } }
  ]
};

const LEAF_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "R3-D Hierarchy/fused leaf group3",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: HIERARCHICAL_VIEW_UNIFORM_SIZE } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: VISIBLE_CLUSTER_QUEUE_MIN_BINDING_SIZE } },
    { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: RASTER_WORK_QUEUE_MIN_BINDING_SIZE } },
    { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_DRAW_INDIRECT_ARGS_SIZE } },
    { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: 256 } }
  ]
};

const HZB_LEAF_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "R3-D Hierarchy/fused leaf + previous HZB group3",
  entries: [
    ...LEAF_GROUP.entries,
    {
      binding: 10,
      visibility: GPUShaderStage.COMPUTE,
      texture: { sampleType: "unfilterable-float", viewDimension: "2d" }
    }
  ]
};

/**
 * Unique owner for R3 frame-local root/ping-pong/selected work resources.
 *
 * `prepare()` is infrequent scene/topology work. `encode()` performs no CPU
 * visibility traversal, readback or submit. Prepared bindings must be rebuilt
 * when either the Asset or Instance table epoch changes. Call `release()` only
 * after the caller has established GPU completion for the last use.
 */
export class HierarchicalWorkGenerator {
  private readonly rootPipeline: GPUComputePipeline;
  private hzbRootPipeline: GPUComputePipeline | null = null;
  private readonly traversalPipeline: GPUComputePipeline;
  private hzbTraversalPipeline: GPUComputePipeline | null = null;
  private readonly leafPipeline: GPUComputePipeline;
  private hzbLeafPipeline: GPUComputePipeline | null = null;
  private readonly expansionPipeline: GPUComputePipeline;
  private readonly dispatchPreparationPipeline: GPUComputePipeline;
  private readonly instanceLayout: GPUBindGroupLayout;
  private hzbInstanceLayout: GPUBindGroupLayout | null = null;
  private readonly traversalLayout: GPUBindGroupLayout;
  private hzbTraversalLayout: GPUBindGroupLayout | null = null;
  private readonly leafLayout: GPUBindGroupLayout;
  private hzbLeafLayout: GPUBindGroupLayout | null = null;
  private readonly expansionLayout: GPUBindGroupLayout;
  private readonly dispatchPreparationLayout: GPUBindGroupLayout;
  private readonly emptyLayout: GPUBindGroupLayout;
  private readonly prepared = new Set<PreparedHierarchyWork>();
  private destroyed = false;

  constructor(private readonly device: GPUDevice) {
    const module = device.createShaderModule({
      label: "R3-B Hierarchical Work Generation",
      code: HIERARCHICAL_WORK_GENERATION_WGSL
    });
    this.instanceLayout = device.createBindGroupLayout(INSTANCE_GROUP);
    this.traversalLayout = device.createBindGroupLayout(TRAVERSAL_GROUP);
    this.leafLayout = device.createBindGroupLayout(LEAF_GROUP);
    this.expansionLayout = device.createBindGroupLayout(EXPANSION_GROUP);
    this.dispatchPreparationLayout = device.createBindGroupLayout(
      DISPATCH_PREPARATION_GROUP
    );
    this.emptyLayout = device.createBindGroupLayout({
      label: "R3-B Hierarchy/empty group0",
      entries: []
    });
    this.rootPipeline = device.createComputePipeline({
      label: "R3-D Hierarchy/fused InstanceCull + root Cluster",
      layout: device.createPipelineLayout({
        label: "R3-D Hierarchy/fused root pipeline layout",
        bindGroupLayouts: [this.instanceLayout]
      }),
      compute: { module, entryPoint: "r3_fused_root_cull" }
    });
    this.traversalPipeline = device.createComputePipeline({
      label: "R3-B Hierarchy/Cluster Frustum + SSE traversal",
      layout: device.createPipelineLayout({
        label: "R3-B Hierarchy/traversal pipeline layout",
        bindGroupLayouts: [this.emptyLayout, this.traversalLayout]
      }),
      compute: { module, entryPoint: "r3_traverse_clusters" }
    });
    this.leafPipeline = device.createComputePipeline({
      label: "R3-D Hierarchy/depth-0 fused leaf work",
      layout: device.createPipelineLayout({
        label: "R3-D Hierarchy/fused leaf pipeline layout",
        bindGroupLayouts: [
          this.emptyLayout,
          this.emptyLayout,
          this.emptyLayout,
          this.leafLayout
        ]
      }),
      compute: { module, entryPoint: "r3_fused_leaf_work" }
    });
    this.expansionPipeline = device.createComputePipeline({
      label: "R3-C Hierarchy/VisibleCluster → RasterWork",
      layout: device.createPipelineLayout({
        label: "R3-C Hierarchy/RasterWork expansion pipeline layout",
        bindGroupLayouts: [this.emptyLayout, this.emptyLayout, this.expansionLayout]
      }),
      compute: { module, entryPoint: "r3_expand_raster_work" }
    });
    this.dispatchPreparationPipeline = device.createComputePipeline({
      label: "R3-C Hierarchy/prepare RasterWork dispatch",
      layout: device.createPipelineLayout({
        label: "R3-C Hierarchy/RasterWork dispatch preparation layout",
        bindGroupLayouts: [
          this.emptyLayout,
          this.emptyLayout,
          this.dispatchPreparationLayout
        ]
      }),
      compute: { module, entryPoint: "r3_prepare_raster_dispatch" }
    });
  }

  prepare(
    scene: HierarchicalWorkSceneDescriptor,
    config: HierarchicalWorkConfig
  ): PreparedHierarchyWork {
    this.assertAlive();
    validateSceneDescriptor(scene);
    if (!Number.isFinite(config.sseThreshold) || config.sseThreshold < 0) {
      throw new RangeError("R3-B sseThreshold must be non-negative and finite");
    }
    if (typeof config.countersEnabled !== "boolean") {
      throw new TypeError("R3-C countersEnabled must be boolean");
    }
    if (config.diagnosticsEnabled !== undefined &&
      typeof config.diagnosticsEnabled !== "boolean") {
      throw new TypeError("R3-D diagnosticsEnabled must be boolean");
    }
    const traversalCapacity = config.traversalWorkCapacity ??
      scene.traversalWorkCapacity;
    assertPositiveU32(traversalCapacity, "R3-B traversal capacity");
    if (traversalCapacity > scene.traversalWorkCapacity) {
      throw new RangeError(
        "R3-B traversal capacity override exceeds the proven scene capacity"
      );
    }
    const roundCount = checkedAddU32(
      scene.maxHierarchyDepth,
      1,
      "R3-B hierarchy round count"
    );
    const implementation = selectHierarchicalWorkImplementation(scene, config);
    const diagnosticsEnabled = config.diagnosticsEnabled ?? config.countersEnabled;
    validateDispatchCapacity(
      this.device,
      scene.instanceCount,
      implementation === "fused-leaf"
        ? "R3-D fused leaf work"
        : "R3-D fused root work"
    );
    if (implementation === "wavefront") {
      validateDispatchCapacity(
        this.device,
        traversalCapacity,
        "R3-B Cluster traversal"
      );
      validateWorkgroupCapacity(
        this.device,
        scene.visibleClusterCapacity,
        "R3-C RasterWork expansion"
      );
    }

    const buffers: GPUBuffer[] = [];
    try {
      const ping = implementation === "wavefront"
        ? this.createQueue(
          "R3-D/TraversalQueue/ping",
          traversalCapacity,
          GPU_TRAVERSAL_WORK_SCHEMA.stride,
          buffers
        )
        : null;
      const pong = implementation === "wavefront"
        ? this.createQueue(
          "R3-D/TraversalQueue/pong",
          traversalCapacity,
          GPU_TRAVERSAL_WORK_SCHEMA.stride,
          buffers
        )
        : null;
      const selectedQueue = this.createQueue(
        "R3-D/VisibleClusterQueue",
        scene.visibleClusterCapacity,
        GPU_VISIBLE_CLUSTER_RECORD_SCHEMA.stride,
        buffers
      );
      const rasterQueue = this.createQueue(
        "R3-D/RasterWorkQueue",
        scene.rasterWorkCapacity,
        GPU_RASTER_WORK_SCHEMA.stride,
        buffers
      );
      const pingArgs = implementation === "wavefront"
        ? this.createDispatchArgs("R3-D/dispatch/ping", buffers)
        : null;
      const pongArgs = implementation === "wavefront"
        ? this.createDispatchArgs("R3-D/dispatch/pong", buffers)
        : null;
      const selectedArgs = implementation === "wavefront"
        ? this.createDispatchArgs("R3-D/dispatch/VisibleCluster", buffers)
        : null;
      const drawIndirect = this.createInitializedBuffer({
        label: "R3-C/Hardware Visibility drawIndirect",
        size: GPU_DRAW_INDIRECT_ARGS_SIZE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT |
          GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
      }, new Uint8Array(new Uint32Array([384, 0, 0, 0]).buffer), buffers);
      const evidenceHeaderCount = checkedAddU32(
        roundCount,
        3,
        "R3-B evidence header count"
      );
      const evidence = diagnosticsEnabled
        ? this.createEvidenceBuffer(
          evidenceHeaderCount,
          roundCount,
          scene,
          traversalCapacity,
          buffers
        )
        : null;
      const viewUniform = this.createBuffer({
        label: "R3-B/view-uniform",
        size: HIERARCHICAL_VIEW_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      }, buffers);

      const rootBindGroup = implementation === "wavefront"
        ? this.createRootBindGroup(
          this.instanceLayout,
          "R3-D/fused root bindings",
          scene,
          viewUniform,
          ping!,
          selectedQueue,
          pingArgs!
        )
        : null;
      const createTraversalGroup = (
        label: string,
        input: GPUBuffer,
        output: GPUBuffer,
        outputArgs: GPUBuffer
      ): GPUBindGroup => this.device.createBindGroup({
        label,
        layout: this.traversalLayout,
        entries: [
          { binding: 0, resource: { buffer: viewUniform } },
          { binding: 1, resource: { buffer: scene.scene.instances } },
          { binding: 3, resource: { buffer: scene.assets.clusterRecords } },
          { binding: 4, resource: { buffer: scene.assets.clusterChildren } },
          { binding: 5, resource: { buffer: input } },
          { binding: 6, resource: { buffer: output } },
          { binding: 7, resource: { buffer: selectedQueue } },
          { binding: 8, resource: { buffer: outputArgs } },
          { binding: 9, resource: { buffer: scene.counterBuffer } }
        ]
      });
      const traversalBindGroups = implementation === "wavefront"
        ? Object.freeze([
          createTraversalGroup("R3-D/ping → pong", ping!, pong!, pongArgs!),
          createTraversalGroup("R3-D/pong → ping", pong!, ping!, pingArgs!)
        ] as const)
        : null;
      const expansionBindGroup = implementation === "wavefront"
        ? this.device.createBindGroup({
        label: "R3-C/VisibleCluster → RasterWork bindings",
        layout: this.expansionLayout,
        entries: [
          { binding: 0, resource: { buffer: viewUniform } },
          { binding: 1, resource: { buffer: scene.assets.clusterRecords } },
          { binding: 2, resource: { buffer: selectedQueue } },
          { binding: 3, resource: { buffer: rasterQueue } },
          { binding: 4, resource: { buffer: drawIndirect } },
          { binding: 6, resource: { buffer: scene.counterBuffer } }
        ]
      })
        : null;
      const dispatchPreparationBindGroup = implementation === "wavefront"
        ? this.device.createBindGroup({
        label: "R3-C/prepare RasterWork dispatch bindings",
        layout: this.dispatchPreparationLayout,
        entries: [
          { binding: 0, resource: { buffer: viewUniform } },
          { binding: 2, resource: { buffer: selectedQueue } },
          { binding: 5, resource: { buffer: selectedArgs! } }
        ]
      })
        : null;
      const leafBindGroup = implementation === "fused-leaf"
        ? this.createLeafBindGroup(
          this.leafLayout,
          "R3-D/fused leaf bindings",
          scene,
          viewUniform,
          selectedQueue,
          rasterQueue,
          drawIndirect
        )
        : null;
      const evidenceLayout = Object.freeze({
        headerStride: GPU_WORK_QUEUE_HEADER_SCHEMA.stride,
        rootHeaderIndex: 0 as const,
        traversalHeaderBegin: 1 as const,
        traversalHeaderCount: roundCount,
        selectedHeaderIndex: roundCount + 1,
        rasterHeaderIndex: roundCount + 2,
        totalHeaderCount: evidenceHeaderCount
      });
      const generated = Object.freeze({
        visibleClusters: selectedQueue,
        visibleClusterCapacity: scene.visibleClusterCapacity,
        rasterWork: rasterQueue,
        rasterWorkCapacity: scene.rasterWorkCapacity,
        drawIndirect,
        evidence,
        evidenceLayout,
        encodedRoundCount: roundCount,
        implementation
      });
      const prepared = Object.freeze({
        [PREPARED_HIERARCHY_WORK_BRAND]: true as const,
        generated
      });
      const state: PreparedState = {
        owner: this,
        scene,
        sseThreshold: config.sseThreshold,
        traversalCapacity,
        roundCount,
        implementation,
        traversalQueues: ping !== null && pong !== null ? [ping, pong] : null,
        selectedQueue,
        rasterQueue,
        drawIndirect,
        dispatchArgs: pingArgs !== null && pongArgs !== null && selectedArgs !== null
          ? [pingArgs, pongArgs, selectedArgs]
          : null,
        evidence,
        evidenceLayout,
        viewUniform,
        rootBindGroup,
        hzbRootBindGroups: new WeakMap(),
        traversalBindGroups,
        hzbTraversalBindGroups: new WeakMap(),
        expansionBindGroup,
        dispatchPreparationBindGroup,
        leafBindGroup,
        hzbLeafBindGroups: new WeakMap(),
        countersEnabled: config.countersEnabled,
        diagnosticsEnabled,
        buffers: Object.freeze(buffers),
        destroyed: false
      };
      PREPARED_STATE.set(prepared as object, state);
      this.prepared.add(prepared);
      return prepared;
    } catch (error) {
      for (const buffer of buffers) buffer.destroy();
      throw error;
    }
  }

  encode(
    encoder: GPUCommandEncoder,
    prepared: PreparedHierarchyWork,
    view: GeometryHierarchyView,
    features: HierarchicalWorkFeatures = {}
  ): GeneratedHierarchyWork {
    this.assertAlive();
    const state = this.requirePrepared(prepared);
    const instrumentationEnabled =
      state.countersEnabled || state.diagnosticsEnabled;
    const viewBytes = packHierarchyViewUniform(
      view,
      state.sseThreshold,
      state.scene.instanceBegin,
      state.scene.instanceCount,
      state.roundCount,
      instrumentationEnabled,
      Number(this.device.limits.maxComputeWorkgroupsPerDimension),
      features
    );
    writeGpuBuffer(
      this.device.queue,
      "HierarchicalWorkGenerator/view",
      state.viewUniform,
      0,
      viewBytes
    );

    clearQueueCounters(encoder, state.selectedQueue);
    clearQueueCounters(encoder, state.rasterQueue);
    if (state.evidence !== null) {
      clearEvidenceCounters(
        encoder,
        state.evidence,
        state.roundCount + 3
      );
    }
    // vertexCount/firstVertex/firstInstance are immutable initialized lanes;
    // the GPU resets and publishes only the dynamic instanceCount lane.
    encoder.clearBuffer(state.drawIndirect, 4, 4);
    const rootGrid = computeHierarchicalDispatchGrid(
      state.scene.instanceCount,
      Number(this.device.limits.maxComputeWorkgroupsPerDimension)
    );
    const hzbEnabled = features.previousHzb !== null &&
      features.previousHzb !== undefined;

    if (state.implementation === "fused-leaf") {
      const leafPass = encoder.beginComputePass({
        label: "R3-D/Fused leaf work generation"
      });
      leafPass.setPipeline(hzbEnabled
        ? this.obtainHzbLeafPipeline()
        : this.leafPipeline);
      leafPass.setBindGroup(
        3,
        hzbEnabled
          ? this.obtainHzbLeafBindGroup(state, features.previousHzb!.view)
          : state.leafBindGroup!
      );
      leafPass.dispatchWorkgroups(rootGrid.x, rootGrid.y, 1);
      leafPass.end();
    } else {
      const queues = state.traversalQueues!;
      const args = state.dispatchArgs!;
      clearQueueCounters(encoder, queues[0]);
      clearQueueCounters(encoder, queues[1]);
      for (const dispatch of args) encoder.clearBuffer(dispatch, 0, 12);

      const rootPass = encoder.beginComputePass({
        label: "R3-D/Fused root hierarchy work generation"
      });
      rootPass.setPipeline(hzbEnabled
        ? this.obtainHzbRootPipeline()
        : this.rootPipeline);
      rootPass.setBindGroup(
        0,
        hzbEnabled
          ? this.obtainHzbRootBindGroup(state, features.previousHzb!.view)
          : state.rootBindGroup!
      );
      rootPass.dispatchWorkgroups(rootGrid.x, rootGrid.y, 1);
      rootPass.end();
      this.copyQueueEvidence(state, encoder, queues[0], 1);

      for (let round = 1; round < state.roundCount; round++) {
        const outputIndex = round % 2;
        const inputIndex = (round - 1) % 2;
        const outputQueue = queues[outputIndex]!;
        const outputArgs = args[outputIndex]!;
        if (round >= 2) {
          clearQueueCounters(encoder, outputQueue);
          encoder.clearBuffer(outputArgs, 0, 12);
        }
        const traversalGroups = hzbEnabled
          ? this.obtainHzbTraversalBindGroups(state, features.previousHzb!.view)
          : state.traversalBindGroups!;
        const traversalPass = encoder.beginComputePass({
          label: `R3-B/Hierarchy round ${round}`
        });
        traversalPass.setPipeline(hzbEnabled
          ? this.obtainHzbTraversalPipeline()
          : this.traversalPipeline);
        traversalPass.setBindGroup(1, traversalGroups[inputIndex]!);
        traversalPass.dispatchWorkgroupsIndirect(args[inputIndex]!, 0);
        traversalPass.end();
        this.copyQueueEvidence(state, encoder, outputQueue, round + 1);
      }

      const dispatchPreparationPass = encoder.beginComputePass({
        label: "R3-C/prepare RasterWork dispatch"
      });
      dispatchPreparationPass.setPipeline(this.dispatchPreparationPipeline);
      dispatchPreparationPass.setBindGroup(2, state.dispatchPreparationBindGroup!);
      dispatchPreparationPass.dispatchWorkgroups(1, 1, 1);
      dispatchPreparationPass.end();
      const expansionPass = encoder.beginComputePass({
        label: "R3-C/VisibleCluster → RasterWork"
      });
      expansionPass.setPipeline(this.expansionPipeline);
      expansionPass.setBindGroup(2, state.expansionBindGroup!);
      expansionPass.dispatchWorkgroupsIndirect(args[2], 0);
      expansionPass.end();
    }

    this.writeSampledEvidence(state, encoder);
    return prepared.generated;
  }

  addToGraph(
    graph: FrameGraph,
    job: HierarchicalWorkGraphJob
  ): GeneratedHierarchyWork {
    const state = this.requirePrepared(job.prepared);
    const builder = graph.add(
      "R3-B Hierarchical Work Generation",
      job,
      (data, _resources, context) => {
        const encoder = resolveGpuEncoder(context);
        if (encoder === undefined) {
          throw new Error("R3-B HierarchicalWorkGenerator requires a GPU encoder");
        }
        this.encode(encoder, data.prepared, data.view());
      }
    );
    builder.make_side_effect();
    return Object.freeze({ ...job.prepared.generated, encodedRoundCount: state.roundCount });
  }

  release(prepared: PreparedHierarchyWork): void {
    const state = this.requirePrepared(prepared);
    state.destroyed = true;
    for (const buffer of state.buffers) buffer.destroy();
    PREPARED_STATE.delete(prepared as object);
    this.prepared.delete(prepared);
  }

  evidence(prepared: PreparedHierarchyWork): Readonly<{
    schemaVersion: 2;
    implementation: HierarchicalWorkImplementation;
    rootCapacity: number;
    rootWorkBytes: 0;
    traversalCapacity: number;
    visibleClusterCapacity: number;
    rasterWorkCapacity: number;
    drawIndirectBytes: 16;
    encodedRoundCount: number;
    encodedTraversalPassCount: number;
    sampledEvidenceBytes: number;
    transientBytes: number;
    privateSubmitCount: 0;
    coneResources: 0;
    hzbResources: 0;
    softwareRasterResources: 0;
  }> {
    const state = this.requirePrepared(prepared);
    return Object.freeze({
      schemaVersion: 2,
      implementation: state.implementation,
      rootCapacity: state.scene.instanceCount,
      rootWorkBytes: 0,
      traversalCapacity: state.traversalCapacity,
      visibleClusterCapacity: state.scene.visibleClusterCapacity,
      rasterWorkCapacity: state.scene.rasterWorkCapacity,
      drawIndirectBytes: GPU_DRAW_INDIRECT_ARGS_SIZE as 16,
      encodedRoundCount: state.roundCount,
      encodedTraversalPassCount: state.implementation === "wavefront"
        ? state.roundCount - 1
        : 0,
      sampledEvidenceBytes: state.evidence?.size ?? 0,
      transientBytes: state.buffers.reduce((sum, buffer) => sum + buffer.size, 0),
      privateSubmitCount: 0,
      coneResources: 0,
      hzbResources: 0,
      softwareRasterResources: 0
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    for (const prepared of [...this.prepared]) this.release(prepared);
    this.destroyed = true;
  }

  private createEvidenceBuffer(
    headerCount: number,
    roundCount: number,
    scene: HierarchicalWorkSceneDescriptor,
    traversalCapacity: number,
    buffers: GPUBuffer[]
  ): GPUBuffer {
    const size = checkedByteLength(
      headerCount,
      GPU_WORK_QUEUE_HEADER_SCHEMA.stride,
      0,
      "R3-D sampled evidence"
    );
    const initial = new Uint8Array(size);
    const view = new DataView(initial.buffer);
    const capacityOffset = GPU_WORK_QUEUE_HEADER_SCHEMA.offsets.capacity!;
    view.setUint32(capacityOffset, scene.instanceCount, true);
    for (let round = 0; round < roundCount; round++) {
      view.setUint32(
        (round + 1) * GPU_WORK_QUEUE_HEADER_SCHEMA.stride + capacityOffset,
        traversalCapacity,
        true
      );
    }
    view.setUint32(
      (roundCount + 1) * GPU_WORK_QUEUE_HEADER_SCHEMA.stride + capacityOffset,
      scene.visibleClusterCapacity,
      true
    );
    view.setUint32(
      (roundCount + 2) * GPU_WORK_QUEUE_HEADER_SCHEMA.stride + capacityOffset,
      scene.rasterWorkCapacity,
      true
    );
    return this.createInitializedBuffer({
      label: "R3-D/sampled queue evidence",
      size,
      usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    }, initial, buffers);
  }

  private createRootBindGroup(
    layout: GPUBindGroupLayout,
    label: string,
    scene: HierarchicalWorkSceneDescriptor,
    viewUniform: GPUBuffer,
    output: GPUBuffer,
    selected: GPUBuffer,
    outputArgs: GPUBuffer,
    hzbView?: GPUTextureView
  ): GPUBindGroup {
    return this.device.createBindGroup({
      label,
      layout,
      entries: [
        { binding: 0, resource: { buffer: viewUniform } },
        { binding: 1, resource: { buffer: scene.scene.instances } },
        { binding: 2, resource: { buffer: scene.assets.geometryRecords } },
        { binding: 3, resource: { buffer: scene.assets.clusterRecords } },
        { binding: 4, resource: { buffer: scene.assets.clusterChildren } },
        { binding: 5, resource: { buffer: output } },
        { binding: 6, resource: { buffer: selected } },
        { binding: 7, resource: { buffer: outputArgs } },
        { binding: 8, resource: { buffer: scene.counterBuffer } },
        ...(hzbView === undefined ? [] : [{ binding: 10, resource: hzbView }])
      ]
    });
  }

  private createLeafBindGroup(
    layout: GPUBindGroupLayout,
    label: string,
    scene: HierarchicalWorkSceneDescriptor,
    viewUniform: GPUBuffer,
    selected: GPUBuffer,
    raster: GPUBuffer,
    drawIndirect: GPUBuffer,
    hzbView?: GPUTextureView
  ): GPUBindGroup {
    return this.device.createBindGroup({
      label,
      layout,
      entries: [
        { binding: 0, resource: { buffer: viewUniform } },
        { binding: 1, resource: { buffer: scene.scene.instances } },
        { binding: 2, resource: { buffer: scene.assets.geometryRecords } },
        { binding: 3, resource: { buffer: scene.assets.clusterRecords } },
        { binding: 4, resource: { buffer: selected } },
        { binding: 5, resource: { buffer: raster } },
        { binding: 6, resource: { buffer: drawIndirect } },
        { binding: 7, resource: { buffer: scene.counterBuffer } },
        ...(hzbView === undefined ? [] : [{ binding: 10, resource: hzbView }])
      ]
    });
  }

  private copyQueueEvidence(
    state: PreparedState,
    encoder: GPUCommandEncoder,
    queue: GPUBuffer,
    headerIndex: number
  ): void {
    if (state.evidence === null) return;
    encoder.copyBufferToBuffer(
      queue,
      0,
      state.evidence,
      headerIndex * GPU_WORK_QUEUE_HEADER_SCHEMA.stride,
      GPU_WORK_QUEUE_HEADER_SCHEMA.stride
    );
  }

  private writeSampledEvidence(
    state: PreparedState,
    encoder: GPUCommandEncoder
  ): void {
    if (state.evidence === null) return;
    const rootOffset = state.evidenceLayout.rootHeaderIndex *
      GPU_WORK_QUEUE_HEADER_SCHEMA.stride;
    encoder.copyBufferToBuffer(
      state.scene.counterBuffer,
      counterByteOffset("visibleInstances"),
      state.evidence,
      rootOffset + GPU_WORK_QUEUE_HEADER_SCHEMA.offsets.written!,
      4
    );
    encoder.copyBufferToBuffer(
      state.scene.counterBuffer,
      counterByteOffset("candidateInstances"),
      state.evidence,
      rootOffset + GPU_WORK_QUEUE_HEADER_SCHEMA.offsets.attempted!,
      4
    );
    encoder.copyBufferToBuffer(
      state.scene.counterBuffer,
      counterByteOffset("visibleInstances"),
      state.evidence,
      rootOffset + GPU_WORK_QUEUE_HEADER_SCHEMA.offsets.peak!,
      4
    );
    this.copyQueueEvidence(
      state,
      encoder,
      state.selectedQueue,
      state.evidenceLayout.selectedHeaderIndex
    );
    this.copyQueueEvidence(
      state,
      encoder,
      state.rasterQueue,
      state.evidenceLayout.rasterHeaderIndex
    );
  }

  private createQueue(
    label: string,
    capacity: number,
    elementStride: number,
    buffers: GPUBuffer[]
  ): GPUBuffer {
    assertPositiveU32(capacity, `${label} capacity`);
    const size = checkedByteLength(
      capacity,
      elementStride,
      GPU_WORK_QUEUE_HEADER_SCHEMA.stride,
      label
    );
    validateStorageBufferSize(this.device, size, label);
    const initial = new Uint8Array(size);
    new DataView(initial.buffer).setUint32(
      GPU_WORK_QUEUE_HEADER_SCHEMA.offsets.capacity!,
      capacity,
      true
    );
    return this.createInitializedBuffer({
      label,
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST
    }, initial, buffers);
  }

  private createDispatchArgs(label: string, buffers: GPUBuffer[]): GPUBuffer {
    const initial = new Uint32Array([0, 1, 1]);
    return this.createInitializedBuffer({
      label,
      size: GPU_DISPATCH_INDIRECT_ARGS_SIZE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT |
        GPUBufferUsage.COPY_DST
    }, new Uint8Array(initial.buffer), buffers);
  }

  private createInitializedBuffer(
    descriptor: GPUBufferDescriptor,
    initial: Uint8Array,
    buffers: GPUBuffer[]
  ): GPUBuffer {
    const buffer = this.device.createBuffer({
      ...descriptor,
      mappedAtCreation: true
    });
    buffers.push(buffer);
    new Uint8Array(buffer.getMappedRange()).set(initial);
    buffer.unmap();
    return buffer;
  }

  private createBuffer(
    descriptor: GPUBufferDescriptor,
    buffers: GPUBuffer[]
  ): GPUBuffer {
    if (descriptor.size > Number(this.device.limits.maxBufferSize)) {
      throw new RangeError(
        `${descriptor.label ?? "R3-B buffer"} exceeds maxBufferSize`
      );
    }
    const buffer = this.device.createBuffer(descriptor);
    buffers.push(buffer);
    return buffer;
  }

  private requirePrepared(prepared: PreparedHierarchyWork): PreparedState {
    const state = PREPARED_STATE.get(prepared as object);
    if (state === undefined || state.owner !== this || state.destroyed) {
      throw new Error("R3-B prepared work is stale or belongs to another owner");
    }
    return state;
  }

  private obtainHzbRootPipeline(): GPUComputePipeline {
    this.hzbRootPipeline ??= this.device.createComputePipeline({
      label: "R3-D Hierarchy/fused root + previous HZB",
      layout: this.device.createPipelineLayout({
        label: "R3-D Hierarchy/fused root HZB pipeline layout",
        bindGroupLayouts: [this.obtainHzbInstanceLayout()]
      }),
      compute: {
        module: this.device.createShaderModule({
          label: "R3-D Hierarchical previous-HZB Work Generation",
          code: HIERARCHICAL_HZB_WORK_GENERATION_WGSL
        }),
        entryPoint: "r3_fused_root_cull"
      }
    });
    return this.hzbRootPipeline;
  }

  private obtainHzbRootBindGroup(
    state: PreparedState,
    hzbView: GPUTextureView
  ): GPUBindGroup {
    const cached = state.hzbRootBindGroups.get(hzbView);
    if (cached !== undefined) return cached;
    const queues = state.traversalQueues!;
    const args = state.dispatchArgs!;
    const group = this.createRootBindGroup(
      this.obtainHzbInstanceLayout(),
      "R3-D/fused root + previous HZB bindings",
      state.scene,
      state.viewUniform,
      queues[0],
      state.selectedQueue,
      args[0],
      hzbView
    );
    state.hzbRootBindGroups.set(hzbView, group);
    return group;
  }

  private obtainHzbInstanceLayout(): GPUBindGroupLayout {
    this.hzbInstanceLayout ??=
      this.device.createBindGroupLayout(HZB_INSTANCE_GROUP);
    return this.hzbInstanceLayout;
  }

  private obtainHzbTraversalPipeline(): GPUComputePipeline {
    this.hzbTraversalPipeline ??= this.device.createComputePipeline({
      label: "R3-D Hierarchy/Cluster Cone + previous HZB traversal",
      layout: this.device.createPipelineLayout({
        label: "R3-D Hierarchy/HZB traversal pipeline layout",
        bindGroupLayouts: [this.emptyLayout, this.obtainHzbTraversalLayout()]
      }),
      compute: {
        module: this.device.createShaderModule({
          label: "R3-D Hierarchical previous-HZB Work Generation",
          code: HIERARCHICAL_HZB_WORK_GENERATION_WGSL
        }),
        entryPoint: "r3_traverse_clusters"
      }
    });
    return this.hzbTraversalPipeline;
  }

  private obtainHzbTraversalBindGroups(
    state: PreparedState,
    hzbView: GPUTextureView
  ): readonly [GPUBindGroup, GPUBindGroup] {
    const cached = state.hzbTraversalBindGroups.get(hzbView);
    if (cached !== undefined) return cached;
    const create = (
      label: string,
      input: GPUBuffer,
      output: GPUBuffer,
      outputArgs: GPUBuffer
    ): GPUBindGroup => this.device.createBindGroup({
      label,
      layout: this.obtainHzbTraversalLayout(),
      entries: [
        { binding: 0, resource: { buffer: state.viewUniform } },
        { binding: 1, resource: { buffer: state.scene.scene.instances } },
        { binding: 3, resource: { buffer: state.scene.assets.clusterRecords } },
        { binding: 4, resource: { buffer: state.scene.assets.clusterChildren } },
        { binding: 5, resource: { buffer: input } },
        { binding: 6, resource: { buffer: output } },
        { binding: 7, resource: { buffer: state.selectedQueue } },
        { binding: 8, resource: { buffer: outputArgs } },
        { binding: 9, resource: { buffer: state.scene.counterBuffer } },
        { binding: 10, resource: hzbView }
      ]
    });
    const queues = state.traversalQueues!;
    const args = state.dispatchArgs!;
    const groups = Object.freeze([
      create("R3-D/ping → pong + previous HZB", queues[0], queues[1], args[1]),
      create("R3-D/pong → ping + previous HZB", queues[1], queues[0], args[0])
    ] as const);
    state.hzbTraversalBindGroups.set(hzbView, groups);
    return groups;
  }

  private obtainHzbTraversalLayout(): GPUBindGroupLayout {
    this.hzbTraversalLayout ??=
      this.device.createBindGroupLayout(HZB_TRAVERSAL_GROUP);
    return this.hzbTraversalLayout;
  }

  private obtainHzbLeafPipeline(): GPUComputePipeline {
    this.hzbLeafPipeline ??= this.device.createComputePipeline({
      label: "R3-D Hierarchy/fused leaf + previous HZB",
      layout: this.device.createPipelineLayout({
        label: "R3-D Hierarchy/fused leaf HZB pipeline layout",
        bindGroupLayouts: [
          this.emptyLayout,
          this.emptyLayout,
          this.emptyLayout,
          this.obtainHzbLeafLayout()
        ]
      }),
      compute: {
        module: this.device.createShaderModule({
          label: "R3-D Hierarchical previous-HZB Work Generation",
          code: HIERARCHICAL_HZB_WORK_GENERATION_WGSL
        }),
        entryPoint: "r3_fused_leaf_work"
      }
    });
    return this.hzbLeafPipeline;
  }

  private obtainHzbLeafBindGroup(
    state: PreparedState,
    hzbView: GPUTextureView
  ): GPUBindGroup {
    const cached = state.hzbLeafBindGroups.get(hzbView);
    if (cached !== undefined) return cached;
    const group = this.createLeafBindGroup(
      this.obtainHzbLeafLayout(),
      "R3-D/fused leaf + previous HZB bindings",
      state.scene,
      state.viewUniform,
      state.selectedQueue,
      state.rasterQueue,
      state.drawIndirect,
      hzbView
    );
    state.hzbLeafBindGroups.set(hzbView, group);
    return group;
  }

  private obtainHzbLeafLayout(): GPUBindGroupLayout {
    this.hzbLeafLayout ??= this.device.createBindGroupLayout(HZB_LEAF_GROUP);
    return this.hzbLeafLayout;
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error("HierarchicalWorkGenerator is destroyed");
  }
}

export function packHierarchyViewUniform(
  view: GeometryHierarchyView,
  sseThreshold: number,
  instanceBegin: number,
  instanceCount: number,
  encodedRoundCount: number,
  countersEnabled = false,
  maxComputeWorkgroupsPerDimension = 65535,
  features: HierarchicalWorkFeatures = {}
): Uint8Array<ArrayBuffer> {
  validateGpuHierarchyView(view);
  if (!Number.isFinite(sseThreshold) || sseThreshold < 0) {
    throw new RangeError("R3-B sseThreshold must be non-negative and finite");
  }
  assertU32(instanceBegin, "R3-B instance begin");
  assertPositiveU32(instanceCount, "R3-B instance count");
  assertPositiveU32(encodedRoundCount, "R3-B encoded round count");
  assertPositiveU32(
    maxComputeWorkgroupsPerDimension,
    "R3-B maxComputeWorkgroupsPerDimension"
  );
  checkedAddU32(instanceBegin, instanceCount, "R3-B Instance range");
  const bytes = new Uint8Array(HIERARCHICAL_VIEW_UNIFORM_SIZE);
  const data = new DataView(bytes.buffer);
  for (let lane = 0; lane < 3; lane++) {
    data.setFloat32(
      HIERARCHICAL_VIEW_OFFSETS.cameraPosition + lane * 4,
      view.cameraPosition[lane]!,
      true
    );
  }
  for (let planeIndex = 0; planeIndex < 6; planeIndex++) {
    const plane = view.frustumPlanes[planeIndex]!;
    for (let lane = 0; lane < 4; lane++) {
      data.setFloat32(
        HIERARCHICAL_VIEW_OFFSETS.frustumPlanes + planeIndex * 16 + lane * 4,
        plane[lane]!,
        true
      );
    }
  }
  const projectionScaleY = view.kind === "perspective"
    ? 1 / Math.tan(view.verticalFovRadians * 0.5)
    : 0;
  const nearPlane = view.kind === "perspective" ? view.nearPlane : 1;
  data.setFloat32(HIERARCHICAL_VIEW_OFFSETS.sse, sseThreshold, true);
  data.setFloat32(HIERARCHICAL_VIEW_OFFSETS.sse + 4, view.viewportHeight, true);
  data.setFloat32(HIERARCHICAL_VIEW_OFFSETS.sse + 8, projectionScaleY, true);
  data.setFloat32(HIERARCHICAL_VIEW_OFFSETS.sse + 12, nearPlane, true);
  data.setFloat32(
    HIERARCHICAL_VIEW_OFFSETS.orthographic,
    view.kind === "orthographic" ? view.verticalWorldSize : 1,
    true
  );
  data.setFloat32(
    HIERARCHICAL_VIEW_OFFSETS.orthographic + 4,
    view.kind === "orthographic" ? 1 : 0,
    true
  );
  data.setUint32(HIERARCHICAL_VIEW_OFFSETS.scene, instanceBegin, true);
  data.setUint32(HIERARCHICAL_VIEW_OFFSETS.scene + 4, instanceCount, true);
  data.setUint32(HIERARCHICAL_VIEW_OFFSETS.scene + 8, encodedRoundCount, true);
  const requiredInstanceFlags = features.requiredInstanceFlags ?? 0;
  assertU32(requiredInstanceFlags, "R5 SecondaryRasterWork required instance flags");
  data.setUint32(HIERARCHICAL_VIEW_OFFSETS.scene + 12, requiredInstanceFlags, true);
  data.setUint32(
    HIERARCHICAL_VIEW_OFFSETS.limits,
    maxComputeWorkgroupsPerDimension,
    true
  );
  const previousHzb = features.previousHzb ?? null;
  const worldToClip = previousHzb?.worldToClipMatrix;
  if (previousHzb !== null &&
    (worldToClip === undefined || worldToClip.length < 16)) {
    throw new RangeError(
      "R3-D previous HZB requires its 16-value previous worldToClipMatrix"
    );
  }
  const matrix = worldToClip ?? IDENTITY_MATRIX;
  for (let index = 0; index < 16; index++) {
    const value = Number(matrix[index]);
    if (!Number.isFinite(value)) {
      throw new RangeError(`R3-D worldToClipMatrix[${index}] must be finite`);
    }
    data.setFloat32(HIERARCHICAL_VIEW_OFFSETS.worldToClip + index * 4, value, true);
  }
  let featureFlags = features.coneEnabled === true ? 1 : 0;
  if (previousHzb !== null) {
    assertPositiveU32(previousHzb.width, "R3-D previous HZB width");
    assertPositiveU32(previousHzb.height, "R3-D previous HZB height");
    assertPositiveU32(previousHzb.mipLevelCount, "R3-D previous HZB mip count");
    featureFlags |= 2;
    data.setUint32(HIERARCHICAL_VIEW_OFFSETS.hzb, previousHzb.width, true);
    data.setUint32(HIERARCHICAL_VIEW_OFFSETS.hzb + 4, previousHzb.height, true);
    data.setUint32(
      HIERARCHICAL_VIEW_OFFSETS.hzb + 8,
      previousHzb.mipLevelCount,
      true
    );
  }
  if (countersEnabled) featureFlags |= 4;
  data.setUint32(HIERARCHICAL_VIEW_OFFSETS.hzb + 12, featureFlags, true);
  return bytes;
}

const IDENTITY_MATRIX = Object.freeze([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1
] as const);

export function computeHierarchicalDispatchGrid(
  invocationCapacity: number,
  maxComputeWorkgroupsPerDimension: number
): Readonly<{ x: number; y: number }> {
  assertPositiveU32(invocationCapacity, "R3 dispatch invocation capacity");
  assertPositiveU32(
    maxComputeWorkgroupsPerDimension,
    "R3 maxComputeWorkgroupsPerDimension"
  );
  const linearWorkgroups = Math.ceil(
    invocationCapacity / HIERARCHICAL_WORKGROUP_SIZE
  );
  const x = Math.min(linearWorkgroups, maxComputeWorkgroupsPerDimension);
  const y = Math.ceil(linearWorkgroups / x);
  if (y > maxComputeWorkgroupsPerDimension) {
    throw new RangeError(
      `R3 dispatch requires ${linearWorkgroups} workgroups, adapter 2D limit is ` +
      `${maxComputeWorkgroupsPerDimension}²`
    );
  }
  return Object.freeze({ x, y });
}

/** R3-D one selected Cluster maps to one expansion workgroup. */
export function computeHierarchicalWorkgroupGrid(
  workgroupCapacity: number,
  maxComputeWorkgroupsPerDimension: number
): Readonly<{ x: number; y: number }> {
  assertPositiveU32(workgroupCapacity, "R3 workgroup capacity");
  assertPositiveU32(
    maxComputeWorkgroupsPerDimension,
    "R3 maxComputeWorkgroupsPerDimension"
  );
  const x = Math.min(workgroupCapacity, maxComputeWorkgroupsPerDimension);
  const y = Math.ceil(workgroupCapacity / x);
  if (y > maxComputeWorkgroupsPerDimension) {
    throw new RangeError(
      `R3 dispatch requires ${workgroupCapacity} workgroups, adapter 2D limit is ` +
      `${maxComputeWorkgroupsPerDimension}²`
    );
  }
  return Object.freeze({ x, y });
}

export function selectHierarchicalWorkImplementation(
  scene: Pick<
    HierarchicalWorkSceneDescriptor,
    "maxHierarchyDepth" | "instanceCount" | "rasterWorkCapacity"
  >,
  config: Pick<HierarchicalWorkConfig, "fusedLeafEnabled"> = {}
): HierarchicalWorkImplementation {
  return config.fusedLeafEnabled !== false &&
    scene.maxHierarchyDepth === 0 &&
    scene.instanceCount <= FUSED_LEAF_INSTANCE_THRESHOLD &&
    scene.rasterWorkCapacity <= FUSED_LEAF_RASTER_WORK_THRESHOLD
    ? "fused-leaf"
    : "wavefront";
}

function validateSceneDescriptor(scene: HierarchicalWorkSceneDescriptor): void {
  if (scene.assets.abiVersion !== GPU_GEOMETRY_ABI_VERSION) {
    throw new Error("R3-B Geometry ABI version mismatch");
  }
  if (scene.scene.abiVersion !== GPU_INSTANCE_ABI_VERSION) {
    throw new Error("R3-B Instance ABI version mismatch");
  }
  assertU32(scene.instanceBegin, "R3-B instance begin");
  assertPositiveU32(scene.instanceCount, "R3-B instance count");
  assertU32(scene.maxHierarchyDepth, "R3-B max hierarchy depth");
  assertPositiveU32(scene.traversalWorkCapacity, "R3-B proven traversal capacity");
  assertPositiveU32(scene.visibleClusterCapacity, "R3-B VisibleCluster capacity");
  assertPositiveU32(scene.rasterWorkCapacity, "R3-C RasterWork capacity");
  if (scene.counterBuffer.size < 256 ||
    (scene.counterBuffer.usage & GPUBufferUsage.STORAGE) === 0) {
    throw new RangeError("R3-C counter buffer must be a 256 B storage buffer");
  }
  const instanceEnd = checkedAddU32(
    scene.instanceBegin,
    scene.instanceCount,
    "R3-B Instance range"
  );
  if (instanceEnd > scene.scene.highWaterCount) {
    throw new RangeError("R3-B Instance range exceeds the resident table");
  }
  if (scene.assets.highWaterCounts.clusterRecords === 0) {
    throw new Error("R3-B requires resident Cluster records");
  }
}

function validateGpuHierarchyView(view: GeometryHierarchyView): void {
  if (view.cameraPosition.length !== 3 ||
    !view.cameraPosition.every(Number.isFinite)) {
    throw new RangeError("R3-B cameraPosition must contain three finite values");
  }
  if (!Number.isFinite(view.viewportHeight) || view.viewportHeight <= 0) {
    throw new RangeError("R3-B viewportHeight must be positive and finite");
  }
  if (view.frustumPlanes.length !== 6) {
    throw new RangeError("R3-B GPU view requires exactly six Frustum planes");
  }
  for (let index = 0; index < 6; index++) {
    const plane = view.frustumPlanes[index]!;
    if (plane.length !== 4 || !plane.every(Number.isFinite)) {
      throw new RangeError(`R3-B frustumPlanes[${index}] is invalid`);
    }
    if (Math.hypot(plane[0], plane[1], plane[2]) === 0 && plane[3] < 0) {
      throw new RangeError(
        `R3-B frustumPlanes[${index}] disabled plane must have non-negative W`
      );
    }
  }
  if (view.kind === "perspective") {
    if (!Number.isFinite(view.verticalFovRadians) ||
      view.verticalFovRadians <= 0 || view.verticalFovRadians >= Math.PI) {
      throw new RangeError("R3-B verticalFovRadians must be in (0, PI)");
    }
    if (!Number.isFinite(view.nearPlane) || view.nearPlane <= 0) {
      throw new RangeError("R3-B nearPlane must be positive and finite");
    }
  } else if (!Number.isFinite(view.verticalWorldSize) ||
    view.verticalWorldSize <= 0) {
    throw new RangeError("R3-B verticalWorldSize must be positive and finite");
  }
}

function clearQueueCounters(encoder: GPUCommandEncoder, queue: GPUBuffer): void {
  // Preserve immutable capacity at byte 20; reset producer evidence around it.
  encoder.clearBuffer(queue, 0, GPU_WORK_QUEUE_HEADER_SCHEMA.offsets.capacity!);
  encoder.clearBuffer(
    queue,
    GPU_WORK_QUEUE_HEADER_SCHEMA.offsets.rejected_cone!,
    8
  );
}

function clearEvidenceCounters(
  encoder: GPUCommandEncoder,
  evidence: GPUBuffer,
  headerCount: number
): void {
  for (let index = 0; index < headerCount; index++) {
    const base = index * GPU_WORK_QUEUE_HEADER_SCHEMA.stride;
    encoder.clearBuffer(
      evidence,
      base,
      GPU_WORK_QUEUE_HEADER_SCHEMA.offsets.capacity!
    );
    encoder.clearBuffer(
      evidence,
      base + GPU_WORK_QUEUE_HEADER_SCHEMA.offsets.rejected_cone!,
      8
    );
  }
}

function validateDispatchCapacity(
  device: GPUDevice,
  capacity: number,
  label: string
): void {
  try {
    computeHierarchicalDispatchGrid(
      capacity,
      Number(device.limits.maxComputeWorkgroupsPerDimension)
    );
  } catch (cause) {
    throw new RangeError(`${label} exceeds the adapter 2D dispatch limit`, {
      cause
    });
  }
}

function validateWorkgroupCapacity(
  device: GPUDevice,
  capacity: number,
  label: string
): void {
  try {
    computeHierarchicalWorkgroupGrid(
      capacity,
      Number(device.limits.maxComputeWorkgroupsPerDimension)
    );
  } catch (cause) {
    throw new RangeError(`${label} exceeds the adapter 2D dispatch limit`, {
      cause
    });
  }
}

function validateStorageBufferSize(
  device: GPUDevice,
  size: number,
  label: string
): void {
  const limit = Math.min(
    Number(device.limits.maxBufferSize),
    Number(device.limits.maxStorageBufferBindingSize)
  );
  if (size > limit) {
    throw new RangeError(`${label} requires ${size} bytes, adapter limit is ${limit}`);
  }
}

function checkedByteLength(
  count: number,
  stride: number,
  header: number,
  label: string
): number {
  assertU32(count, `${label} count`);
  const size = header + count * stride;
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new RangeError(`${label} byte length is invalid`);
  }
  return size;
}

function checkedAddU32(left: number, right: number, label: string): number {
  assertU32(left, label);
  assertU32(right, label);
  const result = left + right;
  assertU32(result, label);
  return result;
}

function assertPositiveU32(value: number, label: string): void {
  assertU32(value, label);
  if (value === 0) throw new RangeError(`${label} must be positive`);
}

function assertU32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${label} ${value} is outside u32`);
  }
}

import type { GeometryHierarchyView } from "../geometry/GeometryHierarchy.js";
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
  /** Test/pressure override. Production defaults to the proven scene capacity. */
  readonly traversalWorkCapacity?: number;
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
  /** Root, each round output, then selected queue headers. */
  readonly evidence: GPUBuffer;
  readonly evidenceLayout: HierarchicalWorkEvidenceLayout;
  readonly encodedRoundCount: number;
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
  readonly rootQueue: GPUBuffer;
  readonly traversalQueues: readonly [GPUBuffer, GPUBuffer];
  readonly selectedQueue: GPUBuffer;
  readonly rasterQueue: GPUBuffer;
  readonly drawIndirect: GPUBuffer;
  readonly dispatchArgs: readonly [GPUBuffer, GPUBuffer, GPUBuffer, GPUBuffer];
  readonly evidence: GPUBuffer;
  readonly viewUniform: GPUBuffer;
  readonly instanceBindGroup: GPUBindGroup;
  readonly traversalBindGroups: readonly [GPUBindGroup, GPUBindGroup, GPUBindGroup];
  readonly expansionBindGroup: GPUBindGroup;
  readonly dispatchPreparationBindGroup: GPUBindGroup;
  readonly counterBindGroup: GPUBindGroup;
  readonly countersEnabled: boolean;
  readonly buffers: readonly GPUBuffer[];
  destroyed: boolean;
}

const PREPARED_STATE = new WeakMap<object, PreparedState>();

const INSTANCE_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "R3-B Hierarchy/instance-cull group0",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: HIERARCHICAL_VIEW_UNIFORM_SIZE } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: TRAVERSAL_QUEUE_MIN_BINDING_SIZE } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_DISPATCH_INDIRECT_ARGS_SIZE } },
    { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_DRAW_INDIRECT_ARGS_SIZE } }
  ]
};

const TRAVERSAL_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "R3-B Hierarchy/traversal group1",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: HIERARCHICAL_VIEW_UNIFORM_SIZE } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: TRAVERSAL_QUEUE_MIN_BINDING_SIZE } },
    { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: TRAVERSAL_QUEUE_MIN_BINDING_SIZE } },
    { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: VISIBLE_CLUSTER_QUEUE_MIN_BINDING_SIZE } },
    { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_DISPATCH_INDIRECT_ARGS_SIZE } }
  ]
};

const EXPANSION_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "R3-C Hierarchy/RasterWork expansion group2",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: HIERARCHICAL_VIEW_UNIFORM_SIZE } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: VISIBLE_CLUSTER_QUEUE_MIN_BINDING_SIZE } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: RASTER_WORK_QUEUE_MIN_BINDING_SIZE } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_DRAW_INDIRECT_ARGS_SIZE } }
  ]
};

const DISPATCH_PREPARATION_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "R3-C Hierarchy/RasterWork dispatch preparation group2",
  entries: [
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: VISIBLE_CLUSTER_QUEUE_MIN_BINDING_SIZE } },
    { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_DISPATCH_INDIRECT_ARGS_SIZE } }
  ]
};

const COUNTER_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "R3-C Hierarchy/queue evidence counter group2",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: HIERARCHICAL_VIEW_UNIFORM_SIZE } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: RASTER_WORK_QUEUE_MIN_BINDING_SIZE } },
    { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: 256 } }
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
  private readonly instancePipeline: GPUComputePipeline;
  private readonly traversalPipeline: GPUComputePipeline;
  private readonly expansionPipeline: GPUComputePipeline;
  private readonly dispatchPreparationPipeline: GPUComputePipeline;
  private readonly counterPipeline: GPUComputePipeline;
  private readonly instanceLayout: GPUBindGroupLayout;
  private readonly traversalLayout: GPUBindGroupLayout;
  private readonly expansionLayout: GPUBindGroupLayout;
  private readonly dispatchPreparationLayout: GPUBindGroupLayout;
  private readonly counterLayout: GPUBindGroupLayout;
  private readonly prepared = new Set<PreparedHierarchyWork>();
  private destroyed = false;

  constructor(private readonly device: GPUDevice) {
    const module = device.createShaderModule({
      label: "R3-B Hierarchical Work Generation",
      code: HIERARCHICAL_WORK_GENERATION_WGSL
    });
    this.instanceLayout = device.createBindGroupLayout(INSTANCE_GROUP);
    this.traversalLayout = device.createBindGroupLayout(TRAVERSAL_GROUP);
    this.expansionLayout = device.createBindGroupLayout(EXPANSION_GROUP);
    this.dispatchPreparationLayout = device.createBindGroupLayout(
      DISPATCH_PREPARATION_GROUP
    );
    this.counterLayout = device.createBindGroupLayout(COUNTER_GROUP);
    const emptyLayout = device.createBindGroupLayout({
      label: "R3-B Hierarchy/empty group0",
      entries: []
    });
    this.instancePipeline = device.createComputePipeline({
      label: "R3-B Hierarchy/InstanceCull → RootTraversal",
      layout: device.createPipelineLayout({
        label: "R3-B Hierarchy/instance pipeline layout",
        bindGroupLayouts: [this.instanceLayout]
      }),
      compute: { module, entryPoint: "r3_instance_cull" }
    });
    this.traversalPipeline = device.createComputePipeline({
      label: "R3-B Hierarchy/Cluster Frustum + SSE traversal",
      layout: device.createPipelineLayout({
        label: "R3-B Hierarchy/traversal pipeline layout",
        bindGroupLayouts: [emptyLayout, this.traversalLayout]
      }),
      compute: { module, entryPoint: "r3_traverse_clusters" }
    });
    this.expansionPipeline = device.createComputePipeline({
      label: "R3-C Hierarchy/VisibleCluster → RasterWork",
      layout: device.createPipelineLayout({
        label: "R3-C Hierarchy/RasterWork expansion pipeline layout",
        bindGroupLayouts: [emptyLayout, emptyLayout, this.expansionLayout]
      }),
      compute: { module, entryPoint: "r3_expand_raster_work" }
    });
    this.dispatchPreparationPipeline = device.createComputePipeline({
      label: "R3-C Hierarchy/prepare RasterWork dispatch",
      layout: device.createPipelineLayout({
        label: "R3-C Hierarchy/RasterWork dispatch preparation layout",
        bindGroupLayouts: [
          emptyLayout,
          emptyLayout,
          this.dispatchPreparationLayout
        ]
      }),
      compute: { module, entryPoint: "r3_prepare_raster_dispatch" }
    });
    this.counterPipeline = device.createComputePipeline({
      label: "R3-C Hierarchy/queue evidence counters",
      layout: device.createPipelineLayout({
        label: "R3-C Hierarchy/queue evidence counter layout",
        bindGroupLayouts: [emptyLayout, emptyLayout, this.counterLayout]
      }),
      compute: { module, entryPoint: "r3_write_work_counters" }
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
    validateDispatchCapacity(
      this.device,
      scene.instanceCount,
      "R3-B root traversal"
    );
    validateDispatchCapacity(
      this.device,
      traversalCapacity,
      "R3-B Cluster traversal"
    );
    validateDispatchCapacity(
      this.device,
      scene.visibleClusterCapacity,
      "R3-C RasterWork expansion"
    );

    const buffers: GPUBuffer[] = [];
    try {
      const rootQueue = this.createQueue(
        "R3-B/RootTraversalQueue",
        scene.instanceCount,
        GPU_TRAVERSAL_WORK_SCHEMA.stride,
        buffers
      );
      const ping = this.createQueue(
        "R3-B/TraversalQueue/ping",
        traversalCapacity,
        GPU_TRAVERSAL_WORK_SCHEMA.stride,
        buffers
      );
      const pong = this.createQueue(
        "R3-B/TraversalQueue/pong",
        traversalCapacity,
        GPU_TRAVERSAL_WORK_SCHEMA.stride,
        buffers
      );
      const selectedQueue = this.createQueue(
        "R3-B/VisibleClusterQueue",
        scene.visibleClusterCapacity,
        GPU_VISIBLE_CLUSTER_RECORD_SCHEMA.stride,
        buffers
      );
      const rasterQueue = this.createQueue(
        "R3-C/RasterWorkQueue",
        scene.rasterWorkCapacity,
        GPU_RASTER_WORK_SCHEMA.stride,
        buffers
      );
      const rootArgs = this.createDispatchArgs("R3-B/dispatch/root", buffers);
      const pingArgs = this.createDispatchArgs("R3-B/dispatch/ping", buffers);
      const pongArgs = this.createDispatchArgs("R3-B/dispatch/pong", buffers);
      const selectedArgs = this.createDispatchArgs(
        "R3-C/dispatch/VisibleCluster",
        buffers
      );
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
      const evidence = this.createBuffer({
        label: "R3-B/queue-evidence",
        size: checkedByteLength(
          evidenceHeaderCount,
          GPU_WORK_QUEUE_HEADER_SCHEMA.stride,
          0,
          "R3-B evidence"
        ),
        usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
          | GPUBufferUsage.STORAGE
      }, buffers);
      const viewUniform = this.createBuffer({
        label: "R3-B/view-uniform",
        size: HIERARCHICAL_VIEW_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      }, buffers);

      const instanceBindGroup = this.device.createBindGroup({
        label: "R3-B/InstanceCull bindings",
        layout: this.instanceLayout,
        entries: [
          { binding: 0, resource: { buffer: viewUniform } },
          { binding: 1, resource: { buffer: scene.scene.instances } },
          { binding: 2, resource: { buffer: scene.assets.geometryRecords } },
          { binding: 3, resource: { buffer: rootQueue } },
          { binding: 4, resource: { buffer: rootArgs } },
          { binding: 5, resource: { buffer: drawIndirect } }
        ]
      });
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
          { binding: 2, resource: { buffer: scene.assets.geometryRecords } },
          { binding: 3, resource: { buffer: scene.assets.clusterRecords } },
          { binding: 4, resource: { buffer: scene.assets.clusterChildren } },
          { binding: 5, resource: { buffer: input } },
          { binding: 6, resource: { buffer: output } },
          { binding: 7, resource: { buffer: selectedQueue } },
          { binding: 8, resource: { buffer: outputArgs } }
        ]
      });
      const traversalBindGroups = Object.freeze([
        createTraversalGroup("R3-B/root → ping", rootQueue, ping, pingArgs),
        createTraversalGroup("R3-B/ping → pong", ping, pong, pongArgs),
        createTraversalGroup("R3-B/pong → ping", pong, ping, pingArgs)
      ] as const);
      const expansionBindGroup = this.device.createBindGroup({
        label: "R3-C/VisibleCluster → RasterWork bindings",
        layout: this.expansionLayout,
        entries: [
          { binding: 0, resource: { buffer: viewUniform } },
          { binding: 1, resource: { buffer: scene.assets.clusterRecords } },
          { binding: 2, resource: { buffer: selectedQueue } },
          { binding: 3, resource: { buffer: rasterQueue } },
          { binding: 4, resource: { buffer: drawIndirect } }
        ]
      });
      const dispatchPreparationBindGroup = this.device.createBindGroup({
        label: "R3-C/prepare RasterWork dispatch bindings",
        layout: this.dispatchPreparationLayout,
        entries: [
          { binding: 2, resource: { buffer: selectedQueue } },
          { binding: 5, resource: { buffer: selectedArgs } }
        ]
      });
      const counterBindGroup = this.device.createBindGroup({
        label: "R3-C/queue evidence counter bindings",
        layout: this.counterLayout,
        entries: [
          { binding: 0, resource: { buffer: viewUniform } },
          { binding: 3, resource: { buffer: rasterQueue } },
          { binding: 6, resource: { buffer: evidence } },
          { binding: 7, resource: { buffer: scene.counterBuffer } }
        ]
      });
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
        encodedRoundCount: roundCount
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
        rootQueue,
        traversalQueues: [ping, pong],
        selectedQueue,
        rasterQueue,
        drawIndirect,
        dispatchArgs: [rootArgs, pingArgs, pongArgs, selectedArgs],
        evidence,
        viewUniform,
        instanceBindGroup,
        traversalBindGroups,
        expansionBindGroup,
        dispatchPreparationBindGroup,
        counterBindGroup,
        countersEnabled: config.countersEnabled,
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
    view: GeometryHierarchyView
  ): GeneratedHierarchyWork {
    this.assertAlive();
    const state = this.requirePrepared(prepared);
    const viewBytes = packHierarchyViewUniform(
      view,
      state.sseThreshold,
      state.scene.instanceBegin,
      state.scene.instanceCount,
      state.roundCount,
      state.countersEnabled
    );
    writeGpuBuffer(
      this.device.queue,
      "HierarchicalWorkGenerator/view",
      state.viewUniform,
      0,
      viewBytes
    );

    clearQueueCounters(encoder, state.rootQueue);
    clearQueueCounters(encoder, state.traversalQueues[0]);
    clearQueueCounters(encoder, state.traversalQueues[1]);
    clearQueueCounters(encoder, state.selectedQueue);
    clearQueueCounters(encoder, state.rasterQueue);
    for (const args of state.dispatchArgs) encoder.clearBuffer(args, 0, 4);

    const instancePass = encoder.beginComputePass({
      label: "R3-B/InstanceCull → RootTraversal"
    });
    instancePass.setPipeline(this.instancePipeline);
    instancePass.setBindGroup(0, state.instanceBindGroup);
    instancePass.dispatchWorkgroups(
      Math.ceil(state.scene.instanceCount / HIERARCHICAL_WORKGROUP_SIZE),
      1,
      1
    );
    instancePass.end();
    encoder.copyBufferToBuffer(
      state.rootQueue,
      0,
      state.evidence,
      0,
      GPU_WORK_QUEUE_HEADER_SCHEMA.stride
    );

    for (let round = 0; round < state.roundCount; round++) {
      const outputIndex = round % 2;
      const outputQueue = state.traversalQueues[outputIndex]!;
      const outputArgs = state.dispatchArgs[outputIndex + 1]!;
      if (round >= 2) {
        clearQueueCounters(encoder, outputQueue);
        encoder.clearBuffer(outputArgs, 0, 4);
      }
      const inputArgs = round === 0
        ? state.dispatchArgs[0]
        : state.dispatchArgs[((round - 1) % 2) + 1]!;
      const group = round === 0
        ? state.traversalBindGroups[0]
        : round % 2 === 1
          ? state.traversalBindGroups[1]
          : state.traversalBindGroups[2];
      const traversalPass = encoder.beginComputePass({
        label: `R3-B/Hierarchy round ${round}`
      });
      traversalPass.setPipeline(this.traversalPipeline);
      traversalPass.setBindGroup(1, group);
      traversalPass.dispatchWorkgroupsIndirect(inputArgs, 0);
      traversalPass.end();
      encoder.copyBufferToBuffer(
        outputQueue,
        0,
        state.evidence,
        (round + 1) * GPU_WORK_QUEUE_HEADER_SCHEMA.stride,
        GPU_WORK_QUEUE_HEADER_SCHEMA.stride
      );
    }
    encoder.copyBufferToBuffer(
      state.selectedQueue,
      0,
      state.evidence,
      (state.roundCount + 1) * GPU_WORK_QUEUE_HEADER_SCHEMA.stride,
      GPU_WORK_QUEUE_HEADER_SCHEMA.stride
    );
    const dispatchPreparationPass = encoder.beginComputePass({
      label: "R3-C/prepare RasterWork dispatch"
    });
    dispatchPreparationPass.setPipeline(this.dispatchPreparationPipeline);
    dispatchPreparationPass.setBindGroup(2, state.dispatchPreparationBindGroup);
    dispatchPreparationPass.dispatchWorkgroups(1, 1, 1);
    dispatchPreparationPass.end();
    const expansionPass = encoder.beginComputePass({
      label: "R3-C/VisibleCluster → RasterWork"
    });
    expansionPass.setPipeline(this.expansionPipeline);
    expansionPass.setBindGroup(2, state.expansionBindGroup);
    expansionPass.dispatchWorkgroupsIndirect(state.dispatchArgs[3], 0);
    expansionPass.end();
    encoder.copyBufferToBuffer(
      state.rasterQueue,
      0,
      state.evidence,
      (state.roundCount + 2) * GPU_WORK_QUEUE_HEADER_SCHEMA.stride,
      GPU_WORK_QUEUE_HEADER_SCHEMA.stride
    );
    if (state.countersEnabled) {
      const counterPass = encoder.beginComputePass({
        label: "R3-C/queue evidence counters"
      });
      counterPass.setPipeline(this.counterPipeline);
      counterPass.setBindGroup(2, state.counterBindGroup);
      counterPass.dispatchWorkgroups(1, 1, 1);
      counterPass.end();
    }
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
    schemaVersion: 1;
    rootCapacity: number;
    traversalCapacity: number;
    visibleClusterCapacity: number;
    rasterWorkCapacity: number;
    drawIndirectBytes: 16;
    encodedRoundCount: number;
    transientBytes: number;
    privateSubmitCount: 0;
    coneResources: 0;
    hzbResources: 0;
    softwareRasterResources: 0;
  }> {
    const state = this.requirePrepared(prepared);
    return Object.freeze({
      schemaVersion: 1,
      rootCapacity: state.scene.instanceCount,
      traversalCapacity: state.traversalCapacity,
      visibleClusterCapacity: state.scene.visibleClusterCapacity,
      rasterWorkCapacity: state.scene.rasterWorkCapacity,
      drawIndirectBytes: GPU_DRAW_INDIRECT_ARGS_SIZE as 16,
      encodedRoundCount: state.roundCount,
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
  countersEnabled = false
): Uint8Array<ArrayBuffer> {
  validateGpuHierarchyView(view);
  if (!Number.isFinite(sseThreshold) || sseThreshold < 0) {
    throw new RangeError("R3-B sseThreshold must be non-negative and finite");
  }
  assertU32(instanceBegin, "R3-B instance begin");
  assertPositiveU32(instanceCount, "R3-B instance count");
  assertPositiveU32(encodedRoundCount, "R3-B encoded round count");
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
  data.setUint32(
    HIERARCHICAL_VIEW_OFFSETS.scene + 12,
    countersEnabled ? 1 : 0,
    true
  );
  return bytes;
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
  // Preserve capacity at byte 20 and immutable padding at 24..31.
  encoder.clearBuffer(queue, 0, GPU_WORK_QUEUE_HEADER_SCHEMA.offsets.capacity!);
}

function validateDispatchCapacity(
  device: GPUDevice,
  capacity: number,
  label: string
): void {
  const workgroups = Math.ceil(capacity / HIERARCHICAL_WORKGROUP_SIZE);
  if (workgroups > Number(device.limits.maxComputeWorkgroupsPerDimension)) {
    throw new RangeError(
      `${label} requires ${workgroups} workgroups, adapter limit is ` +
      `${device.limits.maxComputeWorkgroupsPerDimension}`
    );
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

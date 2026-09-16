import { GPU_COUNTER_BYTE_SIZE } from "../debug/GpuFrameCounters.js";
import type {
  ResourceAccounting,
  ResourceHandle as AccountingResourceHandle
} from "../debug/profiling/ResourceAccounting.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { GpuAssetBindings } from "../gpu/GpuAssetStore.js";
import {
  MESHLET_BUCKET_SETTINGS_STRIDE,
} from "../shaders/meshlet_bucket_visibility.js";
import {
  GPU_MESHLET_BUCKET_COUNT,
  GPU_MESHLET_DRAW_COUNT,
  GPU_MESHLET_RASTER_WORK_RECORD_STRIDE,
  GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE,
  gpuMeshletWorkQueueByteLength,
  packGpuMeshletWorkQueueHeader
} from "../gpu/GpuMeshletRasterWorkAbi.js";
import type { GpuSceneBindings } from "../gpu/GpuScene.js";
import type { GeometryProductGpuBindingsV1 } from "../gpu/VirtualGeometryResidency.js";
import { GPU_DISPATCH_INDIRECT_ARGS_SIZE } from "../gpu/GpuWorkGenerationAbi.js";
import { GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_CAPACITY } from "../gpu/GpuVisibilityKeyAbi.js";
import {
  MESHLET_WORK_BUCKET_INDIRECT_SIZE,
  MESHLET_WORK_BUCKET_STATE_SIZE,
  MESHLET_WORK_COMPACTION_PORTABLE_WGSL,
  MESHLET_WORK_COMPACTION_SETTINGS_SIZE,
  MESHLET_WORK_COMPACTION_SUBGROUP_WGSL,
  type MeshletWorkCompactionPath
} from "../shaders/meshlet_work_compaction.js";
import { VIRTUAL_GEOMETRY_MESHLET_WORK_WGSL } from "../shaders/virtual_geometry_work.js";

const PREPARED_MESHLET_WORK_CANDIDATE = Symbol("PreparedMeshletWorkCandidate");

export interface MeshletWorkCandidateInputs {
  readonly camera: GPUBuffer;
  readonly visibleClusters: GPUBuffer;
  readonly visibleClusterCapacity: number;
  readonly capacity: number;
  readonly assets: GpuAssetBindings;
  readonly scene: GpuSceneBindings;
  readonly counterBuffer: GPUBuffer;
  readonly countersEnabled: boolean;
  readonly compactionPath?: "auto" | MeshletWorkCompactionPath;
}

export interface PreparedMeshletWorkCandidate {
  readonly [PREPARED_MESHLET_WORK_CANDIDATE]: true;
  readonly queue: GPUBuffer;
  readonly bucketStates: GPUBuffer | null;
  readonly drawIndirect: GPUBuffer;
  readonly bucketSettings: GPUBuffer | null;
  readonly bucketCount: number;
  readonly compactionPath: MeshletWorkCompactionPath;
  readonly capacity: number;
  readonly productMode?: boolean;
  readonly productBindings?: GeometryProductGpuBindingsV1;
  readonly productBanks?: readonly GPUBuffer[];
}

interface CandidatePipelines {
  readonly prepare: GPUComputePipeline;
  readonly generate: GPUComputePipeline;
  readonly prepareRisk: GPUComputePipeline;
  readonly classifyRisk: GPUComputePipeline;
  readonly finalize: GPUComputePipeline;
  readonly scatter: GPUComputePipeline;
  readonly prepareValidation: GPUComputePipeline;
  readonly validate: GPUComputePipeline;
  readonly publish: GPUComputePipeline;
}

interface CandidateState {
  camera: GPUBuffer;
  counterBuffer: GPUBuffer;
  countersEnabled: boolean;
  readonly settings: GPUBuffer;
  readonly staging: GPUBuffer;
  readonly queue: GPUBuffer;
  readonly bucketStates: GPUBuffer;
  readonly drawIndirect: GPUBuffer;
  readonly bucketSettings: GPUBuffer;
  readonly dispatch: GPUBuffer;
  readonly compactionPath: MeshletWorkCompactionPath;
  writeBindGroup: GPUBindGroup;
  consumeBindGroup: GPUBindGroup;
  riskBindGroup: GPUBindGroup;
  readonly inputs: Omit<MeshletWorkCandidateInputs, "camera" | "counterBuffer" | "countersEnabled" | "compactionPath">;
  readonly buffers: readonly GPUBuffer[];
  readonly accounting: readonly AccountingResourceHandle[];
  destroyed: boolean;
}

const CANDIDATE_STATE = new WeakMap<object, CandidateState>();

/**
 * Owns the Step-2 non-production compact/bucket/indirect producer and GPU
 * validation consumer. Queue records are never mapped or read back by the CPU.
 */
export class MeshletWorkCandidate {
  private readonly writeLayout: GPUBindGroupLayout;
  private readonly consumeLayout: GPUBindGroupLayout;
  private readonly riskLayout: GPUBindGroupLayout;
  private readonly pipelines = new Map<MeshletWorkCompactionPath, CandidatePipelines>();
  private readonly prepared = new Set<PreparedMeshletWorkCandidate>();
  private destroyed = false;

  constructor(
    private readonly device: GPUDevice,
    private readonly resourceAccounting?: ResourceAccounting
  ) {
    const commonEntries: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE + GPU_MESHLET_RASTER_WORK_RECORD_STRIDE } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: MESHLET_WORK_COMPACTION_SETTINGS_SIZE } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_COUNTER_BYTE_SIZE } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: MESHLET_WORK_BUCKET_STATE_SIZE } },
      { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE + GPU_MESHLET_RASTER_WORK_RECORD_STRIDE } },
      { binding: 10, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: MESHLET_WORK_BUCKET_INDIRECT_SIZE } }
    ];
    this.writeLayout = device.createBindGroupLayout({
      label: "ADR-0008 MeshletWork candidate write group0",
      entries: [
        ...commonEntries,
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_DISPATCH_INDIRECT_ARGS_SIZE } },
      ]
    });
    this.consumeLayout = device.createBindGroupLayout({
      label: "ADR-0008 MeshletWork candidate consume group0",
      entries: commonEntries
    });
    this.riskLayout = device.createBindGroupLayout({
      label: "ADR-0008 selective projection-risk classifier group1",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: MESHLET_WORK_COMPACTION_SETTINGS_SIZE } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE + GPU_MESHLET_RASTER_WORK_RECORD_STRIDE } },
        ...Array.from({ length: 6 }, (_, index) => ({
          binding: index + 3,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" as GPUBufferBindingType }
        })),
        { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: MESHLET_WORK_BUCKET_STATE_SIZE } },
        { binding: 10, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_COUNTER_BYTE_SIZE } }
      ]
    });
    const writePipelineLayout = device.createPipelineLayout({
      label: "ADR-0008 MeshletWork candidate write layout",
      bindGroupLayouts: [this.writeLayout]
    });
    const consumePipelineLayout = device.createPipelineLayout({
      label: "ADR-0008 MeshletWork candidate consume layout",
      bindGroupLayouts: [this.consumeLayout]
    });
    const empty = device.createBindGroupLayout({
      label: "ADR-0008 selective projection-risk empty group0",
      entries: []
    });
    const riskPipelineLayout = device.createPipelineLayout({
      label: "ADR-0008 selective projection-risk layout",
      bindGroupLayouts: [empty, this.riskLayout]
    });
    this.pipelines.set("portable", this.createPipelines(
      "portable", MESHLET_WORK_COMPACTION_PORTABLE_WGSL,
      writePipelineLayout, consumePipelineLayout, riskPipelineLayout
    ));
    if (device.features.has("subgroups")) {
      this.pipelines.set("subgroup", this.createPipelines(
        "subgroup", MESHLET_WORK_COMPACTION_SUBGROUP_WGSL,
        writePipelineLayout, consumePipelineLayout, riskPipelineLayout
      ));
    }
  }

  prepare(inputs: MeshletWorkCandidateInputs): PreparedMeshletWorkCandidate {
    this.assertAlive();
    assertPositiveU32(inputs.visibleClusterCapacity, "visible Cluster capacity");
    assertPositiveU32(inputs.capacity, "MeshletWork capacity");
    if (inputs.capacity > GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_CAPACITY) {
      throw new RangeError(
        `MeshletWork capacity ${inputs.capacity} exceeds VisibilityKey V2 capacity ` +
        `${GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_CAPACITY}`
      );
    }
    const queueBytes = gpuMeshletWorkQueueByteLength(inputs.capacity);
    if (queueBytes > Number(this.device.limits.maxStorageBufferBindingSize)) {
      throw new RangeError(
        `MeshletWork candidate queue requires ${queueBytes} bytes but maxStorageBufferBindingSize is ${this.device.limits.maxStorageBufferBindingSize}`
      );
    }
    const buffers: GPUBuffer[] = [];
    const accounting: AccountingResourceHandle[] = [];
    try {
      const compactionPath = this.resolveCompactionPath(inputs.compactionPath ?? "auto");
      const settings = this.createBuffer({
        label: "ADR-0008 MeshletWork candidate settings",
        size: MESHLET_WORK_COMPACTION_SETTINGS_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      }, buffers, accounting, "uniform");
      const staging = this.createBuffer({
        label: "ADR-0008 correctness-critical MeshletWork compact staging queue",
        size: queueBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      }, buffers, accounting, "work-queue");
      const queue = this.createBuffer({
        label: "ADR-0008 correctness-critical bucketed MeshletWork queue",
        size: queueBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      }, buffers, accounting, "work-queue");
      const bucketStates = this.createBuffer({
        label: "ADR-0008 MeshletWork bounded bucket states",
        size: MESHLET_WORK_BUCKET_STATE_SIZE,
        usage: GPUBufferUsage.STORAGE
      }, buffers, accounting, "work-queue");
      const drawIndirect = this.createBuffer({
        label: "ADR-0008 MeshletWork complete bucket drawIndirect records",
        size: MESHLET_WORK_BUCKET_INDIRECT_SIZE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT
      }, buffers, accounting, "indirect");
      const bucketSettings = this.createBuffer({
        label: "ADR-0008 MeshletWork bucket dynamic settings",
        size: GPU_MESHLET_DRAW_COUNT * MESHLET_BUCKET_SETTINGS_STRIDE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      }, buffers, accounting, "uniform");
      const dispatch = this.createBuffer({
        label: "ADR-0008 MeshletWork candidate dispatchIndirect",
        size: GPU_DISPATCH_INDIRECT_ARGS_SIZE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST
      }, buffers, accounting, "indirect");
      const initialHeader = packGpuMeshletWorkQueueHeader({
        attemptedCount: 0,
        writtenCount: 0,
        consumedCount: 0,
        capacity: inputs.capacity,
        overflowCount: 0,
        generation: 0,
        invalidCount: 0
      });
      this.device.queue.writeBuffer(staging, 0, initialHeader);
      this.device.queue.writeBuffer(queue, 0, initialHeader);
      this.device.queue.writeBuffer(dispatch, 0, new Uint32Array([0, 1, 1]));
      const bucketSettingsData = new Uint32Array(
        GPU_MESHLET_DRAW_COUNT * MESHLET_BUCKET_SETTINGS_STRIDE / 4
      );
      for (let bucket = 0; bucket < GPU_MESHLET_DRAW_COUNT; bucket++) {
        const word = bucket * MESHLET_BUCKET_SETTINGS_STRIDE / 4;
        bucketSettingsData[word] = bucket;
        bucketSettingsData[word + 1] = this.device.features.has("indirect-first-instance") ? 1 : 0;
      }
      this.device.queue.writeBuffer(bucketSettings, 0, bucketSettingsData);
      this.writeSettings(settings, inputs.countersEnabled);
      const fixedInputs = Object.freeze({
        visibleClusters: inputs.visibleClusters,
        visibleClusterCapacity: inputs.visibleClusterCapacity,
        capacity: inputs.capacity,
        assets: inputs.assets,
        scene: inputs.scene
      });
      const bindGroups = this.createBindGroups(
        fixedInputs, staging, queue, bucketStates, drawIndirect,
        dispatch, settings, inputs.counterBuffer
      );
      const riskBindGroup = this.createRiskBindGroup(
        inputs.camera, fixedInputs, staging, bucketStates, settings, inputs.counterBuffer
      );
      const prepared = Object.freeze({
        [PREPARED_MESHLET_WORK_CANDIDATE]: true as const,
        queue,
        bucketStates,
        drawIndirect,
        bucketSettings,
        bucketCount: GPU_MESHLET_DRAW_COUNT,
        compactionPath,
        capacity: inputs.capacity
      });
      CANDIDATE_STATE.set(prepared, {
        camera: inputs.camera,
        counterBuffer: inputs.counterBuffer,
        countersEnabled: inputs.countersEnabled,
        settings,
        staging,
        queue,
        bucketStates,
        drawIndirect,
        bucketSettings,
        dispatch,
        compactionPath,
        writeBindGroup: bindGroups.write,
        consumeBindGroup: bindGroups.consume,
        riskBindGroup,
        inputs: fixedInputs,
        buffers,
        accounting,
        destroyed: false
      });
      this.prepared.add(prepared);
      return prepared;
    } catch (error) {
      buffers.forEach((buffer) => buffer.destroy());
      accounting.forEach((handle) => this.resourceAccounting?.destroyed(handle));
      throw error;
    }
  }

  rebind(
    prepared: PreparedMeshletWorkCandidate,
    binding: { camera: GPUBuffer; counterBuffer: GPUBuffer; countersEnabled: boolean }
  ): void {
    const state = this.requireState(prepared);
    if (state.camera === binding.camera && state.counterBuffer === binding.counterBuffer &&
      state.countersEnabled === binding.countersEnabled) return;
    state.camera = binding.camera;
    state.counterBuffer = binding.counterBuffer;
    state.countersEnabled = binding.countersEnabled;
    this.writeSettings(state.settings, binding.countersEnabled);
    const bindGroups = this.createBindGroups(
      state.inputs,
      state.staging,
      state.queue,
      state.bucketStates,
      state.drawIndirect,
      state.dispatch,
      state.settings,
      state.counterBuffer
    );
    state.writeBindGroup = bindGroups.write;
    state.consumeBindGroup = bindGroups.consume;
    state.riskBindGroup = this.createRiskBindGroup(
      state.camera, state.inputs, state.staging, state.bucketStates,
      state.settings, state.counterBuffer
    );
  }

  encode(
    command: ShadeGPUCommandContext,
    prepared: PreparedMeshletWorkCandidate
  ): void {
    const state = this.requireState(prepared);
    const pipelines = this.pipelines.get(state.compactionPath)!;
    this.encodeDirect(command.gpu_encoder, "prepare", pipelines.prepare, state.writeBindGroup, false);
    this.encodeDirect(command.gpu_encoder, `${state.compactionPath} compact`, pipelines.generate, state.consumeBindGroup, true, state.dispatch);
    this.encodeDirect(command.gpu_encoder, "prepare selective-risk dispatch", pipelines.prepareRisk, state.writeBindGroup, false);
    this.encodeRisk(command.gpu_encoder, pipelines.classifyRisk, state.riskBindGroup, state.dispatch);
    this.encodeDirect(command.gpu_encoder, "bucket prefix + indirect args", pipelines.finalize, state.writeBindGroup, false);
    this.encodeDirect(command.gpu_encoder, "bucket scatter", pipelines.scatter, state.consumeBindGroup, true, state.dispatch);
    this.encodeDirect(command.gpu_encoder, "prepare validation", pipelines.prepareValidation, state.writeBindGroup, false);
    this.encodeDirect(command.gpu_encoder, "validate", pipelines.validate, state.consumeBindGroup, true, state.dispatch);
    this.encodeDirect(command.gpu_encoder, "publish counters", pipelines.publish, state.consumeBindGroup, false);
  }

  release(prepared: PreparedMeshletWorkCandidate): void {
    const state = this.requireState(prepared);
    if (state.destroyed) return;
    state.destroyed = true;
    state.buffers.forEach((buffer) => buffer.destroy());
    state.accounting.forEach((handle) => this.resourceAccounting?.destroyed(handle));
    this.prepared.delete(prepared);
  }

  destroy(): void {
    if (this.destroyed) return;
    for (const prepared of [...this.prepared]) this.release(prepared);
    this.destroyed = true;
  }

  private createPipeline(
    module: GPUShaderModule,
    layout: GPUPipelineLayout,
    entryPoint: string
  ): GPUComputePipeline {
    return this.device.createComputePipeline({
      label: `ADR-0008 MeshletWork candidate/${entryPoint}`,
      layout,
      compute: { module, entryPoint }
    });
  }

  private createPipelines(
    path: MeshletWorkCompactionPath,
    code: string,
    writeLayout: GPUPipelineLayout,
    consumeLayout: GPUPipelineLayout,
    riskLayout: GPUPipelineLayout
  ): CandidatePipelines {
    const module = this.device.createShaderModule({
      label: `ADR-0008 MeshletWork ${path} compaction`,
      code
    });
    return Object.freeze({
      prepare: this.createPipeline(module, writeLayout, "prepare_meshlet_work_candidate"),
      generate: this.createPipeline(module, consumeLayout, "generate_meshlet_work_candidate"),
      prepareRisk: this.createPipeline(module, writeLayout, "prepare_meshlet_risk_dispatch"),
      classifyRisk: this.createPipeline(module, riskLayout, "classify_meshlet_projection_risk"),
      finalize: this.createPipeline(module, writeLayout, "finalize_meshlet_work_buckets"),
      scatter: this.createPipeline(module, consumeLayout, "scatter_meshlet_work_buckets"),
      prepareValidation: this.createPipeline(module, writeLayout, "prepare_meshlet_work_validation"),
      validate: this.createPipeline(module, consumeLayout, "validate_meshlet_work_candidate"),
      publish: this.createPipeline(module, consumeLayout, "publish_meshlet_work_candidate_counters")
    });
  }

  private createRiskBindGroup(
    camera: GPUBuffer,
    inputs: CandidateState["inputs"],
    staging: GPUBuffer,
    bucketStates: GPUBuffer,
    settings: GPUBuffer,
    counters: GPUBuffer
  ): GPUBindGroup {
    return this.device.createBindGroup({
      label: "ADR-0008 selective projection-risk bindings",
      layout: this.riskLayout,
      entries: [
        { binding: 0, resource: { buffer: camera } },
        { binding: 1, resource: { buffer: settings } },
        { binding: 2, resource: { buffer: staging } },
        { binding: 3, resource: { buffer: inputs.scene.instances } },
        { binding: 4, resource: { buffer: inputs.assets.geometryRecords } },
        { binding: 5, resource: { buffer: inputs.assets.meshletRecords } },
        { binding: 6, resource: { buffer: inputs.assets.meshletVertexIndices } },
        { binding: 7, resource: { buffer: inputs.assets.meshletTriangleIndices } },
        { binding: 8, resource: { buffer: inputs.assets.vertexStreamData } },
        { binding: 9, resource: { buffer: bucketStates } },
        { binding: 10, resource: { buffer: counters } }
      ]
    });
  }

  private encodeRisk(
    encoder: GPUCommandEncoder,
    pipeline: GPUComputePipeline,
    bindGroup: GPUBindGroup,
    dispatch: GPUBuffer
  ): void {
    const pass = encoder.beginComputePass({
      label: "ADR-0008 MeshletWork/selective projection-risk classification"
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(1, bindGroup);
    pass.dispatchWorkgroupsIndirect(dispatch, 0);
    pass.end();
  }

  private resolveCompactionPath(
    requested: "auto" | MeshletWorkCompactionPath
  ): MeshletWorkCompactionPath {
    if (requested === "subgroup" && !this.pipelines.has("subgroup")) {
      throw new Error("MeshletWork subgroup compaction was forced but the device lacks 'subgroups'");
    }
    return requested === "auto"
      ? (this.pipelines.has("subgroup") ? "subgroup" : "portable")
      : requested;
  }

  private createBindGroups(
    inputs: CandidateState["inputs"],
    staging: GPUBuffer,
    queue: GPUBuffer,
    bucketStates: GPUBuffer,
    drawIndirect: GPUBuffer,
    dispatch: GPUBuffer,
    settings: GPUBuffer,
    counters: GPUBuffer
  ): Readonly<{ write: GPUBindGroup; consume: GPUBindGroup }> {
    const commonEntries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: inputs.visibleClusters } },
        { binding: 1, resource: { buffer: inputs.assets.clusterRecords } },
        { binding: 2, resource: { buffer: inputs.assets.geometryRecords } },
        { binding: 3, resource: { buffer: inputs.assets.meshletRecords } },
        { binding: 4, resource: { buffer: staging } },
        { binding: 6, resource: { buffer: settings } },
        { binding: 7, resource: { buffer: counters } },
        { binding: 8, resource: { buffer: bucketStates } },
        { binding: 9, resource: { buffer: queue } },
        { binding: 10, resource: { buffer: drawIndirect } }
    ];
    return Object.freeze({
      write: this.device.createBindGroup({
        label: "ADR-0008 MeshletWork candidate write bindings",
        layout: this.writeLayout,
        entries: [...commonEntries, { binding: 5, resource: { buffer: dispatch } }]
      }),
      consume: this.device.createBindGroup({
        label: "ADR-0008 MeshletWork candidate consume bindings",
        layout: this.consumeLayout,
        entries: commonEntries
      })
    });
  }

  private encodeDirect(
    encoder: GPUCommandEncoder,
    phase: string,
    pipeline: GPUComputePipeline,
    bindGroup: GPUBindGroup,
    indirect: boolean,
    dispatch?: GPUBuffer
  ): void {
    const pass = encoder.beginComputePass({
      label: `ADR-0008 MeshletWork candidate/${phase}`
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    if (indirect) pass.dispatchWorkgroupsIndirect(dispatch!, 0);
    else pass.dispatchWorkgroups(1, 1, 1);
    pass.end();
  }

  private writeSettings(settings: GPUBuffer, countersEnabled: boolean): void {
    this.device.queue.writeBuffer(settings, 0, new Uint32Array([
      Number(this.device.limits.maxComputeWorkgroupsPerDimension),
      countersEnabled ? 1 : 0,
      this.device.features.has("indirect-first-instance") ? 1 : 0,
      0
    ]));
  }

  private createBuffer(
    descriptor: GPUBufferDescriptor,
    buffers: GPUBuffer[],
    accounting: AccountingResourceHandle[],
    category: "uniform" | "work-queue" | "indirect"
  ): GPUBuffer {
    const buffer = this.device.createBuffer(descriptor);
    buffers.push(buffer);
    const handle = this.resourceAccounting?.created({
      kind: "buffer",
      category: "transient",
      owner: "VisibilityWorkSet/MeshletWorkCandidate",
      bytes: Number(descriptor.size),
      label: descriptor.label?.toString()
    });
    if (handle !== undefined) accounting.push(handle);
    return buffer;
  }

  private requireState(prepared: PreparedMeshletWorkCandidate): CandidateState {
    this.assertAlive();
    const state = CANDIDATE_STATE.get(prepared);
    if (state === undefined || state.destroyed) {
      throw new Error("MeshletWork candidate was not prepared by this live owner");
    }
    return state;
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error("MeshletWorkCandidate is destroyed");
  }
}

/** S1 Product consumer: one bounded, fixed-width indirect route for decoded Groups. */
export class VirtualGeometryMeshletWorkCandidate {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private readonly prepared = new Set<PreparedMeshletWorkCandidate>();
  private destroyed = false;

  constructor(private readonly device: GPUDevice) {
    this.layout = device.createBindGroupLayout({
      label: "S1 Product MeshletWork layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: 56 } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE + GPU_MESHLET_RASTER_WORK_RECORD_STRIDE } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 16 } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_COUNTER_BYTE_SIZE } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: 16 } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: 64 } },
        ...Array.from({ length: 4 }, (_, index) => ({
          binding: index + 6,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" as GPUBufferBindingType, minBindingSize: 4 }
        }))
      ]
    });
    const module = device.createShaderModule({
      label: "S1 Product MeshletWork shader",
      code: VIRTUAL_GEOMETRY_MESHLET_WORK_WGSL
    });
    const pipelineLayout = device.createPipelineLayout({
      label: "S1 Product MeshletWork pipeline layout",
      bindGroupLayouts: [this.layout]
    });
    this.pipeline = device.createComputePipeline({
      label: "S1 Product MeshletWork pipeline",
      layout: pipelineLayout,
      compute: { module, entryPoint: "generate_virtual_geometry_work" }
    });
  }

  prepare(input: {
    readonly virtualGeometry: GeometryProductGpuBindingsV1;
    readonly visibleClusters: GPUBuffer;
    readonly visibleClusterCapacity: number;
    readonly capacity: number;
    readonly counterBuffer: GPUBuffer;
    readonly countersEnabled: boolean;
  }): PreparedMeshletWorkCandidate {
    this.assertAlive();
    if (input.virtualGeometry.banks.length === 0 || input.virtualGeometry.banks.length > 4) {
      throw new RangeError("S1 Product MeshletWork requires one to four resident banks");
    }
    if (!Number.isInteger(input.visibleClusterCapacity) || input.visibleClusterCapacity <= 0) {
      throw new RangeError("S1 Product visible cluster capacity must be positive");
    }
    if (!Number.isInteger(input.capacity) || input.capacity <= 0 ||
        input.capacity > GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_CAPACITY) {
      throw new RangeError("S1 Product MeshletWork capacity is invalid");
    }
    if (input.visibleClusterCapacity > Number(this.device.limits.maxComputeWorkgroupsPerDimension)) {
      throw new RangeError("S1 Product visible cluster capacity exceeds dispatch dimension");
    }
    const queue = this.device.createBuffer({
      label: "S1 Product MeshletWork queue",
      size: gpuMeshletWorkQueueByteLength(input.capacity),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    const drawIndirect = this.device.createBuffer({
      label: "S1 Product MeshletWork drawIndirect",
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST
    });
    const settings = this.device.createBuffer({
      label: "S1 Product MeshletWork settings",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    const banks: GPUBuffer[] = [...input.virtualGeometry.banks];
    while (banks.length < 4) {
      banks.push(this.device.createBuffer({
        label: "S1 Product MeshletWork empty bank",
        size: 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      }));
    }
    this.device.queue.writeBuffer(queue, 0, packGpuMeshletWorkQueueHeader({
      attemptedCount: 0,
      writtenCount: 0,
      consumedCount: 0,
      capacity: input.capacity,
      overflowCount: 0,
      generation: 0,
      invalidCount: 0
    }));
    this.device.queue.writeBuffer(settings, 0, new Uint32Array([
      input.countersEnabled ? 1 : 0,
      input.virtualGeometry.productGeneration,
      input.visibleClusterCapacity,
      0
    ]));
    const bindGroup = this.device.createBindGroup({
      label: "S1 Product MeshletWork bindings",
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: input.visibleClusters } },
        { binding: 1, resource: { buffer: queue } },
        { binding: 2, resource: { buffer: settings } },
        { binding: 3, resource: { buffer: input.counterBuffer } },
        { binding: 4, resource: { buffer: drawIndirect } },
        { binding: 5, resource: { buffer: input.virtualGeometry.metadata } },
        ...banks.map((buffer, index) => ({ binding: index + 6, resource: { buffer } }))
      ]
    });
    const prepared = Object.freeze({
      [PREPARED_MESHLET_WORK_CANDIDATE]: true as const,
      queue,
      bucketStates: null,
      drawIndirect,
      bucketSettings: null,
      bucketCount: 0,
      compactionPath: "portable" as const,
      capacity: input.capacity,
      productMode: true as const,
      productBindings: input.virtualGeometry,
      productBanks: Object.freeze(banks)
    });
    PRODUCT_CANDIDATE_STATE.set(prepared, {
      queue,
      drawIndirect,
      settings,
      bindGroup,
      banks: Object.freeze(banks),
      visibleClusterCapacity: input.visibleClusterCapacity,
      destroyed: false
    });
    this.prepared.add(prepared);
    return prepared;
  }

  rebind(): void {
    // Product bindings are immutable for one prepared visibility work set.
  }

  encode(command: ShadeGPUCommandContext, prepared: PreparedMeshletWorkCandidate): void {
    const state = this.requireState(prepared);
    const pass = command.gpu_encoder.beginComputePass({ label: "S1 Product MeshletWork" });
    pass.setPipeline(this.pipelineFor("prepare_virtual_geometry_work"));
    pass.setBindGroup(0, state.bindGroup);
    pass.dispatchWorkgroups(1, 1, 1);
    pass.setPipeline(this.pipeline);
    pass.dispatchWorkgroups(state.visibleClusterCapacity, 1, 1);
    pass.setPipeline(this.pipelineFor("finalize_virtual_geometry_work"));
    pass.dispatchWorkgroups(1, 1, 1);
    pass.end();
  }

  release(prepared: PreparedMeshletWorkCandidate): void {
    const state = PRODUCT_CANDIDATE_STATE.get(prepared);
    if (state === undefined || state.destroyed) return;
    state.destroyed = true;
    state.queue.destroy();
    state.drawIndirect.destroy();
    state.settings.destroy();
    for (const bank of state.banks.slice(4)) bank.destroy();
    PRODUCT_CANDIDATE_STATE.delete(prepared);
    this.prepared.delete(prepared);
  }

  destroy(): void {
    if (this.destroyed) return;
    for (const prepared of [...this.prepared]) this.release(prepared);
    this.destroyed = true;
  }

  private pipelineFor(entryPoint: string): GPUComputePipeline {
    const key = `${entryPoint}`;
    const cache = PRODUCT_CANDIDATE_PIPELINES.get(this);
    if (cache?.has(key)) return cache.get(key)!;
    const module = PRODUCT_CANDIDATE_MODULES.get(this) ?? this.device.createShaderModule({
      label: "S1 Product MeshletWork shader",
      code: VIRTUAL_GEOMETRY_MESHLET_WORK_WGSL
    });
    PRODUCT_CANDIDATE_MODULES.set(this, module);
    const layout = this.device.createPipelineLayout({
      label: `S1 Product MeshletWork ${entryPoint} layout`,
      bindGroupLayouts: [this.layout]
    });
    const pipeline = this.device.createComputePipeline({
      label: `S1 Product MeshletWork ${entryPoint}`,
      layout,
      compute: { module, entryPoint }
    });
    if (cache === undefined) PRODUCT_CANDIDATE_PIPELINES.set(this, new Map([[key, pipeline]]));
    else cache.set(key, pipeline);
    return pipeline;
  }

  private requireState(prepared: PreparedMeshletWorkCandidate): ProductCandidateState {
    const state = PRODUCT_CANDIDATE_STATE.get(prepared);
    if (state === undefined || state.destroyed || !prepared.productMode) {
      throw new Error("S1 Product MeshletWork is stale or invalid");
    }
    return state;
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error("S1 Product MeshletWork candidate is destroyed");
  }
}

interface ProductCandidateState {
  readonly queue: GPUBuffer;
  readonly drawIndirect: GPUBuffer;
  readonly settings: GPUBuffer;
  readonly bindGroup: GPUBindGroup;
  readonly banks: readonly GPUBuffer[];
  readonly visibleClusterCapacity: number;
  destroyed: boolean;
}

const PRODUCT_CANDIDATE_STATE = new WeakMap<object, ProductCandidateState>();
const PRODUCT_CANDIDATE_MODULES = new WeakMap<VirtualGeometryMeshletWorkCandidate, GPUShaderModule>();
const PRODUCT_CANDIDATE_PIPELINES = new WeakMap<VirtualGeometryMeshletWorkCandidate, Map<string, GPUComputePipeline>>();

function assertPositiveU32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffffffff) {
    throw new RangeError(`${label} must be a positive u32`);
  }
}

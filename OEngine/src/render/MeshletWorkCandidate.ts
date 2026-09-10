import { GPU_COUNTER_BYTE_SIZE } from "../debug/GpuFrameCounters.js";
import type {
  ResourceAccounting,
  ResourceHandle as AccountingResourceHandle
} from "../debug/profiling/ResourceAccounting.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { GpuAssetBindings } from "../gpu/GpuAssetStore.js";
import {
  GPU_MESHLET_RASTER_WORK_RECORD_STRIDE,
  GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE,
  gpuMeshletWorkQueueByteLength,
  packGpuMeshletWorkQueueHeader
} from "../gpu/GpuMeshletRasterWorkAbi.js";
import type { GpuSceneBindings } from "../gpu/GpuScene.js";
import { GPU_DISPATCH_INDIRECT_ARGS_SIZE } from "../gpu/GpuWorkGenerationAbi.js";
import {
  MESHLET_WORK_CANDIDATE_SETTINGS_SIZE,
  MESHLET_WORK_CANDIDATE_WGSL
} from "../shaders/meshlet_work_candidate.js";

const PREPARED_MESHLET_WORK_CANDIDATE = Symbol("PreparedMeshletWorkCandidate");

export interface MeshletWorkCandidateInputs {
  readonly visibleClusters: GPUBuffer;
  readonly visibleClusterCapacity: number;
  readonly capacity: number;
  readonly assets: GpuAssetBindings;
  readonly scene: GpuSceneBindings;
  readonly counterBuffer: GPUBuffer;
  readonly countersEnabled: boolean;
}

export interface PreparedMeshletWorkCandidate {
  readonly [PREPARED_MESHLET_WORK_CANDIDATE]: true;
  readonly queue: GPUBuffer;
  readonly capacity: number;
}

interface CandidateState {
  counterBuffer: GPUBuffer;
  countersEnabled: boolean;
  readonly settings: GPUBuffer;
  readonly queue: GPUBuffer;
  readonly dispatch: GPUBuffer;
  writeBindGroup: GPUBindGroup;
  consumeBindGroup: GPUBindGroup;
  readonly inputs: Omit<MeshletWorkCandidateInputs, "counterBuffer" | "countersEnabled">;
  readonly buffers: readonly GPUBuffer[];
  readonly accounting: readonly AccountingResourceHandle[];
  destroyed: boolean;
}

const CANDIDATE_STATE = new WeakMap<object, CandidateState>();

/**
 * Owns the Step-1 non-production GPU producer + validation consumer seam.
 * Queue records are never mapped or read back by the CPU.
 */
export class MeshletWorkCandidate {
  private readonly writeLayout: GPUBindGroupLayout;
  private readonly consumeLayout: GPUBindGroupLayout;
  private readonly preparePipeline: GPUComputePipeline;
  private readonly generatePipeline: GPUComputePipeline;
  private readonly prepareValidationPipeline: GPUComputePipeline;
  private readonly validatePipeline: GPUComputePipeline;
  private readonly publishPipeline: GPUComputePipeline;
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
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: MESHLET_WORK_CANDIDATE_SETTINGS_SIZE } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_COUNTER_BYTE_SIZE } }
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
    const module = device.createShaderModule({
      label: "ADR-0008 MeshletWork candidate",
      code: MESHLET_WORK_CANDIDATE_WGSL
    });
    const writePipelineLayout = device.createPipelineLayout({
      label: "ADR-0008 MeshletWork candidate write layout",
      bindGroupLayouts: [this.writeLayout]
    });
    const consumePipelineLayout = device.createPipelineLayout({
      label: "ADR-0008 MeshletWork candidate consume layout",
      bindGroupLayouts: [this.consumeLayout]
    });
    this.preparePipeline = this.createPipeline(module, writePipelineLayout, "prepare_meshlet_work_candidate");
    this.generatePipeline = this.createPipeline(module, consumePipelineLayout, "generate_meshlet_work_candidate");
    this.prepareValidationPipeline = this.createPipeline(module, writePipelineLayout, "prepare_meshlet_work_validation");
    this.validatePipeline = this.createPipeline(module, consumePipelineLayout, "validate_meshlet_work_candidate");
    this.publishPipeline = this.createPipeline(module, consumePipelineLayout, "publish_meshlet_work_candidate_counters");
  }

  prepare(inputs: MeshletWorkCandidateInputs): PreparedMeshletWorkCandidate {
    this.assertAlive();
    assertPositiveU32(inputs.visibleClusterCapacity, "visible Cluster capacity");
    assertPositiveU32(inputs.capacity, "MeshletWork capacity");
    const queueBytes = gpuMeshletWorkQueueByteLength(inputs.capacity);
    if (queueBytes > Number(this.device.limits.maxStorageBufferBindingSize)) {
      throw new RangeError(
        `MeshletWork candidate queue requires ${queueBytes} bytes but maxStorageBufferBindingSize is ${this.device.limits.maxStorageBufferBindingSize}`
      );
    }
    const buffers: GPUBuffer[] = [];
    const accounting: AccountingResourceHandle[] = [];
    try {
      const settings = this.createBuffer({
        label: "ADR-0008 MeshletWork candidate settings",
        size: MESHLET_WORK_CANDIDATE_SETTINGS_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      }, buffers, accounting, "uniform");
      const queue = this.createBuffer({
        label: "ADR-0008 correctness-critical MeshletWork candidate queue",
        size: queueBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      }, buffers, accounting, "work-queue");
      const dispatch = this.createBuffer({
        label: "ADR-0008 MeshletWork candidate dispatchIndirect",
        size: GPU_DISPATCH_INDIRECT_ARGS_SIZE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST
      }, buffers, accounting, "indirect");
      this.device.queue.writeBuffer(queue, 0, packGpuMeshletWorkQueueHeader({
        attemptedCount: 0,
        writtenCount: 0,
        consumedCount: 0,
        capacity: inputs.capacity,
        overflowCount: 0,
        generation: 0,
        invalidCount: 0
      }));
      this.device.queue.writeBuffer(dispatch, 0, new Uint32Array([0, 1, 1]));
      this.writeSettings(settings, inputs.countersEnabled);
      const fixedInputs = Object.freeze({
        visibleClusters: inputs.visibleClusters,
        visibleClusterCapacity: inputs.visibleClusterCapacity,
        capacity: inputs.capacity,
        assets: inputs.assets,
        scene: inputs.scene
      });
      const bindGroups = this.createBindGroups(fixedInputs, queue, dispatch, settings, inputs.counterBuffer);
      const prepared = Object.freeze({
        [PREPARED_MESHLET_WORK_CANDIDATE]: true as const,
        queue,
        capacity: inputs.capacity
      });
      CANDIDATE_STATE.set(prepared, {
        counterBuffer: inputs.counterBuffer,
        countersEnabled: inputs.countersEnabled,
        settings,
        queue,
        dispatch,
        writeBindGroup: bindGroups.write,
        consumeBindGroup: bindGroups.consume,
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
    binding: { counterBuffer: GPUBuffer; countersEnabled: boolean }
  ): void {
    const state = this.requireState(prepared);
    if (state.counterBuffer === binding.counterBuffer &&
      state.countersEnabled === binding.countersEnabled) return;
    state.counterBuffer = binding.counterBuffer;
    state.countersEnabled = binding.countersEnabled;
    this.writeSettings(state.settings, binding.countersEnabled);
    const bindGroups = this.createBindGroups(
      state.inputs,
      state.queue,
      state.dispatch,
      state.settings,
      state.counterBuffer
    );
    state.writeBindGroup = bindGroups.write;
    state.consumeBindGroup = bindGroups.consume;
  }

  encode(
    command: ShadeGPUCommandContext,
    prepared: PreparedMeshletWorkCandidate
  ): void {
    const state = this.requireState(prepared);
    this.encodeDirect(command.gpu_encoder, "prepare", this.preparePipeline, state.writeBindGroup, false);
    this.encodeDirect(command.gpu_encoder, "generate", this.generatePipeline, state.consumeBindGroup, true, state.dispatch);
    this.encodeDirect(command.gpu_encoder, "prepare validation", this.prepareValidationPipeline, state.writeBindGroup, false);
    this.encodeDirect(command.gpu_encoder, "validate", this.validatePipeline, state.consumeBindGroup, true, state.dispatch);
    this.encodeDirect(command.gpu_encoder, "publish counters", this.publishPipeline, state.consumeBindGroup, false);
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

  private createBindGroups(
    inputs: CandidateState["inputs"],
    queue: GPUBuffer,
    dispatch: GPUBuffer,
    settings: GPUBuffer,
    counters: GPUBuffer
  ): Readonly<{ write: GPUBindGroup; consume: GPUBindGroup }> {
    const commonEntries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: inputs.visibleClusters } },
        { binding: 1, resource: { buffer: inputs.assets.clusterRecords } },
        { binding: 2, resource: { buffer: inputs.assets.geometryRecords } },
        { binding: 3, resource: { buffer: inputs.assets.meshletRecords } },
        { binding: 4, resource: { buffer: queue } },
        { binding: 6, resource: { buffer: settings } },
        { binding: 7, resource: { buffer: counters } }
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
      0,
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

function assertPositiveU32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffffffff) {
    throw new RangeError(`${label} must be a positive u32`);
  }
}

import type { ResourceAccounting, ResourceHandle } from "../../debug/profiling/ResourceAccounting.js";
import { writeGpuBuffer } from "../../gpu/GpuQueueEvidence.js";
import { FRAME_GEOMETRY_MESHLET_STRIDE, WINNER_COEFFICIENT_STRIDE, WINNER_CONTROL_STRIDE,
  WINNER_DICTIONARY_STRIDE, WINNER_INDIRECT_STRIDE } from "../../gpu/GpuWinnerInterpolationAbi.js";
import { WINNER_SETTINGS_SIZE, WINNER_WORKGROUP_SIZE, winnerPrimitiveWorkWgsl } from "../../shaders/winner_primitive_work.js";
import { gpuStorageRange, requireDisjointStorageRanges, type GpuStorageInput, type GpuStorageRange } from "../../gpu/GpuStorageRange.js";

export interface SharedClipGeometry {
  /** GPU-produced header + one directory entry per MeshletWork slot. */
  readonly directory: GpuStorageInput;
  readonly clips: GpuStorageInput;
  /** One packed local-u8 triangle per u32. */
  readonly triangles: GpuStorageInput;
}
export interface WinnerInterpolationStorage {
  readonly dictionary: GpuStorageInput;
  readonly coefficients: GpuStorageInput;
  readonly work: GpuStorageInput;
  readonly control: GpuStorageInput;
}
export interface WinnerInterpolationAllocation {
  readonly settings: GPUBuffer;
  readonly dictionary: GpuStorageRange;
  readonly coefficients: GpuStorageRange;
  readonly control: GpuStorageRange;
  readonly geometry: { readonly directory: GpuStorageRange; readonly clips: GpuStorageRange; readonly triangles: GpuStorageRange };
  readonly dictionaryCapacity: number;
  readonly coefficientCapacity: number;
  readonly byteLength: number;
  /** Includes borrowed task/output spans, excluding alignment and input geometry. */
  readonly workingByteLength: number;
}
export interface WinnerInterpolationBudget {
  readonly dictionaryCapacity: number;
  readonly coefficientCapacity: number;
  readonly probeLimit: number;
  readonly maxBytes: number;
}

interface State {
  readonly allocation: WinnerInterpolationAllocation;
  readonly work: GpuStorageRange;
  readonly group: GPUBindGroup;
  readonly indirectGroup: GPUBindGroup;
  readonly indirect: GPUBuffer;
  readonly buffers: readonly GPUBuffer[];
  readonly handles: readonly ResourceHandle[];
  readonly width: number;
  readonly height: number;
}
const ENTRIES = ["winner_reset", "winner_request", "winner_finalize", "winner_build"] as const;

/** Frame-local, GPU-demanded interpolation data. Preparation owns bounded buffers;
 * encode adds commands to the caller encoder without creating/submitting one.
 * Stable frames reuse every pipeline, bind group and allocation. No CPU visible list.
 * This component does not own resident attributes or source-domain LOD mapping. */
export class WinnerPrimitiveInterpolation {
  private readonly states = new Map<WinnerInterpolationAllocation, State>();
  private destroyed = false;
  private constructor(private readonly device: GPUDevice, private readonly layout: GPUBindGroupLayout,
    private readonly indirectLayout: GPUBindGroupLayout, private readonly pipelines: readonly GPUComputePipeline[], private readonly accounting?: ResourceAccounting,
    private readonly maxBytes = 256 * 1024 * 1024) {
    void device.lost.then(() => this.destroy());
  }

  static async create(device: GPUDevice, options: {
    readonly observe?: boolean;
    readonly accounting?: ResourceAccounting;
    readonly maxBytes?: number;
  } = {}): Promise<WinnerPrimitiveInterpolation> {
    if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0)) {
      throw new RangeError("Invalid winner interpolation owner budget");
    }
    if (device.limits.maxStorageBuffersPerShaderStage < 8 || device.limits.maxBindingsPerBindGroup < 9 || device.limits.maxBindGroups < 2 ||
      device.limits.maxComputeInvocationsPerWorkgroup < WINNER_WORKGROUP_SIZE ||
      device.limits.maxComputeWorkgroupSizeX < WINNER_WORKGROUP_SIZE || device.limits.maxComputeWorkgroupSizeY < 8) {
      throw new RangeError("Winner interpolation requires eight storage bindings and 64-lane workgroups");
    }
    const layout = device.createBindGroupLayout({ label: "Surface winner interpolation layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: WINNER_SETTINGS_SIZE } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint", viewDimension: "2d" } },
      // WebGPU usage scopes cover whole buffers. Arena inputs are logically
      // read-only, but every arena view in this dispatch must use Storage.
      ...[2, 3, 4, 5, 6, 7, 8].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" as GPUBufferBindingType } }))
    ] });
    const module = device.createShaderModule({ label: "Surface HomogeneousWinnerInterpolation", code: winnerPrimitiveWorkWgsl(options.observe ?? false) });
    const indirectLayout = device.createBindGroupLayout({ label: "Surface winner indirect producer layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: WINNER_INDIRECT_STRIDE } }
    ] });
    const regularLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const finalizeLayout = device.createPipelineLayout({ bindGroupLayouts: [layout, indirectLayout] });
    const pipelines = await Promise.all(ENTRIES.map((entryPoint, i) => device.createComputePipelineAsync({
      label: `Surface/${entryPoint}`, layout: i === 2 ? finalizeLayout : regularLayout, compute: { module, entryPoint }
    })));
    return new WinnerPrimitiveInterpolation(device, layout, indirectLayout, pipelines, options.accounting, options.maxBytes);
  }

  prepare(input: { readonly geometry: SharedClipGeometry; readonly visibility: GPUTextureView;
    readonly width: number; readonly height: number; readonly budget: WinnerInterpolationBudget;
    /** Borrowed from the sole frame arena owner; dedicated storage is useful
     * for standalone diagnostics of the same algorithm. */
    readonly storage?: WinnerInterpolationStorage;
  }): WinnerInterpolationAllocation {
    this.requireAlive();
    const { width, height, budget } = input;
    const { dictionaryCapacity: dictionary, coefficientCapacity: coefficients, probeLimit } = budget;
    const limit = this.device.limits;
    if (![width, height, dictionary, coefficients, probeLimit, budget.maxBytes].every(value => Number.isSafeInteger(value) && value > 0) ||
      width > limit.maxTextureDimension2D || height > limit.maxTextureDimension2D || width * height > 0xffffffff ||
      dictionary > 0x40000000 || (dictionary & (dictionary - 1)) !== 0 || coefficients > dictionary || probeLimit > dictionary) {
      throw new RangeError("Invalid winner interpolation extent or bounded dictionary budget");
    }
    const sizes = [WINNER_SETTINGS_SIZE, dictionary * WINNER_DICTIONARY_STRIDE, coefficients * WINNER_COEFFICIENT_STRIDE,
      WINNER_CONTROL_STRIDE, coefficients * 4, WINNER_INDIRECT_STRIDE] as const;
    let workingBytes = sizes.reduce((a, b) => a + b, 0);
    const bytes = input.storage ? WINNER_SETTINGS_SIZE + WINNER_INDIRECT_STRIDE : workingBytes;
    const allocatedBytes = Array.from(this.states.keys()).reduce((sum, a) => sum + a.byteLength, 0);
    if (workingBytes > budget.maxBytes || bytes + allocatedBytes > this.maxBytes || sizes.some(size => size > limit.maxBufferSize) ||
      sizes.slice(1).some(size => size > limit.maxStorageBufferBindingSize)) {
      throw new RangeError("Winner interpolation exceeds byte or storage binding budget");
    }
    const geometry = Object.freeze({
      directory: gpuStorageRange(input.geometry.directory, limit, 16 + FRAME_GEOMETRY_MESHLET_STRIDE, "Winner directory"),
      clips: gpuStorageRange(input.geometry.clips, limit, 16, "Winner clips"),
      triangles: gpuStorageRange(input.geometry.triangles, limit, 4, "Winner triangles")
    });
    requireDisjointStorageRanges([], Object.values(geometry));
    const borrowed = input.storage && Object.freeze({
      dictionary: gpuStorageRange(input.storage.dictionary, limit, sizes[1], "Winner dictionary"),
      coefficients: gpuStorageRange(input.storage.coefficients, limit, sizes[2], "Winner coefficients"),
      control: gpuStorageRange(input.storage.control, limit, sizes[3], "Winner control"),
      work: gpuStorageRange(input.storage.work, limit, sizes[4], "Winner compact work")
    });
    if (borrowed) {
      workingBytes = Object.values(borrowed).reduce((sum, range) => sum + range.size, WINNER_SETTINGS_SIZE + WINNER_INDIRECT_STRIDE);
      if (workingBytes > budget.maxBytes) throw new RangeError("Borrowed winner storage exceeds working byte budget");
      if ((borrowed.control.buffer.usage & GPUBufferUsage.COPY_DST) === 0) throw new RangeError("Winner control requires COPY_DST reset usage");
      requireDisjointStorageRanges([], [...Object.values(geometry), ...Object.values(borrowed)]);
      for (const state of this.states.values()) {
        requireDisjointStorageRanges([], [state.allocation.dictionary, state.allocation.coefficients,
          state.allocation.control, state.work, ...Object.values(borrowed)]);
      }
    }
    const resetGroups = Math.ceil(dictionary / WINNER_WORKGROUP_SIZE);
    const max = limit.maxComputeWorkgroupsPerDimension;
    if (resetGroups > max * max || Math.ceil(coefficients / WINNER_WORKGROUP_SIZE) > max * max ||
      Math.ceil(width / 8) > max || Math.ceil(height / 8) > max) {
      throw new RangeError("Winner interpolation dispatch exceeds negotiated workgroup limits");
    }
    const buffers: GPUBuffer[] = [], handles: ResourceHandle[] = [];
    const make = (label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer => {
      const buffer = this.device.createBuffer({ label, size, usage }); buffers.push(buffer);
      const handle = this.accounting?.created({ kind: "buffer", category: "work-cache", owner: "Surface/WinnerPrimitiveInterpolation", bytes: size, label });
      if (handle) handles.push(handle);
      return buffer;
    };
    try {
      const settings = make("Surface winner settings", sizes[0], GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      const owned = (label: string, size: number, usage: GPUBufferUsageFlags) => Object.freeze({ buffer: make(label, size, usage), offset: 0, size });
      const dictionaryBuffer = borrowed?.dictionary ?? owned("Surface winner dictionary", sizes[1], GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      const coefficientBuffer = borrowed?.coefficients ?? owned("Surface winner coefficients", sizes[2], GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      const control = borrowed?.control ?? owned("Surface winner control", sizes[3], GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
      const work = borrowed?.work ?? owned("Surface winner compact work", sizes[4], GPUBufferUsage.STORAGE);
      const indirect = make("Surface winner indirect dispatch", sizes[5], GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC);
      const indirectGroup = this.device.createBindGroup({ layout: this.indirectLayout, entries: [{ binding: 0, resource: { buffer: indirect } }] });
      writeGpuBuffer(this.device.queue, "Surface/winner-settings", settings, 0,
        new Uint32Array([width, height, dictionary, coefficients, probeLimit, max, 0, 0, 0, 0, 0, 0]));
      const group = this.device.createBindGroup({ label: "Surface winner frame bindings", layout: this.layout, entries: [
        { binding: 0, resource: { buffer: settings } }, { binding: 1, resource: input.visibility },
        ...[geometry.directory, geometry.clips, geometry.triangles, dictionaryBuffer, work, coefficientBuffer, control]
          .map((range, i) => ({ binding: i + 2, resource: range }))
      ] });
      const allocation = Object.freeze({ settings, dictionary: dictionaryBuffer, coefficients: coefficientBuffer, control,
        geometry, dictionaryCapacity: dictionary, coefficientCapacity: coefficients, byteLength: bytes, workingByteLength: workingBytes });
      this.states.set(allocation, { allocation, work, group, indirectGroup, indirect, buffers, handles, width, height });
      return allocation;
    } catch (error) {
      for (const buffer of buffers) buffer.destroy();
      for (const handle of handles) this.accounting?.destroyed(handle);
      throw error;
    }
  }

  encode(encoder: GPUCommandEncoder, allocation: WinnerInterpolationAllocation): void {
    this.requireAlive();
    const state = this.require(allocation);
    encoder.clearBuffer(allocation.control.buffer, allocation.control.offset, allocation.control.size);
    const groups = Math.ceil(allocation.dictionaryCapacity / WINNER_WORKGROUP_SIZE);
    const x = Math.min(groups, this.device.limits.maxComputeWorkgroupsPerDimension);
    for (let stage = 0; stage < ENTRIES.length; stage++) {
      const pass = encoder.beginComputePass({ label: `Surface/${ENTRIES[stage]}` });
      pass.setPipeline(this.pipelines[stage]!); pass.setBindGroup(0, state.group);
      if (stage === 0) pass.dispatchWorkgroups(x, Math.ceil(groups / x));
      else if (stage === 1) pass.dispatchWorkgroups(Math.ceil(state.width / 8), Math.ceil(state.height / 8));
      else if (stage === 2) { pass.setBindGroup(1, state.indirectGroup); pass.dispatchWorkgroups(1); }
      else pass.dispatchWorkgroupsIndirect(state.indirect, 0);
      pass.end();
    }
  }

  /** Call only after the allocation's final encoded consumer has completed (or
   * its unsubmitted transaction was aborted). GPU buffers are never reusable leases. */
  release(allocation: WinnerInterpolationAllocation): void {
    if (this.destroyed) return;
    const state = this.require(allocation);
    this.states.delete(allocation);
    for (const buffer of state.buffers) buffer.destroy();
    for (const handle of state.handles) this.accounting?.destroyed(handle);
  }
  destroy(): void {
    if (this.destroyed) return;
    for (const allocation of this.states.keys()) this.release(allocation);
    this.destroyed = true;
  }
  private require(allocation: WinnerInterpolationAllocation): State {
    const state = this.states.get(allocation);
    if (!state) throw new Error("Winner interpolation allocation is stale or foreign");
    return state;
  }
  private requireAlive(): void {
    if (this.destroyed) throw new Error("Winner interpolation owner is destroyed");
  }
}

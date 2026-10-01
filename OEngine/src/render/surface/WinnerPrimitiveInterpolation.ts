import type { ResourceAccounting, ResourceHandle } from "../../debug/profiling/ResourceAccounting.js";
import { writeGpuBuffer } from "../../gpu/GpuQueueEvidence.js";
import { FRAME_GEOMETRY_MESHLET_STRIDE, WINNER_COEFFICIENT_STRIDE, WINNER_CONTROL_STRIDE,
  WINNER_DICTIONARY_STRIDE, WINNER_INDIRECT_STRIDE } from "../../gpu/GpuWinnerInterpolationAbi.js";
import { WINNER_SETTINGS_SIZE, WINNER_WORKGROUP_SIZE, winnerPrimitiveWorkWgsl } from "../../shaders/winner_primitive_work.js";

export interface SharedClipGeometry {
  /** GPU-produced header + one directory entry per MeshletWork slot. */
  readonly directory: GPUBuffer;
  readonly clips: GPUBuffer;
  /** One packed local-u8 triangle per u32. */
  readonly triangles: GPUBuffer;
}
export interface WinnerInterpolationAllocation {
  readonly settings: GPUBuffer;
  readonly dictionary: GPUBuffer;
  readonly coefficients: GPUBuffer;
  readonly control: GPUBuffer;
  readonly geometry: SharedClipGeometry;
  readonly dictionaryCapacity: number;
  readonly coefficientCapacity: number;
  readonly byteLength: number;
}
export interface WinnerInterpolationBudget {
  readonly dictionaryCapacity: number;
  readonly coefficientCapacity: number;
  readonly probeLimit: number;
  readonly maxBytes: number;
}

interface State {
  readonly allocation: WinnerInterpolationAllocation;
  readonly work: GPUBuffer;
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
    private readonly indirectLayout: GPUBindGroupLayout, private readonly pipelines: readonly GPUComputePipeline[], private readonly accounting?: ResourceAccounting) {
    void device.lost.then(() => this.destroy());
  }

  static async create(device: GPUDevice, options: {
    readonly observe?: boolean;
    readonly accounting?: ResourceAccounting;
  } = {}): Promise<WinnerPrimitiveInterpolation> {
    if (device.limits.maxStorageBuffersPerShaderStage < 8 || device.limits.maxBindingsPerBindGroup < 9 || device.limits.maxBindGroups < 2 ||
      device.limits.maxComputeInvocationsPerWorkgroup < WINNER_WORKGROUP_SIZE ||
      device.limits.maxComputeWorkgroupSizeX < WINNER_WORKGROUP_SIZE || device.limits.maxComputeWorkgroupSizeY < 8) {
      throw new RangeError("Winner interpolation requires eight storage bindings and 64-lane workgroups");
    }
    const layout = device.createBindGroupLayout({ label: "Surface winner interpolation layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: WINNER_SETTINGS_SIZE } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint", viewDimension: "2d" } },
      ...[2, 3, 4].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "read-only-storage" as GPUBufferBindingType } })),
      ...[5, 6, 7, 8].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE,
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
    return new WinnerPrimitiveInterpolation(device, layout, indirectLayout, pipelines, options.accounting);
  }

  prepare(input: { readonly geometry: SharedClipGeometry; readonly visibility: GPUTextureView;
    readonly width: number; readonly height: number; readonly budget: WinnerInterpolationBudget;
  }): WinnerInterpolationAllocation {
    this.requireAlive();
    const { width, height, geometry, budget } = input;
    const { dictionaryCapacity: dictionary, coefficientCapacity: coefficients, probeLimit } = budget;
    const limit = this.device.limits;
    if (![width, height, dictionary, coefficients, probeLimit, budget.maxBytes].every(value => Number.isSafeInteger(value) && value > 0) ||
      width > limit.maxTextureDimension2D || height > limit.maxTextureDimension2D || width * height > 0xffffffff ||
      dictionary > 0x40000000 || (dictionary & (dictionary - 1)) !== 0 || coefficients > dictionary || probeLimit > dictionary) {
      throw new RangeError("Invalid winner interpolation extent or bounded dictionary budget");
    }
    const sizes = [WINNER_SETTINGS_SIZE, dictionary * WINNER_DICTIONARY_STRIDE, coefficients * WINNER_COEFFICIENT_STRIDE,
      WINNER_CONTROL_STRIDE, coefficients * 4, WINNER_INDIRECT_STRIDE] as const;
    const bytes = sizes.reduce((a, b) => a + b, 0);
    if (bytes > budget.maxBytes || sizes.some(size => size > limit.maxBufferSize) ||
      sizes.slice(1).some(size => size > limit.maxStorageBufferBindingSize)) {
      throw new RangeError("Winner interpolation exceeds byte or storage binding budget");
    }
    if (geometry.directory.size < 16 + FRAME_GEOMETRY_MESHLET_STRIDE || geometry.clips.size < 16 || geometry.triangles.size < 4 ||
      [geometry.directory, geometry.clips, geometry.triangles].some(buffer => buffer.size > limit.maxStorageBufferBindingSize ||
        (buffer.usage & GPUBufferUsage.STORAGE) === 0)) {
      throw new RangeError("Winner interpolation requires bounded shared frame geometry storage");
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
      const dictionaryBuffer = make("Surface winner dictionary", sizes[1], GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      const coefficientBuffer = make("Surface winner coefficients", sizes[2], GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      const control = make("Surface winner control", sizes[3], GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
      const work = make("Surface winner compact work", sizes[4], GPUBufferUsage.STORAGE);
      const indirect = make("Surface winner indirect dispatch", sizes[5], GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC);
      const indirectGroup = this.device.createBindGroup({ layout: this.indirectLayout, entries: [{ binding: 0, resource: { buffer: indirect } }] });
      writeGpuBuffer(this.device.queue, "Surface/winner-settings", settings, 0,
        new Uint32Array([width, height, dictionary, coefficients, probeLimit, max, 0, 0, 0, 0, 0, 0]));
      const group = this.device.createBindGroup({ label: "Surface winner frame bindings", layout: this.layout, entries: [
        { binding: 0, resource: { buffer: settings } }, { binding: 1, resource: input.visibility },
        ...[geometry.directory, geometry.clips, geometry.triangles, dictionaryBuffer, work, coefficientBuffer, control]
          .map((buffer, i) => ({ binding: i + 2, resource: { buffer } }))
      ] });
      const allocation = Object.freeze({ settings, dictionary: dictionaryBuffer, coefficients: coefficientBuffer, control,
        geometry: Object.freeze({ ...geometry }), dictionaryCapacity: dictionary, coefficientCapacity: coefficients, byteLength: bytes });
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
    encoder.clearBuffer(allocation.control);
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
    const state = this.require(allocation);
    this.states.delete(allocation);
    for (const buffer of state.buffers) buffer.destroy();
    for (const handle of state.handles) this.accounting?.destroyed(handle);
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const allocation of this.states.keys()) this.release(allocation);
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

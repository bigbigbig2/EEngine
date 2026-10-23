import {
  VSM_DIMENSIONS_WORD,
  VSM_CONTROL_WORD,
  VSM_IDENTITY_BYTE_OFFSET as VSM_ABI_IDENTITY_OFFSET,
  VSM_PROJECTION_CONSTANT_BYTES as VSM_ABI_BYTES,
} from "../../gpu/GpuVsmProjectionAbi.js";
import { PreparedComputePipeline } from "../../gpu/PreparedPipeline.js";
import { packVsmProjection, VSM_DEPTH_RANGE_BYTE_OFFSET, VSM_DEPTH_RANGE_BYTES } from "./VsmProjection.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { VSM_CASTER_RECORDS_WGSL } from "../../shaders/vsm_caster_records.js";
import type { VsmDirectionalFrameConstants } from "./VsmReceiverDemandPass.js";
import type { VsmResources } from "./VsmResources.js";
import type { VsmAllocationFrame } from "./VsmResidency.js";
import { vsmImplicitDomain } from "../../gpu/GpuVsmPairAbi.js";
import { VSM_MAX_RESIDENT_SLOTS } from "./VsmCapabilities.js";

export interface VsmCasterRecordInputs {
  readonly allocation: VsmAllocationFrame;
  readonly meshletWork: ResourceId;
  readonly meshletBounds: ResourceId;
  readonly resources: VsmResources;
  readonly frame: VsmDirectionalFrameConstants;
  readonly depthRange: ResourceId;
  readonly generation: number;
  readonly workCapacity: number;
}

export interface VsmCasterRecordFrame {
  /** Same complete-page list consumed by clear, raster and content commit. */
  readonly allocation: ResourceId;
  readonly casterRecords: ResourceId;
  readonly rasterIndirect: ResourceId;
  readonly generation: number;
  readonly capacity: number;
  readonly meshletWork: ResourceId;
  readonly meshletBounds: ResourceId;
  readonly workCapacity: number;
}

const CONSTANT_BYTES = VSM_ABI_BYTES;

export function vsmCasterDispatch(capacity: number, dimension: number): readonly [number, number] {
  const groups = Math.ceil(capacity / 64);
  if (
    !Number.isSafeInteger(capacity) ||
    capacity <= 0 ||
    capacity > 0xffffffff ||
    !Number.isSafeInteger(dimension) ||
    dimension <= 0 ||
    groups > dimension ** 2
  ) {
    throw new RangeError("VSM caster work exceeds the negotiated 2D dispatch grid");
  }
  return [Math.min(groups, dimension), Math.ceil(groups / dimension)];
}

function packConstants(input: VsmCasterRecordInputs): ArrayBuffer {
  const data = packVsmProjection(input.frame);
  const uints = new Uint32Array(data);
  const profile = input.resources.capabilities;
  uints.set([profile.virtualPagesPerAxis, profile.pageSize, profile.border, profile.atlasDimension], VSM_DIMENSIONS_WORD);
  uints.set(
    [
      input.generation >>> 0,
      input.workCapacity >>> 0,
      profile.casterRecordCapacity >>> 0,
      profile.residentSlots >>> 0,
    ],
    VSM_CONTROL_WORD,
  );
  uints[VSM_ABI_IDENTITY_OFFSET / 4 + 3] = input.resources.capabilities.limits.maxComputeWorkgroupsPerDimension;
  return data;
}

/** GPU-only mapping from bounded MeshletWork to dirty VSM pages. */
export class VsmCasterRecordPass {
  async preparePipelines(): Promise<void> {
    await Promise.all([
      this.casterPipeline.prepare(),
      this.countPipeline.prepare(),
      this.selectPipeline.prepare(),
      this.preparePipeline.prepare(),
      this.finalizePipeline.prepare(),
    ]);
  }

  private readonly constants: GPUBuffer;
  private readonly casterLayout: GPUBindGroupLayout;
  private readonly mainLayout: GPUBindGroupLayout;
  private readonly preparePipeline: PreparedComputePipeline;
  private readonly casterPipeline: PreparedComputePipeline;
  private readonly countPipeline: PreparedComputePipeline;
  private readonly selectPipeline: PreparedComputePipeline;
  private readonly pageCounts: GPUBuffer;
  private readonly finalizePipeline: PreparedComputePipeline;
  private bindings: Readonly<{
    buffers: readonly GPUBuffer[];
    full: GPUBindGroup;
    main: GPUBindGroup;
  }> | null = null;

  constructor(private readonly device: GPUDevice) {
    const countBytes = VSM_MAX_RESIDENT_SLOTS * 16;
    if (countBytes > Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize)) {
      throw new RangeError("VSM complete page counts exceed negotiated buffer capacity");
    }
    this.pageCounts = device.createBuffer({
      label: "VSM/complete page pair counts",
      size: countBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.constants = device.createBuffer({
      label: "VSM/caster constants",
      size: CONSTANT_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.casterLayout = device.createBindGroupLayout({
      label: "VSM/caster records layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    this.mainLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        ...[2, 3, 4].map((binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" as const },
        })),
        ...[1, 5, 6, 8].map((binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" as const },
        })),
      ],
    });
    const module = device.createShaderModule({
      label: "VSM/caster records WGSL",
      code: VSM_CASTER_RECORDS_WGSL,
    });
    this.casterPipeline = new PreparedComputePipeline(device, {
      label: "VSM/caster records",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.mainLayout] }),
      compute: { module, entryPoint: "main" },
    });
    this.countPipeline = new PreparedComputePipeline(device, {
      label: "VSM/count complete page pairs",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.mainLayout] }),
      compute: { module, entryPoint: "main", constants: { count_only: 1 } },
    });
    this.selectPipeline = new PreparedComputePipeline(device, {
      label: "VSM/select complete page pairs",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.casterLayout] }),
      compute: { module, entryPoint: "select_complete_pages" },
    });
    this.preparePipeline = new PreparedComputePipeline(device, {
      label: "VSM/prepare actual pair dispatch",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.casterLayout] }),
      compute: { module, entryPoint: "prepare_pairs" },
    });
    this.finalizePipeline = new PreparedComputePipeline(device, {
      label: "VSM/fixed raster indirect",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.casterLayout] }),
      compute: { module, entryPoint: "finalize_indirect" },
    });
  }

  private bindingGroups(buffers: readonly GPUBuffer[]): Readonly<{ full: GPUBindGroup; main: GPUBindGroup }> {
    const cached = this.bindings;
    if (cached && buffers.every((buffer, index) => buffer === cached.buffers[index])) {
      return cached;
    }
    const entries = buffers.map((buffer, binding) => ({ binding, resource: { buffer } }));
    this.bindings = {
      buffers,
      full: this.device.createBindGroup({
        label: "VSM/pair prepare/finalize bindings",
        layout: this.casterLayout,
        entries,
      }),
      main: this.device.createBindGroup({
        label: "VSM/pair append bindings",
        layout: this.mainLayout,
        entries: [...entries.slice(0, 7), entries[8]!],
      }),
    };
    return this.bindings;
  }

  addToGraph(graph: FrameGraph, input: VsmCasterRecordInputs): VsmCasterRecordFrame {
    const dimension = this.device.limits.maxComputeWorkgroupsPerDimension;
    if (input.resources.capabilities.residentSlots > VSM_MAX_RESIDENT_SLOTS) {
      throw new RangeError("VSM complete page selection exceeds the negotiated profile");
    }
    vsmCasterDispatch(input.workCapacity, dimension);
    vsmImplicitDomain(input.workCapacity, input.resources.capabilities.residentSlots);
    if (input.resources.profile === "shadow-disabled")
      throw new Error("VSM caster records require an enabled profile");
    if (!Number.isSafeInteger(input.generation) || input.generation < 1 || input.generation > 0xffffffff)
      throw new RangeError("VSM caster generation is invalid");
    const casterBuffer = input.resources.casterRecords;
    const indirectBuffer = input.resources.rasterIndirect;
    const telemetryBuffer = input.resources.overflowCounters;
    if (!casterBuffer || !indirectBuffer || !telemetryBuffer)
      throw new Error("VSM caster buffers are unavailable");
    const constants = graph.import_resource(
      "VSM/caster constants",
      { kind: "imported", label: "VSM caster constants" },
      this.constants,
    );
    const allocation = input.allocation.allocation;
    const pageTable = input.allocation.pageTable;
    const work = input.meshletWork;
    const bounds = input.meshletBounds;
    const caster = graph.import_resource(
      "VSM/caster records",
      { kind: "imported", label: "VSM caster records" },
      casterBuffer,
    );
    const indirect = graph.import_resource(
      "VSM/raster indirect",
      { kind: "imported", label: "VSM fixed raster indirect" },
      indirectBuffer,
    );
    const telemetry = graph.import_resource(
      "VSM/caster telemetry",
      { kind: "imported", label: "VSM overflow telemetry" },
      telemetryBuffer,
    );
    const pageCounts = graph.import_resource(
      "VSM/complete page counts",
      { kind: "imported" },
      this.pageCounts,
    );
    const update = graph.add("VSM/update caster constants", input, (data, _resources, context) => {
      (context.encoder as ShadeGPUCommandContext).writeBuffer(
        this.constants,
        0,
        packConstants(data),
        0,
        CONSTANT_BYTES,
      );
      (context.encoder as ShadeGPUCommandContext).copyBufferToBuffer(
        _resources.get(data.depthRange) as GPUBuffer,
        0,
        this.constants,
        VSM_DEPTH_RANGE_BYTE_OFFSET,
        VSM_DEPTH_RANGE_BYTES,
      );
    });
    update.read(input.depthRange);
    const currentConstants = update.write(constants);
    const produce = graph.add("VSM/caster records", input, (data, resolved, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const casterGpu = resolved.get(caster) as GPUBuffer;
      const telemetryGpu = resolved.get(telemetry) as GPUBuffer;
      // Allocation owns words 0..3 and the pending backlog in word 7.
      // Reset only caster excess/failure/mode; selection adds deferred pages
      // to the existing backlog rather than erasing the allocator's remainder.
      command.clearBuffer(telemetryGpu, 16, 12);
      command.clearBuffer(this.pageCounts);
      const groups = this.bindingGroups([
        resolved.get(currentConstants) as GPUBuffer,
        resolved.get(allocation) as GPUBuffer,
        resolved.get(pageTable) as GPUBuffer,
        resolved.get(work) as GPUBuffer,
        resolved.get(bounds) as GPUBuffer,
        casterGpu,
        telemetryGpu,
        resolved.get(indirect) as GPUBuffer,
        this.pageCounts,
      ]);
      const prepare = command.beginComputePass({ label: "VSM/prepare actual pair dispatch" });
      prepare.setPipeline(this.preparePipeline.requirePrepared());
      prepare.setBindGroup(0, groups.full);
      prepare.dispatchWorkgroups(1);
      prepare.end();
      const count = command.beginComputePass({ label: "VSM/count complete page pairs" });
      count.setPipeline(this.countPipeline.requirePrepared());
      count.setBindGroup(0, groups.main);
      count.dispatchWorkgroupsIndirect(resolved.get(indirect) as GPUBuffer, 0);
      count.end();
      const select = command.beginComputePass({ label: "VSM/select complete page pairs" });
      select.setPipeline(this.selectPipeline.requirePrepared());
      select.setBindGroup(0, groups.full);
      select.dispatchWorkgroups(1);
      select.end();
      const pass = command.beginComputePass({ label: "VSM/compact pairs" });
      pass.setPipeline(this.casterPipeline.requirePrepared());
      pass.setBindGroup(0, groups.main);
      pass.dispatchWorkgroupsIndirect(resolved.get(indirect) as GPUBuffer, 0);
      pass.end();
    });
    produce.read(currentConstants);
    produce.read(allocation);
    produce.read(pageTable);
    produce.read(work);
    produce.read(bounds);
    const producedCaster = produce.write(caster);
    const producedTelemetry = produce.write(telemetry);
    const preparedIndirect = produce.write(indirect);
    produce.make_side_effect();
    const selectedAllocation = produce.write(allocation);
    const countedPages = produce.write(pageCounts);
    const finalize = graph.add("VSM/finalize raster indirect", {}, (_data, resolved, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const groups = this.bindingGroups([
        resolved.get(currentConstants) as GPUBuffer,
        resolved.get(selectedAllocation) as GPUBuffer,
        resolved.get(pageTable) as GPUBuffer,
        resolved.get(work) as GPUBuffer,
        resolved.get(bounds) as GPUBuffer,
        resolved.get(producedCaster) as GPUBuffer,
        resolved.get(producedTelemetry) as GPUBuffer,
        resolved.get(preparedIndirect) as GPUBuffer,
        this.pageCounts,
      ]);
      const pass = command.beginComputePass({ label: "VSM/finalize raster indirect" });
      pass.setPipeline(this.finalizePipeline.requirePrepared());
      pass.setBindGroup(0, groups.full);
      pass.dispatchWorkgroups(1);
      pass.end();
    });
    finalize.read(currentConstants);
    finalize.read(selectedAllocation);
    finalize.read(producedCaster);
    finalize.read(preparedIndirect);
    finalize.read(pageTable);
    finalize.read(work);
    finalize.read(bounds);
    finalize.read(countedPages);
    const completeCaster = finalize.write(producedCaster);
    finalize.write(producedTelemetry);
    const producedIndirect = finalize.write(preparedIndirect);
    finalize.make_side_effect();
    return {
      allocation: selectedAllocation,
      casterRecords: completeCaster,
      rasterIndirect: producedIndirect,
      generation: input.generation,
      capacity: input.resources.capabilities.casterRecordCapacity,
      meshletWork: work,
      meshletBounds: bounds,
      get workCapacity() {
        return input.workCapacity;
      },
    };
  }

  destroy(): void {
    this.bindings = null;
    this.constants.destroy();
    this.pageCounts.destroy();
  }
}

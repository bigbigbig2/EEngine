import { packVsmProjection, VSM_DEPTH_RANGE_BYTE_OFFSET, VSM_DEPTH_RANGE_BYTES } from "./VsmProjection.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { VSM_CASTER_RECORDS_WGSL } from "../../shaders/vsm_caster_records.js";
import type { VsmDirectionalFrameConstants } from "./VsmReceiverDemandPass.js";
import type { VsmResources } from "./VsmResources.js";
import type { VsmAllocationFrame } from "./VsmResidency.js";
import { vsmImplicitDomain } from "../../gpu/GpuVsmPairAbi.js";

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
  readonly casterRecords: ResourceId;
  readonly rasterIndirect: ResourceId;
  readonly generation: number;
  readonly capacity: number;
  readonly meshletWork: ResourceId;
  readonly meshletBounds: ResourceId;
  readonly workCapacity: number;
}

const CONSTANT_BYTES = 256;

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
  uints.set([profile.virtualPagesPerAxis, profile.pageSize, profile.border, profile.atlasDimension], 40);
  uints.set(
    [
      input.generation >>> 0,
      input.workCapacity >>> 0,
      profile.casterRecordCapacity >>> 0,
      profile.residentSlots >>> 0,
    ],
    44,
  );
  uints[59] = input.resources.capabilities.limits.maxComputeWorkgroupsPerDimension;
  return data;
}

/** GPU-only mapping from bounded MeshletWork to dirty VSM pages. */
export class VsmCasterRecordPass {
  private readonly constants: GPUBuffer;
  private readonly casterLayout: GPUBindGroupLayout;
  private readonly mainLayout: GPUBindGroupLayout;
  private readonly preparePipeline: GPUComputePipeline;
  private readonly casterPipeline: GPUComputePipeline;
  private readonly finalizePipeline: GPUComputePipeline;
  private bindings: Readonly<{
    buffers: readonly GPUBuffer[];
    full: GPUBindGroup;
    main: GPUBindGroup;
  }> | null = null;

  constructor(private readonly device: GPUDevice) {
    this.constants = device.createBuffer({
      label: "VSM/caster constants",
      size: CONSTANT_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.casterLayout = device.createBindGroupLayout({
      label: "VSM/caster records layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    this.mainLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        ...[1, 2, 3, 4].map((binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" as const },
        })),
        ...[5, 6].map((binding) => ({
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
    this.casterPipeline = device.createComputePipeline({
      label: "VSM/caster records",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.mainLayout] }),
      compute: { module, entryPoint: "main" },
    });
    this.preparePipeline = device.createComputePipeline({
      label: "VSM/prepare actual pair dispatch",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.casterLayout] }),
      compute: { module, entryPoint: "prepare_pairs" },
    });
    this.finalizePipeline = device.createComputePipeline({
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
        entries: entries.slice(0, 7),
      }),
    };
    return this.bindings;
  }

  addToGraph(graph: FrameGraph, input: VsmCasterRecordInputs): VsmCasterRecordFrame {
    const dimension = this.device.limits.maxComputeWorkgroupsPerDimension;
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
      // The first 16 bytes are E5 allocation telemetry; E6 uses the next
      // 16-byte lane for caster/raster overflow counters.
      command.clearBuffer(telemetryGpu, 16, 16);
      const groups = this.bindingGroups([
        resolved.get(currentConstants) as GPUBuffer,
        resolved.get(allocation) as GPUBuffer,
        resolved.get(pageTable) as GPUBuffer,
        resolved.get(work) as GPUBuffer,
        resolved.get(bounds) as GPUBuffer,
        casterGpu,
        telemetryGpu,
        resolved.get(indirect) as GPUBuffer,
      ]);
      const prepare = command.beginComputePass({ label: "VSM/prepare actual pair dispatch" });
      prepare.setPipeline(this.preparePipeline);
      prepare.setBindGroup(0, groups.full);
      prepare.dispatchWorkgroups(1);
      prepare.end();
      const pass = command.beginComputePass({ label: "VSM/compact pairs" });
      pass.setPipeline(this.casterPipeline);
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
    const finalize = graph.add("VSM/finalize raster indirect", {}, (_data, resolved, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const groups = this.bindingGroups([
        resolved.get(currentConstants) as GPUBuffer,
        resolved.get(allocation) as GPUBuffer,
        resolved.get(pageTable) as GPUBuffer,
        resolved.get(work) as GPUBuffer,
        resolved.get(bounds) as GPUBuffer,
        resolved.get(producedCaster) as GPUBuffer,
        resolved.get(producedTelemetry) as GPUBuffer,
        resolved.get(preparedIndirect) as GPUBuffer,
      ]);
      const pass = command.beginComputePass({ label: "VSM/finalize raster indirect" });
      pass.setPipeline(this.finalizePipeline);
      pass.setBindGroup(0, groups.full);
      pass.dispatchWorkgroups(1);
      pass.end();
    });
    finalize.read(currentConstants);
    finalize.read(allocation);
    finalize.read(producedCaster);
    finalize.read(preparedIndirect);
    finalize.read(pageTable);
    finalize.read(work);
    finalize.read(bounds);
    const completeCaster = finalize.write(producedCaster);
    finalize.write(producedTelemetry);
    const producedIndirect = finalize.write(preparedIndirect);
    finalize.make_side_effect();
    return {
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
  }
}

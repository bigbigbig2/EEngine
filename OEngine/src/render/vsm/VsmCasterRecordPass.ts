import { packVsmProjection, VSM_DEPTH_RANGE_BYTE_OFFSET, VSM_DEPTH_RANGE_BYTES } from "./VsmProjection.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { VSM_CASTER_RECORDS_WGSL } from "../../shaders/vsm_caster_records.js";
import type { VsmDirectionalFrameConstants } from "./VsmReceiverDemandPass.js";
import type { VsmResources } from "./VsmResources.js";
import type { VsmAllocationFrame } from "./VsmResidency.js";

export interface VsmCasterRecordInputs {
  readonly allocation: VsmAllocationFrame;
  readonly meshletWork: ResourceId;
  readonly instances: ResourceId;
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
  return data;
}

/** GPU-only mapping from bounded MeshletWork to dirty VSM pages. */
export class VsmCasterRecordPass {
  private readonly constants: GPUBuffer;
  private readonly casterLayout: GPUBindGroupLayout;
  private readonly finalizeLayout: GPUBindGroupLayout;
  private readonly casterPipeline: GPUComputePipeline;
  private readonly finalizePipeline: GPUComputePipeline;

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
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    this.finalizeLayout = device.createBindGroupLayout({
      label: "VSM/raster indirect finalize layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    const module = device.createShaderModule({
      label: "VSM/caster records WGSL",
      code: VSM_CASTER_RECORDS_WGSL,
    });
    this.casterPipeline = device.createComputePipeline({
      label: "VSM/caster records",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.casterLayout] }),
      compute: { module, entryPoint: "main" },
    });
    this.finalizePipeline = device.createComputePipeline({
      label: "VSM/fixed raster indirect",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.finalizeLayout] }),
      compute: { module, entryPoint: "finalize_indirect" },
    });
  }

  addToGraph(graph: FrameGraph, input: VsmCasterRecordInputs): VsmCasterRecordFrame {
    const dimension = this.device.limits.maxComputeWorkgroupsPerDimension;
    vsmCasterDispatch(input.workCapacity, dimension);
    if (input.resources.profile === "shadow-disabled")
      throw new Error("VSM caster records require an enabled profile");
    if (!Number.isSafeInteger(input.generation) || input.generation < 0)
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
    const instances = input.instances;
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
        VSM_DEPTH_RANGE_BYTES
      );
    });
    update.read(input.depthRange);
    const currentConstants = update.write(constants);
    const produce = graph.add("VSM/caster records", input, (data, resolved, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const casterGpu = resolved.get(caster) as GPUBuffer;
      const telemetryGpu = resolved.get(telemetry) as GPUBuffer;
      command.clearBuffer(casterGpu, 0, 16);
      // The first 16 bytes are E5 allocation telemetry; E6 uses the next
      // 16-byte lane for caster/raster overflow counters.
      command.clearBuffer(telemetryGpu, 16, 16);
      const group = this.device.createBindGroup({
        label: "VSM/caster records bindings",
        layout: this.casterLayout,
        entries: [
          { binding: 0, resource: { buffer: resolved.get(currentConstants) as GPUBuffer } },
          { binding: 1, resource: { buffer: resolved.get(allocation) as GPUBuffer } },
          { binding: 2, resource: { buffer: resolved.get(pageTable) as GPUBuffer } },
          { binding: 3, resource: { buffer: resolved.get(work) as GPUBuffer } },
          { binding: 4, resource: { buffer: resolved.get(instances) as GPUBuffer } },
          { binding: 5, resource: { buffer: casterGpu } },
          { binding: 6, resource: { buffer: telemetryGpu } },
        ],
      });
      const pass = command.beginComputePass({ label: "VSM/caster records" });
      pass.setPipeline(this.casterPipeline);
      pass.setBindGroup(0, group);
      // Keep the legal capacity baseline: the extra actual-count prepare pass
      // did not establish break-even for this consumer in the G2.3 cost probe.
      const [x, y] = vsmCasterDispatch(data.workCapacity, dimension);
      pass.dispatchWorkgroups(x, y, 1);
      pass.end();
    });
    produce.read(currentConstants);
    produce.read(allocation);
    produce.read(pageTable);
    produce.read(work);
    produce.read(instances);
    const producedCaster = produce.write(caster);
    produce.write(telemetry);
    produce.make_side_effect();
    const finalize = graph.add("VSM/finalize raster indirect", {}, (_data, resolved, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const group = this.device.createBindGroup({
        label: "VSM/finalize raster indirect bindings",
        layout: this.finalizeLayout,
        entries: [
          { binding: 0, resource: { buffer: resolved.get(currentConstants) as GPUBuffer } },
          { binding: 1, resource: { buffer: resolved.get(allocation) as GPUBuffer } },
          { binding: 5, resource: { buffer: resolved.get(caster) as GPUBuffer } },
          { binding: 7, resource: { buffer: resolved.get(indirect) as GPUBuffer } },
        ],
      });
      const pass = command.beginComputePass({ label: "VSM/finalize raster indirect" });
      pass.setPipeline(this.finalizePipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
    });
    finalize.read(currentConstants);
    finalize.read(allocation);
    finalize.read(producedCaster);
    const producedIndirect = finalize.write(indirect);
    finalize.make_side_effect();
    return {
      casterRecords: producedCaster,
      rasterIndirect: producedIndirect,
      generation: input.generation,
      capacity: input.resources.capabilities.casterRecordCapacity,
    };
  }

  destroy(): void {
    this.constants.destroy();
  }
}

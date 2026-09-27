import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { VSM_ALLOCATE_PAGES_WGSL } from "../../shaders/vsm_allocate_pages.js";
import { requireResidencyBuffers, type VsmAllocationFrame } from "./VsmResidency.js";
import type { VsmResources } from "./VsmResources.js";

export interface VsmAllocatePagesInputs {
  readonly demand: ResourceId;
  readonly resources: VsmResources;
  readonly generation: number;
}

const CONSTANT_BYTES = 256;

function packConstants(input: VsmAllocatePagesInputs): ArrayBuffer {
  const capabilities = input.resources.capabilities;
  const data = new ArrayBuffer(CONSTANT_BYTES);
  new Uint32Array(data).set([
    input.generation >>> 0,
    capabilities.demandCapacity >>> 0,
    capabilities.residentSlots >>> 0,
    capabilities.clipLevels >>> 0,
    capabilities.virtualPagesPerAxis >>> 0,
    capabilities.atlasPagesPerAxis >>> 0,
    capabilities.clipLevels * capabilities.virtualPagesPerAxis ** 2,
    0
  ]);
  return data;
}

/** GPU residency owner. It never reads demand or chooses pages on the CPU. */
export class VsmAllocatePagesPass {
  private readonly constants: GPUBuffer;
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;

  constructor(private readonly device: GPUDevice) {
    this.constants = device.createBuffer({
      label: "VSM/allocation constants",
      size: CONSTANT_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.layout = device.createBindGroupLayout({ label: "VSM/allocation layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
    ] });
    this.pipeline = device.createComputePipeline({
      label: "VSM/allocate pages",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: {
        module: device.createShaderModule({ label: "VSM/allocate pages WGSL", code: VSM_ALLOCATE_PAGES_WGSL }),
        entryPoint: "main"
      }
    });
  }

  addToGraph(graph: FrameGraph, input: VsmAllocatePagesInputs): VsmAllocationFrame {
    const resources = requireResidencyBuffers(input.resources);
    if (input.resources.profile === "shadow-disabled") {
      throw new Error("VSM allocation requires an enabled profile");
    }
    if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
      throw new RangeError("VSM allocation generation is invalid");
    }
    const demandBuffer = input.resources.demand;
    if (!demandBuffer) throw new Error("VSM demand buffer is unavailable");

    const constants = graph.import_resource(
      "VSM/allocation constants", { kind: "imported", label: "VSM allocation constants" }, this.constants);
    const demand = input.demand;
    const pageTable = graph.import_resource(
      "VSM/page table allocation", { kind: "imported", label: "VSM page table" }, resources.pageTable);
    const metaTable = graph.import_resource(
      "VSM/meta table allocation", { kind: "imported", label: "VSM meta table" }, resources.metaTable);
    const allocation = graph.import_resource(
      "VSM/allocation work", { kind: "imported", label: "VSM allocation work" }, resources.allocation);
    const pageLocks = graph.import_resource(
      "VSM/page locks", { kind: "imported", label: "VSM page locks" }, resources.pageLocks);
    const slotLocks = graph.import_resource(
      "VSM/slot locks", { kind: "imported", label: "VSM slot locks" }, resources.slotLocks);
    const telemetry = graph.import_resource(
      "VSM/allocation telemetry", { kind: "imported", label: "VSM allocation telemetry" }, resources.overflowCounters);

    const update = graph.add("VSM/update allocation constants", input,
      (data, _resources, context) => {
        (context.encoder as ShadeGPUCommandContext).writeBuffer(
          this.constants, 0, packConstants(data), 0, CONSTANT_BYTES);
      });
    const currentConstants = update.write(constants);
    const produce = graph.add("VSM/allocate pages", {}, (_data, resolved, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const allocationBuffer = resolved.get(allocation) as GPUBuffer;
      const pageLocksBuffer = resolved.get(pageLocks) as GPUBuffer;
      const slotLocksBuffer = resolved.get(slotLocks) as GPUBuffer;
      const telemetryBuffer = resolved.get(telemetry) as GPUBuffer;
      command.clearBuffer(allocationBuffer, 0, 16);
      command.clearBuffer(pageLocksBuffer, 0, pageLocksBuffer.size);
      command.clearBuffer(slotLocksBuffer, 0, slotLocksBuffer.size);
      command.clearBuffer(telemetryBuffer, 0, 16);
      const group = this.device.createBindGroup({ label: "VSM/allocate pages bindings", layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: resolved.get(currentConstants) as GPUBuffer } },
          { binding: 1, resource: { buffer: resolved.get(demand) as GPUBuffer } },
          { binding: 2, resource: { buffer: resolved.get(pageTable) as GPUBuffer } },
          { binding: 3, resource: { buffer: resolved.get(metaTable) as GPUBuffer } },
          { binding: 4, resource: { buffer: allocationBuffer } },
          { binding: 5, resource: { buffer: pageLocksBuffer } },
          { binding: 6, resource: { buffer: slotLocksBuffer } },
          { binding: 7, resource: { buffer: telemetryBuffer } }
        ] });
      const pass = command.beginComputePass({ label: "VSM/allocate pages" });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(input.resources.capabilities.demandCapacity / 64));
      pass.end();
    });
    produce.read(currentConstants);
    produce.read(demand);
    produce.write(pageTable);
    produce.write(metaTable);
    produce.write(allocation);
    produce.write(pageLocks);
    produce.write(slotLocks);
    produce.write(telemetry);
    produce.make_side_effect();
    return {
      allocation,
      demand,
      generation: input.generation,
      capacity: input.resources.capabilities.residentSlots
    };
  }

  destroy(): void { this.constants.destroy(); }
}

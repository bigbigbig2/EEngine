import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { VsmResources } from "./VsmResources.js";
import { VSM_RECEIVER_DEMAND_WGSL } from "../../shaders/vsm_receiver_demand.js";

export interface VsmReceiverDemandInputs {
  readonly width: number;
  readonly height: number;
  readonly camera: ResourceId;
  readonly depth: ResourceId;
  readonly visibilityKey: ResourceId;
  readonly resources: VsmResources;
  readonly generation: number;
  readonly lightView: readonly number[];
  /** Per-level light-space origin, coverage extent, and texel footprint. */
  readonly clipOriginExtent: readonly (readonly [number, number, number, number])[];
}

export interface VsmDemandFrame {
  readonly demand: ResourceId;
  readonly generation: number;
  readonly capacity: number;
}

const CONSTANT_BYTES = 256;

function packConstants(input: VsmReceiverDemandInputs, resources: VsmResources): ArrayBuffer {
  if (input.lightView.length !== 16 || input.clipOriginExtent.length < resources.capabilities.clipLevels) {
    throw new RangeError("VSM receiver demand requires a light view and every clip level");
  }
  const data = new ArrayBuffer(CONSTANT_BYTES);
  const floats = new Float32Array(data);
  const uints = new Uint32Array(data);
  floats.set(input.lightView, 0);
  for (let level = 0; level < 6; level++) {
    const value = input.clipOriginExtent[level] ?? [0, 0, 1, 1];
    floats.set(value, 16 + level * 4);
  }
  uints.set([input.width, input.height, resources.capabilities.pageSize,
    resources.capabilities.virtualPagesPerAxis], 40);
  uints.set([resources.capabilities.clipLevels, input.generation >>> 0,
    resources.capabilities.demandCapacity, 0], 44);
  floats.set([1 / input.width, 1 / input.height, 1, 0], 48);
  return data;
}

/** GPU receiver demand producer. It never reads demand back or chooses work on CPU. */
export class VsmReceiverDemandPass {
  private readonly constants: GPUBuffer;
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;

  constructor(private readonly device: GPUDevice) {
    this.constants = device.createBuffer({ label: "VSM/receiver demand constants",
      size: CONSTANT_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "depth" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
    ] });
    this.pipeline = device.createComputePipeline({ label: "VSM/receiver demand",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module: device.createShaderModule({ code: VSM_RECEIVER_DEMAND_WGSL }), entryPoint: "main" } });
  }

  addToGraph(graph: FrameGraph, input: VsmReceiverDemandInputs): VsmDemandFrame {
    const profile = input.resources.capabilities;
    if (input.resources.profile === "shadow-disabled") throw new Error("VSM receiver demand requires an enabled profile");
    if (!Number.isInteger(input.width) || input.width < 1 || !Number.isInteger(input.height) || input.height < 1 ||
        input.width > Number(this.device.limits.maxTextureDimension2D) ||
        input.height > Number(this.device.limits.maxTextureDimension2D)) {
      throw new RangeError("VSM receiver demand extent exceeds device limits");
    }
    if (!Number.isSafeInteger(input.generation) || input.generation < 0) throw new RangeError("VSM generation is invalid");
    const demandBuffer = input.resources.demand;
    if (!demandBuffer) throw new Error("VSM demand buffer is unavailable");
    const constants = graph.import_resource("VSM/receiver demand constants",
      { kind: "imported", label: "VSM receiver demand constants" }, this.constants);
    const demand = graph.import_resource("VSM/demand", { kind: "imported", label: "VSM demand buffer" },
      demandBuffer);
    const update = graph.add("VSM/update receiver demand constants", input,
      (data, _resources, context) => {
        (context.encoder as ShadeGPUCommandContext).writeBuffer(this.constants, 0,
          packConstants(data, input.resources), 0, CONSTANT_BYTES);
      });
    const currentConstants = update.write(constants);
    const produce = graph.add("VSM/receiver demand", {}, (_data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const demandBuffer = resources.get(demand) as GPUBuffer;
      command.clearBuffer(demandBuffer, 0, 16);
      const group = this.device.createBindGroup({ layout: this.layout, entries: [
        { binding: 0, resource: { buffer: resources.get(input.camera) as GPUBuffer } },
        { binding: 1, resource: resolveTextureView(resources.get(input.depth)) },
        { binding: 2, resource: resolveTextureView(resources.get(input.visibilityKey)) },
        { binding: 3, resource: { buffer: resources.get(currentConstants) as GPUBuffer } },
        { binding: 4, resource: { buffer: demandBuffer } }
      ] });
      const pass = command.beginComputePass({ label: "VSM/receiver demand" });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(input.width / 8), Math.ceil(input.height / 8));
      pass.end();
    });
    produce.read(currentConstants);
    produce.read(input.camera);
    produce.read(input.depth);
    produce.read(input.visibilityKey);
    produce.write(demand);
    return { demand, generation: input.generation, capacity: profile.demandCapacity };
  }

  destroy(): void { this.constants.destroy(); }
}

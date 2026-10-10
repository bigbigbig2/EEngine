import {
  packVsmProjection,
  VSM_PROJECTION_CONSTANT_BYTES,
  VSM_DEPTH_RANGE_BYTE_OFFSET,
  VSM_DEPTH_RANGE_BYTES,
  type VsmDirectionalFrameConstants,
} from "./VsmProjection.js";
export { buildVsmDirectionalFrameConstants, type VsmDirectionalFrameConstants } from "./VsmProjection.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { VsmResources } from "./VsmResources.js";
import { VSM_RECEIVER_DEMAND_WGSL } from "../../shaders/vsm_receiver_demand.js";
import {
  SHADOW_NORMAL_OFFSET_SCALE,
  SHADOW_DEPTH_BIAS,
  SHADOW_DEPTH_SLOPE_SCALE,
} from "../../gpu/ShadowContract.js";

export interface VsmReceiverDemandInputs {
  readonly width: number;
  readonly height: number;
  readonly camera: ResourceId;
  readonly instances: ResourceId;
  readonly meshletWork: ResourceId;
  readonly depthRange: ResourceId;
  readonly frame: VsmDirectionalFrameConstants;
  readonly depth: ResourceId;
  readonly visibilityKey: ResourceId;
  readonly resources: VsmResources;
  readonly generation: number;
}

export interface VsmDemandFrame {
  readonly demand: ResourceId;
  readonly samplingConstants: ResourceId;
  readonly generation: number;
  readonly capacity: number;
}

const CONSTANT_BYTES = VSM_PROJECTION_CONSTANT_BYTES;

export function vsmReceiverDispatch(width: number, height: number): readonly [number, number] {
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new RangeError("VSM receiver demand extent is invalid");
  }
  return [Math.ceil(width / 8), Math.ceil(height / 8)];
}

function packConstants(input: VsmReceiverDemandInputs, resources: VsmResources): ArrayBuffer {
  if (
    input.frame.lightView.length !== 16 ||
    input.frame.clipOriginExtent.length < resources.capabilities.clipLevels
  ) {
    throw new RangeError("VSM receiver demand requires a light view and every clip level");
  }
  const data = packVsmProjection(input.frame);
  const floats = new Float32Array(data);
  const uints = new Uint32Array(data);
  uints.set(
    [input.width, input.height, resources.capabilities.pageSize, resources.capabilities.virtualPagesPerAxis],
    40,
  );
  uints.set(
    [resources.capabilities.clipLevels, input.generation >>> 0, resources.capabilities.demandCapacity, 0],
    44,
  );
  floats.set([1 / input.width, 1 / input.height, 1, 0], 48);
  return data;
}

/** Same projection ABI as raster. Biases stay in shadow texels until the
 * sampler scales by the actual level/mip world texel and stable inverse Z range. */
export function packVsmSamplingConstants(input: VsmReceiverDemandInputs): ArrayBuffer {
  const data = packConstants(input, input.resources);
  const floats = new Float32Array(data),
    uints = new Uint32Array(data);
  const profile = input.resources.capabilities;
  uints.set([profile.virtualPagesPerAxis, profile.pageSize, profile.border, profile.atlasPagesPerAxis], 40);
  uints.set([profile.clipLevels, input.generation, profile.pcfTapCount, profile.atlasDimension], 44);
  const depthPerTexel = 1; // Actual world texel * inverse depth range is applied by the sampler.
  floats.set(
    [
      SHADOW_NORMAL_OFFSET_SCALE * depthPerTexel,
      SHADOW_DEPTH_BIAS * depthPerTexel,
      SHADOW_DEPTH_SLOPE_SCALE * depthPerTexel,
      0,
    ],
    48,
  );
  return data;
}

/** GPU receiver demand producer. It never reads demand back or chooses work on CPU. */
export class VsmReceiverDemandPass {
  private readonly constants: GPUBuffer;
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private readonly coarsePipeline: GPUComputePipeline;

  constructor(private readonly device: GPUDevice) {
    this.constants = device.createBuffer({
      label: "VSM/receiver demand constants",
      size: CONSTANT_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "depth" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      ],
    });
    this.pipeline = device.createComputePipeline({
      label: "VSM/receiver demand",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module: device.createShaderModule({ code: VSM_RECEIVER_DEMAND_WGSL }), entryPoint: "main" },
    });
    this.coarsePipeline = device.createComputePipeline({
      label: "VSM/complete coarse coverage",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: {
        module: device.createShaderModule({ code: VSM_RECEIVER_DEMAND_WGSL }),
        entryPoint: "mark_coarse",
      },
    });
  }

  addToGraph(graph: FrameGraph, input: VsmReceiverDemandInputs): VsmDemandFrame {
    const profile = input.resources.capabilities;
    if (input.resources.profile === "shadow-disabled")
      throw new Error("VSM receiver demand requires an enabled profile");
    if (
      !Number.isInteger(input.width) ||
      input.width < 1 ||
      !Number.isInteger(input.height) ||
      input.height < 1 ||
      input.width > Number(this.device.limits.maxTextureDimension2D) ||
      input.height > Number(this.device.limits.maxTextureDimension2D)
    ) {
      throw new RangeError("VSM receiver demand extent exceeds device limits");
    }
    if (!Number.isSafeInteger(input.generation) || input.generation < 0)
      throw new RangeError("VSM generation is invalid");
    const demandBuffer = input.resources.requestedPages;
    if (!demandBuffer) throw new Error("VSM demand buffer is unavailable");
    const constants = graph.import_resource(
      "VSM/receiver demand constants",
      { kind: "imported", label: "VSM receiver demand constants" },
      this.constants,
    );
    const demand = graph.import_resource(
      "VSM/demand",
      { kind: "imported", label: "VSM demand buffer" },
      demandBuffer,
    );
    if (!input.resources.pageConstants) throw new Error("VSM sampling constants are unavailable");
    const sampling = graph.import_resource(
      "VSM/sampling constants",
      { kind: "imported" },
      input.resources.pageConstants,
    );
    const update = graph.add("VSM/update receiver demand constants", input, (data, _resources, context) => {
      (context.encoder as ShadeGPUCommandContext).writeBuffer(
        this.constants,
        0,
        packConstants(data, input.resources),
        0,
        CONSTANT_BYTES,
      );
      (context.encoder as ShadeGPUCommandContext).writeBuffer(
        data.resources.pageConstants!,
        0,
        packVsmSamplingConstants(data),
        0,
        CONSTANT_BYTES,
      );
      (context.encoder as ShadeGPUCommandContext).copyBufferToBuffer(
        _resources.get(data.depthRange) as GPUBuffer,
        0,
        data.resources.pageConstants!,
        VSM_DEPTH_RANGE_BYTE_OFFSET,
        VSM_DEPTH_RANGE_BYTES,
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
    const samplingConstants = update.write(sampling);
    const produce = graph.add("VSM/receiver demand", {}, (_data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const demandBuffer = resources.get(demand) as GPUBuffer;
      command.clearBuffer(demandBuffer);
      const group = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: resources.get(input.camera) as GPUBuffer } },
          { binding: 1, resource: resolveTextureView(resources.get(input.depth)) },
          { binding: 2, resource: resolveTextureView(resources.get(input.visibilityKey)) },
          { binding: 3, resource: { buffer: resources.get(currentConstants) as GPUBuffer } },
          { binding: 4, resource: { buffer: demandBuffer } },
          { binding: 5, resource: { buffer: resources.get(input.meshletWork) as GPUBuffer } },
          { binding: 6, resource: { buffer: resources.get(input.instances) as GPUBuffer } },
        ],
      });
      const pass = command.beginComputePass({ label: "VSM/receiver demand" });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(...vsmReceiverDispatch(input.width, input.height));
      pass.setPipeline(this.coarsePipeline);
      pass.dispatchWorkgroups(profile.clipLevels);
      pass.end();
    });
    produce.read(currentConstants);
    produce.read(input.camera);
    produce.read(input.depth);
    produce.read(input.visibilityKey);
    produce.read(input.meshletWork);
    produce.read(input.instances);
    const producedDemand = produce.write(demand);
    produce.make_side_effect();
    return {
      demand: producedDemand,
      samplingConstants,
      generation: input.generation,
      capacity: profile.demandCapacity,
    };
  }

  destroy(): void {
    this.constants.destroy();
  }
}

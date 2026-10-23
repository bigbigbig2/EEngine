import {
  VSM_DIMENSIONS_WORD,
  VSM_CONTROL_WORD,
  VSM_PARAMETERS_WORD,
  VSM_FOOTPRINT_WORD,
} from "../../gpu/GpuVsmProjectionAbi.js";
import { PreparedComputePipeline } from "../../gpu/PreparedPipeline.js";
import {
  packVsmProjection,
  VSM_PROJECTION_CONSTANT_BYTES,
  VSM_DEPTH_RANGE_BYTE_OFFSET,
  VSM_DEPTH_RANGE_BYTES,
  VSM_IDENTITY_BYTE_OFFSET,
  type VsmDirectionalFrameConstants,
} from "./VsmProjection.js";
export { buildVsmDirectionalFrameConstants, type VsmDirectionalFrameConstants } from "./VsmProjection.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { GpuBindGroupCache } from "../../gpu/GpuBindGroupResourceCache.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { VsmResources } from "./VsmResources.js";
import {
  VSM_RECEIVER_DEMAND_WGSL,
  vsmReceiverDemandDiagnosticWgsl,
} from "../../shaders/vsm_receiver_demand.js";
import { VSM_DEFAULT_SETTINGS, VSM_DEBUG_VIEWS, effectiveVsmFilterMode } from "./VsmSettings.js";
import { VSM_FILTER_MODES, VSM_FILTER_NOISE_PHASES } from "../../gpu/GpuVsmFilterAbi.js";

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
  readonly filterNoiseWordOffset?: number;
  readonly filterPhase?: number;
  readonly temporal?: boolean;
  /** Future cross-page filters must declare their finite worst-case radius.
   * This expands demand only; it does not enable an unimplemented filter. */
  readonly boundedFilterFootprintRadiusTexels?: number;
}

export interface VsmDemandFrame {
  readonly demand: ResourceId;
  readonly priority: ResourceId;
  readonly samplingConstants: ResourceId;
  readonly generation: number;
  readonly capacity: number;
}

const CONSTANT_BYTES = VSM_PROJECTION_CONSTANT_BYTES;
declare const __EENGINE_PERFORMANCE_DIAGNOSTICS__: boolean;
const DEMAND_DIAGNOSTICS =
  typeof __EENGINE_PERFORMANCE_DIAGNOSTICS__ !== "undefined" &&
  __EENGINE_PERFORMANCE_DIAGNOSTICS__ &&
  new URLSearchParams(globalThis.location.search).get("vsmDemandDiagnostics") === "1";

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
    VSM_DIMENSIONS_WORD,
  );
  uints.set(
    [resources.capabilities.clipLevels, input.generation >>> 0, resources.capabilities.demandCapacity, 0],
    VSM_CONTROL_WORD,
  );
  floats.set([1 / input.width, 1 / input.height, 1, 0], VSM_PARAMETERS_WORD);
  const settings = input.frame.settings ?? VSM_DEFAULT_SETTINGS;
  const mode = effectiveVsmFilterMode(settings);
  const activeRadius = mode === "point" ? 0 : mode === "stable-pcf" ? 3 : Math.min(Math.ceil((settings.lightSize ?? 1) * 2.5 + 4), resources.capabilities.pageSize);
  const radius = input.boundedFilterFootprintRadiusTexels ?? activeRadius;
  if (!Number.isFinite(radius) || radius < activeRadius || radius > resources.capabilities.pageSize) {
    throw new RangeError("VSM footprint must include all active taps and be at most one page in radius");
  }
  floats.set([radius, activeRadius, settings.clipTransitionRatio, resources.capabilities.border], VSM_FOOTPRINT_WORD);
  return data;
}

/** Same projection ABI as raster. Biases stay in shadow texels until the
 * sampler scales by the actual level/mip world texel and stable inverse Z range. */
export function packVsmSamplingConstants(input: VsmReceiverDemandInputs): ArrayBuffer {
  const data = packConstants(input, input.resources);
  const floats = new Float32Array(data);
  const uints = new Uint32Array(data);
  const profile = input.resources.capabilities;
  uints.set([profile.virtualPagesPerAxis, profile.pageSize, profile.border, profile.atlasPagesPerAxis], VSM_DIMENSIONS_WORD);
  const settings = input.frame.settings ?? VSM_DEFAULT_SETTINGS;
  const filterMode = effectiveVsmFilterMode(settings);
  const phase = input.filterPhase ?? 0;
  const noiseOffset = input.filterNoiseWordOffset ?? 0;
  const temporal = input.temporal ?? (input.filterPhase !== undefined ? input.filterPhase !== 0 : true);
  uints.set([profile.clipLevels, input.generation, VSM_FILTER_MODES[filterMode], temporal ? 1 : 0], VSM_CONTROL_WORD);
  floats.set(
    [
      settings.angularBiasTexels,
      settings.depthBiasTexels,
      settings.clipTransitionRatio,
      settings.lightSize ?? settings.filterRadiusTexels,
    ],
    VSM_PARAMETERS_WORD,
  );
  uints[VSM_IDENTITY_BYTE_OFFSET / 4 + 2] = VSM_DEBUG_VIEWS[settings.debugView];
  uints[VSM_IDENTITY_BYTE_OFFSET / 4 + 3] = noiseOffset;
  return data;
}

/** GPU receiver demand producer. It never reads demand back or chooses work on CPU. */
export class VsmReceiverDemandPass {
  async preparePipelines(): Promise<void> {
    await Promise.all([this.pipeline.prepare(), this.coarsePipeline.prepare()]);
  }

  private readonly constants: GPUBuffer;
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: PreparedComputePipeline;
  private readonly coarsePipeline: PreparedComputePipeline;
  private readonly bindGroups = new GpuBindGroupCache(8);
  private diagnosticWorkgroups: GPUBuffer | null = null;

  constructor(private readonly device: GPUDevice) {
    this.constants = device.createBuffer({
      label: "VSM/receiver demand constants",
      size: CONSTANT_BYTES,
      usage:
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | (DEMAND_DIAGNOSTICS ? GPUBufferUsage.COPY_SRC : 0),
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
        { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        ...(DEMAND_DIAGNOSTICS
          ? [{ binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" as const } }]
          : []),
      ],
    });
    this.pipeline = new PreparedComputePipeline(device, {
      label: "VSM/receiver demand",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: {
        module: device.createShaderModule({
          code: DEMAND_DIAGNOSTICS ? vsmReceiverDemandDiagnosticWgsl() : VSM_RECEIVER_DEMAND_WGSL,
        }),
        entryPoint: "main",
      },
    });
    this.coarsePipeline = new PreparedComputePipeline(device, {
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
    if (input.resources.profile === "shadow-disabled") {
      throw new Error("VSM receiver demand requires an enabled profile");
    }
    if (
      !Number.isInteger(input.width) ||
      input.width < 1 ||
      !Number.isInteger(input.height) ||
      input.height < 1 ||
      input.width > Number(this.device.limits.maxTextureDimension2D) ||
      input.height > Number(this.device.limits.maxTextureDimension2D) ||
      input.width * input.height * 3 > 0xffffffff
    ) {
      throw new RangeError("VSM receiver demand extent exceeds device limits");
    }
    if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
      throw new RangeError("VSM generation is invalid");
    }
    const demandBuffer = input.resources.requestedPages;
    if (!demandBuffer) {
      throw new Error("VSM demand buffer is unavailable");
    }
    let diagnostic: ResourceId | undefined;
    if (DEMAND_DIAGNOSTICS) {
      const [groupsX, groupsY] = vsmReceiverDispatch(input.width, input.height);
      const size = 16 + groupsX * groupsY * 16;
      if (size > this.device.limits.maxStorageBufferBindingSize || size > this.device.limits.maxBufferSize) {
        throw new RangeError("VSM demand diagnostic capacity exceeds device limits");
      }
      if (this.diagnosticWorkgroups?.size !== size) {
        this.diagnosticWorkgroups?.destroy();
        this.diagnosticWorkgroups = this.device.createBuffer({
          label: "Diagnostic/VSM receiver workgroups",
          size,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });
      }
      diagnostic = graph.import_resource(
        "Diagnostic/VSM receiver workgroups",
        { kind: "imported" },
        this.diagnosticWorkgroups,
      );
    }
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
    const priority = graph.import_resource(
      "VSM/receiver screen benefit",
      { kind: "imported" },
      input.resources.getBuffer("receiverPriority")!,
    );
    if (!input.resources.pageConstants) {
      throw new Error("VSM sampling constants are unavailable");
    }
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
      const priorityBuffer = resources.get(priority) as GPUBuffer;
      command.clearBuffer(priorityBuffer);
      const group = this.bindGroups.create(this.device, {
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: resources.get(input.camera) as GPUBuffer } },
          { binding: 1, resource: resolveTextureView(resources.get(input.depth)) },
          { binding: 2, resource: resolveTextureView(resources.get(input.visibilityKey)) },
          { binding: 3, resource: { buffer: resources.get(currentConstants) as GPUBuffer } },
          { binding: 4, resource: { buffer: demandBuffer } },
          { binding: 5, resource: { buffer: resources.get(input.meshletWork) as GPUBuffer } },
          { binding: 6, resource: { buffer: resources.get(input.instances) as GPUBuffer } },
          { binding: 8, resource: { buffer: priorityBuffer } },
          ...(diagnostic === undefined
            ? []
            : [{ binding: 7, resource: { buffer: resources.get(diagnostic) as GPUBuffer } }]),
        ],
      });
      const pass = command.beginComputePass({ label: "VSM/receiver demand" });
      pass.setPipeline(this.pipeline.requirePrepared());
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(...vsmReceiverDispatch(input.width, input.height));
      pass.setPipeline(this.coarsePipeline.requirePrepared());
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
    const producedPriority = produce.write(priority);
    if (diagnostic !== undefined) {
      produce.write(diagnostic);
    }
    produce.make_side_effect();
    return {
      demand: producedDemand,
      priority: producedPriority,
      samplingConstants,
      generation: input.generation,
      capacity: profile.demandCapacity,
    };
  }

  destroy(): void {
    this.bindGroups.clear();
    this.constants.destroy();
    this.diagnosticWorkgroups?.destroy();
  }
}

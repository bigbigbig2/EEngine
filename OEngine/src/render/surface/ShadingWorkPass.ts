import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import {
  SHADING_WORK_CLASS_BUFFER_BYTES,
  SHADING_WORK_HEADER_BYTES, SHADING_WORK_INDIRECT_BYTES, shadingWorkCapacity
} from "./ShadingWorkAbi.js";
import {
  SHADING_WORK_FINALIZE_WGSL,
  shadingWorkClassifyWgsl, shadingWorkScatterWgsl
} from "../../shaders/shading_work.js";
import { SHADING_FREQUENCY_PLAN_WGSL } from "../../shaders/shading_frequency.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { SHADING_FREQUENCY_COARSE4_BIT, shadingFrequencyPlanCapacity } from "./ShadingFrequencyPlanAbi.js";

export interface ShadingWorkInputs {
  readonly visibilityKey: ResourceId;
  readonly meshletWork: ResourceId;
  readonly materialRecords: ResourceId;
  readonly depth: ResourceId;
  readonly instances: ResourceId;
  readonly adaptive: boolean;
  readonly width: number;
  readonly height: number;
}

/** GPU classification and compact work publication for the Surface consumer. */
export class ShadingWorkPass {
  private diagnosticQueue: GPUBuffer | null = null;
  private diagnosticPlan: GPUBuffer | null = null;
  private diagnosticPlanBytes = 0;
  private diagnosticPlanTilesX = 0;
  private readonly classifyLayout: GPUBindGroupLayout;
  private readonly adaptiveClassifyLayout: GPUBindGroupLayout;
  private readonly frequencyLayout: GPUBindGroupLayout;
  private readonly finalizeLayout: GPUBindGroupLayout;
  private readonly initialize: GPUComputePipeline;
  private readonly adaptiveInitialize: GPUComputePipeline;
  private readonly classify: GPUComputePipeline;
  private readonly finalize: GPUComputePipeline;
  private readonly scatter: GPUComputePipeline;
  private readonly adaptiveClassify: GPUComputePipeline;
  private readonly adaptiveScatter: GPUComputePipeline;
  private readonly frequency: GPUComputePipeline;

  constructor(private readonly device: GPUDevice) {
    const compute = GPUShaderStage.COMPUTE;
    this.classifyLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: compute, texture: { sampleType: "uint" } },
      { binding: 1, visibility: compute, buffer: { type: "storage" } },
      { binding: 2, visibility: compute, buffer: { type: "uniform" } },
      { binding: 3, visibility: compute, buffer: { type: "storage" } },
      { binding: 4, visibility: compute, buffer: { type: "read-only-storage" } },
      { binding: 5, visibility: compute, buffer: { type: "read-only-storage" } }
    ] });
    this.adaptiveClassifyLayout = device.createBindGroupLayout({ entries: [
      ...[...Array(6).keys()].map(binding => ({
        binding, visibility: compute,
        ...(binding === 0 ? { texture: { sampleType: "uint" as const } } :
          { buffer: { type: binding === 2 ? "uniform" as const :
            binding === 4 || binding === 5 ? "read-only-storage" as const : "storage" as const } })
      })),
      { binding: 6, visibility: compute, buffer: { type: "read-only-storage" } }
    ] });
    this.frequencyLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: compute, texture: { sampleType: "uint" } },
      { binding: 1, visibility: compute, texture: { sampleType: "depth" } },
      { binding: 2, visibility: compute, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: compute, buffer: { type: "read-only-storage" } },
      { binding: 4, visibility: compute, buffer: { type: "read-only-storage" } },
      { binding: 5, visibility: compute, buffer: { type: "storage" } },
      { binding: 6, visibility: compute, buffer: { type: "uniform" } }
    ] });
    this.finalizeLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: compute, buffer: { type: "storage" } },
      { binding: 1, visibility: compute, buffer: { type: "storage" } },
      { binding: 2, visibility: compute, buffer: { type: "uniform" } },
      { binding: 3, visibility: compute, buffer: { type: "storage" } }
    ] });
    const classifyModule = device.createShaderModule({ code: shadingWorkClassifyWgsl(false) });
    const adaptiveModule = device.createShaderModule({ code: shadingWorkClassifyWgsl(true) });
    const classifyLayout = device.createPipelineLayout({ bindGroupLayouts: [this.classifyLayout] });
    const adaptiveLayout = device.createPipelineLayout({ bindGroupLayouts: [this.adaptiveClassifyLayout] });
    this.initialize = device.createComputePipeline({ layout: classifyLayout,
      compute: { module: classifyModule, entryPoint: "initialize" } });
    this.adaptiveInitialize = device.createComputePipeline({ layout: adaptiveLayout,
      compute: { module: adaptiveModule, entryPoint: "initialize" } });
    this.classify = device.createComputePipeline({ layout: classifyLayout,
      compute: { module: classifyModule, entryPoint: "classify" } });
    this.adaptiveClassify = device.createComputePipeline({ layout: adaptiveLayout,
      compute: { module: adaptiveModule, entryPoint: "classify" } });
    this.finalize = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.finalizeLayout] }),
      compute: { module: device.createShaderModule({ code: SHADING_WORK_FINALIZE_WGSL }), entryPoint: "finalize" }
    });
    this.scatter = device.createComputePipeline({
      layout: classifyLayout,
      compute: { module: device.createShaderModule({ code: shadingWorkScatterWgsl(false) }), entryPoint: "scatter" }
    });
    this.adaptiveScatter = device.createComputePipeline({
      layout: adaptiveLayout,
      compute: { module: device.createShaderModule({ code: shadingWorkScatterWgsl(true) }), entryPoint: "scatter" }
    });
    this.frequency = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.frequencyLayout] }),
      compute: { module: device.createShaderModule({ code: SHADING_FREQUENCY_PLAN_WGSL }), entryPoint: "plan" }
    });
  }

  addToGraph(graph: FrameGraph, input: ShadingWorkInputs): Readonly<{
    queue: ResourceId;
    classes: ResourceId;
    indirect: ResourceId;
    frequencyPlan?: ResourceId;
  }> {
    const { width, height } = input;
    const { capacity, queueBytes } = shadingWorkCapacity(width, height, {
      maxBufferSize: Number(this.device.limits.maxBufferSize),
      maxStorageBufferBindingSize: Number(this.device.limits.maxStorageBufferBindingSize),
      maxComputeWorkgroupsPerDimension: Number(this.device.limits.maxComputeWorkgroupsPerDimension)
    });
    if (queueBytes <= SHADING_WORK_HEADER_BYTES) throw new Error("ShadingWork has no record capacity");
    const params = new Uint32Array([
      width, height, capacity, Number(this.device.limits.maxComputeWorkgroupsPerDimension)
    ]);
    let frequencyPlan: ResourceId | undefined;
    if (input.adaptive) {
      const { tilesX, tilesY, bytes: planBytes } = shadingFrequencyPlanCapacity(width, height, {
        maxBufferSize: Number(this.device.limits.maxBufferSize),
        maxStorageBufferBindingSize: Number(this.device.limits.maxStorageBufferBindingSize),
        maxComputeWorkgroupsPerDimension: Number(this.device.limits.maxComputeWorkgroupsPerDimension)
      });
      const frequency = graph.add("Surface/plan spatial shading frequency", {}, (_data, resources, context) => {
        const command = context.encoder as ShadeGPUCommandContext;
        const extent = command.allocateTransientBufferAndLoad(
          new Uint32Array([width, height, 0, 0]).buffer, GPUBufferUsage.UNIFORM
        );
        const bind = this.device.createBindGroup({ layout: this.frequencyLayout, entries: [
          { binding: 0, resource: resolveTextureView(resources.get(input.visibilityKey)) },
          { binding: 1, resource: resolveTextureView(resources.get(input.depth)) },
          { binding: 2, resource: { buffer: resources.get(input.meshletWork) as GPUBuffer } },
          { binding: 3, resource: { buffer: resources.get(input.materialRecords) as GPUBuffer } },
          { binding: 4, resource: { buffer: resources.get(input.instances) as GPUBuffer } },
          { binding: 5, resource: { buffer: resources.get(frequencyPlan!) as GPUBuffer } },
          { binding: 6, resource: { buffer: extent } }
        ] });
        const pass = command.beginComputePass({ label: "Surface/frequency plan" });
        pass.setPipeline(this.frequency);
        pass.setBindGroup(0, bind);
        pass.dispatchWorkgroups(Math.ceil(tilesX / 8), Math.ceil(tilesY / 8));
        pass.end();
        this.diagnosticPlan = resources.get(frequencyPlan!) as GPUBuffer;
        this.diagnosticPlanBytes = planBytes;
        this.diagnosticPlanTilesX = tilesX;
      });
      frequency.read(input.visibilityKey);
      frequency.read(input.depth);
      frequency.read(input.meshletWork);
      frequency.read(input.materialRecords);
      frequency.read(input.instances);
      frequencyPlan = frequency.create("Surface/frequency plan", {
        kind: "transient_buffer", size: planBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
      });
    }
    const classify = graph.add("Surface/classify visible ShadingWork", {}, (_data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const uniform = command.allocateTransientBufferAndLoad(params.buffer, GPUBufferUsage.UNIFORM);
      const bind = this.device.createBindGroup({ layout: frequencyPlan === undefined
        ? this.classifyLayout : this.adaptiveClassifyLayout, entries: [
        { binding: 0, resource: resolveTextureView(resources.get(input.visibilityKey)) },
        { binding: 1, resource: { buffer: resources.get(queue) as GPUBuffer } },
        { binding: 2, resource: { buffer: uniform } },
        { binding: 3, resource: { buffer: resources.get(classes) as GPUBuffer } },
        { binding: 4, resource: { buffer: resources.get(input.meshletWork) as GPUBuffer } },
        { binding: 5, resource: { buffer: resources.get(input.materialRecords) as GPUBuffer } },
        ...(frequencyPlan === undefined ? [] : [{ binding: 6,
          resource: { buffer: resources.get(frequencyPlan) as GPUBuffer } }])
      ] });
      const pass = command.beginComputePass({ label: "Surface/ShadingWork classify" });
      pass.setBindGroup(0, bind);
      pass.setPipeline(frequencyPlan === undefined ? this.initialize : this.adaptiveInitialize);
      pass.dispatchWorkgroups(1);
      pass.setPipeline(frequencyPlan === undefined ? this.classify : this.adaptiveClassify);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      pass.end();
    });
    classify.read(input.visibilityKey);
    classify.read(input.meshletWork);
    classify.read(input.materialRecords);
    if (frequencyPlan !== undefined) classify.read(frequencyPlan);
    const queue = classify.create("ShadingWork queue", {
      kind: "transient_buffer", size: queueBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });
    const classes = classify.create("ShadingWork material classes", {
      kind: "transient_buffer", size: SHADING_WORK_CLASS_BUFFER_BYTES,
      usage: GPUBufferUsage.STORAGE
    });

    const finalize = graph.add("Surface/finalize ShadingWork indirect", {}, (_data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const uniform = command.allocateTransientBufferAndLoad(params.buffer, GPUBufferUsage.UNIFORM);
      const bind = this.device.createBindGroup({ layout: this.finalizeLayout, entries: [
        { binding: 0, resource: { buffer: resources.get(queue) as GPUBuffer } },
        { binding: 1, resource: { buffer: resources.get(indirect) as GPUBuffer } },
        { binding: 2, resource: { buffer: uniform } },
        { binding: 3, resource: { buffer: resources.get(classes) as GPUBuffer } }
      ] });
      const pass = command.beginComputePass({ label: "Surface/ShadingWork indirect" });
      pass.setPipeline(this.finalize);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(1);
      pass.end();
    });
    finalize.read(queue);
    finalize.read(classes);
    const finalizedQueue = finalize.write(queue);
    const finalizedClasses = finalize.write(classes);
    const indirect = finalize.create("ShadingWork indirect args", {
      kind: "transient_buffer", size: SHADING_WORK_INDIRECT_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT
    });

    const scatter = graph.add("Surface/scatter ShadingWork by material class", {}, (_data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const uniform = command.allocateTransientBufferAndLoad(params.buffer, GPUBufferUsage.UNIFORM);
      const bind = this.device.createBindGroup({ layout: frequencyPlan === undefined
        ? this.classifyLayout : this.adaptiveClassifyLayout, entries: [
        { binding: 0, resource: resolveTextureView(resources.get(input.visibilityKey)) },
        { binding: 1, resource: { buffer: resources.get(finalizedQueue) as GPUBuffer } },
        { binding: 2, resource: { buffer: uniform } },
        { binding: 3, resource: { buffer: resources.get(finalizedClasses) as GPUBuffer } },
        { binding: 4, resource: { buffer: resources.get(input.meshletWork) as GPUBuffer } },
        { binding: 5, resource: { buffer: resources.get(input.materialRecords) as GPUBuffer } },
        ...(frequencyPlan === undefined ? [] : [{ binding: 6,
          resource: { buffer: resources.get(frequencyPlan) as GPUBuffer } }])
      ] });
      const pass = command.beginComputePass({ label: "Surface/ShadingWork scatter classes" });
      pass.setPipeline(frequencyPlan === undefined ? this.scatter : this.adaptiveScatter);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      pass.end();
      this.diagnosticQueue = resources.get(finalizedQueue) as GPUBuffer;
      if (frequencyPlan === undefined) {
        this.diagnosticPlan = null;
        this.diagnosticPlanBytes = 0;
        this.diagnosticPlanTilesX = 0;
      }
    });
    scatter.read(input.visibilityKey);
    scatter.read(input.meshletWork);
    scatter.read(input.materialRecords);
    if (frequencyPlan !== undefined) scatter.read(frequencyPlan);
    scatter.read(finalizedQueue);
    scatter.read(finalizedClasses);
    const scatteredQueue = scatter.write(finalizedQueue);
    const scatteredClasses = scatter.write(finalizedClasses);

    return Object.freeze({
      queue: scatteredQueue, classes: scatteredClasses, indirect,
      ...(frequencyPlan === undefined ? {} : { frequencyPlan })
    });
  }

  /** Explicit diagnostic copy after a submitted frame; never called by the production frame loop. */
  async readDiagnosticFrequency(): Promise<Readonly<{
    attempted: number; written: number; overflow: number;
    coarse2Blocks: number; coarse4Blocks: number; savedEvaluations: number;
    leftCoarseBlocks: number; rightCoarseBlocks: number;
  }>> {
    if (!this.diagnosticQueue || !this.diagnosticPlan) {
      throw new Error("No adaptive ShadingWork frame is available for diagnosis");
    }
    const bytes = SHADING_WORK_HEADER_BYTES + this.diagnosticPlanBytes;
    const staging = this.device.createBuffer({
      label: "Diagnostic/ShadingWork frequency readback", size: bytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    try {
      const encoder = this.device.createCommandEncoder({ label: "Diagnostic/ShadingWork frequency copy" });
      encoder.copyBufferToBuffer(this.diagnosticQueue, 0, staging, 0, SHADING_WORK_HEADER_BYTES);
      encoder.copyBufferToBuffer(this.diagnosticPlan, 0, staging,
        SHADING_WORK_HEADER_BYTES, this.diagnosticPlanBytes);
      this.device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const words = new Uint32Array(staging.getMappedRange().slice(0));
      let coarse2Blocks = 0, coarse4Blocks = 0;
      let leftCoarseBlocks = 0, rightCoarseBlocks = 0;
      for (let i = SHADING_WORK_HEADER_BYTES / 4; i < words.length; i++) {
        const mask = words[i]!;
        if ((mask & SHADING_FREQUENCY_COARSE4_BIT) !== 0) coarse4Blocks++;
        else for (let cell = 0; cell < 4; cell++) if ((mask & (1 << cell)) !== 0) coarse2Blocks++;
        if (mask !== 0) {
          if ((i - SHADING_WORK_HEADER_BYTES / 4) % this.diagnosticPlanTilesX <
              this.diagnosticPlanTilesX / 2) leftCoarseBlocks++;
          else rightCoarseBlocks++;
        }
      }
      staging.unmap();
      return Object.freeze({
        attempted: words[0]!, written: words[1]!, overflow: words[2]!,
        coarse2Blocks, coarse4Blocks,
        savedEvaluations: coarse4Blocks * 15 + coarse2Blocks * 3,
        leftCoarseBlocks, rightCoarseBlocks
      });
    } finally {
      staging.destroy();
    }
  }
}

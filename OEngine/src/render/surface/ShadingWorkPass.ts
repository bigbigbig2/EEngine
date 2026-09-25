import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import {
  SHADING_WORK_CLASS_BUFFER_BYTES,
  SHADING_WORK_HEADER_BYTES, SHADING_WORK_INDIRECT_BYTES, shadingWorkCapacity
} from "./ShadingWorkAbi.js";
import {
  SHADING_WORK_CLASSIFY_WGSL,
  SHADING_WORK_FINALIZE_WGSL,
  SHADING_WORK_SCATTER_WGSL
} from "../../shaders/shading_work.js";
import { resolveTextureView } from "../RenderTargetViews.js";

export interface ShadingWorkInputs {
  readonly visibilityKey: ResourceId;
  readonly meshletWork: ResourceId;
  readonly materialRecords: ResourceId;
  readonly width: number;
  readonly height: number;
}

/** GPU classification and compact work publication for the Surface consumer. */
export class ShadingWorkPass {
  private readonly classifyLayout: GPUBindGroupLayout;
  private readonly finalizeLayout: GPUBindGroupLayout;
  private readonly initialize: GPUComputePipeline;
  private readonly classify: GPUComputePipeline;
  private readonly finalize: GPUComputePipeline;
  private readonly scatter: GPUComputePipeline;

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
    this.finalizeLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: compute, buffer: { type: "storage" } },
      { binding: 1, visibility: compute, buffer: { type: "storage" } },
      { binding: 2, visibility: compute, buffer: { type: "uniform" } },
      { binding: 3, visibility: compute, buffer: { type: "storage" } }
    ] });
    const classifyModule = device.createShaderModule({ code: SHADING_WORK_CLASSIFY_WGSL });
    const classifyLayout = device.createPipelineLayout({ bindGroupLayouts: [this.classifyLayout] });
    this.initialize = device.createComputePipeline({ layout: classifyLayout,
      compute: { module: classifyModule, entryPoint: "initialize" } });
    this.classify = device.createComputePipeline({ layout: classifyLayout,
      compute: { module: classifyModule, entryPoint: "classify" } });
    this.finalize = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.finalizeLayout] }),
      compute: { module: device.createShaderModule({ code: SHADING_WORK_FINALIZE_WGSL }), entryPoint: "finalize" }
    });
    this.scatter = device.createComputePipeline({
      layout: classifyLayout,
      compute: { module: device.createShaderModule({ code: SHADING_WORK_SCATTER_WGSL }), entryPoint: "scatter" }
    });
  }

  addToGraph(graph: FrameGraph, input: ShadingWorkInputs): Readonly<{
    queue: ResourceId;
    classes: ResourceId;
    indirect: ResourceId;
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
    const classify = graph.add("Surface/classify visible ShadingWork", {}, (_data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const uniform = command.allocateTransientBufferAndLoad(params.buffer, GPUBufferUsage.UNIFORM);
      const bind = this.device.createBindGroup({ layout: this.classifyLayout, entries: [
        { binding: 0, resource: resolveTextureView(resources.get(input.visibilityKey)) },
        { binding: 1, resource: { buffer: resources.get(queue) as GPUBuffer } },
        { binding: 2, resource: { buffer: uniform } },
        { binding: 3, resource: { buffer: resources.get(classes) as GPUBuffer } },
        { binding: 4, resource: { buffer: resources.get(input.meshletWork) as GPUBuffer } },
        { binding: 5, resource: { buffer: resources.get(input.materialRecords) as GPUBuffer } }
      ] });
      const pass = command.beginComputePass({ label: "Surface/ShadingWork classify" });
      pass.setBindGroup(0, bind);
      pass.setPipeline(this.initialize);
      pass.dispatchWorkgroups(1);
      pass.setPipeline(this.classify);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      pass.end();
    });
    classify.read(input.visibilityKey);
    classify.read(input.meshletWork);
    classify.read(input.materialRecords);
    const queue = classify.create("ShadingWork queue", {
      kind: "transient_buffer", size: queueBytes, usage: GPUBufferUsage.STORAGE
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
      const bind = this.device.createBindGroup({ layout: this.classifyLayout, entries: [
        { binding: 0, resource: resolveTextureView(resources.get(input.visibilityKey)) },
        { binding: 1, resource: { buffer: resources.get(finalizedQueue) as GPUBuffer } },
        { binding: 2, resource: { buffer: uniform } },
        { binding: 3, resource: { buffer: resources.get(finalizedClasses) as GPUBuffer } },
        { binding: 4, resource: { buffer: resources.get(input.meshletWork) as GPUBuffer } },
        { binding: 5, resource: { buffer: resources.get(input.materialRecords) as GPUBuffer } }
      ] });
      const pass = command.beginComputePass({ label: "Surface/ShadingWork scatter classes" });
      pass.setPipeline(this.scatter);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      pass.end();
    });
    scatter.read(input.visibilityKey);
    scatter.read(input.meshletWork);
    scatter.read(input.materialRecords);
    scatter.read(finalizedQueue);
    scatter.read(finalizedClasses);
    const scatteredQueue = scatter.write(finalizedQueue);
    const scatteredClasses = scatter.write(finalizedClasses);

    return Object.freeze({
      queue: scatteredQueue, classes: scatteredClasses, indirect
    });
  }
}

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import {
  SHADING_WORK_HEADER_BYTES, shadingWorkCapacity
} from "./ShadingWorkAbi.js";
import {
  SHADING_WORK_CLASSIFY_WGSL,
  SHADING_WORK_FINALIZE_WGSL,
  SHADING_WORK_MATERIAL_DIAGNOSTIC_WGSL
} from "../../shaders/shading_work.js";
import { resolveTextureView } from "../RenderTargetViews.js";

export interface ShadingWorkInputs {
  readonly visibilityKey: ResourceId;
  readonly meshletWork: ResourceId;
  readonly materialRecords: ResourceId;
  readonly width: number;
  readonly height: number;
}

/** First GPU-closed ShadingWork path; the material output remains diagnostic until full Surface evaluation lands. */
export class ShadingWorkPass {
  private readonly classifyLayout: GPUBindGroupLayout;
  private readonly finalizeLayout: GPUBindGroupLayout;
  private readonly consumeLayout: GPUBindGroupLayout;
  private readonly initialize: GPUComputePipeline;
  private readonly classify: GPUComputePipeline;
  private readonly finalize: GPUComputePipeline;
  private readonly consume: GPUComputePipeline;

  constructor(private readonly device: GPUDevice) {
    const compute = GPUShaderStage.COMPUTE;
    this.classifyLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: compute, texture: { sampleType: "uint" } },
      { binding: 1, visibility: compute, buffer: { type: "storage" } },
      { binding: 2, visibility: compute, buffer: { type: "uniform" } }
    ] });
    this.finalizeLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: compute, buffer: { type: "storage" } },
      { binding: 1, visibility: compute, buffer: { type: "storage" } },
      { binding: 2, visibility: compute, buffer: { type: "uniform" } }
    ] });
    this.consumeLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: compute, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: compute, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: compute, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: compute, storageTexture: { access: "write-only", format: "rgba16float" } },
      { binding: 4, visibility: compute, buffer: { type: "uniform" } }
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
    this.consume = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.consumeLayout] }),
      compute: { module: device.createShaderModule({ code: SHADING_WORK_MATERIAL_DIAGNOSTIC_WGSL }), entryPoint: "consume" }
    });
  }

  addToGraph(graph: FrameGraph, input: ShadingWorkInputs): Readonly<{
    color: ResourceId;
    queue: ResourceId;
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
        { binding: 2, resource: { buffer: uniform } }
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
    const queue = classify.create("ShadingWork queue", {
      kind: "transient_buffer", size: queueBytes, usage: GPUBufferUsage.STORAGE
    });

    const finalize = graph.add("Surface/finalize ShadingWork indirect", {}, (_data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const uniform = command.allocateTransientBufferAndLoad(params.buffer, GPUBufferUsage.UNIFORM);
      const bind = this.device.createBindGroup({ layout: this.finalizeLayout, entries: [
        { binding: 0, resource: { buffer: resources.get(queue) as GPUBuffer } },
        { binding: 1, resource: { buffer: resources.get(indirect) as GPUBuffer } },
        { binding: 2, resource: { buffer: uniform } }
      ] });
      const pass = command.beginComputePass({ label: "Surface/ShadingWork indirect" });
      pass.setPipeline(this.finalize);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(1);
      pass.end();
    });
    finalize.read(queue);
    const finalizedQueue = finalize.write(queue);
    const indirect = finalize.create("ShadingWork indirect args", {
      kind: "transient_buffer", size: 12, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT
    });

    const clear = graph.add("Surface/clear material diagnostic", {}, (_data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const pass = command.gpu_encoder.beginRenderPass({ colorAttachments: [{
        view: resolveTextureView(resources.get(color)),
        loadOp: "clear", storeOp: "store",
        clearValue: { r: 0.025, g: 0.035, b: 0.05, a: 1 }
      }] });
      pass.end();
    });
    const color = clear.create("Surface/material publication diagnostic", {
      kind: "transient_texture", width, height, format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING,
      domain: "internal-full"
    });

    const consume = graph.add("Surface/consume ShadingWork material diagnostic", {}, (_data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const uniform = command.allocateTransientBufferAndLoad(params.buffer, GPUBufferUsage.UNIFORM);
      const bind = this.device.createBindGroup({ layout: this.consumeLayout, entries: [
        { binding: 0, resource: { buffer: resources.get(finalizedQueue) as GPUBuffer } },
        { binding: 1, resource: { buffer: resources.get(input.meshletWork) as GPUBuffer } },
        { binding: 2, resource: { buffer: resources.get(input.materialRecords) as GPUBuffer } },
        { binding: 3, resource: resolveTextureView(resources.get(color)) },
        { binding: 4, resource: { buffer: uniform } }
      ] });
      const pass = command.beginComputePass({ label: "Surface/ShadingWork material diagnostic" });
      pass.setPipeline(this.consume);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroupsIndirect(resources.get(indirect) as GPUBuffer, 0);
      pass.end();
    });
    consume.read(finalizedQueue);
    consume.read(indirect);
    consume.read(input.meshletWork);
    consume.read(input.materialRecords);
    consume.read(color);
    return Object.freeze({ color: consume.write(color), queue: finalizedQueue });
  }
}

import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { GpuPackedMaterialBindings } from "../gpu/GpuPackedMaterialBindings.js";
import {
  GPU_MATERIAL_KERNEL_CLASS_COUNT,
  GPU_SHADE_CLASS_STATE_BYTES,
  GPU_SHADE_CLASSIFICATION_WORKGROUP_SIZE,
  GPU_SHADE_DRAW_INDIRECT_BYTES,
  computeGpuShadeWorkCapacity,
  type GpuShadeWorkCapacity
} from "../gpu/GpuMaterialKernelAbi.js";
import { writeGpuBuffer } from "../gpu/GpuQueueEvidence.js";
import { VISIBLE_PIXEL_CLASSIFICATION_WGSL } from "../shaders/visible_pixel_classification.js";

export interface VisiblePixelClassifierInputs {
  readonly visibilityKeys: GPUTextureView;
  readonly materials: GpuPackedMaterialBindings;
  readonly visibility: Readonly<{
    rasterWork: GPUBuffer;
    classCapacity: number;
  }>;
  readonly width: number;
  readonly height: number;
  readonly counterBuffer?: GPUBuffer;
}

export interface ShadeWorkOutput {
  readonly shadeWork: GPUBuffer;
  readonly classStates: GPUBuffer;
  readonly drawIndirect: GPUBuffer;
  readonly pixelCapacity: number;
  readonly classCount: number;
}

interface Resources {
  readonly capacity: GpuShadeWorkCapacity;
  readonly settings: GPUBuffer;
  readonly groupCounts: GPUBuffer;
  readonly groupPrefixes: GPUBuffer;
  readonly classTotals: GPUBuffer;
  readonly classStates: GPUBuffer;
  readonly drawIndirect: GPUBuffer;
  readonly shadeWork: GPUBuffer;
  readonly levelSums: readonly GPUBuffer[];
  readonly levelPrefixes: readonly GPUBuffer[];
  readonly buffers: readonly GPUBuffer[];
}

/**
 * Portable multi-workgroup count/prefix/scatter producer. Global atomics are
 * paid once per class per workgroup, never once per visible pixel.
 */
export class VisiblePixelClassifier {
  private readonly countLayout: GPUBindGroupLayout;
  private readonly scanLayout: GPUBindGroupLayout;
  private readonly addLayout: GPUBindGroupLayout;
  private readonly prepareLayout: GPUBindGroupLayout;
  private readonly scatterLayout: GPUBindGroupLayout;
  private readonly publishLayout: GPUBindGroupLayout;
  private readonly countPipeline: GPUComputePipeline;
  private readonly scanPipeline: GPUComputePipeline;
  private readonly addPipeline: GPUComputePipeline;
  private readonly preparePipeline: GPUComputePipeline;
  private readonly scatterPipeline: GPUComputePipeline;
  private readonly publishPipeline: GPUComputePipeline;
  private resources: Resources | null = null;
  private destroyed = false;

  constructor(private readonly device: GPUDevice) {
    const module = device.createShaderModule({
      label: "Visible pixel MaterialKernel classification",
      code: VISIBLE_PIXEL_CLASSIFICATION_WGSL
    });
    this.countLayout = device.createBindGroupLayout({
      label: "Visible pixel classification/group0",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 16 } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
      ]
    });
    this.scanLayout = device.createBindGroupLayout({
      label: "Visible pixel classification/scan group1",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 16 } }
      ]
    });
    this.addLayout = device.createBindGroupLayout({
      label: "Visible pixel classification/add group2",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 16 } }
      ]
    });
    this.prepareLayout = device.createBindGroupLayout({
      label: "Visible pixel classification/prepare group3",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
      ]
    });
    this.scatterLayout = device.createBindGroupLayout({
      label: "Visible pixel classification/scatter group1",
      entries: [
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
      ]
    });
    this.publishLayout = device.createBindGroupLayout({
      label: "Visible pixel classification/counter group1",
      entries: [
        { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
      ]
    });
    const empty = device.createBindGroupLayout({ label: "Visible pixel classification/empty", entries: [] });
    this.countPipeline = computePipeline(device, "count", module, "count_visible_pixels", [this.countLayout]);
    this.scanPipeline = computePipeline(device, "scan", module, "scan_blocks", [empty, this.scanLayout]);
    this.addPipeline = computePipeline(device, "add", module, "add_block_prefixes", [empty, empty, this.addLayout]);
    this.preparePipeline = computePipeline(device, "prepare", module, "prepare_classes", [empty, empty, empty, this.prepareLayout]);
    this.scatterPipeline = computePipeline(
      device,
      "scatter",
      module,
      "scatter_visible_pixels",
      [this.countLayout, this.scatterLayout]
    );
    this.publishPipeline = computePipeline(
      device,
      "publish counters",
      module,
      "publish_classification_counters",
      [empty, this.publishLayout]
    );
  }

  encode(command: ShadeGPUCommandContext, inputs: VisiblePixelClassifierInputs): ShadeWorkOutput {
    this.assertAlive();
    const resources = this.ensureResources(inputs.width, inputs.height);
    const { capacity } = resources;
    writeGpuBuffer(this.device.queue, "ShadeWork/settings", resources.settings, 0, new Uint32Array([
      inputs.width,
      inputs.height,
      inputs.visibility.classCapacity,
      capacity.workgroupCount
    ]));
    command.clearBuffer(resources.classTotals);

    const countGroup = this.device.createBindGroup({
      label: "Visible pixel classification/count bindings",
      layout: this.countLayout,
      entries: [
        { binding: 0, resource: inputs.visibilityKeys },
        { binding: 1, resource: { buffer: inputs.materials.materialRecords } },
        { binding: 2, resource: { buffer: inputs.visibility.rasterWork } },
        { binding: 3, resource: { buffer: resources.settings } },
        { binding: 4, resource: { buffer: resources.groupCounts } },
        { binding: 5, resource: { buffer: resources.classTotals } }
      ]
    });
    const count = command.beginComputePass({ label: "MaterialKernel/count visible pixels" });
    count.setPipeline(this.countPipeline);
    count.setBindGroup(0, countGroup);
    count.dispatchWorkgroups(capacity.dispatchWorkgroupsX, capacity.dispatchWorkgroupsY);
    count.end();

    const scanOutputs: GPUBuffer[] = [resources.groupPrefixes, ...resources.levelPrefixes];
    const scanInputs: GPUBuffer[] = [resources.groupCounts, ...resources.levelSums.slice(0, -1)];
    const elementCounts = [capacity.workgroupCount, ...capacity.scanLevelElementCounts.slice(0, -1)];
    for (let level = 0; level < scanInputs.length; level++) {
      const elementCount = elementCounts[level]!;
      const blockCount = Math.ceil(elementCount / GPU_SHADE_CLASSIFICATION_WORKGROUP_SIZE);
      const settings = command.allocateTransientBufferAndLoad(
        new Uint32Array([elementCount, blockCount, 0, 0]).buffer,
        GPUBufferUsage.UNIFORM
      );
      const group = this.device.createBindGroup({
        label: `MaterialKernel/scan level ${level}`,
        layout: this.scanLayout,
        entries: [
          { binding: 0, resource: { buffer: scanInputs[level]! } },
          { binding: 1, resource: { buffer: scanOutputs[level]! } },
          { binding: 2, resource: { buffer: resources.levelSums[level]! } },
          { binding: 3, resource: { buffer: settings } }
        ]
      });
      const pass = command.beginComputePass({ label: `MaterialKernel/prefix scan level ${level}` });
      pass.setPipeline(this.scanPipeline);
      pass.setBindGroup(1, group);
      pass.dispatchWorkgroups(blockCount, GPU_MATERIAL_KERNEL_CLASS_COUNT);
      pass.end();
    }

    for (let level = scanOutputs.length - 2; level >= 0; level--) {
      const elementCount = elementCounts[level]!;
      const blockCount = Math.ceil(elementCount / GPU_SHADE_CLASSIFICATION_WORKGROUP_SIZE);
      const settings = command.allocateTransientBufferAndLoad(
        new Uint32Array([elementCount, blockCount, 0, 0]).buffer,
        GPUBufferUsage.UNIFORM
      );
      const group = this.device.createBindGroup({
        label: `MaterialKernel/add prefix level ${level}`,
        layout: this.addLayout,
        entries: [
          { binding: 0, resource: { buffer: scanOutputs[level]! } },
          { binding: 1, resource: { buffer: scanOutputs[level + 1]! } },
          { binding: 2, resource: { buffer: settings } }
        ]
      });
      const pass = command.beginComputePass({ label: `MaterialKernel/add block prefixes level ${level}` });
      pass.setPipeline(this.addPipeline);
      pass.setBindGroup(2, group);
      pass.dispatchWorkgroups(blockCount, GPU_MATERIAL_KERNEL_CLASS_COUNT);
      pass.end();
    }

    const prepareGroup = this.device.createBindGroup({
      label: "MaterialKernel/prepare indirect bindings",
      layout: this.prepareLayout,
      entries: [
        { binding: 0, resource: { buffer: resources.classTotals } },
        { binding: 1, resource: { buffer: resources.classStates } },
        { binding: 2, resource: { buffer: resources.drawIndirect } }
      ]
    });
    const prepare = command.beginComputePass({ label: "MaterialKernel/prepare class ranges and indirect draws" });
    prepare.setPipeline(this.preparePipeline);
    prepare.setBindGroup(3, prepareGroup);
    prepare.dispatchWorkgroups(1);
    prepare.end();

    const scatterGroup = this.device.createBindGroup({
      label: "Visible pixel classification/scatter bindings",
      layout: this.scatterLayout,
      entries: [
        { binding: 4, resource: { buffer: resources.groupPrefixes } },
        { binding: 5, resource: { buffer: resources.classStates } },
        { binding: 6, resource: { buffer: resources.shadeWork } }
      ]
    });
    const scatter = command.beginComputePass({ label: "MaterialKernel/scatter ShadeWork" });
    scatter.setPipeline(this.scatterPipeline);
    scatter.setBindGroup(0, countGroup);
    scatter.setBindGroup(1, scatterGroup);
    scatter.dispatchWorkgroups(capacity.dispatchWorkgroupsX, capacity.dispatchWorkgroupsY);
    scatter.end();

    if (inputs.counterBuffer !== undefined) {
      const publishGroup = this.device.createBindGroup({
        label: "MaterialKernel/counter bindings",
        layout: this.publishLayout,
        entries: [
          { binding: 7, resource: { buffer: resources.classStates } },
          { binding: 8, resource: { buffer: inputs.counterBuffer } }
        ]
      });
      const publish = command.beginComputePass({ label: "MaterialKernel/publish sampled counters" });
      publish.setPipeline(this.publishPipeline);
      publish.setBindGroup(1, publishGroup);
      publish.dispatchWorkgroups(1);
      publish.end();
    }

    return Object.freeze({
      shadeWork: resources.shadeWork,
      classStates: resources.classStates,
      drawIndirect: resources.drawIndirect,
      pixelCapacity: capacity.pixelCapacity,
      classCount: GPU_MATERIAL_KERNEL_CLASS_COUNT
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const resources = this.resources;
    this.resources = null;
    if (resources !== null) {
      const destroy = (): void => this.destroyResources(resources);
      void this.device.queue.onSubmittedWorkDone().then(destroy, destroy);
    }
  }

  private ensureResources(width: number, height: number): Resources {
    const capacity = computeGpuShadeWorkCapacity(width, height, this.device.limits);
    if (this.resources?.capacity.pixelCapacity === capacity.pixelCapacity &&
        this.resources.capacity.workgroupCount === capacity.workgroupCount) {
      return this.resources;
    }
    const previous = this.resources;
    const buffers: GPUBuffer[] = [];
    const create = (label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer => {
      const buffer = this.device.createBuffer({ label, size: Math.max(4, size), usage });
      buffers.push(buffer);
      return buffer;
    };
    const levelSums: GPUBuffer[] = [];
    const levelPrefixes: GPUBuffer[] = [];
    for (let level = 0; level < capacity.scanLevelElementCounts.length; level++) {
      const bytes = capacity.scanLevelElementCounts[level]! * GPU_MATERIAL_KERNEL_CLASS_COUNT * 4;
      levelSums.push(create(`ShadeWork/scan sums ${level}`, bytes, STORAGE));
      if (level < capacity.scanLevelElementCounts.length - 1) {
        levelPrefixes.push(create(`ShadeWork/scan prefixes ${level}`, bytes, STORAGE));
      }
    }
    this.resources = {
      capacity,
      settings: create("ShadeWork/settings", 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      groupCounts: create("ShadeWork/group counts", capacity.groupCountBytes, STORAGE),
      groupPrefixes: create("ShadeWork/group prefixes", capacity.groupPrefixBytes, STORAGE),
      classTotals: create("ShadeWork/class totals", GPU_MATERIAL_KERNEL_CLASS_COUNT * 4, STORAGE),
      classStates: create("ShadeWork/class states", GPU_SHADE_CLASS_STATE_BYTES, STORAGE),
      drawIndirect: create("ShadeWork/drawIndirect", GPU_SHADE_DRAW_INDIRECT_BYTES, STORAGE | GPUBufferUsage.INDIRECT),
      shadeWork: create("ShadeWork/pixel queue", capacity.queueBytes, STORAGE),
      levelSums: Object.freeze(levelSums),
      levelPrefixes: Object.freeze(levelPrefixes),
      buffers: Object.freeze(buffers)
    };
    if (previous !== null) {
      const destroy = (): void => this.destroyResources(previous);
      void this.device.queue.onSubmittedWorkDone().then(destroy, destroy);
    }
    return this.resources;
  }

  private destroyResources(resources: Resources | null): void {
    if (resources === null) return;
    for (const buffer of resources.buffers) buffer.destroy();
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error("VisiblePixelClassifier is destroyed");
  }
}

const STORAGE = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;

function computePipeline(
  device: GPUDevice,
  label: string,
  module: GPUShaderModule,
  entryPoint: string,
  bindGroupLayouts: readonly GPUBindGroupLayout[]
): GPUComputePipeline {
  return device.createComputePipeline({
    label: `MaterialKernel/${label}`,
    layout: device.createPipelineLayout({ bindGroupLayouts }),
    compute: { module, entryPoint }
  });
}

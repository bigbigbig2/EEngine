import type { VsmResources } from "./VsmResources.js";
import { VSM_MAX_CLIP_LEVELS, VSM_PROJECTION_CONSTANT_BYTES } from "../../gpu/GpuVsmProjectionAbi.js";
import { PreparedComputePipeline } from "../../gpu/PreparedPipeline.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { GpuBindGroupCache } from "../../gpu/GpuBindGroupResourceCache.js";
import { VSM_SAMPLING_PUBLICATION_WGSL } from "../../shaders/vsm_sampling_publication.js";
import { vsmMipStorageAxis } from "./VsmPageState.js";

export const VSM_SAMPLING_DESCRIPTOR_BYTES = 16;

export function vsmSamplingDescriptorCount(pages: number, levels: number): number {
  if (
    !Number.isSafeInteger(pages) ||
    pages < 1 ||
    !Number.isSafeInteger(levels) ||
    levels < 1 ||
    levels > VSM_MAX_CLIP_LEVELS
  ) {
    throw new RangeError("VSM sampling publication requires a complete clip/page domain");
  }
  const coarse = vsmMipStorageAxis(pages, 5);
  return levels * (pages * pages + coarse * coarse);
}

/** Persistent VSM descriptors are initialized once, then updated from mutations.
 * Every fresh final-lighting scratch segment still receives a complete copy.
 * CPU initialization bookkeeping advances only on submit, never on abort. */
export class VsmSamplingPublicationPass {
  async preparePipelines(): Promise<void> {
    await Promise.all([this.pipeline.prepare(), this.initialize.prepare(), this.finish.prepare()]);
  }

  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: PreparedComputePipeline;
  private readonly initialize: PreparedComputePipeline;
  private readonly finish: PreparedComputePipeline;
  private readonly groups = new GpuBindGroupCache();
  private destroyed = false;
  private readonly initializedEpochs = new WeakMap<GPUBuffer, number>();

  constructor(private readonly device: GPUDevice) {
    this.layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform", minBindingSize: VSM_PROJECTION_CONSTANT_BYTES }
        },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
      ]
    });
    this.pipeline = new PreparedComputePipeline(device, {
      label: "VSM/sampling descriptor publication",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: {
        module: device.createShaderModule({ code: VSM_SAMPLING_PUBLICATION_WGSL }),
        entryPoint: "main"
      }
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const module = device.createShaderModule({ code: VSM_SAMPLING_PUBLICATION_WGSL });
    this.initialize = new PreparedComputePipeline(device, {
      label: "VSM/initialize persistent descriptors",
      layout,
      compute: { module, entryPoint: "main", constants: { initialize: 1 } }
    });
    this.finish = new PreparedComputePipeline(device, {
      label: "VSM/finish descriptor initialization",
      layout,
      compute: { module, entryPoint: "finish_initialization" }
    });
    void device.lost.then(() => this.destroy());
  }

  addToGraph(
    graph: FrameGraph,
    input: {
      resources: VsmResources;
      mutations: ResourceId;
      pages: number;
      levels: number;
      constants: ResourceId;
      pageTable: ResourceId;
      contentVersion: ResourceId;
      /** Final frame-directory version, written only in this bounded segment. */
      target?: { readonly resource: ResourceId; readonly offset: number; readonly size: number };
    }
  ): ResourceId {
    const count = vsmSamplingDescriptorCount(input.pages, input.levels);
    const bytes = count * VSM_SAMPLING_DESCRIPTOR_BYTES;
    const groups = Math.ceil(count / 64);
    if (this.destroyed) {
      throw new Error("VSM sampling publication is destroyed");
    }
    if (
      !Number.isSafeInteger(bytes) ||
      bytes > this.device.limits.maxStorageBufferBindingSize ||
      bytes > this.device.limits.maxBufferSize ||
      groups > this.device.limits.maxComputeWorkgroupsPerDimension
    ) {
      throw new RangeError("VSM sampling publication exceeds negotiated capacity");
    }
    if (
      input.target &&
      (input.target.size !== bytes ||
        input.target.offset < 0 ||
        !Number.isSafeInteger(input.target.offset) ||
        input.target.offset % this.device.limits.minStorageBufferOffsetAlignment !== 0)
    ) {
      throw new RangeError("VSM publication target must cover the complete aligned descriptor domain");
    }
    const persistent = graph.import_resource(
      "VSM/persistent sampling descriptors",
      { kind: "imported" },
      input.resources.getBuffer("samplingDescriptors")!
    );
    let output = persistent;
    const publish = graph.add("VSM/sampling descriptor publication", input, (data, resources, context) => {
      if (this.destroyed) {
        throw new Error("VSM sampling publication was destroyed before encoding");
      }
      const group = this.groups.create(this.device, {
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: resources.get(data.constants) as GPUBuffer } },
          { binding: 1, resource: { buffer: resources.get(data.pageTable) as GPUBuffer } },
          {
            binding: 2,
            resource: {
              buffer: resources.get(output) as GPUBuffer
            }
          },
          { binding: 3, resource: { buffer: resources.get(data.mutations) as GPUBuffer } }
        ]
      });
      const pass = (context.encoder as ShadeGPUCommandContext).beginComputePass({
        label: "VSM/sampling descriptor publication"
      });
      const descriptorBuffer = resources.get(output) as GPUBuffer;
      const epoch = data.resources.samplingDescriptorEpoch;
      const initialize = this.initializedEpochs.get(descriptorBuffer) !== epoch;
      if (initialize) {
        pass.setPipeline(this.initialize.requirePrepared());
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(groups);
      }
      pass.setPipeline(this.pipeline.requirePrepared());
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(Math.ceil(count / 32) / 64));
      if (initialize) {
        pass.setPipeline(this.finish.requirePrepared());
        pass.dispatchWorkgroups(1);
        (context.encoder as ShadeGPUCommandContext).onFinished.addOne(() =>
          this.initializedEpochs.set(descriptorBuffer, epoch)
        );
      }
      pass.end();
    });
    publish.read(input.constants);
    publish.read(input.pageTable);
    // The version is an ordering product: never use allocation as content-ready.
    publish.read(input.contentVersion);
    publish.write(input.mutations);
    output = publish.write(persistent);
    if (input.target) {
      const target = input.target;
      const copy = graph.add(
        "VSM/copy descriptors into final lighting directory",
        {},
        (_data, resolved, context) => {
          (context.encoder as ShadeGPUCommandContext).copyBufferToBuffer(
            resolved.get(output) as GPUBuffer,
            0,
            resolved.get(target.resource) as GPUBuffer,
            target.offset,
            bytes
          );
        }
      );
      copy.read(output);
      return copy.write(target.resource);
    }
    return output;
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.groups.clear();
  }
}

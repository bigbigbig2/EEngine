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
    levels > 6
  ) {
    throw new RangeError("VSM sampling publication requires a complete clip/page domain");
  }
  const coarse = vsmMipStorageAxis(pages, 5);
  return levels * (pages * pages + coarse * coarse);
}

/** VSM owns publication; the FrameGraph pool owns per-frame output/fences.
 * Abort cannot publish or advance a cache version: every submitted frame fully
 * overwrites the product after its current page-table/content commit. */
export class VsmSamplingPublicationPass {
  async preparePipelines(): Promise<void> {
    await Promise.all([this.pipeline.prepare()]);
  }

  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: PreparedComputePipeline;
  private readonly groups = new GpuBindGroupCache();
  private destroyed = false;

  constructor(private readonly device: GPUDevice) {
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 256 } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    this.pipeline = new PreparedComputePipeline(device, {
      label: "VSM/sampling descriptor publication",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: {
        module: device.createShaderModule({ code: VSM_SAMPLING_PUBLICATION_WGSL }),
        entryPoint: "main",
      },
    });
    void device.lost.then(() => this.destroy());
  }

  addToGraph(
    graph: FrameGraph,
    input: {
      pages: number;
      levels: number;
      constants: ResourceId;
      pageTable: ResourceId;
      contentVersion: ResourceId;
      /** Final frame-directory version, written only in this bounded segment. */
      target?: { readonly resource: ResourceId; readonly offset: number; readonly size: number };
    },
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
    let output = -1;
    const publish = graph.add("VSM/sampling descriptor publication", input, (data, resources, context) => {
      if (this.destroyed) {
        throw new Error("VSM sampling publication was destroyed before encoding");
      }
      if (data.target && (resources.get(output) as GPUBuffer).size < data.target.offset + data.target.size) {
        throw new RangeError("VSM publication container omits part of the descriptor domain");
      }
      const group = this.groups.create(this.device, {
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: resources.get(data.constants) as GPUBuffer } },
          { binding: 1, resource: { buffer: resources.get(data.pageTable) as GPUBuffer } },
          {
            binding: 2,
            resource: {
              buffer: resources.get(output) as GPUBuffer,
              ...(data.target ? { offset: data.target.offset, size: data.target.size } : {}),
            },
          },
        ],
      });
      const pass = (context.encoder as ShadeGPUCommandContext).beginComputePass({
        label: "VSM/sampling descriptor publication",
      });
      pass.setPipeline(this.pipeline.requirePrepared());
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(groups);
      pass.end();
    });
    publish.read(input.constants);
    publish.read(input.pageTable);
    // The version is an ordering product: never use allocation as content-ready.
    publish.read(input.contentVersion);
    output = input.target
      ? publish.write(input.target.resource)
      : publish.create("VSM/sampling descriptors", {
          kind: "transient_buffer",
          size: bytes,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });
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

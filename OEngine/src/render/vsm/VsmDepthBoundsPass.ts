import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { VSM_DEPTH_BOUNDS_WGSL } from "../../shaders/vsm_depth_bounds.js";
import type { VsmResources } from "./VsmResources.js";
import type { VsmDirectionalFrameConstants } from "./VsmProjection.js";
import type { VsmGenerationState } from "./VsmGeneration.js";

export class VsmDepthBoundsPass {
  private readonly constants: GPUBuffer;
  private scratch: GPUBuffer;
  private readonly layout: GPUBindGroupLayout;
  private readonly boundsPipeline: GPUComputePipeline;
  private readonly publishPipeline: GPUComputePipeline;
  constructor(private readonly device: GPUDevice) {
    this.constants = device.createBuffer({
      label: "VSM/depth bounds constants",
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.scratch = device.createBuffer({
      label: "VSM/depth bounds partial",
      size: 16,
      usage: GPUBufferUsage.STORAGE
    });
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
      ]
    });
    const module = device.createShaderModule({
      label: "VSM/stable depth bounds",
      code: VSM_DEPTH_BOUNDS_WGSL
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    this.boundsPipeline = device.createComputePipeline({
      layout,
      compute: { module, entryPoint: "instance_bounds" }
    });
    this.publishPipeline = device.createComputePipeline({
      layout,
      compute: { module, entryPoint: "publish_depth" }
    });
  }
  prepareFrame(instanceCount: number, command: ShadeGPUCommandContext): void {
    const groups = Math.max(1, Math.ceil(instanceCount / 64));
    const bytes = groups * 16;
    if (
      !Number.isSafeInteger(instanceCount) ||
      instanceCount < 0 ||
      groups > this.device.limits.maxComputeWorkgroupsPerDimension ||
      bytes > this.device.limits.maxStorageBufferBindingSize ||
      bytes > this.device.limits.maxBufferSize
    ) {
      throw new RangeError("VSM complete caster bounds exceed the supported reduction domain");
    }
    if (bytes > this.scratch.size) {
      const next = this.device.createBuffer({
        label: "VSM/depth bounds partial",
        size: bytes,
        usage: GPUBufferUsage.STORAGE
      });
      command.destroyAfterGpuDone(this.scratch);
      this.scratch = next;
    }
  }
  addToGraph(
    graph: FrameGraph,
    input: {
      resources: VsmResources;
      frame: VsmDirectionalFrameConstants;
      state: VsmGenerationState;
      instances: ResourceId;
      instanceBegin: number;
      instanceCount: number;
    }
  ): ResourceId {
    const product = graph.import_resource(
      "VSM/stable depth range",
      { kind: "imported" },
      input.resources.depthRange!
    );
    const produce = graph.add("VSM/epoch caster depth bounds", input, (data, resolved, context) => {
      if (!data.state.rebuildDepth) {
        return;
      }
      const command = context.encoder as ShadeGPUCommandContext;
      const groups = Math.max(1, Math.ceil(data.instanceCount / 64));
      const packed = new ArrayBuffer(80);
      new Float32Array(packed).set(data.frame.lightView);
      new Uint32Array(packed).set(
        [data.instanceBegin, data.instanceCount, groups, data.frame.projectionEpoch],
        16
      );
      command.writeBuffer(this.constants, 0, packed, 0, 80);
      const group = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.constants } },
          { binding: 1, resource: { buffer: resolved.get(data.instances) as GPUBuffer } },
          { binding: 2, resource: { buffer: this.scratch } },
          { binding: 3, resource: { buffer: resolved.get(product) as GPUBuffer } }
        ]
      });
      const bounds = command.beginComputePass({ label: "VSM/complete caster bounds" });
      bounds.setPipeline(this.boundsPipeline);
      bounds.setBindGroup(0, group);
      bounds.dispatchWorkgroups(groups);
      bounds.end();
      const publish = command.beginComputePass({ label: "VSM/publish stable depth" });
      publish.setPipeline(this.publishPipeline);
      publish.setBindGroup(0, group);
      publish.dispatchWorkgroups(1);
      publish.end();
    });
    produce.read(input.instances);
    produce.make_side_effect();
    return produce.write(product);
  }
  destroy(): void {
    this.constants.destroy();
    this.scratch.destroy();
  }
}

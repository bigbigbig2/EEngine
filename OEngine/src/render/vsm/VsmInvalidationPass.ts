import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { VsmGenerationState } from "./VsmGeneration.js";
import type { VsmResources } from "./VsmResources.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import { VSM_INVALIDATION_WGSL } from "../../shaders/vsm_invalidation.js";
import { packVsmProjection, type VsmDirectionalFrameConstants } from "./VsmProjection.js";

/**
 * Publishes VSM lifecycle facts inside the current command context.  The pass
 * never maps a GPU buffer and never chooses visible page work on the CPU.
 */
export class VsmInvalidationPass {
  private readonly constants: GPUBuffer;
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  constructor(private readonly device: GPUDevice) {
    this.constants = device.createBuffer({
      label: "VSM/window invalidation constants",
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        ...[1, 2, 3].map((binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" as GPUBufferBindingType },
        })),
      ],
    });
    this.pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module: device.createShaderModule({ code: VSM_INVALIDATION_WGSL }), entryPoint: "main" },
    });
  }
  addToGraph(
    graph: FrameGraph,
    input: {
      readonly resources: VsmResources;
      readonly state: VsmGenerationState;
      readonly frame: VsmDirectionalFrameConstants;
    },
  ): ResourceId | null {
    if (input.resources.profile === "shadow-disabled") return null;
    const generation = input.resources.generation;
    const overflowCounters = input.resources.overflowCounters;
    const contentVersion = input.resources.contentVersion;
    if (!generation || !overflowCounters || !contentVersion) {
      throw new Error("VSM invalidation resources are unavailable");
    }
    const generationResource = graph.import_resource(
      "VSM/generation facts",
      { kind: "imported", label: "VSM generation facts" },
      generation,
    );
    const overflowResource = graph.import_resource(
      "VSM/invalidation telemetry",
      { kind: "imported", label: "VSM overflow telemetry" },
      overflowCounters,
    );
    const contentResource = graph.import_resource(
      "VSM/content publication",
      { kind: "imported", label: "VSM content version" },
      contentVersion,
    );
    const pageResource = graph.import_resource(
      "VSM/window pages",
      { kind: "imported" },
      input.resources.pageTable!,
    );
    const metaResource = graph.import_resource(
      "VSM/window slots",
      { kind: "imported" },
      input.resources.metaTable!,
    );
    const node = graph.add("VSM/publish invalidation facts", input, (data, resources, context) => {
      const state = data.state;
      const command = context.encoder as ShadeGPUCommandContext;
      const generationBuffer = resources.get(generationResource) as GPUBuffer;
      const overflowBuffer = resources.get(overflowResource) as GPUBuffer;
      const flags =
        (state.fullInvalidate ? 1 : 0) |
        (state.temporalInvalidate ? 2 : 0) |
        (state.pageQuantumChanged ? 4 : 0) |
        (state.resized ? 8 : 0);
      const header = new Uint32Array([
        state.generation >>> 0,
        state.deviceEpoch >>> 0,
        state.reasonMask >>> 0,
        flags >>> 0,
        state.sceneRevision >>> 0,
        state.casterRevision >>> 0,
        state.projectionEpoch,
        state.frameSerial,
      ]);
      command.writeBuffer(generationBuffer, 0, header.buffer, 0, header.byteLength);
      // Keep diagnostics frame-local while preserving the GPU-only control
      // path. Allocation and caster passes overwrite their own ranges.
      command.clearBuffer(overflowBuffer);
      command.clearBuffer(resources.get(contentResource) as GPUBuffer, 4, 4);
      if (state.fullInvalidate || state.pageQuantumChanged) {
        const packed = packVsmProjection(data.frame);
        const words = new Uint32Array(packed);
        const capabilities = data.resources.capabilities;
        words.set([capabilities.virtualPagesPerAxis, capabilities.atlasPagesPerAxis, 0, 0], 40);
        words.set([state.generation, state.fullInvalidate ? 1 : 0, 0, 0], 44);
        command.writeBuffer(this.constants, 0, packed, 0, packed.byteLength);
        const group = this.device.createBindGroup({
          layout: this.layout,
          entries: [
            { binding: 0, resource: { buffer: this.constants } },
            { binding: 1, resource: { buffer: resources.get(pageResource) as GPUBuffer } },
            { binding: 2, resource: { buffer: resources.get(metaResource) as GPUBuffer } },
            { binding: 3, resource: { buffer: resources.get(contentResource) as GPUBuffer } },
          ],
        });
        const pass = command.beginComputePass({ label: "VSM/revoke departed world pages" });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(capabilities.virtualEntryCount / 64));
        pass.end();
      }
    });
    node.write(generationResource);
    node.write(overflowResource);
    node.write(pageResource);
    node.write(metaResource);
    node.make_side_effect();
    return node.write(contentResource);
  }
  destroy(): void {
    this.constants.destroy();
  }
}

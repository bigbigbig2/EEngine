import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { VsmGenerationState } from "./VsmGeneration.js";
import type { VsmResources } from "./VsmResources.js";

/**
 * Publishes VSM lifecycle facts inside the current command context.  The pass
 * never maps a GPU buffer and never chooses visible page work on the CPU.
 */
export class VsmInvalidationPass {
  addToGraph(graph: FrameGraph, input: {
    readonly resources: VsmResources;
    readonly state: VsmGenerationState;
  }): void {
    if (input.resources.profile === "shadow-disabled") return;
    const generation = input.resources.generation;
    const dirtyMask = input.resources.dirtyMask;
    const overflowCounters = input.resources.overflowCounters;
    if (!generation || !dirtyMask || !overflowCounters) {
      throw new Error("VSM invalidation resources are unavailable");
    }
    const generationResource = graph.import_resource(
      "VSM/generation facts", { kind: "imported", label: "VSM generation facts" }, generation);
    const dirtyResource = graph.import_resource(
      "VSM/invalidation dirty mask", { kind: "imported", label: "VSM dirty mask" }, dirtyMask);
    const overflowResource = graph.import_resource(
      "VSM/invalidation telemetry", { kind: "imported", label: "VSM overflow telemetry" }, overflowCounters);
    const node = graph.add("VSM/publish invalidation facts", input.state,
      (state, resources, context) => {
        const command = context.encoder as ShadeGPUCommandContext;
        const generationBuffer = resources.get(generationResource) as GPUBuffer;
        const dirtyBuffer = resources.get(dirtyResource) as GPUBuffer;
        const overflowBuffer = resources.get(overflowResource) as GPUBuffer;
        const flags = (state.fullInvalidate ? 1 : 0) |
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
          state.sunRevision >>> 0,
          0
        ]);
        command.writeBuffer(generationBuffer, 0, header.buffer, 0, header.byteLength);
        // A generation mismatch already makes old pages non-sampleable. The
        // bounded mask is cleared only for a full invalidation; allocation and
        // raster passes publish new dirty bits in the same frame.
        if (state.fullInvalidate) command.clearBuffer(dirtyBuffer);
        // Keep diagnostics frame-local while preserving the GPU-only control
        // path. Allocation and caster passes overwrite their own ranges.
        command.clearBuffer(overflowBuffer);
      });
    node.write(generationResource);
    node.write(dirtyResource);
    node.write(overflowResource);
    node.make_side_effect();
  }
}

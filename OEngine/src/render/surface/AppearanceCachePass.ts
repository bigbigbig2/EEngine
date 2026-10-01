import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { GpuAppearanceCache } from "../../gpu/GpuAppearanceCache.js";
import type { GpuAppearancePublication } from "../../gpu/GpuAppearancePublication.js";
import { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";

/** FrameGraph owner for Appearance page state. Demand/evaluate pipelines are
 * compiled per publication; this pass owns the shared reset/age/publish fence
 * and uploads live numeric inputs before any field consumer reads them. */
export class AppearanceCachePass {
  constructor(private readonly cache: GpuAppearanceCache) {}
  addToGraph(graph: FrameGraph, input: { readonly visibility: ResourceId; readonly publication: GpuAppearancePublication; readonly frame: number }): void {
    const pass = graph.add("Appearance cache state and live inputs", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      data.publication.syncRuntime(command);
      this.cache.encode(command, data.publication.cache, data.frame);
    });
    pass.read(input.visibility);
    pass.make_side_effect();
  }
}

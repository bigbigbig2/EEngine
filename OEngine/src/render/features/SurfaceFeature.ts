import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import {
  PackedMaterialResolvePass,
  type PackedMaterialResolveJob,
  type PackedMaterialResolveOutputs
} from "../passes/PackedMaterialResolvePass.js";

export interface SurfaceFeatureInputs {
  readonly visibilityKey: ResourceId;
  readonly view: ResourceId;
  readonly counters?: ResourceId;
}

/**
 * P3 Surface Feature：将 VisibilityKey 的 GPU lookup 和一次 Resolve draw
 * 作为唯一 Surface producer 边界，向 Lighting/AO/SSR/Temporal 输出 Surface。
 */
export class SurfaceFeature {
  private readonly implementation: PackedMaterialResolvePass;

  constructor(graphics: GraphicsContext) {
    this.implementation = new PackedMaterialResolvePass(graphics);
  }

  get lastKernelDrawCount(): number { return this.implementation.lastKernelDrawCount; }
  get lastActiveMaterialCount(): number { return this.implementation.lastActiveMaterialCount; }
  get surfaceBytesPerPixel(): number { return this.implementation.surfaceBytesPerPixel; }

  addToGraph(
    graph: FrameGraph,
    job: PackedMaterialResolveJob,
    inputs: SurfaceFeatureInputs,
    options?: Readonly<{ velocity: boolean }>
  ): PackedMaterialResolveOutputs {
    return this.implementation.addToGraph(graph, job, inputs, options);
  }

  destroy(): void {
    this.implementation.destroy();
  }
}

export type {
  PackedMaterialResolveJob,
  PackedMaterialResolveOutputs,
  ResourceId
};

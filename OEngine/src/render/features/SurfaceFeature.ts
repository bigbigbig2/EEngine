import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import {
  PackedMaterialResolvePass,
  type PackedMaterialResolveJob,
  type PackedMaterialResolveOutputs
} from "../passes/PackedMaterialResolvePass.js";
import type { VisibilityFrame } from "../pipeline/FrameProducts.js";

export interface SurfaceFeatureInputs {
  readonly visibility: VisibilityFrame;
  readonly view: ResourceId;
  readonly counters?: ResourceId;
}

/**
 * Surface Feature：将 VisibilityKey 的 GPU tile classification 和 indirect
 * compute material evaluation 作为唯一 Surface producer 边界，向
 * Lighting/AO/SSR/Temporal 输出紧凑 SurfaceLite。
 */
export class SurfaceFeature {
  private readonly implementation: PackedMaterialResolvePass;

  constructor(graphics: GraphicsContext) {
    this.implementation = new PackedMaterialResolvePass(graphics);
  }

  get lastActiveMaterialCount(): number { return this.implementation.lastActiveMaterialCount; }
  get surfaceBytesPerPixel(): number { return this.implementation.surfaceBytesPerPixel; }
  get materialResolveBackend(): "tile-compute" {
    return "tile-compute";
  }

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

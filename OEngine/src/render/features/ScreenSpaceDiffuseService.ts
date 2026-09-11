import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import {
  GPU_SHADING_SURFACE_LITE_PROFILE,
  type GpuShadingSurfaceLiteProfile
} from "../../gpu/GpuComputeMaterialAbi.js";
import {
  SsgiPass,
  type SsgiHistoryBindings,
  type SsgiInputs,
  type SsgiJob,
  type SsgiOutput
} from "../passes/SsgiPass.js";

/** Exclusive production owner used only when ScreenSpaceDiffuseMode is ssgi. */
export class ScreenSpaceDiffuseService {
  readonly implementation: SsgiPass;

  constructor(
    graphics: GraphicsContext,
    temporalEnabled: boolean,
    resolutionScale: 0.5 | 1,
    profile: GpuShadingSurfaceLiteProfile = GPU_SHADING_SURFACE_LITE_PROFILE
  ) {
    this.implementation = new SsgiPass(graphics, temporalEnabled, resolutionScale, profile);
  }

  addToGraph(graph: FrameGraph, job: SsgiJob, inputs: SsgiInputs, history?: SsgiHistoryBindings): SsgiOutput {
    return this.implementation.addToGraph(graph, job, inputs, history);
  }
  historyTexture(index: 0 | 1, kind: "ao" | "gi"): GPUTexture { return this.implementation.historyTexture(index, kind); }
  resize(width: number, height: number): void { this.implementation.resize(width, height); }
  resetFrameEvidence(): void { this.implementation.resetFrameEvidence(); }
  destroy(): void { this.implementation.destroy(); }
  get historyTextureCount(): number { return this.implementation.historyTextureCount; }
  get historyBytes(): number { return this.implementation.historyBytes; }
  get lastTracePasses(): number { return this.implementation.lastTracePasses; }
  get lastSpatialPasses(): number { return this.implementation.lastSpatialPasses; }
  get lastTemporalPasses(): number { return this.implementation.lastTemporalPasses; }
  get lastResolvePasses(): number { return this.implementation.lastResolvePasses; }
}

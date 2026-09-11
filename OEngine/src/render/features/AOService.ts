/**
 * P5 AO Service：统一 Material AO 之外的 GTAO visibility 与 bent normal。
 *
 * GTAO 只输出独立的 ambient visibility/bent normal，Material AO 仍由 Surface
 * 合同提供；具体采样、空间滤波和时域算法由现有 Pass 持有。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import {
  GPU_SHADING_SURFACE_LITE_PROFILE,
  type GpuShadingSurfaceLiteProfile
} from "../../gpu/GpuComputeMaterialAbi.js";
import {
  GtaoPass,
  type GtaoInputs,
  type GtaoJob,
  type GtaoOutput
} from "../passes/GtaoPass.js";

export class AOService {
  readonly implementation: GtaoPass;

  constructor(
    graphics: GraphicsContext,
    temporalEnabled: boolean,
    resolutionScale: 0.5 | 1,
    surfaceProfile: GpuShadingSurfaceLiteProfile = GPU_SHADING_SURFACE_LITE_PROFILE
  ) {
    this.implementation = new GtaoPass(
      graphics,
      temporalEnabled,
      resolutionScale,
      surfaceProfile
    );
  }

  get temporalEnabled(): boolean { return this.implementation.temporalEnabled; }
  get algorithm(): "three-gtao-r186-oengine-wgsl" { return this.implementation.algorithm; }
  get upstreamRevision(): string { return this.implementation.upstreamRevision; }
  get momentsFormat(): GPUTextureFormat { return this.implementation.momentsFormat; }
  get finalVisibilityFormat(): GPUTextureFormat { return this.implementation.finalVisibilityFormat; }
  get bentNormalFormat(): GPUTextureFormat { return this.implementation.bentNormalFormat; }
  get momentsBytesPerPixel(): number { return this.implementation.momentsBytesPerPixel; }
  get finalVisibilityBytesPerPixel(): number { return this.implementation.finalVisibilityBytesPerPixel; }
  get bentNormalBytesPerPixel(): number { return this.implementation.bentNormalBytesPerPixel; }
  get resolutionScale(): 0.5 | 1 { return this.implementation.resolutionScale; }
  get lastRan(): boolean { return this.implementation.lastRan; }
  get lastRawPasses(): number { return this.implementation.lastRawPasses; }
  get lastSpatialPasses(): number { return this.implementation.lastSpatialPasses; }
  get lastTemporalPasses(): number { return this.implementation.lastTemporalPasses; }
  get lastCompositePasses(): number { return this.implementation.lastCompositePasses; }
  get lastBentNormalUpsamplePasses(): number { return this.implementation.lastBentNormalUpsamplePasses; }
  get historyTextureCount(): number { return this.implementation.historyTextureCount; }
  get historyBytes(): number { return this.implementation.historyBytes; }

  resize(width: number, height: number): void { this.implementation.resize(width, height); }
  resetFrameEvidence(): void { this.implementation.resetFrameEvidence(); }
  historyTexture(index: 0 | 1): GPUTexture { return this.implementation.historyTexture(index); }

  addToGraph(
    graph: FrameGraph,
    job: GtaoJob,
    inputs: GtaoInputs,
    historyBindings?: { readonly input: unknown; readonly output: unknown }
  ): GtaoOutput {
    return this.implementation.addToGraph(graph, job, inputs, historyBindings);
  }

  destroy(): void { this.implementation.destroy(); }
}

export type { ResourceId };

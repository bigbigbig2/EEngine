/**
 * P5 Reflection Service：统一 Local/SSR 反射修正与 IBL fallback 的接入边界。
 *
 * 当前实现由 ScreenSpaceReflectionsPass 产生带置信度的修正结果，再由
 * SpecularCorrectionPass 与完整 opaque HDR 合成；miss 不覆盖 IBL 基线。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import {
  ScreenSpaceReflectionsPass,
  type ScreenSpaceReflectionsInputs,
  type ScreenSpaceReflectionsJob,
  type ScreenSpaceReflectionsOutput
} from "../passes/ScreenSpaceReflectionsPass.js";
import {
  SpecularCorrectionPass,
  type SpecularCorrectionInputs
} from "../passes/SpecularCorrectionPass.js";

export class ReflectionService {
  readonly implementation: ScreenSpaceReflectionsPass;
  readonly correction: SpecularCorrectionPass;
  readonly temporalEnabled: boolean;
  readonly resolutionScale: 0.5 | 1;

  constructor(
    graphics: GraphicsContext,
    temporalEnabled: boolean,
    resolutionScale: 0.5 | 1
  ) {
    this.temporalEnabled = temporalEnabled;
    this.resolutionScale = resolutionScale;
    this.implementation = new ScreenSpaceReflectionsPass(
      graphics,
      temporalEnabled,
      resolutionScale
    );
    this.correction = new SpecularCorrectionPass(graphics);
  }

  get lastRan(): boolean { return this.implementation.lastRan; }
  get lastTracePasses(): number { return this.implementation.lastTracePasses; }
  get lastPrefilterPasses(): number { return this.implementation.lastPrefilterPasses; }
  get lastResolvePasses(): number { return this.implementation.lastResolvePasses; }
  get lastSpatialPasses(): number { return this.implementation.lastSpatialPasses; }
  get lastTemporalPasses(): number { return this.implementation.lastTemporalPasses; }
  get historyTextureCount(): number { return this.implementation.historyTextureCount; }
  get historyBytes(): number { return this.implementation.historyBytes; }
  get lastCorrectionRan(): boolean { return this.correction.lastRan; }

  resize(width: number, height: number): void { this.implementation.resize(width, height); }
  resetFrameEvidence(): void {
    this.implementation.resetFrameEvidence();
    this.correction.lastRan = false;
  }
  historyTexture(index: 0 | 1): GPUTexture { return this.implementation.historyTexture(index); }

  addToGraph(
    graph: FrameGraph,
    job: ScreenSpaceReflectionsJob,
    inputs: ScreenSpaceReflectionsInputs,
    historyBindings: { readonly input: unknown; readonly output: unknown }
  ): ScreenSpaceReflectionsOutput {
    return this.implementation.addToGraph(graph, job, inputs, historyBindings);
  }

  addCorrection(graph: FrameGraph, inputs: SpecularCorrectionInputs): ResourceId {
    return this.correction.addToGraph(graph, inputs);
  }

  destroy(): void {
    this.implementation.destroy();
    this.correction.destroy();
  }
}

/**
 * P5 GI Service：收拢静态/动态间接光 Provider 与 IBL fallback 的 composition。
 *
 * 当前生产 owner 是 OpaqueLightingPipeline；它提供 IBL diffuse/specular 基线，
 * 并把后续 LPV/Brick4 provider 通过同一 IndirectComposite 合成，不复制 Surface 解释。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import {
  OpaqueLightingPipeline,
  type OpaqueIblInputs,
  type OpaqueLightingFrame
} from "../pipeline/OpaqueLightingPipeline.js";
import type { IndirectCompositeInputs } from "../passes/IndirectCompositePass.js";

export class GIService {
  readonly implementation: OpaqueLightingPipeline;

  constructor(graphics: GraphicsContext) {
    this.implementation = new OpaqueLightingPipeline(graphics);
  }

  addIblBaseline(
    graph: FrameGraph,
    extent: { readonly width: number; readonly height: number },
    inputs: OpaqueIblInputs
  ): OpaqueLightingFrame {
    return this.implementation.addIblBaseline(graph, extent, inputs);
  }

  addBaselineSpecular(
    graph: FrameGraph,
    extent: { readonly width: number; readonly height: number },
    inputs: Pick<OpaqueIblInputs, "bentNormal" | "normal" | "environment" | "pbr" | "depth" | "camera">
  ): ResourceId {
    return this.implementation.addBaselineSpecular(graph, extent, inputs);
  }

  composeIndirect(graph: FrameGraph, inputs: IndirectCompositeInputs): ResourceId {
    return this.implementation.composeIndirect(graph, inputs);
  }

  resetFrameEvidence(): void { this.implementation.resetFrameEvidence(); }
  destroy(): void { this.implementation.destroy(); }
}

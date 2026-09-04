import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import { IblDiffusePass } from "../passes/IblDiffusePass.js";
import { IblSpecularPass } from "../passes/IblSpecularPass.js";
import {
  OpaqueLightingResolvePass,
  type OpaqueLightingResolveInputs
} from "../passes/OpaqueLightingResolvePass.js";
import {
  opaqueLightingFrame,
  type AmbientOcclusionFrame,
  type OpaqueLightingFrame
} from "./FrameProducts.js";

export type { OpaqueLightingFrame } from "./FrameProducts.js";

export interface OpaqueIblInputs {
  readonly hdr: ResourceId;
  readonly depth: ResourceId;
  readonly normal: ResourceId;
  readonly bentNormal: ResourceId;
  readonly albedoAo: ResourceId;
  readonly pbr: ResourceId;
  readonly environment: ResourceId;
  readonly diffuseIrradiance: ResourceId;
  readonly splitSum: ResourceId;
  readonly camera: ResourceId;
  readonly metadata?: ResourceId;
  readonly ambientOcclusion?: Pick<AmbientOcclusionFrame, "visibility">;
}

/**
 * Composition owner for baseline opaque IBL. Concrete GPU passes remain
 * separate implementation details; Renderer consumes one immutable product.
 */
export class OpaqueLightingPipeline {
  private readonly specular: IblSpecularPass;
  private readonly diffuse: IblDiffusePass;
  private readonly resolvePass: OpaqueLightingResolvePass;

  constructor(graphics: GraphicsContext) {
    this.specular = new IblSpecularPass(graphics);
    this.diffuse = new IblDiffusePass(graphics);
    this.resolvePass = new OpaqueLightingResolvePass(graphics);
  }

  resolveIblBaseline(
    graph: FrameGraph,
    extent: { readonly width: number; readonly height: number },
    inputs: OpaqueIblInputs
  ): OpaqueLightingFrame {
    const iblSpecular = this.resolveBaselineSpecular(graph, extent, {
      bentNormal: inputs.bentNormal,
      normal: inputs.normal,
      environment: inputs.environment,
      pbr: inputs.pbr,
      depth: inputs.depth,
      camera: inputs.camera
    });
    const indirectDiffuse = this.diffuse.addToGraph(graph, extent, {
      bentNormal: inputs.bentNormal,
      albedoAo: inputs.albedoAo,
      environment: inputs.diffuseIrradiance,
      depth: inputs.depth
    }).indirectDiffuse;
    const hdr = this.resolve(graph, {
      hdr: inputs.hdr,
      depth: inputs.depth,
      normal: inputs.normal,
      bentNormal: inputs.bentNormal,
      albedoAo: inputs.albedoAo,
      pbr: inputs.pbr,
      splitSum: inputs.splitSum,
      indirectDiffuse,
      indirectSpecular: iblSpecular,
      ambientVisibility: inputs.ambientOcclusion?.visibility,
      camera: inputs.camera,
      metadata: inputs.metadata
    });
    return opaqueLightingFrame({
      hdr,
      iblSpecular,
      indirectDiffuse,
      domain: {
        domain: "internal-full" as const,
        width: extent.width,
        height: extent.height,
        scale: 1
      }
    });
  }

  resolveBaselineSpecular(
    graph: FrameGraph,
    extent: { readonly width: number; readonly height: number },
    inputs: Pick<OpaqueIblInputs, "bentNormal" | "normal" | "environment" | "pbr" | "depth" | "camera">
  ): ResourceId {
    return this.specular.addToGraph(graph, extent, inputs).indirectSpecular;
  }

  resolve(graph: FrameGraph, inputs: OpaqueLightingResolveInputs): ResourceId {
    return this.resolvePass.addToGraph(graph, inputs).hdr;
  }

  resetFrameEvidence(): void {
    this.resolvePass.lastRan = false;
  }

  destroy(): void {
    this.specular.destroy();
    this.diffuse.destroy();
    this.resolvePass.destroy();
  }
}

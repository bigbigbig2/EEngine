import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import {
  GPU_SHADING_SURFACE_LITE_PROFILE,
  type GpuShadingSurfaceLiteProfile
} from "../../gpu/GpuComputeMaterialAbi.js";
import { IblBaselinePass } from "../passes/IblBaselinePass.js";
import {
  OpaqueLightingResolvePass,
  type OpaqueLightingResolveInputs
} from "../passes/OpaqueLightingResolvePass.js";

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
  readonly metadata: ResourceId;
  readonly ambientVisibility?: ResourceId;
}

export interface FusedOpaqueIblFrame {
  readonly hdr: ResourceId;
  readonly iblSpecular: ResourceId | null;
  readonly indirectDiffuse: null;
  readonly domain: Readonly<{
    domain: "internal-full";
    width: number;
    height: number;
    scale: 1;
  }>;
}

/**
 * Composition owner for baseline opaque IBL. Concrete GPU passes remain
 * separate implementation details; Renderer consumes one immutable product.
 */
export class OpaqueLightingPipeline {
  private readonly fusedIbl: IblBaselinePass;
  private readonly resolvePass: OpaqueLightingResolvePass;

  constructor(
    graphics: GraphicsContext,
    surfaceProfile: GpuShadingSurfaceLiteProfile = GPU_SHADING_SURFACE_LITE_PROFILE
  ) {
    this.fusedIbl = new IblBaselinePass(graphics, surfaceProfile);
    this.resolvePass = new OpaqueLightingResolvePass(graphics, surfaceProfile);
  }

  resolveIblBaseline(
    graph: FrameGraph,
    extent: { readonly width: number; readonly height: number },
    inputs: OpaqueIblInputs,
    options: Readonly<{ baselineSpecular: boolean }>
  ): FusedOpaqueIblFrame {
    return this.resolveFusedBaseline(graph, extent, inputs, {
      ...options,
      diffuseSource: "octahedral"
    });
  }

  resolveScreenDiffuseBaseline(
    graph: FrameGraph,
    extent: { readonly width: number; readonly height: number },
    inputs: OpaqueIblInputs,
    options: Readonly<{ baselineSpecular: boolean }>
  ): FusedOpaqueIblFrame {
    return this.resolveFusedBaseline(graph, extent, inputs, {
      ...options,
      diffuseSource: "screen"
    });
  }

  private resolveFusedBaseline(
    graph: FrameGraph,
    extent: { readonly width: number; readonly height: number },
    inputs: OpaqueIblInputs,
    options: Readonly<{
      baselineSpecular: boolean;
      diffuseSource: "octahedral" | "screen";
    }>
  ): FusedOpaqueIblFrame {
    const fused = this.fusedIbl.addToGraph(graph, extent, {
      hdr: inputs.hdr,
      depth: inputs.depth,
      normal: inputs.normal,
      bentNormal: inputs.bentNormal,
      albedoAo: inputs.albedoAo,
      material: inputs.pbr,
      camera: inputs.camera,
      metadata: inputs.metadata,
      environment: inputs.environment,
      diffuseIrradiance: inputs.diffuseIrradiance,
      splitSum: inputs.splitSum,
      ambientVisibility: inputs.ambientVisibility
    }, options);
    return Object.freeze({
      hdr: fused.hdr,
      iblSpecular: fused.baselineSpecular,
      indirectDiffuse: null,
      domain: {
        domain: "internal-full" as const,
        width: extent.width,
        height: extent.height,
        scale: 1 as const
      }
    });
  }

  resolve(graph: FrameGraph, inputs: OpaqueLightingResolveInputs): ResourceId {
    return this.resolvePass.addToGraph(graph, inputs).hdr;
  }

  resetFrameEvidence(): void {
    this.resolvePass.lastRan = false;
  }

  destroy(): void {
    this.fusedIbl.destroy();
    this.resolvePass.destroy();
  }
}

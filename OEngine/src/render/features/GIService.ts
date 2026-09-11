/** Single owner for receiver-local long-range GI and screen-space correction. */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import {
  GPU_SHADING_SURFACE_LITE_PROFILE,
  type GpuShadingSurfaceLiteProfile
} from "../../gpu/GpuComputeMaterialAbi.js";
import {
  LongRangeDiffuseProviderPass,
  type LongRangeProviderInputs,
  type LongRangeProviderJob
} from "../passes/LongRangeDiffuseProviderPass.js";
import {
  OpaqueLightingResolvePass,
  type OpaqueLightingResolveInputs
} from "../passes/OpaqueLightingResolvePass.js";
import {
  ScreenSpaceDiffuseResolvePass,
  type ScreenSpaceDiffuseResolveInputs
} from "../passes/ScreenSpaceDiffuseResolvePass.js";

export interface OpaqueLightingRequest {
  readonly hdr: ResourceId;
  readonly depth: ResourceId;
  readonly normal: ResourceId;
  readonly bentNormal: ResourceId;
  readonly albedoAo: ResourceId;
  readonly pbr: ResourceId;
  readonly camera: ResourceId;
  readonly splitSum: ResourceId;
  readonly ambientVisibility?: ResourceId;
  readonly metadata: ResourceId;
  readonly extent: { readonly width: number; readonly height: number };
  readonly reflectionCorrectionExpected: boolean;
  readonly screenSpaceDiffuseCorrectionExpected: boolean;
  readonly fallbackDiffuseIrradiance: ResourceId;
  readonly providerJob: LongRangeProviderJob;
  readonly providerInputs: Omit<LongRangeProviderInputs,
    "depth" | "normal" | "bentNormal" | "albedoAo" | "material" |
    "metadata" | "camera">;
}

export interface OpaqueLightingResult {
  readonly hdr: ResourceId;
  /** Raw selected provider products. These are radiometric inputs, not receiver-resolved lighting. */
  readonly selectedDiffuseIrradiance: ResourceId;
  readonly selectedSpecularRadiance: ResourceId;
  /** Receiver-resolved products exist only when their correction consumer requested them. */
  readonly resolvedDiffuse: ResourceId | null;
  readonly baselineSpecular: ResourceId | null;
  /** Alpha is the exact selected provider identity 1..4. */
  readonly providerSelection: ResourceId;
  readonly counters: ResourceId;
}

export class GIService {
  private readonly longRangeProvider: LongRangeDiffuseProviderPass;
  private readonly opaqueResolve: OpaqueLightingResolvePass;
  private readonly screenSpaceDiffuseResolve: ScreenSpaceDiffuseResolvePass;

  constructor(
    graphics: GraphicsContext,
    surfaceProfile: GpuShadingSurfaceLiteProfile = GPU_SHADING_SURFACE_LITE_PROFILE
  ) {
    this.longRangeProvider = new LongRangeDiffuseProviderPass(graphics, surfaceProfile);
    this.opaqueResolve = new OpaqueLightingResolvePass(graphics, surfaceProfile);
    this.screenSpaceDiffuseResolve = new ScreenSpaceDiffuseResolvePass(graphics, surfaceProfile);
  }

  resolveScreenSpaceDiffuse(
    graph: FrameGraph,
    inputs: ScreenSpaceDiffuseResolveInputs
  ): ResourceId {
    return this.screenSpaceDiffuseResolve.addToGraph(graph, inputs);
  }

  resolveOpaqueLighting(
    graph: FrameGraph,
    inputs: OpaqueLightingRequest
  ): OpaqueLightingResult {
    const selected = this.longRangeProvider.addToGraph(
      graph,
      inputs.providerJob,
      {
        ...inputs.providerInputs,
        depth: inputs.depth,
        normal: inputs.normal,
        bentNormal: inputs.bentNormal,
        albedoAo: inputs.albedoAo,
        material: inputs.pbr,
        metadata: inputs.metadata,
        camera: inputs.camera
      }
    );
    const resolveInputs: OpaqueLightingResolveInputs = {
      hdr: inputs.hdr,
      depth: inputs.depth,
      normal: inputs.normal,
      bentNormal: inputs.bentNormal,
      albedoAo: inputs.albedoAo,
      pbr: inputs.pbr,
      splitSum: inputs.splitSum,
      indirectDiffuse: selected.diffuseIrradiance,
      indirectSpecular: selected.specularRadiance,
      fallbackDiffuseIrradiance: inputs.fallbackDiffuseIrradiance,
      ambientVisibility: inputs.ambientVisibility,
      camera: inputs.camera,
      metadata: inputs.metadata
    };
    const resolved = this.opaqueResolve.addToGraph(graph, resolveInputs, {
      baselineSpecular:
        inputs.reflectionCorrectionExpected ||
        inputs.screenSpaceDiffuseCorrectionExpected,
      componentOutputs: inputs.screenSpaceDiffuseCorrectionExpected,
      extent: inputs.extent
    });
    return {
      hdr: resolved.hdr,
      selectedDiffuseIrradiance: selected.diffuseIrradiance,
      selectedSpecularRadiance: selected.specularRadiance,
      resolvedDiffuse: resolved.resolvedDiffuse,
      baselineSpecular: resolved.baselineSpecular,
      providerSelection: selected.providerSelection,
      counters: selected.counters
    };
  }

  resetFrameEvidence(): void {
    this.longRangeProvider.resetFrameEvidence();
    this.opaqueResolve.lastRan = false;
    this.screenSpaceDiffuseResolve.lastRan = false;
  }

  destroy(): void {
    this.longRangeProvider.destroy();
    this.opaqueResolve.destroy();
    this.screenSpaceDiffuseResolve.destroy();
  }
}

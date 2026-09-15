import {
  RenderDebugView,
  type RenderDebugView as RenderDebugViewT
} from "../debug/RenderDebugView.js";
import { GPU_SHADING_OUTPUT_DEPENDENCY } from "./GpuSparseShadingPipelineContract.js";

/**
 * Immutable demand snapshot shared by sparse publication and the main graph.
 *
 * The snapshot describes products required by opaque consumers, not the
 * products that happen to be visible in one frame.  That distinction keeps
 * shader/layout publication stable while the camera moves and makes feature
 * off pruning observable in the compiled graph.
 */
export interface OpaqueShadingDemand {
  readonly hasOpaqueReceiver: boolean;
  readonly hasOpaqueLitReceiver: boolean;
  readonly hasOpaqueUnlitReceiver: boolean;
  readonly needsHdr: boolean;
  readonly needsSurface: boolean;
  readonly needsDiffuseSurface: boolean;
  readonly needsVelocity: boolean;
  readonly needsPreviousDepth: boolean;
  readonly needsIndirectComponents: boolean;
  readonly needsLightingDebug: boolean;
  readonly needsEnvironmentIbl: boolean;
  readonly shadowSamplingEnabled: boolean;
  readonly outputDependencyMask: number;
}

export interface OpaqueShadingDemandInput {
  readonly opaqueLitReceiverCount: number;
  readonly opaqueUnlitReceiverCount: number;
  readonly shadows: boolean;
  readonly gtao: boolean;
  readonly ssgi: boolean;
  readonly ssr: boolean;
  readonly needsPreviousDepth: boolean;
  readonly motionBlur: boolean;
  readonly debugView: RenderDebugViewT;
}

/**
 * Derive every opaque publication dependency in one place.  Counts come from
 * the immutable shading publication and topology comes from the current
 * settings snapshot; no per-frame visible-list or GPU readback is involved.
 */
export function deriveOpaqueShadingDemand(
  input: OpaqueShadingDemandInput
): Readonly<OpaqueShadingDemand> {
  validateCount(input.opaqueLitReceiverCount, "opaqueLitReceiverCount");
  validateCount(input.opaqueUnlitReceiverCount, "opaqueUnlitReceiverCount");
  if (typeof input.shadows !== "boolean" ||
      typeof input.gtao !== "boolean" ||
      typeof input.ssgi !== "boolean" ||
      typeof input.ssr !== "boolean" ||
      typeof input.needsPreviousDepth !== "boolean" ||
      typeof input.motionBlur !== "boolean") {
    throw new TypeError("Opaque shading topology inputs must be boolean");
  }

  const hasOpaqueLitReceiver = input.opaqueLitReceiverCount > 0;
  const hasOpaqueUnlitReceiver = input.opaqueUnlitReceiverCount > 0;
  const hasOpaqueReceiver = hasOpaqueLitReceiver || hasOpaqueUnlitReceiver;
  const needsIndirectComponents = input.gtao || input.ssgi || input.ssr;
  const debugDependencies = hasOpaqueReceiver
    ? debugOutputDependencies(input.debugView)
    : 0;
  const needsLightingDebug = hasOpaqueReceiver && (
    debugDependencies !== 0 ||
    input.debugView === RenderDebugView.IndirectDiffuse ||
    input.debugView === RenderDebugView.IndirectSpecular ||
    input.debugView === RenderDebugView.LinearHdr
  );
  const needsSurface = hasOpaqueLitReceiver && (
    input.gtao || input.ssgi || input.ssr || input.needsPreviousDepth ||
    input.motionBlur || input.debugView === RenderDebugView.Velocity ||
    debugDependencies !== 0
  );
  const needsDiffuseSurface = hasOpaqueLitReceiver && (
    input.gtao || input.ssgi || input.ssr
  );
  const needsVelocity = hasOpaqueReceiver && (
    input.needsPreviousDepth || input.motionBlur ||
    input.debugView === RenderDebugView.Velocity
  );
  const needsEnvironmentIbl = hasOpaqueLitReceiver && !needsIndirectComponents;

  let outputDependencyMask = debugDependencies;
  if (needsSurface) outputDependencyMask |= GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite;
  if (needsDiffuseSurface) outputDependencyMask |= GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite;
  if (needsVelocity) outputDependencyMask |= GPU_SHADING_OUTPUT_DEPENDENCY.Velocity;
  if (needsEnvironmentIbl) outputDependencyMask |= GPU_SHADING_OUTPUT_DEPENDENCY.EnvironmentIBL;

  return Object.freeze({
    hasOpaqueReceiver,
    hasOpaqueLitReceiver,
    hasOpaqueUnlitReceiver,
    needsHdr: hasOpaqueReceiver,
    needsSurface: needsSurface || needsDiffuseSurface,
    needsDiffuseSurface,
    needsVelocity,
    needsPreviousDepth: input.needsPreviousDepth,
    needsIndirectComponents,
    needsLightingDebug,
    needsEnvironmentIbl,
    shadowSamplingEnabled: hasOpaqueLitReceiver && input.shadows,
    outputDependencyMask
  });
}

function debugOutputDependencies(view: RenderDebugViewT): number {
  switch (view) {
    case RenderDebugView.BaseColor:
    case RenderDebugView.Occlusion:
    case RenderDebugView.Emissive:
      return GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite;
    case RenderDebugView.ShadingNormal:
    case RenderDebugView.Metallic:
    case RenderDebugView.Roughness:
    case RenderDebugView.HistoryValidity:
    case RenderDebugView.Reactive:
    case RenderDebugView.Velocity:
      return GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite;
    default:
      return 0;
  }
}

function validateCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Opaque shading ${name} must be a non-negative safe integer`);
  }
}

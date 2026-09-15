import {
  getRenderDebugViewStatus,
  RenderDebugView,
  type RenderDebugView as RenderDebugViewT
} from "../../debug/RenderDebugView.js";
import type { OpaqueShadingDemand } from "../../gpu/GpuOpaqueShadingDemand.js";
import { GPU_SHADING_OUTPUT_DEPENDENCY } from "../../gpu/GpuSparseShadingPipelineContract.js";

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
 * Derives all opaque publication products from the immutable receiver summary
 * and one resolved feature topology.  Camera visibility and GPU readback are
 * deliberately absent, so the result remains stable while a publication is
 * live and can be used by both pipeline publication and FrameGraph creation.
 */
export function deriveOpaqueShadingDemand(
  input: OpaqueShadingDemandInput
): Readonly<OpaqueShadingDemand> {
  validateCount(input.opaqueLitReceiverCount, "opaqueLitReceiverCount");
  validateCount(input.opaqueUnlitReceiverCount, "opaqueUnlitReceiverCount");
  validateBooleans(input);
  getRenderDebugViewStatus(input.debugView);

  const hasOpaqueLitReceiver = input.opaqueLitReceiverCount > 0;
  const hasOpaqueUnlitReceiver = input.opaqueUnlitReceiverCount > 0;
  const hasOpaqueReceiver = hasOpaqueLitReceiver || hasOpaqueUnlitReceiver;
  const debugDependencies = hasOpaqueReceiver
    ? debugOutputDependencies(input.debugView)
    : 0;
  const needsLightingDebug = hasOpaqueLitReceiver && (
    input.debugView === RenderDebugView.IndirectDiffuse ||
    input.debugView === RenderDebugView.IndirectSpecular
  );
  const needsIndirectComponents = hasOpaqueLitReceiver && (
    input.gtao || input.ssgi || input.ssr || needsLightingDebug
  );
  const needsSurface = hasOpaqueReceiver && (
    input.needsPreviousDepth ||
    input.debugView === RenderDebugView.Velocity ||
    (debugDependencies & GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite) !== 0 ||
    hasOpaqueLitReceiver && (input.gtao || input.ssgi || input.ssr || needsLightingDebug)
  );
  const needsDiffuseSurface = hasOpaqueReceiver && (
    (debugDependencies & GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite) !== 0 ||
    hasOpaqueLitReceiver && (input.gtao || input.ssgi || input.ssr || needsLightingDebug)
  );
  const needsVelocity = hasOpaqueReceiver && (
    input.needsPreviousDepth || input.motionBlur ||
    input.debugView === RenderDebugView.Velocity
  );
  const needsEnvironmentIbl = hasOpaqueLitReceiver && !needsIndirectComponents;

  let outputDependencyMask = 0;
  if (needsSurface) outputDependencyMask |= GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite;
  if (needsDiffuseSurface) outputDependencyMask |= GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite;
  if (needsVelocity) outputDependencyMask |= GPU_SHADING_OUTPUT_DEPENDENCY.Velocity;
  if (needsEnvironmentIbl) outputDependencyMask |= GPU_SHADING_OUTPUT_DEPENDENCY.EnvironmentIBL;

  return Object.freeze({
    hasOpaqueReceiver,
    hasOpaqueLitReceiver,
    hasOpaqueUnlitReceiver,
    needsHdr: hasOpaqueReceiver,
    needsSurface,
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

function validateBooleans(input: OpaqueShadingDemandInput): void {
  const values = [
    input.shadows,
    input.gtao,
    input.ssgi,
    input.ssr,
    input.needsPreviousDepth,
    input.motionBlur
  ];
  if (values.some((value) => typeof value !== "boolean")) {
    throw new TypeError("Opaque shading topology inputs must be boolean");
  }
}

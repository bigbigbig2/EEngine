import {
  getRenderDebugViewStatus,
  RenderDebugView,
  type RenderDebugView as RenderDebugViewT
} from "../../debug/RenderDebugView.js";
import type { OpaqueShadingDemand } from "../../gpu/GpuOpaqueShadingDemand.js";
import {
  GPU_SHADING_OUTPUT_DEPENDENCY,
  GPU_SHADING_OUTPUT_DEPENDENCY_VALID_MASK
} from "../../gpu/GpuSparseShadingPipelineContract.js";

export type OpaqueProductRepresentation = "fused" | "deferred" | "materialized" | "absent";

/** Finite physical plan for the current opaque visibility consumer. */
export interface OpaqueSurfaceProductPlan {
  readonly normal: "materialized" | "absent";
  readonly diffuseReflectance: "materialized" | "absent";
  /** One shared physical product for either compact Surface consumer. */
  readonly materialFlags: "materialized" | "absent";
  readonly velocity: "materialized" | "absent";
  readonly environmentIbl: OpaqueProductRepresentation;
  /** HDR plus optional materialized attachment bytes per internal pixel. */
  readonly attachmentBytesPerPixel: number;
}

/**
 * Lower semantic publication demand into the current bounded Surface layout.
 * Older contract fixtures carry only the output mask; production also checks
 * the frozen semantic demand before the graph allocates any optional output.
 */
export function compileOpaqueSurfaceProductPlan(input: Readonly<{
  outputDependencyMask: number;
  opaqueDemand?: Readonly<OpaqueShadingDemand>;
}>): Readonly<OpaqueSurfaceProductPlan> {
  const mask = input.outputDependencyMask;
  if (!Number.isInteger(mask) || mask < 0 ||
      (mask & ~GPU_SHADING_OUTPUT_DEPENDENCY_VALID_MASK) !== 0) {
    throw new RangeError("Opaque Surface product mask is invalid");
  }
  const demand = input.opaqueDemand;
  const normal = (mask & GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite) !== 0;
  const diffuse = (mask & GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite) !== 0;
  const velocity = (mask & GPU_SHADING_OUTPUT_DEPENDENCY.Velocity) !== 0;
  const ibl = (mask & GPU_SHADING_OUTPUT_DEPENDENCY.EnvironmentIBL) !== 0;
  if (demand !== undefined && (
    demand.outputDependencyMask !== mask ||
    demand.needsSurface !== normal ||
    demand.needsDiffuseSurface !== diffuse ||
    demand.needsVelocity !== velocity ||
    demand.needsEnvironmentIbl !== ibl
  )) {
    throw new Error("Opaque Surface plan does not match the published demand");
  }
  const materialFlags = normal || diffuse;
  return Object.freeze({
    normal: normal ? "materialized" : "absent",
    diffuseReflectance: diffuse ? "materialized" : "absent",
    materialFlags: materialFlags ? "materialized" : "absent",
    velocity: velocity ? "materialized" : "absent",
    environmentIbl: ibl ? "fused" : demand?.needsIndirectComponents ? "deferred" : "absent",
    attachmentBytesPerPixel: demand?.hasOpaqueReceiver === false ? 0 :
      8 + (normal ? 8 : 0) + (materialFlags ? 8 : 0) +
        (diffuse ? 4 : 0) + (velocity ? 4 : 0)
  });
}

export interface OpaqueShadingDemandInput {
  readonly opaqueLitReceiverCount: number;
  readonly opaqueUnlitReceiverCount: number;
  readonly shadows: boolean;
  readonly gtao: boolean;
  readonly ssgi: boolean;
  readonly ssr: boolean;
  /** A registered Brick4 map or a complete Probe Volume requires receiver-local lookup. */
  readonly spatialGiQuery: boolean;
  readonly needsPreviousDepth: boolean;
  readonly motionBlur: boolean;
  readonly debugView: RenderDebugViewT;
}

export interface SpatialGiQueryInput {
  readonly brick4Registered: boolean;
  readonly probeCount: number;
  readonly probeTetrahedronCount: number;
}

/**
 * Placement follows the published query domain, not transient GPU residency.
 * An invalidated Brick4 generation must stay deferred so the receiver-local
 * provider can fall through to Probe/IBL/black without changing PBR ownership.
 */
export function requiresSpatialGiQuery(input: SpatialGiQueryInput): boolean {
  if (typeof input.brick4Registered !== "boolean") {
    throw new TypeError("Brick4 registration must be boolean");
  }
  validateCount(input.probeCount, "probeCount");
  validateCount(input.probeTetrahedronCount, "probeTetrahedronCount");
  return input.brick4Registered ||
    (input.probeCount >= 4 && input.probeTetrahedronCount > 0);
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
    input.gtao || input.ssgi || input.ssr || input.spatialGiQuery || needsLightingDebug
  );
  const needsSurface = hasOpaqueReceiver && (
    input.needsPreviousDepth ||
    input.debugView === RenderDebugView.Velocity ||
    (debugDependencies & GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite) !== 0 ||
    hasOpaqueLitReceiver && (
      input.gtao || input.ssgi || input.ssr || input.spatialGiQuery || needsLightingDebug
    )
  );
  const needsDiffuseSurface = hasOpaqueReceiver && (
    (debugDependencies & GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite) !== 0 ||
    hasOpaqueLitReceiver && (
      input.gtao || input.ssgi || input.ssr || input.spatialGiQuery || needsLightingDebug
    )
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
    input.spatialGiQuery,
    input.needsPreviousDepth,
    input.motionBlur
  ];
  if (values.some((value) => typeof value !== "boolean")) {
    throw new TypeError("Opaque shading topology inputs must be boolean");
  }
}

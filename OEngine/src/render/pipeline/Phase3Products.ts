/**
 * The small product vocabulary that appeared during ADR-0020 Phase 3.
 *
 * This is a semantic inventory, not a resource allocator. A product remains
 * `declared-not-wired` or `blocked` until a real FrameGraph producer and
 * consumer prove its closure.
 */
export const PHASE3_PRODUCT = Object.freeze({
  PhysicalSun: "PhysicalSun",
  SkyRadiance: "SkyRadiance",
  SkyIrradiance: "SkyIrradiance",
  AerialScattering: "AerialScattering",
  Motion: "Motion",
  TemporalDepth: "TemporalDepth",
  PreExposure: "PreExposure",
  TemporalReconstructedColor: "TemporalReconstructedColor"
} as const);

export type Phase3ProductName = typeof PHASE3_PRODUCT[keyof typeof PHASE3_PRODUCT];
export type Phase3ProductState = "production" | "declared-not-wired" | "blocked";

export interface Phase3ProductContract {
  readonly name: Phase3ProductName;
  readonly owner: string;
  readonly consumers: readonly string[];
  readonly generation: "environment" | "frame" | "pre-exposure";
  readonly state: Phase3ProductState;
  readonly reason: string;
}

export const PHASE3_PRODUCT_CONTRACTS: Readonly<Record<Phase3ProductName, Phase3ProductContract>> =
  Object.freeze({
    PhysicalSun: Object.freeze({
      name: PHASE3_PRODUCT.PhysicalSun,
      owner: "PhysicalEnvironmentRuntime",
      consumers: Object.freeze(["Surface direct lighting"]),
      generation: "environment",
      state: "production",
      reason: "PhysicalEnvironmentRuntime writes the immutable Sun buffer and Surface direct lighting consumes it with DirectVisibility=1."
    }),
    SkyRadiance: Object.freeze({
      name: PHASE3_PRODUCT.SkyRadiance,
      owner: "PhysicalEnvironmentRuntime",
      consumers: Object.freeze(["PhysicalSkyPass", "AerialPerspectivePass"]),
      generation: "environment",
      state: "production",
      reason: "PhysicalSkyPass and AerialPerspectivePass sample the shared 3D combined-scattering LUT and higher-order LUT."
    }),
    SkyIrradiance: Object.freeze({
      name: PHASE3_PRODUCT.SkyIrradiance,
      owner: "PhysicalEnvironmentRuntime",
      consumers: Object.freeze(["Environment lighting"]),
      generation: "environment",
      state: "production",
      reason: "Surface direct programs sample the pinned 2D SkyIrradiance LUT for the indirect diffuse term."
    }),
    AerialScattering: Object.freeze({
      name: PHASE3_PRODUCT.AerialScattering,
      owner: "AerialPerspectivePass",
      consumers: Object.freeze(["Present"]),
      generation: "environment",
      state: "production",
      reason: "AerialPerspectivePass reconstructs the camera-to-point segment and applies Takram LUT transmittance plus in-scattering."
    }),
    Motion: Object.freeze({
      name: PHASE3_PRODUCT.Motion,
      owner: "Surface material path",
      consumers: Object.freeze(["Temporal Fabric"]),
      generation: "frame",
      state: "production",
      reason: "Surface material programs write the rg16float motion product and the analytic temporal consumer marks it produced."
    }),
    TemporalDepth: Object.freeze({
      name: PHASE3_PRODUCT.TemporalDepth,
      owner: "Visibility depth",
      consumers: Object.freeze(["Temporal Fabric"]),
      generation: "frame",
      state: "production",
      reason: "Analytic Temporal Baseline reads visibility depth and writes the ping-pong depth history."
    }),
    PreExposure: Object.freeze({
      name: PHASE3_PRODUCT.PreExposure,
      owner: "RadiometryContract",
      consumers: Object.freeze(["Surface radiance", "Temporal Fabric"]),
      generation: "pre-exposure",
      state: "production",
      reason: "RadiometryRuntime owns one immutable frame contract; environment-generation and multiplier changes advance the shared generation consumed by Surface and Temporal Fabric."
    }),
    TemporalReconstructedColor: Object.freeze({
      name: PHASE3_PRODUCT.TemporalReconstructedColor,
      owner: "Temporal backend",
      consumers: Object.freeze(["Present"]),
      generation: "frame",
      state: "production",
      reason: "EEngine Analytic Temporal Baseline is connected to FrameGraph and Present; it is explicitly not FSR3."
    })
  });

export function phase3ProductContract(name: Phase3ProductName): Phase3ProductContract {
  return PHASE3_PRODUCT_CONTRACTS[name];
}

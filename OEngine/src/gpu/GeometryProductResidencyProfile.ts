import { OEGPACK_V3_PAGE_BYTES } from "../assets/GeometryAbiV3.js";
import { GEOMETRY_PRODUCT_GPU_SLOTS_PER_BANK_V1 } from "./GeometryProductGpuAbiV1.js";

/** Phase H profile selector ABI. This changes physical capacity only; Product/Page ABI stays V1. */
export const GEOMETRY_PRODUCT_RESIDENCY_PROFILE_ABI_VERSION_V1 = 1;
export const GEOMETRY_PRODUCT_RESIDENCY_BANK_COUNT_V1 = 4;
export const GEOMETRY_PRODUCT_PORTABLE_BANK_BYTES_V1 = 128 * 1024 * 1024;
export const GEOMETRY_PRODUCT_BALANCED_BANK_BYTES_V1 = 192 * 1024 * 1024;
export const GEOMETRY_PRODUCT_HIGH_END_BANK_BYTES_V1 = 256 * 1024 * 1024;
export const GEOMETRY_PRODUCT_PORTABLE_CAPACITY_BYTES_V1 =
  GEOMETRY_PRODUCT_PORTABLE_BANK_BYTES_V1 * GEOMETRY_PRODUCT_RESIDENCY_BANK_COUNT_V1;
export const GEOMETRY_PRODUCT_BALANCED_CAPACITY_BYTES_V1 =
  GEOMETRY_PRODUCT_BALANCED_BANK_BYTES_V1 * GEOMETRY_PRODUCT_RESIDENCY_BANK_COUNT_V1;
export const GEOMETRY_PRODUCT_HIGH_END_CAPACITY_BYTES_V1 =
  GEOMETRY_PRODUCT_HIGH_END_BANK_BYTES_V1 * GEOMETRY_PRODUCT_RESIDENCY_BANK_COUNT_V1;

export type GeometryProductResidencyProfileIdV1 = "Portable" | "Balanced" | "HighEnd";
export type GeometryProductResidencyProfileRequestV1 = GeometryProductResidencyProfileIdV1 | "auto";

/** Only negotiated WebGPU limits are accepted. Physical adapter VRAM is deliberately absent. */
export interface GeometryProductResidencyLimitsV1 {
  readonly maxBufferSize: number;
  readonly maxStorageBufferBindingSize: number;
  readonly maxStorageBuffersPerShaderStage: number;
}

/** Delayed counters may promote an auto profile, but never increase a configured cap. */
export interface GeometryProductResidencyRuntimeEvidenceV1 {
  readonly residentBytes?: number;
  readonly retiringBytes?: number;
  readonly demandOverflow?: number;
  readonly fallbackGroups?: number;
  readonly pressure?: number;
}

export interface GeometryProductResidencyProfileOptionsV1 {
  readonly requestedProfile?: GeometryProductResidencyProfileRequestV1;
  readonly runtimeEvidence?: GeometryProductResidencyRuntimeEvidenceV1;
  readonly featureEnabled?: boolean;
  /** Explicit application budget; it is not inferred from physical VRAM. */
  readonly configuredCapacityBytes?: number;
  /** Explicit per-bank target for an application working set. Defaults retain
   * the profile tier; device limits and configuredCapacityBytes remain caps. */
  readonly configuredBankBytes?: number;
}

export interface GeometryProductResidencyProfilePlanV1 {
  readonly abiVersion: 1;
  readonly enabled: boolean;
  readonly requestedProfile: GeometryProductResidencyProfileRequestV1;
  readonly profile: GeometryProductResidencyProfileIdV1 | "Disabled";
  readonly reason: "selected" | "feature-off" | "unsupported-limits" | "configured-budget";
  readonly bankCount: number;
  readonly bankBytes: number;
  readonly slotsPerBank: number;
  readonly slotCapacity: number;
  readonly capacityBytes: number;
  readonly negotiatedLimits: Readonly<GeometryProductResidencyLimitsV1>;
  readonly runtimeEvidence: Readonly<GeometryProductResidencyRuntimeEvidenceV1>;
  readonly fallbackFrom?: GeometryProductResidencyProfileIdV1;
}

const PROFILE_BANK_BYTES: Readonly<Record<GeometryProductResidencyProfileIdV1, number>> = Object.freeze({
  Portable: GEOMETRY_PRODUCT_PORTABLE_BANK_BYTES_V1,
  Balanced: GEOMETRY_PRODUCT_BALANCED_BANK_BYTES_V1,
  HighEnd: GEOMETRY_PRODUCT_HIGH_END_BANK_BYTES_V1
});
const PROFILE_ORDER: readonly GeometryProductResidencyProfileIdV1[] = Object.freeze([
  "Portable",
  "Balanced",
  "HighEnd"
]);

/**
 * Selects a bounded physical residency plan from actual device limits and
 * delayed runtime counters. No GPU resource is created by this function.
 */
export function selectGeometryProductResidencyProfileV1(
  limits: GeometryProductResidencyLimitsV1,
  options: GeometryProductResidencyProfileOptionsV1 = {}
): GeometryProductResidencyProfilePlanV1 {
  const normalizedLimits = normalizeLimits(limits);
  const requestedProfile = options.requestedProfile ?? "auto";
  const evidence = normalizeEvidence(options.runtimeEvidence);
  const featureEnabled = options.featureEnabled ?? true;
  const configuredCapacityBytes =
    options.configuredCapacityBytes ??
    (requestedProfile === "auto" ? 128 * 1024 * 1024 : Number.POSITIVE_INFINITY);
  if (
    !(configuredCapacityBytes > 0) ||
    (!Number.isFinite(configuredCapacityBytes) && configuredCapacityBytes !== Number.POSITIVE_INFINITY)
  ) {
    throw new RangeError("Geometry Product configuredCapacityBytes must be positive or infinite");
  }
  if (
    options.configuredBankBytes !== undefined &&
    (!Number.isSafeInteger(options.configuredBankBytes) || options.configuredBankBytes < OEGPACK_V3_PAGE_BYTES)
  ) {
    throw new RangeError("Geometry Product configuredBankBytes must be a positive page-sized integer");
  }
  if (options.configuredBankBytes !== undefined && !Number.isFinite(options.configuredCapacityBytes)) {
    throw new RangeError("Geometry Product explicit bank target requires finite configuredCapacityBytes");
  }
  if (!featureEnabled) return disabledPlan(normalizedLimits, requestedProfile, evidence, "feature-off");
  if (normalizedLimits.maxStorageBuffersPerShaderStage < 16) {
    return disabledPlan(normalizedLimits, requestedProfile, evidence, "unsupported-limits");
  }

  const maximumBankBytes = Math.min(
    normalizedLimits.maxBufferSize,
    normalizedLimits.maxStorageBufferBindingSize,
    GEOMETRY_PRODUCT_GPU_SLOTS_PER_BANK_V1 * OEGPACK_V3_PAGE_BYTES
  );
  const capacityLimit = Math.min(
    configuredCapacityBytes,
    maximumBankBytes * GEOMETRY_PRODUCT_RESIDENCY_BANK_COUNT_V1
  );
  const autoPressure = evidence.pressure ?? derivePressure(evidence);
  const requested =
    requestedProfile === "auto"
      ? autoPressure >= 0.75 || (evidence.demandOverflow ?? 0) > 0 || (evidence.fallbackGroups ?? 0) > 0
        ? "HighEnd"
        : "Portable"
      : requestedProfile;
  if (!PROFILE_ORDER.includes(requested)) {
    throw new RangeError("Unknown Geometry Product residency profile");
  }
  // An explicit bank target overrides the default profile ceiling. Four equal,
  // page-aligned banks still fit the device limits and application budget.
  const bankBytes =
    Math.floor(
      Math.min(
        options.configuredBankBytes ?? PROFILE_BANK_BYTES[requested],
        maximumBankBytes,
        configuredCapacityBytes / GEOMETRY_PRODUCT_RESIDENCY_BANK_COUNT_V1
      ) / OEGPACK_V3_PAGE_BYTES
    ) * OEGPACK_V3_PAGE_BYTES;
  if (bankBytes < OEGPACK_V3_PAGE_BYTES) {
    return disabledPlan(normalizedLimits, requestedProfile, evidence, "configured-budget");
  }
  const profile =
    bankBytes > GEOMETRY_PRODUCT_BALANCED_BANK_BYTES_V1
      ? "HighEnd"
      : bankBytes > GEOMETRY_PRODUCT_PORTABLE_BANK_BYTES_V1
        ? "Balanced"
        : "Portable";
  const capacityBytes = bankBytes * GEOMETRY_PRODUCT_RESIDENCY_BANK_COUNT_V1;
  return Object.freeze({
    abiVersion: GEOMETRY_PRODUCT_RESIDENCY_PROFILE_ABI_VERSION_V1,
    enabled: true,
    requestedProfile,
    profile,
    reason: "selected",
    bankCount: GEOMETRY_PRODUCT_RESIDENCY_BANK_COUNT_V1,
    bankBytes,
    slotsPerBank: bankBytes / OEGPACK_V3_PAGE_BYTES,
    slotCapacity: capacityBytes / OEGPACK_V3_PAGE_BYTES,
    capacityBytes,
    negotiatedLimits: normalizedLimits,
    runtimeEvidence: evidence,
    ...(profile === requested ? {} : { fallbackFrom: requested })
  });
}

function normalizeLimits(
  limits: GeometryProductResidencyLimitsV1
): Readonly<GeometryProductResidencyLimitsV1> {
  const normalized = {
    maxBufferSize: Number(limits.maxBufferSize),
    maxStorageBufferBindingSize: Number(limits.maxStorageBufferBindingSize),
    maxStorageBuffersPerShaderStage: Number(limits.maxStorageBuffersPerShaderStage)
  };
  for (const [name, value] of Object.entries(normalized)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new RangeError(`Geometry Product ${name} limit is invalid`);
  }
  return Object.freeze(normalized);
}

function normalizeEvidence(
  evidence: GeometryProductResidencyRuntimeEvidenceV1 | undefined
): Readonly<GeometryProductResidencyRuntimeEvidenceV1> {
  const normalized: GeometryProductResidencyRuntimeEvidenceV1 = Object.freeze({
    ...(evidence?.residentBytes === undefined
      ? {}
      : { residentBytes: nonNegative(evidence.residentBytes, "residentBytes") }),
    ...(evidence?.retiringBytes === undefined
      ? {}
      : { retiringBytes: nonNegative(evidence.retiringBytes, "retiringBytes") }),
    ...(evidence?.demandOverflow === undefined
      ? {}
      : { demandOverflow: nonNegative(evidence.demandOverflow, "demandOverflow") }),
    ...(evidence?.fallbackGroups === undefined
      ? {}
      : { fallbackGroups: nonNegative(evidence.fallbackGroups, "fallbackGroups") }),
    ...(evidence?.pressure === undefined ? {} : { pressure: finiteRatio(evidence.pressure, "pressure") })
  });
  return normalized;
}

function derivePressure(evidence: Readonly<GeometryProductResidencyRuntimeEvidenceV1>): number {
  const resident = evidence.residentBytes ?? 0;
  const retiring = evidence.retiringBytes ?? 0;
  const bytesPressure = (resident + retiring) / GEOMETRY_PRODUCT_PORTABLE_CAPACITY_BYTES_V1;
  return Math.min(1, Math.max(0, bytesPressure));
}

function disabledPlan(
  limits: Readonly<GeometryProductResidencyLimitsV1>,
  requestedProfile: GeometryProductResidencyProfileRequestV1,
  runtimeEvidence: Readonly<GeometryProductResidencyRuntimeEvidenceV1>,
  reason: "feature-off" | "unsupported-limits" | "configured-budget"
): GeometryProductResidencyProfilePlanV1 {
  return Object.freeze({
    abiVersion: GEOMETRY_PRODUCT_RESIDENCY_PROFILE_ABI_VERSION_V1,
    enabled: false,
    requestedProfile,
    profile: "Disabled",
    reason,
    bankCount: 0,
    bankBytes: 0,
    slotsPerBank: 0,
    slotCapacity: 0,
    capacityBytes: 0,
    negotiatedLimits: limits,
    runtimeEvidence
  });
}

function nonNegative(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`Geometry Product ${label} must be a non-negative safe integer`);
  return value;
}

function finiteRatio(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new RangeError(`Geometry Product ${label} must be within [0, 1]`);
  return value;
}

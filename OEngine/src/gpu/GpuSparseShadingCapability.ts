import { GPU_SHADING_BIN_CLASSIFIER_INVOCATIONS } from "./GpuShadingBinAbi.js";

export const GPU_SPARSE_SHADING_CAPABILITY_SCHEMA_VERSION = 1;
export const GPU_SPARSE_SHADING_REQUIRED_FEATURES = Object.freeze([
  "core-features-and-limits",
  "subgroups",
  "texture-formats-tier1"
] as const satisfies readonly GPUFeatureName[]);
export const GPU_SPARSE_SHADING_FORBIDDEN_FEATURES = Object.freeze([
  "subgroup-size-control"
] as const);
export const GPU_SPARSE_SHADING_CLASSIFIER_WORKGROUP_STORAGE_BYTES = 768;

export const GPU_SPARSE_SHADING_REQUIRED_LIMITS = Object.freeze({
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupSizeX: 16,
  maxComputeWorkgroupSizeY: 16,
  maxComputeWorkgroupStorageSize: GPU_SPARSE_SHADING_CLASSIFIER_WORKGROUP_STORAGE_BYTES,
  maxStorageBuffersPerShaderStage: 10,
  maxStorageTexturesPerShaderStage: 5,
  maxSampledTexturesPerShaderStage: 16,
  maxSamplersPerShaderStage: 8,
  maxBindGroups: 4
} as const);

export type GpuSparseShadingRequiredLimitName =
  keyof typeof GPU_SPARSE_SHADING_REQUIRED_LIMITS;

export interface GpuSparseShadingAdapterSnapshot {
  readonly features: Iterable<string>;
  readonly limits: Readonly<Record<string, number | undefined>>;
}

export interface GpuSparseShadingCapabilityDependencies {
  readonly requiredFeatures?: readonly string[];
  readonly requiredLimits?: Readonly<Record<string, number>>;
}

export interface GpuSparseShadingCapabilityPlan {
  readonly schemaVersion: 1;
  readonly requiredFeatures: readonly GPUFeatureName[];
  readonly requiredLimits: Readonly<Record<string, number>>;
  readonly subgroupMinSize: number;
  readonly subgroupMaxSize: number;
}

export interface GpuSparseShadingDeviceSnapshot {
  readonly features: Iterable<string>;
  readonly limits: Readonly<Record<string, number | undefined>>;
  readonly textureFormatFeatures: readonly string[];
  readonly formatProfile: string;
}

export interface GpuSparseShadingCapabilityRecord {
  readonly schemaVersion: 1;
  readonly requiredFeatures: readonly string[];
  readonly deviceFeatures: readonly string[];
  readonly requiredLimits: Readonly<Record<string, number>>;
  readonly actualLimits: Readonly<Record<string, number>>;
  readonly subgroupMinSize: number;
  readonly subgroupMaxSize: number;
  readonly textureFormatFeatures: readonly string[];
  readonly formatProfile: string;
  readonly fingerprint: string;
}

export class UnsupportedGpuPerformanceBaselineError extends Error {
  readonly failureKind: "feature" | "limit" | "subgroup-range";
  readonly capability: string;
  readonly required: string | number;
  readonly actual: string | number;

  constructor(input: {
    failureKind: "feature" | "limit" | "subgroup-range";
    capability: string;
    required: string | number;
    actual: string | number;
  }) {
    super(
      `Unsupported OEngine GPU Performance Baseline: ${input.capability} ` +
      `requires ${input.required}, actual ${input.actual}`
    );
    this.name = "UnsupportedGpuPerformanceBaselineError";
    this.failureKind = input.failureKind;
    this.capability = input.capability;
    this.required = input.required;
    this.actual = input.actual;
  }
}

/** Pure adapter preflight. It does not request a device or create any GPU owner. */
export function createGpuSparseShadingCapabilityPlan(
  adapter: GpuSparseShadingAdapterSnapshot,
  dependencies: GpuSparseShadingCapabilityDependencies = {}
): Readonly<GpuSparseShadingCapabilityPlan> {
  const adapterFeatures = new Set([...adapter.features].map(String));
  const requestedFeatures = new Set<string>(GPU_SPARSE_SHADING_REQUIRED_FEATURES);
  for (const feature of dependencies.requiredFeatures ?? []) {
    if ((GPU_SPARSE_SHADING_FORBIDDEN_FEATURES as readonly string[]).includes(feature)) {
      throw new UnsupportedGpuPerformanceBaselineError({
        failureKind: "feature",
        capability: feature,
        required: "not requested by ADR-0013",
        actual: "requested by dependency closure"
      });
    }
    requestedFeatures.add(feature);
  }
  const requiredFeatures = [...requestedFeatures].sort();
  for (const feature of requiredFeatures) {
    if (!adapterFeatures.has(feature)) {
      throw new UnsupportedGpuPerformanceBaselineError({
        failureKind: "feature",
        capability: feature,
        required: "supported",
        actual: "missing"
      });
    }
  }

  const requiredLimits: Record<string, number> = {
    ...GPU_SPARSE_SHADING_REQUIRED_LIMITS
  };
  for (const [name, required] of Object.entries(dependencies.requiredLimits ?? {})) {
    assertPositiveSafeInteger(required, `Required limit ${name}`);
    requiredLimits[name] = Math.max(requiredLimits[name] ?? 0, required);
  }
  for (const [name, required] of Object.entries(requiredLimits)) {
    const actual = Number(adapter.limits[name] ?? 0);
    if (!Number.isFinite(actual) || actual < required) {
      throw new UnsupportedGpuPerformanceBaselineError({
        failureKind: "limit",
        capability: name,
        required,
        actual
      });
    }
  }
  const subgroupMinSize = Number(adapter.limits.subgroupMinSize ?? 0);
  const subgroupMaxSize = Number(adapter.limits.subgroupMaxSize ?? 0);
  validateSubgroupRange(subgroupMinSize, subgroupMaxSize);
  return Object.freeze({
    schemaVersion: GPU_SPARSE_SHADING_CAPABILITY_SCHEMA_VERSION as 1,
    requiredFeatures: Object.freeze(requiredFeatures as GPUFeatureName[]),
    requiredLimits: Object.freeze(sortNumberRecord(requiredLimits)),
    subgroupMinSize,
    subgroupMaxSize
  });
}

/** Freezes the actual post-device record used by pipeline keys and evidence. */
export function captureGpuSparseShadingCapabilityRecord(
  plan: GpuSparseShadingCapabilityPlan,
  device: GpuSparseShadingDeviceSnapshot
): Readonly<GpuSparseShadingCapabilityRecord> {
  const deviceFeatures = Object.freeze([...device.features].map(String).sort());
  const featureSet = new Set(deviceFeatures);
  for (const feature of plan.requiredFeatures) {
    if (!featureSet.has(feature)) {
      throw new UnsupportedGpuPerformanceBaselineError({
        failureKind: "feature",
        capability: feature,
        required: "enabled on device",
        actual: "missing"
      });
    }
  }
  const actualLimits: Record<string, number> = {};
  for (const [name, required] of Object.entries(plan.requiredLimits)) {
    const actual = Number(device.limits[name] ?? 0);
    if (!Number.isFinite(actual) || actual < required) {
      throw new UnsupportedGpuPerformanceBaselineError({
        failureKind: "limit",
        capability: name,
        required,
        actual
      });
    }
    actualLimits[name] = actual;
  }
  const subgroupMinSize = Number(device.limits.subgroupMinSize ?? 0);
  const subgroupMaxSize = Number(device.limits.subgroupMaxSize ?? 0);
  validateSubgroupRange(subgroupMinSize, subgroupMaxSize);
  if (device.formatProfile.length === 0) {
    throw new RangeError("Sparse shading format profile must not be empty");
  }
  const textureFormatFeatures = Object.freeze(
    [...new Set(device.textureFormatFeatures.map(String))].sort()
  );
  const canonical = {
    schemaVersion: GPU_SPARSE_SHADING_CAPABILITY_SCHEMA_VERSION as 1,
    requiredFeatures: [...plan.requiredFeatures],
    deviceFeatures,
    requiredLimits: sortNumberRecord(plan.requiredLimits),
    actualLimits: sortNumberRecord(actualLimits),
    subgroupMinSize,
    subgroupMaxSize,
    textureFormatFeatures,
    formatProfile: device.formatProfile
  };
  return Object.freeze({
    ...canonical,
    requiredFeatures: Object.freeze(canonical.requiredFeatures),
    requiredLimits: Object.freeze(canonical.requiredLimits),
    actualLimits: Object.freeze(canonical.actualLimits),
    fingerprint: JSON.stringify(canonical)
  });
}

function validateSubgroupRange(minimum: number, maximum: number): void {
  const valid = Number.isSafeInteger(minimum) && Number.isSafeInteger(maximum) &&
    minimum >= 4 && maximum <= 128 && minimum <= maximum &&
    isPowerOfTwo(minimum) && isPowerOfTwo(maximum) &&
    GPU_SHADING_BIN_CLASSIFIER_INVOCATIONS % minimum === 0 &&
    GPU_SHADING_BIN_CLASSIFIER_INVOCATIONS % maximum === 0;
  if (!valid) {
    throw new UnsupportedGpuPerformanceBaselineError({
      failureKind: "subgroup-range",
      capability: "subgroupMinSize..subgroupMaxSize",
      required: "power-of-two range 4..128 dividing 256",
      actual: `${minimum}..${maximum}`
    });
  }
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function sortNumberRecord(
  values: Readonly<Record<string, number>>
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(values).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  );
}

/** Version of the JSON contract shared by OEngine benchmark artifacts. */
export const BENCHMARK_RESULT_SCHEMA_VERSION = 2;

export type BenchmarkPowerPreference = GPUPowerPreference | "unknown";

export interface BenchmarkEngineIdentity {
  commit: string;
  dirty: boolean;
  dirtyReasons: string[];
}

export interface BenchmarkPlatformIdentity {
  os: string;
  browser: string;
  userAgent: string;
}

export interface BenchmarkAdapterIdentity {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  driver?: string | null;
}

export type BenchmarkBaselineRole =
  | "observability-smoke"
  | "frame-smoke"
  | "minimum-a"
  | "minimum-b"
  | "engine-generality-c";

export interface BenchmarkWebGpuEnvironmentInput {
  features: Iterable<string>;
  limits: Readonly<Record<string, number>>;
  powerPreference: BenchmarkPowerPreference;
}

export interface BenchmarkFrameEnvironment {
  canvasWidth: number;
  canvasHeight: number;
  internalWidth: number;
  internalHeight: number;
  dpr: number;
}

export interface BenchmarkRunEnvironmentInput {
  baselineRole: BenchmarkBaselineRole;
  featureSet: Iterable<string>;
  warmupFrames: number;
  sampleFrames: number;
  gpuSampleInterval: number;
  gpuCounterSampleInterval: number;
  readbackRingSlots: number;
}

export interface BenchmarkEnvironmentInput {
  capturedAt?: string;
  engine: BenchmarkEngineIdentity;
  platform: BenchmarkPlatformIdentity;
  adapter: BenchmarkAdapterIdentity | null;
  webgpu: BenchmarkWebGpuEnvironmentInput;
  frame: BenchmarkFrameEnvironment;
  run: BenchmarkRunEnvironmentInput;
}

export interface BenchmarkEnvironmentManifest {
  schemaVersion: number;
  capturedAt: string;
  engine: BenchmarkEngineIdentity;
  platform: BenchmarkPlatformIdentity;
  adapter: BenchmarkAdapterIdentity | null;
  webgpu: {
    features: string[];
    limits: Record<string, number>;
    powerPreference: BenchmarkPowerPreference;
    timestampQueryAvailable: boolean;
  };
  frame: BenchmarkFrameEnvironment;
  run: {
    baselineRole: BenchmarkBaselineRole;
    featureSet: string[];
    warmupFrames: number;
    sampleFrames: number;
    gpuSampleInterval: number;
    gpuCounterSampleInterval: number;
    readbackRingSlots: number;
  };
}

const WEBGPU_LIMIT_NAMES = [
  "maxTextureDimension1D",
  "maxTextureDimension2D",
  "maxTextureDimension3D",
  "maxTextureArrayLayers",
  "maxBindGroups",
  "maxBindGroupsPlusVertexBuffers",
  "maxBindingsPerBindGroup",
  "maxDynamicUniformBuffersPerPipelineLayout",
  "maxDynamicStorageBuffersPerPipelineLayout",
  "maxSampledTexturesPerShaderStage",
  "maxSamplersPerShaderStage",
  "maxStorageBuffersPerShaderStage",
  "maxStorageBuffersInVertexStage",
  "maxStorageBuffersInFragmentStage",
  "maxStorageTexturesPerShaderStage",
  "maxStorageTexturesInVertexStage",
  "maxStorageTexturesInFragmentStage",
  "maxUniformBuffersPerShaderStage",
  "maxUniformBufferBindingSize",
  "maxStorageBufferBindingSize",
  "minUniformBufferOffsetAlignment",
  "minStorageBufferOffsetAlignment",
  "maxVertexBuffers",
  "maxBufferSize",
  "maxVertexAttributes",
  "maxVertexBufferArrayStride",
  "maxInterStageShaderVariables",
  "maxColorAttachments",
  "maxColorAttachmentBytesPerSample",
  "maxComputeWorkgroupStorageSize",
  "maxComputeInvocationsPerWorkgroup",
  "maxComputeWorkgroupSizeX",
  "maxComputeWorkgroupSizeY",
  "maxComputeWorkgroupSizeZ",
  "maxComputeWorkgroupsPerDimension",
  "maxImmediateSize"
] as const satisfies readonly (Exclude<keyof GPUSupportedLimits, "__brand">)[];

/** GPUSupportedLimits commonly exposes prototype getters, so enumerate the spec fields. */
export function captureWebGpuLimits(
  limits: GPUSupportedLimits
): Record<string, number> {
  const captured: Record<string, number> = {};
  for (const name of WEBGPU_LIMIT_NAMES) {
    const value = limits[name];
    if (typeof value === "number") captured[name] = value;
  }
  return canonicalLimits(captured);
}

export function captureGpuAdapterIdentity(
  info: GPUAdapterInfo
): BenchmarkAdapterIdentity {
  return {
    vendor: info.vendor,
    architecture: info.architecture,
    device: info.device,
    description: info.description,
    driver: null
  };
}

/**
 * Produces deterministic benchmark metadata. Callers supply commit/browser data
 * because browsers do not expose a trustworthy repository or driver identity.
 */
export function createEnvironmentManifest(
  input: BenchmarkEnvironmentInput
): BenchmarkEnvironmentManifest {
  assertNonEmpty(input.engine.commit, "engine.commit");
  if (input.engine.dirty !== (input.engine.dirtyReasons.length > 0)) {
    throw new RangeError("engine.dirty must match engine.dirtyReasons");
  }
  assertNonEmpty(input.platform.os, "platform.os");
  assertNonEmpty(input.platform.browser, "platform.browser");
  assertPositiveInteger(input.frame.canvasWidth, "frame.canvasWidth");
  assertPositiveInteger(input.frame.canvasHeight, "frame.canvasHeight");
  assertPositiveInteger(input.frame.internalWidth, "frame.internalWidth");
  assertPositiveInteger(input.frame.internalHeight, "frame.internalHeight");
  assertPositiveNumber(input.frame.dpr, "frame.dpr");
  assertNonNegativeInteger(input.run.warmupFrames, "run.warmupFrames");
  assertPositiveInteger(input.run.sampleFrames, "run.sampleFrames");
  assertPositiveInteger(input.run.gpuSampleInterval, "run.gpuSampleInterval");
  assertPositiveInteger(
    input.run.gpuCounterSampleInterval,
    "run.gpuCounterSampleInterval"
  );
  assertPositiveInteger(input.run.readbackRingSlots, "run.readbackRingSlots");
  if (input.run.readbackRingSlots < 3) {
    throw new RangeError("run.readbackRingSlots must be at least 3");
  }
  assertBaselineRole(input.run.baselineRole);

  const features = canonicalStrings(input.webgpu.features);
  const featureSet = canonicalStrings(input.run.featureSet);
  const limits = canonicalLimits(input.webgpu.limits);
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(capturedAt))) {
    throw new RangeError("capturedAt must be an ISO-compatible date string");
  }

  return {
    schemaVersion: BENCHMARK_RESULT_SCHEMA_VERSION,
    capturedAt,
    engine: {
      commit: input.engine.commit,
      dirty: input.engine.dirty,
      dirtyReasons: canonicalStrings(input.engine.dirtyReasons)
    },
    platform: { ...input.platform },
    adapter: input.adapter === null
      ? null
      : { ...input.adapter, driver: input.adapter.driver ?? null },
    webgpu: {
      features,
      limits,
      powerPreference: input.webgpu.powerPreference,
      timestampQueryAvailable: features.includes("timestamp-query")
    },
    frame: { ...input.frame },
    run: {
      baselineRole: input.run.baselineRole,
      featureSet,
      warmupFrames: input.run.warmupFrames,
      sampleFrames: input.run.sampleFrames,
      gpuSampleInterval: input.run.gpuSampleInterval,
      gpuCounterSampleInterval: input.run.gpuCounterSampleInterval,
      readbackRingSlots: input.run.readbackRingSlots
    }
  };
}

function canonicalStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function canonicalLimits(
  limits: Readonly<Record<string, number>>
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const key of Object.keys(limits).sort((a, b) => a.localeCompare(b))) {
    const value = limits[key];
    if (value === undefined || !Number.isFinite(value) || value < 0) {
      throw new RangeError(`webgpu.limits.${key} must be a finite non-negative number`);
    }
    result[key] = value;
  }
  return result;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new RangeError(`${field} must not be empty`);
}

function assertPositiveNumber(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${field} must be a finite positive number`);
  }
}

function assertPositiveInteger(value: number, field: string): void {
  assertPositiveNumber(value, field);
  if (!Number.isInteger(value)) throw new RangeError(`${field} must be an integer`);
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative integer`);
  }
}

function assertBaselineRole(value: BenchmarkBaselineRole): void {
  const roles: readonly BenchmarkBaselineRole[] = [
    "observability-smoke",
    "frame-smoke",
    "minimum-a",
    "minimum-b",
    "engine-generality-c"
  ];
  if (!roles.includes(value)) {
    throw new RangeError(`run.baselineRole '${value}' is not supported`);
  }
}

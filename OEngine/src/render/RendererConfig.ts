import { resolveExposureSettings, type ExposureSettings } from "./temporal/ExposureSettings.js";

/** Immutable Renderer capability and execution configuration. */
export interface RendererConfig {
  /** Opt in to extended Display-P3 when canvas and display report support. */
  readonly displayProfile?: "sdr" | "hdr-auto";
  /** Create the VSM resource and pass owners. Disabled for A-D validation runs. */
  readonly enableVsm?: boolean;
  /** Create physical sky and atmosphere resources. Disabled for geometry-only A-D runs. */
  readonly enablePhysicalEnvironment?: boolean;
  /** Immutable for the renderer lifetime. False skips metering/adaptation and uses fixedExposure. Default true. */
  readonly autoExposure?: boolean;
  /** Fixed scene exposure used when autoExposure is false. Defaults to 1. */
  readonly fixedExposure?: number;
  /** Immutable HDR metering policy. Changes require a new renderer. */
  readonly exposure?: Partial<ExposureSettings>;
  /** Immutable named error budgets; omitted means exact/full-rate rejection. No shader or resource ownership transfers. */
  /** Internal visibility resolution relative to the output, in (0, 1]. */
  readonly renderScale?: number;
  readonly geometryResidency?: Readonly<{
    readonly maxUploadBytes?: number;
    readonly maxResidentBytes?: number;
  }>;
  readonly requiredFeatures?: readonly GPUFeatureName[];
  readonly requiredLimits?: Readonly<{
    maxStorageBuffersPerShaderStage?: number;
    maxColorAttachmentBytesPerSample?: number;
  }>;
}

export const DEFAULT_RENDERER_CONFIG: RendererConfig = Object.freeze({ renderScale: 1, enableVsm: true });

export function mergeRendererConfig(base: RendererConfig, override?: RendererConfig): RendererConfig {
  if (!override) return base;
  return Object.freeze({
    ...base,
    ...override,
    requiredFeatures: Object.freeze([...(base.requiredFeatures ?? []), ...(override.requiredFeatures ?? [])]),
    requiredLimits: Object.freeze({ ...base.requiredLimits, ...override.requiredLimits }),
    geometryResidency: Object.freeze({ ...base.geometryResidency, ...override.geometryResidency }),
  });
}

export function validateRendererConfig(config: RendererConfig): void {
  resolveExposureSettings(config.exposure);
  if (
    config.renderScale !== undefined &&
    (!Number.isFinite(config.renderScale) || config.renderScale <= 0 || config.renderScale > 1)
  ) {
    throw new RangeError("Renderer renderScale must be in (0, 1]");
  }
  if (
    config.fixedExposure !== undefined &&
    (!Number.isFinite(config.fixedExposure) || config.fixedExposure < 1e-6 || config.fixedExposure > 64)
  ) {
    throw new RangeError("fixedExposure must be finite and in [1e-6, 64]");
  }
  for (const [name, value] of Object.entries(config.geometryResidency ?? {})) {
    if (!Number.isSafeInteger(value) || value <= 0 || value % 4 !== 0) {
      throw new RangeError(`geometryResidency.${name} must be a positive 4-byte-aligned integer`);
    }
  }
  for (const feature of config.requiredFeatures ?? []) {
    if (!feature) throw new Error("Required WebGPU feature must not be empty");
  }
  for (const [name, limit] of Object.entries(config.requiredLimits ?? {})) {
    if (!Number.isFinite(limit) || limit <= 0)
      throw new RangeError(`requiredLimits.${name} must be positive`);
  }
}

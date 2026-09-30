import { packSurfaceProbeBudget } from "./surface/SurfaceProbe.js";

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
  /** Immutable named error budgets; omitted means exact/full-rate rejection. No shader or resource ownership transfers. */
  readonly surfaceShadingBudget?: import("./surface/SurfaceProbe.js").SurfaceProbeBudget;
  /** Internal visibility resolution relative to the output, in (0, 1]. */
  readonly renderScale?: number;
  readonly textureMaxResolution?: 256 | 512 | 1024 | 2048 | 4096;
  readonly textureBankMaxCapacities?: readonly [number, number, number, number, number];
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
    ...base, ...override,
    requiredFeatures: Object.freeze([...(base.requiredFeatures ?? []), ...(override.requiredFeatures ?? [])]),
    requiredLimits: Object.freeze({ ...base.requiredLimits, ...override.requiredLimits }),
    geometryResidency: Object.freeze({ ...base.geometryResidency, ...override.geometryResidency })
  });
}

export function validateRendererConfig(config: RendererConfig): void {
  if (config.surfaceShadingBudget !== undefined) packSurfaceProbeBudget(config.surfaceShadingBudget);
  if (config.renderScale !== undefined &&
      (!Number.isFinite(config.renderScale) || config.renderScale <= 0 || config.renderScale > 1)) {
    throw new RangeError("Renderer renderScale must be in (0, 1]");
  }
  if (config.textureMaxResolution !== undefined &&
      ![256, 512, 1024, 2048, 4096].includes(config.textureMaxResolution)) {
    throw new RangeError("textureMaxResolution must be a supported texture bank size");
  }
  if (config.fixedExposure !== undefined &&
      (!Number.isFinite(config.fixedExposure) || config.fixedExposure <= 0 || config.fixedExposure > 64)) {
    throw new RangeError("fixedExposure must be finite and in (0, 64]");
  }
  for (const [index, capacity] of (config.textureBankMaxCapacities ?? []).entries()) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`textureBankMaxCapacities[${index}] must be positive`);
    }
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
    if (!Number.isFinite(limit) || limit <= 0) throw new RangeError(`requiredLimits.${name} must be positive`);
  }
}

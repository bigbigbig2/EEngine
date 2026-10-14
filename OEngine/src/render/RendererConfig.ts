import { resolveExposureSettings, type ExposureSettings } from "./temporal/ExposureSettings.js";
import {
  AMBIENT_OCCLUSION_DEFAULT_SETTINGS,
  resolveAmbientOcclusionSettings,
  type AmbientOcclusionSettings,
} from "./ao/AmbientOcclusionSettings.js";
import {
  DEFAULT_FRAME_GEOMETRY_ARENA_MAX_BYTES,
  DEFAULT_FRAME_GEOMETRY_OWNER_MAX_BYTES
} from "../gpu/GpuFrameGeometryArenaAbi.js";

/** Immutable Renderer capability and execution configuration. */
export interface RendererConfig {
  /** Initial AO controls; runtime edits use Renderer.setAmbientOcclusionSettings. */
  readonly ambientOcclusion?: Partial<AmbientOcclusionSettings>;
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
  /** Immutable frame geometry ceilings. Allocates only admitted work; oversize
   * work or device limits reject before buffer creation. Owner includes all
   * live views and fence-retired worksets. Defaults: 512 MiB/view, 1 GiB/owner. */
  readonly frameGeometry?: Readonly<{
    readonly maxBytes?: number;
    readonly ownerMaxBytes?: number;
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
    ambientOcclusion: Object.freeze({ ...base.ambientOcclusion, ...override.ambientOcclusion }),
    requiredFeatures: Object.freeze([...(base.requiredFeatures ?? []), ...(override.requiredFeatures ?? [])]),
    requiredLimits: Object.freeze({ ...base.requiredLimits, ...override.requiredLimits }),
    geometryResidency: Object.freeze({ ...base.geometryResidency, ...override.geometryResidency }),
    frameGeometry: Object.freeze({ ...base.frameGeometry, ...override.frameGeometry })
  });
}

export function validateRendererConfig(config: RendererConfig): void {
  resolveAmbientOcclusionSettings(AMBIENT_OCCLUSION_DEFAULT_SETTINGS, config.ambientOcclusion ?? {});
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
  for (const [name, value] of Object.entries(config.frameGeometry ?? {})) {
    if (!Number.isSafeInteger(value) || value <= 0 || value % 4 !== 0) {
      throw new RangeError(`frameGeometry.${name} must be a positive 4-byte-aligned integer`);
    }
  }
  if (
    (config.frameGeometry?.maxBytes ?? DEFAULT_FRAME_GEOMETRY_ARENA_MAX_BYTES) >
    (config.frameGeometry?.ownerMaxBytes ?? DEFAULT_FRAME_GEOMETRY_OWNER_MAX_BYTES)
  ) {
    throw new RangeError("frameGeometry.maxBytes exceeds ownerMaxBytes");
  }
  for (const feature of config.requiredFeatures ?? []) {
    if (!feature) throw new Error("Required WebGPU feature must not be empty");
  }
  for (const [name, limit] of Object.entries(config.requiredLimits ?? {})) {
    if (!Number.isFinite(limit) || limit <= 0)
      throw new RangeError(`requiredLimits.${name} must be positive`);
  }
}

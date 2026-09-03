import type { RenderSettingsPatch } from "./pipeline/RenderSettings.js";

/**
 * Renderer 初始化配置。配置只在创建/初始化时作为默认值应用，运行时数值调整
 * 仍通过 Renderer.configure()，避免各 Pass 自己持有一份默认参数。
 */
export interface RendererConfig {
  /** RenderSettings 的完整增量；优先级高于下方便捷开关。 */
  readonly renderSettings?: RenderSettingsPatch;
  /** 便捷配置会被转换为统一 RenderSettings patch。 */
  readonly renderScale?: number;
  readonly aoScale?: 0.5 | 1;
  readonly ssrScale?: 0.5 | 1;
  readonly enableGTAO?: boolean;
  readonly enableSSSR?: boolean;
  readonly enableTAAU?: boolean;
  /** 提交给 adapter/device 的额外必需能力；缺失时初始化明确失败。 */
  readonly requiredFeatures?: readonly GPUFeatureName[];
  /** 额外的最小设备限制；缺失时初始化明确失败。 */
  readonly requiredLimits?: Readonly<{
    maxStorageBuffersPerShaderStage?: number;
    maxColorAttachmentBytesPerSample?: number;
  }>;
}

/**
 * 产品默认：固定中等偏高配置，效果默认开启；不是独立质量管线。
 */
export const DEFAULT_RENDERER_CONFIG: RendererConfig = Object.freeze({
  renderScale: 1,
  aoScale: 0.5,
  ssrScale: 0.5,
  enableGTAO: true,
  enableSSSR: true,
  enableTAAU: true
});

export function mergeRendererConfig(
  base: RendererConfig,
  override: RendererConfig | undefined
): RendererConfig {
  if (override === undefined) return base;
  const settings = {
    ...base.renderSettings,
    ...override.renderSettings,
    features: {
      ...base.renderSettings?.features,
      ...override.renderSettings?.features
    },
    ao: { ...base.renderSettings?.ao, ...override.renderSettings?.ao },
    ssr: { ...base.renderSettings?.ssr, ...override.renderSettings?.ssr },
    resolution: {
      ...base.renderSettings?.resolution,
      ...override.renderSettings?.resolution
    }
  };
  return Object.freeze({
    ...base,
    ...override,
    renderSettings: settings,
    requiredFeatures: Object.freeze([
      ...(base.requiredFeatures ?? []),
      ...(override.requiredFeatures ?? [])
    ]),
    requiredLimits: Object.freeze({
      ...base.requiredLimits,
      ...override.requiredLimits
    })
  });
}

/** 将产品便捷字段归一化为唯一 RenderSettings patch。 */
export function rendererConfigSettingsPatch(
  config: RendererConfig
): RenderSettingsPatch {
  return {
    ...config.renderSettings,
    features: {
      ...(config.enableGTAO === undefined
        ? {}
        : { ambientOcclusion: config.enableGTAO }),
      ...(config.enableSSSR === undefined
        ? {}
        : { screenSpaceReflections: config.enableSSSR }),
      ...(config.enableTAAU === undefined
        ? {}
        : { temporalAntiAliasing: config.enableTAAU }),
      ...config.renderSettings?.features
    },
    ao: {
      ...(config.aoScale === undefined ? {} : { resolutionScale: config.aoScale }),
      ...config.renderSettings?.ao
    },
    ssr: {
      ...(config.ssrScale === undefined ? {} : { resolutionScale: config.ssrScale }),
      ...config.renderSettings?.ssr
    },
    resolution: {
      ...(config.renderScale === undefined ? {} : { internalScale: config.renderScale }),
      ...config.renderSettings?.resolution
    }
  };
}

export function validateRendererConfig(config: RendererConfig): void {
  for (const feature of config.requiredFeatures ?? []) {
    if (feature.length === 0) throw new Error("Renderer required feature must not be empty");
  }
  for (const [name, value] of Object.entries(config.requiredLimits ?? {})) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`Renderer required limit '${name}' must be positive`);
    }
  }
}

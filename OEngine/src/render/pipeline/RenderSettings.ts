export type QualityProfile = "medium" | "high" | "ultra";

export interface PhysicalScaleContract {
  /** Number of meters represented by one scene world unit. */
  readonly metersPerWorldUnit: number;
}

export interface RenderFeatureSettings {
  readonly shadows: boolean;
  readonly ambientOcclusion: boolean;
  readonly screenSpaceReflections: boolean;
  readonly temporalAntiAliasing: boolean;
  readonly bloom: boolean;
  readonly automaticExposure: boolean;
  readonly motionBlur: boolean;
  readonly sharpening: boolean;
}

export interface GtaoSettings {
  readonly radiusMeters: number;
  readonly falloffMeters: number;
  readonly intensity: number;
  readonly resolutionScale: 0.5 | 1;
  readonly temporalEnabled: boolean;
  readonly sliceCount: number;
  readonly stepCount: number;
  readonly spatialStep: number;
  readonly temporalBlend: number;
}

export interface SsrSettings {
  readonly resolutionScale: 0.5 | 1;
  readonly temporalEnabled: boolean;
  readonly maxDistanceMeters: number;
  readonly edgeFade: number;
  readonly maxSteps: number;
  readonly baseThicknessMeters: number;
  readonly distanceThicknessScale: number;
  readonly maxRoughness: number;
  readonly temporalStrength: number;
}

export interface TemporalSettings {
  readonly historyStrength: number;
  readonly varianceGamma: number;
  readonly minimumHistoryWeight: number;
  readonly maximumHistoryWeight: number;
  readonly historyLockStep: number;
  readonly reactiveThreshold: number;
  readonly disocclusionThreshold: number;
  readonly motionFadePixels: number;
}

export interface ShadowSettings {
  readonly cascadeLambda: number;
  readonly maximumDistanceMeters: number;
  readonly texelGuardBand: number;
}

export interface PostSettings {
  readonly bloomIntensity: number;
  readonly sharpeningStrength: number;
  readonly exposureCompensation: number;
  readonly exposureSpeedUp: number;
  readonly exposureSpeedDown: number;
  /** ASC CDL lift（暗部加性偏移，线性域），默认 0 = 恒等。 */
  readonly colorGradingLift: number;
  /** ASC CDL gamma（幂指数），默认 1 = 恒等。 */
  readonly colorGradingGamma: number;
  /** ASC CDL gain（高光乘性增益），默认 1 = 恒等。 */
  readonly colorGradingGain: number;
  /** 饱和度，默认 1 = 恒等。 */
  readonly colorGradingSaturation: number;
  /** 对比度（log2 域斜率），默认 1 = 恒等。 */
  readonly colorGradingContrast: number;
}

export interface ResolutionSettings {
  readonly internalScale: number;
}

export interface RenderSettingsValues {
  readonly qualityProfile: QualityProfile;
  readonly physicalScale: PhysicalScaleContract;
  readonly features: RenderFeatureSettings;
  readonly ao: GtaoSettings;
  readonly ssr: SsrSettings;
  readonly temporal: TemporalSettings;
  readonly shadows: ShadowSettings;
  readonly post: PostSettings;
  readonly resolution: ResolutionSettings;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface RenderSettingsPatch {
  readonly qualityProfile?: QualityProfile;
  readonly physicalScale?: Partial<PhysicalScaleContract>;
  readonly features?: Partial<RenderFeatureSettings>;
  readonly ao?: Partial<GtaoSettings>;
  readonly ssr?: Partial<SsrSettings>;
  readonly temporal?: Partial<TemporalSettings>;
  readonly shadows?: Partial<ShadowSettings>;
  readonly post?: Partial<PostSettings>;
  readonly resolution?: Partial<ResolutionSettings>;
}

export interface RenderSettingsChange {
  readonly changed: boolean;
  readonly topologyChanged: boolean;
  readonly resourcesChanged: boolean;
  readonly resolutionChanged: boolean;
  readonly historiesInvalidated: readonly ("color" | "ssao" | "ssr")[];
  readonly revision: number;
}

export interface RenderFeatureContract {
  readonly owner: string;
  readonly inputDomain: "internal-full" | "output-full";
  readonly outputDomain: "internal-full" | "output-full";
  readonly history: "none" | "color" | "ssao" | "ssr";
  readonly topologyKeys: readonly string[];
  readonly prunedWhenDisabled: boolean;
}

export const RENDER_FEATURE_CONTRACTS = Object.freeze({
  ambientOcclusion: Object.freeze({
    owner: "AOService",
    inputDomain: "internal-full",
    outputDomain: "internal-full",
    history: "ssao",
    topologyKeys: Object.freeze(["features.ambientOcclusion", "ao.resolutionScale", "ao.temporalEnabled"]),
    prunedWhenDisabled: true
  }),
  screenSpaceReflections: Object.freeze({
    owner: "ReflectionService",
    inputDomain: "internal-full",
    outputDomain: "internal-full",
    history: "ssr",
    topologyKeys: Object.freeze([
      "features.screenSpaceReflections",
      "ssr.resolutionScale",
      "ssr.temporalEnabled"
    ]),
    prunedWhenDisabled: true
  }),
  temporalAntiAliasing: Object.freeze({
    owner: "TemporalFeature",
    inputDomain: "internal-full",
    outputDomain: "output-full",
    history: "color",
    topologyKeys: Object.freeze(["features.temporalAntiAliasing"]),
    prunedWhenDisabled: true
  })
} satisfies Record<string, RenderFeatureContract>);

const DEFAULTS: RenderSettingsValues = {
  qualityProfile: "high",
  physicalScale: { metersPerWorldUnit: 1 },
  features: {
    shadows: true,
    ambientOcclusion: true,
    screenSpaceReflections: false,
    temporalAntiAliasing: false,
    bloom: true,
    automaticExposure: true,
    motionBlur: false,
    sharpening: true
  },
  ao: {
    radiusMeters: 1,
    falloffMeters: 0.615,
    intensity: 1,
    resolutionScale: 0.5,
    temporalEnabled: true,
    sliceCount: 2,
    stepCount: 4,
    spatialStep: 1,
    temporalBlend: 0.95
  },
  ssr: {
    resolutionScale: 0.5,
    temporalEnabled: true,
    maxDistanceMeters: 16,
    edgeFade: 0.07,
    maxSteps: 128,
    baseThicknessMeters: 0.08,
    distanceThicknessScale: 0.01,
    maxRoughness: 0.65,
    temporalStrength: 0.9
  },
  temporal: {
    historyStrength: 1,
    varianceGamma: 1.25,
    minimumHistoryWeight: 0.65,
    maximumHistoryWeight: 0.92,
    historyLockStep: 1 / 16,
    reactiveThreshold: 0.5,
    disocclusionThreshold: 0.2,
    motionFadePixels: 128
  },
  shadows: {
    cascadeLambda: 0.5,
    maximumDistanceMeters: 80,
    texelGuardBand: 2.5
  },
  post: {
    bloomIntensity: 1,
    sharpeningStrength: 0.8,
    exposureCompensation: 1,
    exposureSpeedUp: 3,
    exposureSpeedDown: 1.2,
    colorGradingLift: 0,
    colorGradingGamma: 1,
    colorGradingGain: 1,
    colorGradingSaturation: 1,
    colorGradingContrast: 1
  },
  resolution: { internalScale: 1 }
};

const QUALITY_PATCHES: Readonly<Record<QualityProfile, RenderSettingsPatch>> = Object.freeze({
  medium: Object.freeze({
    ao: Object.freeze({ resolutionScale: 0.5, sliceCount: 1, stepCount: 3, spatialStep: 1 }),
    ssr: Object.freeze({ resolutionScale: 0.5, maxSteps: 64 })
  }),
  high: Object.freeze({
    ao: Object.freeze({ resolutionScale: 0.5, sliceCount: 2, stepCount: 4, spatialStep: 1 }),
    ssr: Object.freeze({ resolutionScale: 0.5, maxSteps: 96 })
  }),
  ultra: Object.freeze({
    ao: Object.freeze({ resolutionScale: 1, sliceCount: 3, stepCount: 6, spatialStep: 1 }),
    ssr: Object.freeze({ resolutionScale: 1, maxSteps: 128 })
  })
});

export function qualityProfilePatch(profile: QualityProfile): RenderSettingsPatch {
  return QUALITY_PATCHES[profile];
}

export function metersToWorldUnits(meters: number, scale: PhysicalScaleContract): number {
  assertFinitePositive(scale.metersPerWorldUnit, "metersPerWorldUnit");
  return meters / scale.metersPerWorldUnit;
}

export class RenderSettings {
  private current: RenderSettingsValues = freezeValues(cloneValues(DEFAULTS));
  private currentRevision = 0;

  get values(): RenderSettingsValues {
    return this.current;
  }

  update(patch: RenderSettingsPatch): RenderSettingsChange {
    const requestedProfile = patch.qualityProfile;
    const profilePatch = requestedProfile === undefined ? {} : QUALITY_PATCHES[requestedProfile];
    const next = mergeValues(this.current, profilePatch, patch);
    validate(next);
    const previous = this.current;
    if (sameValues(previous, next)) {
      return unchanged(this.currentRevision);
    }

    const featuresChanged = !sameRecord(previous.features, next.features);
    const topologyChanged =
      featuresChanged ||
      previous.ao.resolutionScale !== next.ao.resolutionScale ||
      previous.ao.temporalEnabled !== next.ao.temporalEnabled ||
      previous.ssr.resolutionScale !== next.ssr.resolutionScale ||
      previous.ssr.temporalEnabled !== next.ssr.temporalEnabled;
    const resolutionChanged = previous.resolution.internalScale !== next.resolution.internalScale;
    const resourcesChanged = topologyChanged || resolutionChanged;
    const histories = new Set<"color" | "ssao" | "ssr">();
    if (resolutionChanged ||
        previous.features.temporalAntiAliasing !== next.features.temporalAntiAliasing ||
        !sameRecord(previous.temporal, next.temporal)) histories.add("color");
    if (resolutionChanged ||
        previous.features.ambientOcclusion !== next.features.ambientOcclusion ||
        !sameRecord(previous.ao, next.ao) ||
        previous.physicalScale.metersPerWorldUnit !== next.physicalScale.metersPerWorldUnit) histories.add("ssao");
    if (resolutionChanged ||
        previous.features.screenSpaceReflections !== next.features.screenSpaceReflections ||
        !sameRecord(previous.ssr, next.ssr) ||
        previous.physicalScale.metersPerWorldUnit !== next.physicalScale.metersPerWorldUnit) histories.add("ssr");

    this.current = freezeValues(next);
    this.currentRevision++;
    return {
      changed: true,
      topologyChanged,
      resourcesChanged,
      resolutionChanged,
      historiesInvalidated: [...histories],
      revision: this.currentRevision
    };
  }
}

function mergeValues(
  current: RenderSettingsValues,
  profile: RenderSettingsPatch,
  patch: RenderSettingsPatch
): RenderSettingsValues {
  const combined = combinePatches(profile, patch);
  return {
    qualityProfile: patch.qualityProfile ?? current.qualityProfile,
    physicalScale: { ...current.physicalScale, ...combined.physicalScale },
    features: { ...current.features, ...combined.features },
    ao: { ...current.ao, ...combined.ao },
    ssr: { ...current.ssr, ...combined.ssr },
    temporal: { ...current.temporal, ...combined.temporal },
    shadows: { ...current.shadows, ...combined.shadows },
    post: { ...current.post, ...combined.post },
    resolution: { ...current.resolution, ...combined.resolution }
  };
}

function combinePatches(a: RenderSettingsPatch, b: RenderSettingsPatch): RenderSettingsPatch {
  return {
    physicalScale: { ...a.physicalScale, ...b.physicalScale },
    features: { ...a.features, ...b.features },
    ao: { ...a.ao, ...b.ao },
    ssr: { ...a.ssr, ...b.ssr },
    temporal: { ...a.temporal, ...b.temporal },
    shadows: { ...a.shadows, ...b.shadows },
    post: { ...a.post, ...b.post },
    resolution: { ...a.resolution, ...b.resolution }
  };
}

function validate(value: RenderSettingsValues): void {
  assertFinitePositive(value.physicalScale.metersPerWorldUnit, "metersPerWorldUnit");
  assertFinitePositive(value.ao.radiusMeters, "ao.radiusMeters");
  assertFinitePositive(value.ao.falloffMeters, "ao.falloffMeters");
  if (value.ao.resolutionScale !== 0.5 && value.ao.resolutionScale !== 1) {
    throw new RangeError("ao.resolutionScale must be 0.5 or 1");
  }
  assertRange(value.ao.intensity, 0, 4, "ao.intensity");
  assertIntegerRange(value.ao.sliceCount, 1, 4, "ao.sliceCount");
  assertIntegerRange(value.ao.stepCount, 1, 8, "ao.stepCount");
  assertIntegerRange(value.ao.spatialStep, 1, 4, "ao.spatialStep");
  assertRange(value.ao.temporalBlend, 0, 0.99, "ao.temporalBlend");
  if (value.ssr.resolutionScale !== 0.5 && value.ssr.resolutionScale !== 1) {
    throw new RangeError("ssr.resolutionScale must be 0.5 or 1");
  }
  assertFinitePositive(value.ssr.maxDistanceMeters, "ssr.maxDistanceMeters");
  assertFinitePositive(value.ssr.baseThicknessMeters, "ssr.baseThicknessMeters");
  assertRange(value.ssr.distanceThicknessScale, 0, 0.2, "ssr.distanceThicknessScale");
  assertRange(value.ssr.maxRoughness, 0, 1, "ssr.maxRoughness");
  assertRange(value.ssr.temporalStrength, 0, 1, "ssr.temporalStrength");
  assertIntegerRange(value.ssr.maxSteps, 1, 256, "ssr.maxSteps");
  assertRange(value.resolution.internalScale, 0.25, 1, "resolution.internalScale");
}

function cloneValues(value: RenderSettingsValues): RenderSettingsValues {
  return mergeValues(value, {}, {});
}

function freezeValues(value: RenderSettingsValues): RenderSettingsValues {
  const mutable = value as Mutable<RenderSettingsValues>;
  for (const key of ["physicalScale", "features", "ao", "ssr", "temporal", "shadows", "post", "resolution"] as const) {
    Object.freeze(mutable[key]);
  }
  return Object.freeze(mutable);
}

function sameValues(a: RenderSettingsValues, b: RenderSettingsValues): boolean {
  return a.qualityProfile === b.qualityProfile &&
    sameRecord(a.physicalScale, b.physicalScale) && sameRecord(a.features, b.features) &&
    sameRecord(a.ao, b.ao) && sameRecord(a.ssr, b.ssr) && sameRecord(a.temporal, b.temporal) &&
    sameRecord(a.shadows, b.shadows) && sameRecord(a.post, b.post) && sameRecord(a.resolution, b.resolution);
}

function sameRecord(a: object, b: object): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) =>
    (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key]);
}

function unchanged(revision: number): RenderSettingsChange {
  return {
    changed: false,
    topologyChanged: false,
    resourcesChanged: false,
    resolutionChanged: false,
    historiesInvalidated: [],
    revision
  };
}

function assertFinitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be finite and greater than zero`);
}

function assertRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isFinite(value) || value < min || value > max) throw new RangeError(`${label} must be in [${min}, ${max}]`);
}

function assertIntegerRange(value: number, min: number, max: number, label: string): void {
  assertRange(value, min, max, label);
  if (!Number.isInteger(value)) throw new RangeError(`${label} must be an integer`);
}

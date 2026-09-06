import type {
  RenderFeatureSettings,
  RenderSettingsPatch,
  Renderer
} from "../../OEngine/src/index.ts";

export type RenderingLabCaseId =
  | "base"
  | "full"
  | "full-minus-shadow"
  | "full-minus-gtao"
  | "full-minus-ssr"
  | "full-minus-transparency"
  | "full-minus-temporal"
  | "full-minus-bloom"
  | "full-minus-exposure"
  | "full-minus-motion-blur"
  | "full-minus-sharpen";

export type RenderingLabFeature =
  | "shadows"
  | "ambientOcclusion"
  | "screenSpaceReflections"
  | "temporalAntiAliasing"
  | "bloom"
  | "automaticExposure"
  | "motionBlur"
  | "sharpening";

export const RENDERING_LAB_CASES: readonly RenderingLabCaseId[] = Object.freeze([
  "base", "full", "full-minus-shadow", "full-minus-gtao", "full-minus-ssr",
  "full-minus-transparency", "full-minus-temporal", "full-minus-bloom",
  "full-minus-exposure", "full-minus-motion-blur", "full-minus-sharpen"
]);

export const RENDERING_LAB_FULL_FEATURES: Readonly<RenderFeatureSettings> = Object.freeze({
  shadows: true,
  ambientOcclusion: true,
  screenSpaceReflections: true,
  temporalAntiAliasing: true,
  bloom: true,
  automaticExposure: true,
  motionBlur: true,
  sharpening: true
});

const MINIMUM_FEATURES: Readonly<RenderFeatureSettings> = Object.freeze({
  shadows: false,
  ambientOcclusion: false,
  screenSpaceReflections: false,
  temporalAntiAliasing: false,
  bloom: false,
  automaticExposure: false,
  motionBlur: false,
  sharpening: false
});

export function featuresForCase(caseId: RenderingLabCaseId): Readonly<RenderFeatureSettings> {
  if (caseId === "base") return MINIMUM_FEATURES;
  const features = { ...RENDERING_LAB_FULL_FEATURES };
  const disabled = caseId.replace("full-minus-", "");
  if (disabled === "shadow") features.shadows = false;
  if (disabled === "gtao") features.ambientOcclusion = false;
  if (disabled === "ssr") features.screenSpaceReflections = false;
  if (disabled === "transparency") {
    // Transparency is workload-driven; this flag is consumed by the scenario
    // runner to remove transparent instance patches, not by RenderSettings.
  }
  if (disabled === "temporal") features.temporalAntiAliasing = false;
  if (disabled === "bloom") features.bloom = false;
  if (disabled === "exposure") features.automaticExposure = false;
  if (disabled === "motion-blur") features.motionBlur = false;
  if (disabled === "sharpen") features.sharpening = false;
  return Object.freeze(features);
}

export function patchForCase(caseId: RenderingLabCaseId): RenderSettingsPatch {
  const features = featuresForCase(caseId);
  return Object.freeze({
    features,
    ao: { resolutionScale: 0.5 as const, temporalEnabled: features.ambientOcclusion },
    ssr: { resolutionScale: 0.5 as const, temporalEnabled: features.screenSpaceReflections },
    resolution: { internalScale: 1 as const }
  });
}

export function applyCase(renderer: Renderer, caseId: RenderingLabCaseId): void {
  renderer.configure(patchForCase(caseId));
  renderer.internal_resolution_scale = 1;
  renderer.packed_visibility_cone_enabled = true;
  renderer.packed_visibility_hzb_enabled = true;
  renderer.packed_visibility_sse_threshold = 4;
}

export function featureLabels(features: Readonly<RenderFeatureSettings>): readonly string[] {
  return Object.entries(features)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .sort();
}

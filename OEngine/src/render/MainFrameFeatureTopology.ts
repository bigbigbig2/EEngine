import {
  RenderDebugView,
  isRenderableRenderDebugView,
  type RenderDebugView as RenderDebugViewT
} from "../debug/RenderDebugView.js";
import { RenderFeatureRegistry } from "./RenderFeatureRegistry.js";
import type { ScreenSpaceDiffuseMode } from "./pipeline/FrameProducts.js";

export type MainFrameFeatureInputs = {
  shadows: boolean;
  ssr: boolean;
  ssrTemporal?: boolean;
  ssrHalfResolution?: boolean;
  screenSpaceDiffuseMode: ScreenSpaceDiffuseMode;
  screenSpaceDiffuseTemporal?: boolean;
  screenSpaceDiffuseHalfResolution?: boolean;
  temporal: boolean;
  bloom: boolean;
  automaticExposure: boolean;
  motionBlur: boolean;
  sharpening: boolean;
  fusedIndirect: boolean;
  upscaleType: number;
  debugView: RenderDebugViewT;
  indirectLightingMode: number;
  transparency?: boolean;
  highDynamicRange?: boolean;
};

export type MainFrameFeatureTopology = Readonly<{
  shadows: boolean;
  ssr: boolean;
  ssrTemporal: boolean;
  ssrHalfResolution: boolean;
  screenSpaceDiffuseMode: ScreenSpaceDiffuseMode;
  gtao: boolean;
  ssgi: boolean;
  screenSpaceDiffuseTemporal: boolean;
  screenSpaceDiffuseHalfResolution: boolean;
  temporal: boolean;
  taa: boolean;
  nss: boolean;
  bloom: boolean;
  automaticExposure: boolean;
  motionBlur: boolean;
  sharpening: boolean;
  transparency: boolean;
  debug: boolean;
  enabledFeatureBits: number;
  persistentOwners: readonly string[];
  histories: readonly string[];
}>;

const MAIN_FRAME_FEATURES = new RenderFeatureRegistry<MainFrameFeatureInputs>([
  {
    id: "shadows",
    enabled: (input) => input.shadows,
    outputs: ["shadow-atlas", "shadow-factor"],
    persistentOwner: "shadow"
  },
  {
    id: "ssr",
    enabled: (input) => input.ssr,
    inputs: ["scene-depth", "opaque-hdr", "scene-normal"],
    outputs: ["ssr-specular"],
    persistentOwner: "ssr",
    history: (input) => input.ssrTemporal === false ? undefined : "ssr-history"
  },
  {
    id: "screen-space-diffuse",
    enabled: (input) => input.screenSpaceDiffuseMode !== "off",
    inputs: ["scene-depth", "scene-normal"],
    outputs: ["screen-ambient-visibility", "bent-normal", "near-field-diffuse-gi"],
    persistentOwner: (input) => input.screenSpaceDiffuseMode,
    history: (input) => input.screenSpaceDiffuseTemporal === false
      ? undefined
      : `${input.screenSpaceDiffuseMode}-history`
  },
  {
    id: "temporal",
    enabled: (input) => input.temporal,
    inputs: ["current-hdr", "velocity", "reactive-mask"],
    outputs: ["temporal-hdr"],
    persistentOwner: (input) => input.upscaleType === 1 ? "nss" : "taa",
    history: (input) => input.upscaleType === 1 ? "nss-feedback-history" : "temporal-color-history"
  },
  {
    id: "bloom",
    enabled: (input) => input.bloom,
    inputs: ["scene-hdr"],
    outputs: ["bloom-hdr"],
    persistentOwner: "bloom"
  },
  {
    id: "automatic-exposure",
    enabled: (input) => input.automaticExposure,
    persistentOwner: "automatic-exposure",
    history: "automatic-exposure-history"
  },
  { id: "motion-blur", enabled: (input) => input.motionBlur, persistentOwner: "motion-blur" },
  { id: "sharpen", enabled: (input) => input.sharpening, persistentOwner: "sharpen" },
  { id: "transparency", enabled: (input) => input.transparency === true, persistentOwner: "transparency" },
  { id: "render-debug", enabled: (input) => isRenderableRenderDebugView(input.debugView), persistentOwner: "render-debug" }
]);

/**
 * Single source of truth for optional main-frame topology and persistent
 * owners. Dynamic GPU handles and scene counts intentionally do not enter it.
 */
export function resolveMainFrameFeatureTopology(
  input: MainFrameFeatureInputs
): MainFrameFeatureTopology {
  if (!["off", "gtao", "ssgi"].includes(input.screenSpaceDiffuseMode)) {
    throw new Error(
      `Unknown screen-space diffuse mode '${String(input.screenSpaceDiffuseMode)}'`
    );
  }
  const taa = input.temporal && input.upscaleType !== 1;
  const nss = input.temporal && input.upscaleType === 1;
  const debug = isRenderableRenderDebugView(input.debugView);
  const debugTopology = debug ? debugTopologyCode(input.debugView) : 0;
  const gtao = input.screenSpaceDiffuseMode === "gtao";
  const ssgi = input.screenSpaceDiffuseMode === "ssgi";
  const screenSpaceDiffuseTemporal =
    input.screenSpaceDiffuseMode !== "off" &&
    input.screenSpaceDiffuseTemporal !== false;
  const screenSpaceDiffuseHalfResolution =
    input.screenSpaceDiffuseMode !== "off" &&
    input.screenSpaceDiffuseHalfResolution === true;
  const ssrTemporal = input.ssr && input.ssrTemporal !== false;
  const ssrHalfResolution = input.ssr && input.ssrHalfResolution === true;
  const featureSelection = MAIN_FRAME_FEATURES.resolve(input);

  let bits = 0;
  if (input.shadows) bits += 2 ** 0;
  if (input.ssr) bits += 2 ** 1;
  if (gtao) bits += 2 ** 2;
  if (input.temporal) bits += 2 ** 3;
  if (input.bloom) bits += 2 ** 4;
  if (input.automaticExposure) bits += 2 ** 5;
  if (input.motionBlur) bits += 2 ** 6;
  if (input.sharpening) bits += 2 ** 7;
  if (input.fusedIndirect) bits += 2 ** 8;
  bits += debugTopology * 2 ** 12;
  bits += input.indirectLightingMode * 2 ** 17;
  bits += (input.temporal ? input.upscaleType : 0) * 2 ** 20;
  if (input.transparency) bits += 2 ** 24;
  if (input.highDynamicRange) bits += 2 ** 25;
  if (screenSpaceDiffuseTemporal) bits += 2 ** 26;
  if (screenSpaceDiffuseHalfResolution) bits += 2 ** 27;
  if (ssrTemporal) bits += 2 ** 28;
  if (ssrHalfResolution) bits += 2 ** 29;
  if (ssgi) bits += 2 ** 30;

  return Object.freeze({
    shadows: input.shadows,
    ssr: input.ssr,
    ssrTemporal,
    ssrHalfResolution,
    screenSpaceDiffuseMode: input.screenSpaceDiffuseMode,
    gtao,
    ssgi,
    screenSpaceDiffuseTemporal,
    screenSpaceDiffuseHalfResolution,
    temporal: input.temporal,
    taa,
    nss,
    bloom: input.bloom,
    automaticExposure: input.automaticExposure,
    motionBlur: input.motionBlur,
    sharpening: input.sharpening,
    transparency: input.transparency === true,
    debug,
    enabledFeatureBits: bits,
    persistentOwners: featureSelection.persistentOwners,
    histories: featureSelection.histories
  });
}

function debugTopologyCode(view: RenderDebugViewT): number {
  switch (view) {
    case RenderDebugView.VisibilityKey: return 1;
    case RenderDebugView.Depth: return 2;
    case RenderDebugView.Velocity: return 3;
    case RenderDebugView.MaterialId: return 4;
    case RenderDebugView.BaseColor: return 5;
    case RenderDebugView.ShadingNormal: return 6;
    case RenderDebugView.Roughness: return 7;
    case RenderDebugView.Metallic: return 8;
    case RenderDebugView.Occlusion: return 9;
    case RenderDebugView.Emissive: return 10;
    case RenderDebugView.HistoryValidity: return 11;
    case RenderDebugView.Reactive: return 12;
    case RenderDebugView.IndirectDiffuse: return 13;
    case RenderDebugView.IndirectSpecular: return 14;
    case RenderDebugView.LinearHdr: return 15;
    case RenderDebugView.AmbientOcclusionRaw: return 16;
    case RenderDebugView.AmbientOcclusionDenoised: return 17;
    case RenderDebugView.AmbientOcclusionTemporal: return 18;
    case RenderDebugView.ScreenSpaceReflectionHitMiss: return 19;
    case RenderDebugView.ScreenSpaceReflectionHistoryConfidence: return 20;
    default: return 0;
  }
}

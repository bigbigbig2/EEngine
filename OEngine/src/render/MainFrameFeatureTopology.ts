import {
  RenderDebugView,
  isRenderableRenderDebugView,
  type RenderDebugView as RenderDebugViewT
} from "../debug/RenderDebugView.js";

export type MainFrameFeatureInputs = {
  shadows: boolean;
  ssr: boolean;
  ssao: boolean;
  temporal: boolean;
  bloom: boolean;
  automaticExposure: boolean;
  motionBlur: boolean;
  sharpening: boolean;
  fusedIndirect: boolean;
  upscaleType: number;
  debugView: RenderDebugViewT;
  indirectLightingMode: number;
  alphaTested?: boolean;
  previousSkinPositions?: boolean;
  previousSkinOffsets?: boolean;
  transparency?: boolean;
  highDynamicRange?: boolean;
};

export type MainFrameFeatureTopology = Readonly<{
  shadows: boolean;
  ssr: boolean;
  ssao: boolean;
  temporal: boolean;
  taa: boolean;
  nss: boolean;
  bloom: boolean;
  automaticExposure: boolean;
  motionBlur: boolean;
  sharpening: boolean;
  debug: boolean;
  enabledFeatureBits: number;
  persistentOwners: readonly string[];
  histories: readonly string[];
}>;

/**
 * Single source of truth for optional main-frame topology and persistent
 * owners. Dynamic GPU handles and scene counts intentionally do not enter it.
 */
export function resolveMainFrameFeatureTopology(
  input: MainFrameFeatureInputs
): MainFrameFeatureTopology {
  const taa = input.temporal && input.upscaleType !== 1;
  const nss = input.temporal && input.upscaleType === 1;
  const debug = isRenderableRenderDebugView(input.debugView);
  const debugTopology = input.debugView === RenderDebugView.VisibilityKey
    ? 1
    : input.debugView === RenderDebugView.Depth
      ? 2
      : input.debugView === RenderDebugView.Velocity
        ? 3
        : 0;

  let bits = 0;
  if (input.shadows) bits += 2 ** 0;
  if (input.ssr) bits += 2 ** 1;
  if (input.ssao) bits += 2 ** 2;
  if (input.temporal) bits += 2 ** 3;
  if (input.bloom) bits += 2 ** 4;
  if (input.automaticExposure) bits += 2 ** 5;
  if (input.motionBlur) bits += 2 ** 6;
  if (input.sharpening) bits += 2 ** 7;
  if (input.fusedIndirect) bits += 2 ** 8;
  if (input.alphaTested) bits += 2 ** 9;
  if (input.previousSkinOffsets) bits += 2 ** 10;
  if (input.previousSkinPositions) bits += 2 ** 11;
  bits += debugTopology * 2 ** 12;
  bits += input.indirectLightingMode * 2 ** 16;
  bits += (input.temporal ? input.upscaleType : 0) * 2 ** 19;
  if (input.transparency) bits += 2 ** 23;
  if (input.highDynamicRange) bits += 2 ** 24;

  return Object.freeze({
    shadows: input.shadows,
    ssr: input.ssr,
    ssao: input.ssao,
    temporal: input.temporal,
    taa,
    nss,
    bloom: input.bloom,
    automaticExposure: input.automaticExposure,
    motionBlur: input.motionBlur,
    sharpening: input.sharpening,
    debug,
    enabledFeatureBits: bits,
    persistentOwners: Object.freeze([
      ...(input.ssao ? ["ssao"] : []),
      ...(input.ssr ? ["ssr"] : []),
      ...(taa ? ["taa"] : []),
      ...(nss ? ["nss"] : []),
      ...(input.motionBlur ? ["motion-blur"] : []),
      ...(input.sharpening ? ["sharpen"] : []),
      ...(input.bloom ? ["bloom"] : []),
      ...(input.automaticExposure ? ["automatic-exposure"] : []),
      ...(debug ? ["render-debug"] : [])
    ]),
    histories: Object.freeze([
      ...(input.ssao ? ["ssao-history"] : []),
      ...(input.ssr ? ["ssr-history"] : []),
      ...(input.temporal ? ["temporal-color-history"] : []),
      ...(nss ? ["nss-feedback-history"] : []),
      ...(input.automaticExposure ? ["automatic-exposure-history"] : [])
    ])
  });
}

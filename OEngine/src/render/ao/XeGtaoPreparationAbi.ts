/**
 * XeGTAO a5b1686c7ea37788eeb3576b5be47f7c03db532c, MIT.
 * Shared constants for GenerateNormals, PrefilterDepths16x16 and scalar MainPass.
 * This is the one CPU/WGSL layout source.
 */
export const XE_GTAO_PREP_BYTES = 80;
export const XE_GTAO_DEFAULT_RADIUS_MULTIPLIER = 1.457;
export const XE_GTAO_DEFAULT_FALLOFF_RANGE = 0.615;
export const XE_GTAO_DEFAULT_SAMPLE_DISTRIBUTION_POWER = 2;
export const XE_GTAO_DEFAULT_THIN_OCCLUDER_COMPENSATION = 0;
export const XE_GTAO_DEFAULT_FINAL_VALUE_POWER = 2.2;
export const XE_GTAO_DEFAULT_DEPTH_MIP_SAMPLING_OFFSET = 3.3;
export const XE_GTAO_OCCLUSION_TERM_SCALE = 1.5;

export interface XeGtaoTuning {
  readonly radiusMultiplier?: number;
  readonly falloffRange?: number;
  readonly sampleDistributionPower?: number;
  readonly thinOccluderCompensation?: number;
  readonly finalValuePower?: number;
  readonly depthMipSamplingOffset?: number;
}

export const XE_GTAO_PREP_UNIFORM_WGSL = /* wgsl */ `
struct XeGtaoPrep {
  viewport: vec4f,       // width, height, 1/width, 1/height
  depth_unpack: vec4f,   // projection[10], projection[14], tanHalfFovX/Y
  ndc_to_view: vec4f,    // mul.xy, add.xy (includes jitter)
  effect: vec4f,         // world-unit radius, falloff, radius multiplier, noise index
  main: vec4f,           // sample distribution, thin compensation, final power, mip offset
};
@group(0) @binding(0) var<uniform> xe: XeGtaoPrep;

fn xe_view_depth(device_depth: f32) -> f32 {
  // EEngine reverse-Z adaptation of XeGTAO_ScreenSpaceToViewSpaceDepth.
  return min(3.402823466e+38, xe.depth_unpack.y /
    max(device_depth + xe.depth_unpack.x, 1.0e-30));
}
fn xe_view_position(uv: vec2f, depth: f32) -> vec3f {
  return vec3f((xe.ndc_to_view.xy * uv + xe.ndc_to_view.zw) * depth, depth);
}
fn xe_depth_mip_filter(depths: vec4f) -> f32 {
  let max_depth = max(max(depths.x, depths.y), max(depths.z, depths.w));
  let radius = 0.75 * xe.effect.x * xe.effect.z;
  let range = max(xe.effect.y * radius, 1.0e-10);
  let falloff_start = radius * (1.0 - xe.effect.y);
  let weights = clamp((vec4f(max_depth) - depths) * (-1.0 / range) +
    vec4f(falloff_start / range + 1.0), vec4f(0.0), vec4f(1.0));
  return dot(weights, depths) / max(dot(weights, vec4f(1.0)), 1.0e-10);
}
`;

export interface XeGtaoPreparationValues {
  readonly width: number;
  readonly height: number;
  /** The jittered projection uploaded to GPUCameraState for this frame. */
  readonly projection: ArrayLike<number>;
  readonly radiusMeters: number;
  readonly metersPerWorldUnit: number;
  readonly tuning?: XeGtaoTuning;
  /** 0 until a temporal owner guarantees matching accumulation/history. */
  readonly noiseIndex?: number;
}

/** Matches XeGTAO.h::GTAOUpdateConstants, adjusted for EEngine reverse-Z. */
export function packXeGtaoPreparation(input: XeGtaoPreparationValues): ArrayBuffer {
  const { width, height, projection } = input;
  if (
    !Number.isSafeInteger(width) ||
    width < 1 ||
    !Number.isSafeInteger(height) ||
    height < 1 ||
    !Number.isFinite(input.radiusMeters) ||
    input.radiusMeters <= 0 ||
    !Number.isFinite(input.metersPerWorldUnit) ||
    input.metersPerWorldUnit <= 0
  ) {
    throw new RangeError("XeGTAO viewport, radius and world scale must be positive");
  }
  const p00 = projection[0]!;
  const p11 = projection[5]!;
  const p08 = projection[8]!;
  const p09 = projection[9]!;
  const p22 = projection[10]!;
  const p32 = projection[14]!;
  if (![p00, p11, p08, p09, p22, p32].every(Number.isFinite) || p00 === 0 || p11 === 0 || p32 <= 0) {
    throw new RangeError("XeGTAO requires the current perspective reverse-Z projection");
  }
  const radius = input.radiusMeters / input.metersPerWorldUnit;
  const tuning = input.tuning;
  const radiusMultiplier = tuning?.radiusMultiplier ?? XE_GTAO_DEFAULT_RADIUS_MULTIPLIER;
  const falloffRange = tuning?.falloffRange ?? XE_GTAO_DEFAULT_FALLOFF_RANGE;
  const distribution = tuning?.sampleDistributionPower ?? XE_GTAO_DEFAULT_SAMPLE_DISTRIBUTION_POWER;
  const thinCompensation = tuning?.thinOccluderCompensation ?? XE_GTAO_DEFAULT_THIN_OCCLUDER_COMPENSATION;
  const finalPower = tuning?.finalValuePower ?? XE_GTAO_DEFAULT_FINAL_VALUE_POWER;
  const mipOffset = tuning?.depthMipSamplingOffset ?? XE_GTAO_DEFAULT_DEPTH_MIP_SAMPLING_OFFSET;
  const noiseIndex = input.noiseIndex ?? 0;
  if (
    !Number.isFinite(radius) ||
    !Number.isFinite(radiusMultiplier) ||
    radiusMultiplier < 0.3 ||
    radiusMultiplier > 3 ||
    !Number.isFinite(falloffRange) ||
    falloffRange <= 0 ||
    falloffRange > 1 ||
    !Number.isFinite(distribution) ||
    distribution < 1 ||
    distribution > 3 ||
    !Number.isFinite(thinCompensation) ||
    thinCompensation < 0 ||
    thinCompensation > 0.7 ||
    !Number.isFinite(finalPower) ||
    finalPower < 0.5 ||
    finalPower > 5 ||
    !Number.isFinite(mipOffset) ||
    mipOffset < 2 ||
    mipOffset > 6 ||
    !Number.isInteger(noiseIndex) ||
    noiseIndex < 0 ||
    noiseIndex >= 64
  ) {
    throw new RangeError("XeGTAO tuning or noise index is outside the source profile");
  }
  const packed = new Float32Array(XE_GTAO_PREP_BYTES / 4);
  packed.set([width, height, 1 / width, 1 / height], 0);
  packed.set([p22, p32, 1 / p00, 1 / p11], 4);
  packed.set([2 / p00, -2 / p11, (p08 - 1) / p00, (p09 + 1) / p11], 8);
  packed.set([radius, falloffRange, radiusMultiplier, noiseIndex], 12);
  packed.set([distribution, thinCompensation, finalPower, mipOffset], 16);
  return packed.buffer;
}

/** Source XeGTAO_DepthMIPFilter in f64 for focused CPU comparison. */
export function xeGtaoWeightedDepth4(
  depths: readonly [number, number, number, number],
  radiusWorldUnits: number,
): number {
  const maxDepth = Math.max(...depths);
  const radius = 0.75 * radiusWorldUnits * XE_GTAO_DEFAULT_RADIUS_MULTIPLIER;
  const range = Math.max(XE_GTAO_DEFAULT_FALLOFF_RANGE * radius, 1e-10);
  const from = radius * (1 - XE_GTAO_DEFAULT_FALLOFF_RANGE);
  const weights = depths.map((depth) =>
    Math.min(1, Math.max(0, (maxDepth - depth) * (-1 / range) + from / range + 1)),
  );
  const sum = weights.reduce((value, weight) => value + weight, 0);
  return depths.reduce((value, depth, index) => value + depth * weights[index]!, 0) / Math.max(sum, 1e-10);
}

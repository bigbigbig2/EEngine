/**
 * XeGTAO a5b1686c7ea37788eeb3576b5be47f7c03db532c, MIT.
 * C2/C3 constants for GenerateNormals and PrefilterDepths16x16.
 * This is the one CPU/WGSL layout source; MainPass extends it in C4.
 */
export const XE_GTAO_PREP_BYTES = 64;
export const XE_GTAO_DEFAULT_RADIUS_MULTIPLIER = 1.457;
export const XE_GTAO_DEFAULT_FALLOFF_RANGE = 0.615;

export const XE_GTAO_PREP_UNIFORM_WGSL = /* wgsl */ `
struct XeGtaoPrep {
  viewport: vec4f,       // width, height, 1/width, 1/height
  depth_unpack: vec4f,   // projection[10], projection[14], tanHalfFovX/Y
  ndc_to_view: vec4f,    // mul.xy, add.xy (includes jitter)
  effect: vec4f,         // world-unit radius, falloff, radius multiplier, unused
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
  let from = radius * (1.0 - xe.effect.y);
  let weights = clamp((vec4f(max_depth) - depths) * (-1.0 / range) +
    vec4f(from / range + 1.0), vec4f(0.0), vec4f(1.0));
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
}

/** Matches XeGTAO.h::GTAOUpdateConstants, adjusted for EEngine reverse-Z. */
export function packXeGtaoPreparation(input: XeGtaoPreparationValues): ArrayBuffer {
  const { width, height, projection } = input;
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1 ||
      !Number.isFinite(input.radiusMeters) || input.radiusMeters <= 0 ||
      !Number.isFinite(input.metersPerWorldUnit) || input.metersPerWorldUnit <= 0) {
    throw new RangeError("XeGTAO viewport, radius and world scale must be positive");
  }
  const p00 = projection[0]!;
  const p11 = projection[5]!;
  const p08 = projection[8]!;
  const p09 = projection[9]!;
  const p22 = projection[10]!;
  const p32 = projection[14]!;
  if (![p00, p11, p08, p09, p22, p32].every(Number.isFinite) ||
      p00 === 0 || p11 === 0 || p32 <= 0) {
    throw new RangeError("XeGTAO requires the current perspective reverse-Z projection");
  }
  const radius = input.radiusMeters / input.metersPerWorldUnit;
  const packed = new Float32Array(XE_GTAO_PREP_BYTES / 4);
  packed.set([width, height, 1 / width, 1 / height], 0);
  packed.set([p22, p32, 1 / p00, 1 / p11], 4);
  packed.set([2 / p00, -2 / p11, (p08 - 1) / p00, (p09 + 1) / p11], 8);
  packed.set([radius, XE_GTAO_DEFAULT_FALLOFF_RANGE,
    XE_GTAO_DEFAULT_RADIUS_MULTIPLIER, 0], 12);
  return packed.buffer;
}

/** Source XeGTAO_DepthMIPFilter in f64 for focused CPU comparison. */
export function xeGtaoWeightedDepth4(depths: readonly [number, number, number, number],
  radiusWorldUnits: number): number {
  const maxDepth = Math.max(...depths);
  const radius = 0.75 * radiusWorldUnits * XE_GTAO_DEFAULT_RADIUS_MULTIPLIER;
  const range = Math.max(XE_GTAO_DEFAULT_FALLOFF_RANGE * radius, 1e-10);
  const from = radius * (1 - XE_GTAO_DEFAULT_FALLOFF_RANGE);
  const weights = depths.map(depth => Math.min(1, Math.max(0,
    (maxDepth - depth) * (-1 / range) + from / range + 1)));
  const sum = weights.reduce((value, weight) => value + weight, 0);
  return depths.reduce((value, depth, index) => value + depth * weights[index]!, 0) /
    Math.max(sum, 1e-10);
}

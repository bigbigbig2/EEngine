/**
 * Stage 2A CPU oracle for the scene-linear direct BRDF.
 *
 * This is intentionally independent TypeScript, not a runtime shader helper. It
 * mirrors the numeric contract of `lighting_direct.ts` so browser evidence can
 * compare known material/light vectors without reading GPU buffers back every
 * frame.
 */

export type DirectRgb = readonly [number, number, number];

export interface DirectLightingReferenceInput {
  readonly albedo: DirectRgb;
  readonly metallic: number;
  readonly roughness: number;
  readonly noL: number;
  readonly noV: number;
  readonly noH: number;
  readonly voH: number;
  readonly radiance: DirectRgb;
}

export interface DirectLightingReferenceOutput {
  readonly fresnel: DirectRgb;
  readonly diffuse: DirectRgb;
  readonly specular: DirectRgb;
  readonly contribution: DirectRgb;
}

const PI = Math.PI;
const RECIPROCAL_PI = 1 / PI;
const EPSILON = 1e-7;

export function schlickFresnel(
  f0: DirectRgb,
  f90: number,
  cosine: number
): DirectRgb {
  const oneMinus = 1 - clamp01(cosine);
  const fifth = oneMinus ** 5;
  return [
    f0[0] + (f90 - f0[0]) * fifth,
    f0[1] + (f90 - f0[1]) * fifth,
    f0[2] + (f90 - f0[2]) * fifth
  ];
}

export function evaluateDirectLighting(
  input: DirectLightingReferenceInput
): DirectLightingReferenceOutput {
  const metallic = clamp01(input.metallic);
  const roughness = Math.max(input.roughness, 0.02);
  const noL = clamp01(input.noL);
  const noV = clamp01(input.noV);
  const noH = clamp01(input.noH);
  const f0: DirectRgb = [
    0.04 + (input.albedo[0] - 0.04) * metallic,
    0.04 + (input.albedo[1] - 0.04) * metallic,
    0.04 + (input.albedo[2] - 0.04) * metallic
  ];
  const fresnel = schlickFresnel(f0, 1, input.voH);
  const alpha = roughness * roughness;
  const alphaSquared = alpha * alpha;
  const denominator = noH * noH * (alphaSquared - 1) + 1;
  const distribution = alphaSquared / (PI * denominator * denominator);
  const lambdaV = noL * Math.sqrt(Math.max(noV * noV * (1 - alphaSquared) + alphaSquared, 0));
  const lambdaL = noV * Math.sqrt(Math.max(noL * noL * (1 - alphaSquared) + alphaSquared, 0));
  const visibility = 0.5 / Math.max(lambdaV + lambdaL, EPSILON);
  const diffuseColor: DirectRgb = [
    input.albedo[0] * (1 - metallic),
    input.albedo[1] * (1 - metallic),
    input.albedo[2] * (1 - metallic)
  ];
  const diffuse: DirectRgb = [
    diffuseColor[0] * Math.max(0, 1 - fresnel[0]),
    diffuseColor[1] * Math.max(0, 1 - fresnel[1]),
    diffuseColor[2] * Math.max(0, 1 - fresnel[2])
  ];
  const specular: DirectRgb = [
    fresnel[0] * visibility * distribution,
    fresnel[1] * visibility * distribution,
    fresnel[2] * visibility * distribution
  ];
  const contribution: DirectRgb = [
    input.radiance[0] * (specular[0] + diffuse[0] * RECIPROCAL_PI),
    input.radiance[1] * (specular[1] + diffuse[1] * RECIPROCAL_PI),
    input.radiance[2] * (specular[2] + diffuse[2] * RECIPROCAL_PI)
  ];
  if (!contribution.every(Number.isFinite)) {
    return {
      fresnel,
      diffuse: [0, 0, 0],
      specular: [0, 0, 0],
      contribution: [0, 0, 0]
    };
  }
  return { fresnel, diffuse, specular, contribution };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

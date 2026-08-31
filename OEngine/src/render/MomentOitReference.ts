/**
 * Four power-moment MBOIT reference used by FX-05 CPU oracles.
 *
 * Mathematical source: Muenstermann et al., Moment-Based Order-Independent
 * Transparency, I3D 2018. The official CC0 implementation is recorded in the
 * FX-05 porting ledger. WebGPU production WGSL keeps the same invariants and
 * adds finite/degenerate fallbacks at the numeric boundary.
 */

export const MBOIT_MAX_COVERAGE = 0.997;
export const MBOIT_SINGLE_PRECISION_BIAS = 5e-7;
export const MBOIT_BIAS_VECTOR = Object.freeze([0, 0.375, 0, 0.375] as const);
export const MBOIT_OVER_ESTIMATION = 0.25;

export interface PowerMoments4 {
  readonly b0: number;
  readonly moments: readonly [number, number, number, number];
}

export function accumulatePowerMoments4(
  fragments: readonly Readonly<{ depth: number; opacity: number }>[]
): PowerMoments4 {
  let b0 = 0;
  let m0 = 0;
  let m1 = 0;
  let m2 = 0;
  let m3 = 0;
  for (const fragment of fragments) {
    const depth = clamp01(finiteOr(fragment.depth, 0));
    const opacity = Math.min(MBOIT_MAX_COVERAGE, clamp01(finiteOr(fragment.opacity, 0)));
    const absorbance = -Math.log1p(-opacity);
    const depth2 = depth * depth;
    b0 += absorbance;
    m0 += depth * absorbance;
    m1 += depth2 * absorbance;
    m2 += depth2 * depth * absorbance;
    m3 += depth2 * depth2 * absorbance;
  }
  return Object.freeze({
    b0,
    moments: Object.freeze([m0, m1, m2, m3]) as readonly [number, number, number, number]
  });
}

/** Conservative total transmittance; also the production degenerate fallback. */
export function totalMomentTransmittance(b0: number): number {
  return Math.exp(-Math.max(0, finiteOr(b0, 0)));
}

export function resolvePowerMoments4(
  depth: number,
  accumulation: PowerMoments4,
  bias = MBOIT_SINGLE_PRECISION_BIAS,
  overEstimation = MBOIT_OVER_ESTIMATION
): number {
  const b0 = finiteOr(accumulation.b0, 0);
  if (b0 <= 1e-8) return 1;
  const fallback = totalMomentTransmittance(b0);
  const raw = accumulation.moments;
  const normalized = [
    raw[0] / b0,
    raw[1] / b0,
    raw[2] / b0,
    raw[3] / b0
  ];
  const moments = normalized.map((value, index) =>
    finiteOr(value, MBOIT_BIAS_VECTOR[index]!) * (1 - bias) +
    MBOIT_BIAS_VECTOR[index]! * bias
  );
  const d = clamp01(finiteOr(depth, 0));
  const l21D11 = moments[1]! - moments[0]! * moments[0]!;
  const l32D11 = moments[2]! - moments[0]! * moments[1]!;
  if (Math.abs(l21D11) <= 1e-12) return fallback;
  const l32 = l32D11 / l21D11;
  const d22 = moments[3]! - moments[1]! * moments[1]!;
  const denominator22 = d22 - l32D11 * l32;
  if (Math.abs(denominator22) <= 1e-12) return fallback;
  let c0 = 1;
  let c1 = d - moments[0]!;
  let c2 = d * d - moments[1]!;
  c2 -= l32 * c1;
  c1 /= l21D11;
  c2 /= denominator22;
  c1 -= l32 * c2;
  c0 -= c1 * moments[0]! + c2 * moments[1]!;
  if (Math.abs(c2) <= 1e-12) return fallback;
  const p = c1 / c2;
  const q = c0 / c2;
  const discriminant = p * p * 0.25 - q;
  if (!Number.isFinite(discriminant) || discriminant < 0) return fallback;
  const root = Math.sqrt(discriminant);
  const z1 = -p * 0.5 - root;
  const z2 = -p * 0.5 + root;
  const d10 = z1 - d;
  const d21 = z2 - z1;
  const d20 = z2 - d;
  if (Math.min(Math.abs(d10), Math.abs(d21), Math.abs(d20)) <= 1e-12) return fallback;
  const switchValues = [overEstimation, z1 < d ? 1 : 0, z2 < d ? 1 : 0];
  const quotient = (switchValues[1]! - switchValues[0]!) / d10;
  const quotient2 = (switchValues[2]! - switchValues[1]!) / d21;
  const coefficient = (quotient2 - quotient) / d20;
  let px = quotient - coefficient * z1;
  const pz = coefficient;
  const py = px - coefficient * d;
  px = switchValues[0]! - px * d;
  const absorbance = px + moments[0]! * py + moments[1]! * pz;
  const result = Math.exp(-b0 * absorbance);
  return Number.isFinite(result) ? clamp01(result) : fallback;
}

export function sortedAlphaComposite(
  fragments: readonly Readonly<{
    depth: number;
    opacity: number;
    color: readonly [number, number, number];
  }>[]
): readonly [number, number, number, number] {
  const sorted = [...fragments].sort((left, right) => right.depth - left.depth);
  let color: [number, number, number] = [0, 0, 0];
  let alpha = 0;
  for (const fragment of sorted) {
    const opacity = clamp01(finiteOr(fragment.opacity, 0));
    const oneMinus = 1 - opacity;
    color = [
      finiteOr(fragment.color[0], 0) * opacity + color[0] * oneMinus,
      finiteOr(fragment.color[1], 0) * opacity + color[1] * oneMinus,
      finiteOr(fragment.color[2], 0) * opacity + color[2] * oneMinus
    ];
    alpha = opacity + alpha * oneMinus;
  }
  return Object.freeze([color[0], color[1], color[2], alpha]);
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

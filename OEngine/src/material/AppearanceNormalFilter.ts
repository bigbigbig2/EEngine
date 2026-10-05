/**
 * CoupledVmfAppearanceFilter, local profile. Reference stages:
 * The Forge AssetPipeline_Textures.cpp @ cd5046893faba2dc7869243873bf01f02a6f0df9
 * Copyright (c) 2017-2025 The Forge Interactive Inc., Apache-2.0.
 * Mathematical profile: Karis, 2018, Normal map filtering using vMF (part 3).
 * See docs/porting/next-renderer.md for differences and incomplete adoption.
 * A GGX fit to a vMF mixture is an approximation, not exact mixed-GGX shading.
 */
export const APPEARANCE_NORMAL_FILTER_MODEL = "vmf-r-perceptual-ggx-v1";
export const APPEARANCE_NORMAL_MIN_MOMENT_SQUARED = 1e-8;

export interface AppearanceNormalFilterContract {
  readonly model: typeof APPEARANCE_NORMAL_FILTER_MODEL;
  readonly momentField: string;
  readonly normalOutput: string;
  readonly roughnessOutput: string;
  readonly maxAngleRadians: number;
  readonly maxRoughnessError: number;
  /** CPU lattice probes after quantization/fit; hardware filter precision is a separate GPU check. */
  readonly measuredAngleRadians: number;
  readonly measuredRoughnessError: number;
}

export interface AppearanceFilteredNormal {
  readonly normal: readonly [number, number, number];
  /** Perceptual roughness, as used by the Standard/Coated material ABI. */
  readonly roughness: number;
  /** An isotropic/cancelled distribution has no unique direction. */
  readonly directionValid: boolean;
}

/** Offline conversion from evaluated signed TS normal and perceptual roughness. */
export function encodeAppearanceNormalMoment(
  normal: readonly number[],
  roughness: number,
): readonly [number, number, number] {
  const length = Math.hypot(...normal);
  if (
    normal.length !== 3 ||
    !normal.every(Number.isFinite) ||
    !Number.isFinite(length) ||
    length === 0 ||
    !Number.isFinite(roughness) ||
    roughness < 0 ||
    roughness > 1
  ) {
    throw new RangeError(
      "Appearance normal moment requires a finite direction and perceptual roughness in [0,1]",
    );
  }
  const alpha = roughness * roughness,
    invLambda = 0.5 * alpha * alpha;
  // Evaluate the infinite concentration limit directly; no divide by zero.
  const exp2L = invLambda > 0.1 ? Math.exp(-2 / invLambda) : 0;
  const meanLength = (invLambda > 0.1 ? (1 + exp2L) / (1 - exp2L) : 1) - invLambda;
  return [
    (normal[0]! / length) * meanLength,
    (normal[1]! / length) * meanLength,
    (normal[2]! / length) * meanLength,
  ];
}

/** Hot consumer profile, f32 Karis inverse. Filter moments BEFORE this function. */
export function decodeAppearanceNormalMoment(moment: readonly number[]): AppearanceFilteredNormal {
  const f = Math.fround,
    [x, y, z] = moment.map(f) as [number, number, number];
  const raw = f(f(f(x * x) + f(y * y)) + f(z * z));
  if (raw <= APPEARANCE_NORMAL_MIN_MOMENT_SQUARED) {
    return { normal: [0, 0, 1], roughness: 1, directionValid: false };
  }
  const r2 = Math.min(raw, 1),
    invLength = f(1 / Math.sqrt(raw));
  const invLambda = f(f(f(1 / Math.sqrt(r2)) * f(1 - r2)) / f(3 - r2));
  const alpha = f(Math.sqrt(Math.min(f(2 * invLambda), 1)));
  return {
    normal: [f(x * invLength), f(y * invLength), f(z * invLength)],
    roughness: f(Math.sqrt(alpha)),
    directionValid: true,
  };
}

/** Independent cold double reference: numerically invert coth(k)-1/k, not Karis's inverse fit. */
export function referenceAppearanceNormalMoment(moment: readonly number[]): AppearanceFilteredNormal {
  const length = Math.hypot(...moment);
  if (length * length <= APPEARANCE_NORMAL_MIN_MOMENT_SQUARED) {
    return { normal: [0, 0, 1], roughness: 1, directionValid: false };
  }
  const normal = moment.map((n) => n / length) as [number, number, number];
  // Roundoff in normalizing an exactly unit double vector is not material variance.
  if (length >= 1 - 1e-15) return { normal, roughness: 0, directionValid: true };
  const mean = (inv: number) => {
    if (inv === 0) return 1;
    const e = Math.exp(-2 / inv);
    return (1 + e) / (1 - e) - inv;
  };
  if (length <= mean(0.5)) return { normal, roughness: 1, directionValid: true };
  let low = 0,
    high = 0.5;
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    if (mean(mid) > length) low = mid;
    else high = mid;
  }
  return { normal, roughness: Math.sqrt(Math.sqrt((2 * (low + high)) / 2)), directionValid: true };
}

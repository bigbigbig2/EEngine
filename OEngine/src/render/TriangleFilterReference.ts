export type TriangleFilterRejectReason =
  | "invalid"
  | "degenerate"
  | "backface"
  | "frustum"
  | "small-primitive";

export interface TriangleFilterReferenceOptions {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly doubleSided: boolean;
  readonly mirrored: boolean;
  /** Orientation in NDC before the WebGPU viewport Y transform. */
  readonly frontFace: "ccw" | "cw";
  readonly sampleCount: number;
  readonly cullSmallPrimitives: boolean;
}

export interface TriangleFilterReferenceResult {
  readonly keep: boolean;
  readonly reason: TriangleFilterRejectReason | null;
  readonly crossesNearPlane: boolean;
}

/**
 * CPU oracle for the exact-triangle GPU filter. It follows The Forge's
 * homogeneous orientation + conservative clip/bounds ordering while making
 * OEngine's WebGPU clip range and fail-open cases explicit.
 */
export function filterTriangleClipReference(
  clip: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>],
  options: TriangleFilterReferenceOptions
): TriangleFilterReferenceResult {
  validateOptions(options);
  const vertices = clip.map((value, index) => readClip(value, index)) as
    [readonly number[], readonly number[], readonly number[]];
  if (vertices.some((value) => value.some((component) => !Number.isFinite(component)))) {
    return rejected("invalid", false);
  }
  const crossesNearPlane = vertices.some((value) => value[2]! < 0 || value[3]! <= 0) &&
    vertices.some((value) => value[2]! >= 0 && value[3]! > 0);
  if (outsideClipVolume(vertices)) return rejected("frustum", crossesNearPlane);

  // A triangle crossing w=0 or the near plane stays conservative. Projection,
  // small-primitive and orientation tests are not stable across that plane.
  if (crossesNearPlane || vertices.some((value) => value[3]! <= 0)) {
    return kept(true);
  }

  const determinant = homogeneousOrientation(vertices);
  const determinantScale = Math.max(
    ...vertices.flatMap((value) => [Math.abs(value[0]!), Math.abs(value[1]!), Math.abs(value[3]!)]),
    1
  );
  if (Math.abs(determinant) <= Number.EPSILON * determinantScale * determinantScale * determinantScale * 16) {
    return rejected("degenerate", false);
  }
  if (!options.doubleSided) {
    const expectedPositive = (options.frontFace === "ccw") !== options.mirrored;
    if ((determinant > 0) !== expectedPositive) return rejected("backface", false);
  }

  if (options.cullSmallPrimitives && fixedPointSmallPrimitiveRejected(
    vertices,
    options.viewportWidth,
    options.viewportHeight,
    options.sampleCount
  )) {
    return rejected("small-primitive", false);
  }
  return kept(false);
}

function outsideClipVolume(
  vertices: readonly (readonly number[])[]
): boolean {
  // WebGPU homogeneous clip volume: -w <= x/y <= w and 0 <= z <= w.
  return vertices.every((value) => value[0]! < -value[3]!) ||
    vertices.every((value) => value[0]! > value[3]!) ||
    vertices.every((value) => value[1]! < -value[3]!) ||
    vertices.every((value) => value[1]! > value[3]!) ||
    vertices.every((value) => value[2]! < 0) ||
    vertices.every((value) => value[2]! > value[3]!);
}

function homogeneousOrientation(vertices: readonly (readonly number[])[]): number {
  const [a, b, c] = vertices;
  return a![0]! * (b![1]! * c![3]! - b![3]! * c![1]!) -
    a![1]! * (b![0]! * c![3]! - b![3]! * c![0]!) +
    a![3]! * (b![0]! * c![1]! - b![1]! * c![0]!);
}

/**
 * Direct CPU transcription of The Forge's 23.8 small-primitive predicate.
 * The sample multiplier is retained for the upstream 1-4x MSAA contract.
 */
function fixedPointSmallPrimitiveRejected(
  vertices: readonly (readonly number[])[],
  width: number,
  height: number,
  samples: number
): boolean {
  const subpixelSamples = 256;
  const subpixelMask = 0xff;
  const sampleCenter = subpixelSamples / 2;
  const sampleSize = subpixelSamples - 1;
  const fixed = vertices.map((value) => [
    (value[0]! / value[3]! * 0.5 + 0.5) * width,
    (0.5 - value[1]! / value[3]! * 0.5) * height
  ].map((component) => Math.trunc(component * subpixelSamples * samples)) as
    [number, number]);
  for (let axis = 0; axis < 2; axis++) {
    const minimum = Math.min(...fixed.map((value) => value[axis]!));
    const maximum = Math.max(...fixed.map((value) => value[axis]!));
    const fractionalMinimum = minimum & subpixelMask;
    const distanceFromFirstCenter = maximum -
      ((minimum & ~subpixelMask) + sampleCenter);
    if (fractionalMinimum > sampleCenter && distanceFromFirstCenter < sampleSize) {
      return true;
    }
  }
  return false;
}

function readClip(value: ArrayLike<number>, index: number): readonly number[] {
  if (value.length !== 4) throw new RangeError(`clip[${index}] must contain four values`);
  return Object.freeze([value[0]!, value[1]!, value[2]!, value[3]!]);
}

function validateOptions(options: TriangleFilterReferenceOptions): void {
  for (const [label, value] of [
    ["viewportWidth", options.viewportWidth],
    ["viewportHeight", options.viewportHeight],
    ["sampleCount", options.sampleCount]
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${label} must be a positive integer`);
    }
  }
  if (options.frontFace !== "ccw" && options.frontFace !== "cw") {
    throw new RangeError("frontFace must be ccw or cw");
  }
  if (options.sampleCount > 4) {
    throw new RangeError("sampleCount must not exceed the upstream 4x precision contract");
  }
}

function rejected(
  reason: TriangleFilterRejectReason,
  crossesNearPlane: boolean
): TriangleFilterReferenceResult {
  return Object.freeze({ keep: false, reason, crossesNearPlane });
}

function kept(crossesNearPlane: boolean): TriangleFilterReferenceResult {
  return Object.freeze({ keep: true, reason: null, crossesNearPlane });
}

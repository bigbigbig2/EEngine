type Vec2 = readonly [number, number];
type Vec3 = readonly [number, number, number];
type Vec4 = readonly [number, number, number, number];

export interface ProjectedSurfaceBarycentric {
  readonly weights: Vec3;
  readonly ddx: Vec3;
  readonly ddy: Vec3;
  readonly valid: boolean;
}

/** Independent CPU oracle for The Forge CalcFullBary's projected one-pixel gradients. */
export function projectedSurfaceBarycentricReference(
  pixel: Vec2,
  clips: readonly [Vec4, Vec4, Vec4],
  extent: Vec2,
): Readonly<ProjectedSurfaceBarycentric> {
  const invalid = (): Readonly<ProjectedSurfaceBarycentric> =>
    Object.freeze({
      weights: [1, 0, 0] as Vec3,
      ddx: [0, 0, 0] as Vec3,
      ddy: [0, 0, 0] as Vec3,
      valid: false,
    });
  if (
    !Number.isFinite(extent[0]) ||
    !Number.isFinite(extent[1]) ||
    extent[0] <= 0 ||
    extent[1] <= 0 ||
    clips.some((clip) => !clip.every(Number.isFinite) || Math.abs(clip[3]) < 1e-8)
  )
    return invalid();
  const screen = clips.map(
    (clip) =>
      [((clip[0] / clip[3]) * 0.5 + 0.5) * extent[0], (0.5 - (clip[1] / clip[3]) * 0.5) * extent[1]] as Vec2,
  );
  const [a, b, c] = screen as [Vec2, Vec2, Vec2];
  const determinant = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-8) return invalid();
  const at = (sample: Vec2): Vec3 | null => {
    const l0 = ((b[1] - c[1]) * (sample[0] - c[0]) + (c[0] - b[0]) * (sample[1] - c[1])) / determinant;
    const l1 = ((c[1] - a[1]) * (sample[0] - c[0]) + (a[0] - c[0]) * (sample[1] - c[1])) / determinant;
    const affine = [l0, l1, 1 - l0 - l1];
    const weighted = affine.map((lambda, index) => lambda / clips[index]![3]);
    const denominator = weighted[0]! + weighted[1]! + weighted[2]!;
    if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-8) return null;
    return [weighted[0]! / denominator, weighted[1]! / denominator, weighted[2]! / denominator];
  };
  const center = at(pixel);
  const right = at([pixel[0] + 1, pixel[1]]);
  const below = at([pixel[0], pixel[1] + 1]);
  if (center === null || right === null || below === null) return invalid();
  const subtract = (lhs: Vec3, rhs: Vec3): Vec3 => [lhs[0] - rhs[0], lhs[1] - rhs[1], lhs[2] - rhs[2]];
  return Object.freeze({
    weights: center,
    ddx: subtract(right, center),
    ddy: subtract(below, center),
    valid: true,
  });
}

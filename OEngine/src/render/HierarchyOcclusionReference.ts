import type { HzbLevel } from "./HzbReference.js";
import { isReverseZOccluded } from "./HzbReference.js";

export interface ClusterConeReference {
  readonly apex: readonly [number, number, number];
  readonly axis: readonly [number, number, number];
  readonly cutoff: number;
  readonly valid: boolean;
  readonly doubleSided?: boolean;
}

export interface ProjectedAabbHzbReference {
  readonly uvMin: readonly [number, number];
  readonly uvMax: readonly [number, number];
  readonly candidateNearestDepth: number;
  readonly mip: number;
}

/**
 * CPU oracle for meshoptimizer v1.0's perspective cone test. Mirrored,
 * non-uniform and sheared transforms deliberately fail open.
 */
export function isClusterConeBackfacingReference(
  cone: ClusterConeReference,
  objectToWorld: ArrayLike<number>,
  cameraPosition: readonly [number, number, number]
): boolean {
  if (!cone.valid || cone.doubleSided || objectToWorld.length < 16) return false;
  const x = axis(objectToWorld, 0);
  const y = axis(objectToWorld, 4);
  const z = axis(objectToWorld, 8);
  const sx = length3(x);
  const sy = length3(y);
  const sz = length3(z);
  const maximum = Math.max(sx, sy, sz);
  const minimum = Math.min(sx, sy, sz);
  if (!Number.isFinite(maximum) || minimum <= 1e-12 ||
    maximum - minimum > maximum * 1e-5) return false;
  if (Math.max(Math.abs(dot3(x, y)), Math.abs(dot3(x, z)), Math.abs(dot3(y, z))) >
    maximum * maximum * 1e-5) return false;
  if (dot3(cross3(x, y), z) <= 0) return false;
  const axisLength = length3(cone.axis);
  if (!Number.isFinite(cone.cutoff) || cone.cutoff < -1 || cone.cutoff >= 1 ||
    axisLength < 0.5 || axisLength > 1.5) return false;
  const apex = transformPoint(objectToWorld, cone.apex);
  const transformedAxis: [number, number, number] = [
    x[0] * cone.axis[0] + y[0] * cone.axis[1] + z[0] * cone.axis[2],
    x[1] * cone.axis[0] + y[1] * cone.axis[1] + z[1] * cone.axis[2],
    x[2] * cone.axis[0] + y[2] * cone.axis[1] + z[2] * cone.axis[2]
  ];
  const normalizedAxis = scale3(transformedAxis, 1 / length3(transformedAxis));
  const view: [number, number, number] = [
    apex[0] - cameraPosition[0],
    apex[1] - cameraPosition[1],
    apex[2] - cameraPosition[2]
  ];
  const viewLength = length3(view);
  return viewLength > 1e-12 &&
    dot3(view, normalizedAxis) >= cone.cutoff * viewLength;
}

/** Conservative 8-corner projection used by the R3-D previous-HZB shader. */
export function projectAabbToPreviousHzbReference(
  boundsMin: readonly [number, number, number],
  boundsMax: readonly [number, number, number],
  currentObjectToWorld: ArrayLike<number>,
  previousFromCurrent: ArrayLike<number>,
  previousWorldToClip: ArrayLike<number>,
  hzbWidth: number,
  hzbHeight: number,
  mipLevelCount: number,
  motionValid = true
): ProjectedAabbHzbReference | null {
  if (!motionValid || currentObjectToWorld.length < 16 ||
    previousFromCurrent.length < 16 || previousWorldToClip.length < 16 ||
    !Number.isInteger(hzbWidth) || hzbWidth < 1 ||
    !Number.isInteger(hzbHeight) || hzbHeight < 1 ||
    !Number.isInteger(mipLevelCount) || mipLevelCount < 1) return null;
  let minU = 1;
  let minV = 1;
  let maxU = 0;
  let maxV = 0;
  let nearest = 0;
  for (let corner = 0; corner < 8; corner++) {
    const local: [number, number, number] = [
      (corner & 1) === 0 ? boundsMin[0] : boundsMax[0],
      (corner & 2) === 0 ? boundsMin[1] : boundsMax[1],
      (corner & 4) === 0 ? boundsMin[2] : boundsMax[2]
    ];
    const currentWorld = transformPoint(currentObjectToWorld, local);
    const previousWorld4 = transform4(previousFromCurrent, [
      currentWorld[0], currentWorld[1], currentWorld[2], 1
    ]);
    const clip = transform4(previousWorldToClip, previousWorld4);
    if (!clip.every(Number.isFinite) || clip[3] <= 1e-6) return null;
    const ndcX = clip[0] / clip[3];
    const ndcY = clip[1] / clip[3];
    const ndcZ = clip[2] / clip[3];
    const u = ndcX * 0.5 + 0.5;
    const v = 0.5 - ndcY * 0.5;
    minU = Math.min(minU, u);
    minV = Math.min(minV, v);
    maxU = Math.max(maxU, u);
    maxV = Math.max(maxV, v);
    nearest = Math.max(nearest, clamp01(ndcZ));
  }
  if (maxU <= 0 || maxV <= 0 || minU >= 1 || minV >= 1) return null;
  minU = clamp01(minU);
  minV = clamp01(minV);
  maxU = clamp01(maxU);
  maxV = clamp01(maxV);
  const footprint = Math.max((maxU - minU) * hzbWidth, (maxV - minV) * hzbHeight);
  const mip = Math.min(Math.ceil(Math.log2(Math.max(footprint, 1))), mipLevelCount - 1);
  return Object.freeze({
    uvMin: [minU, minV] as const,
    uvMax: [maxU, maxV] as const,
    candidateNearestDepth: nearest,
    mip
  });
}

export function isProjectedAabbOccludedReference(
  projected: ProjectedAabbHzbReference,
  level: HzbLevel
): boolean {
  const loX = texel(projected.uvMin[0], level.width);
  const loY = texel(projected.uvMin[1], level.height);
  const hiX = texel(projected.uvMax[0], level.width);
  const hiY = texel(projected.uvMax[1], level.height);
  const farthest = Math.min(
    hzbMin(level, loX, loY),
    hzbMin(level, hiX, loY),
    hzbMin(level, loX, hiY),
    hzbMin(level, hiX, hiY)
  );
  return isReverseZOccluded(projected.candidateNearestDepth, farthest);
}

function hzbMin(level: HzbLevel, x: number, y: number): number {
  return level.minMax[(y * level.width + x) * 2]!;
}

function texel(uv: number, size: number): number {
  return Math.max(0, Math.min(size - 1, Math.floor(uv * size)));
}

function transformPoint(matrix: ArrayLike<number>, value: readonly [number, number, number]): [number, number, number] {
  const result = transform4(matrix, [value[0], value[1], value[2], 1]);
  return [result[0], result[1], result[2]];
}

function transform4(matrix: ArrayLike<number>, value: readonly [number, number, number, number]): [number, number, number, number] {
  return [0, 1, 2, 3].map((row) =>
    matrix[row]! * value[0] + matrix[row + 4]! * value[1] +
    matrix[row + 8]! * value[2] + matrix[row + 12]! * value[3]
  ) as [number, number, number, number];
}

function axis(matrix: ArrayLike<number>, begin: number): [number, number, number] {
  return [Number(matrix[begin]), Number(matrix[begin + 1]), Number(matrix[begin + 2])];
}

function dot3(a: readonly number[], b: readonly number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

function cross3(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!
  ];
}

function length3(value: readonly number[]): number { return Math.hypot(...value); }
function scale3(value: readonly number[], scale: number): [number, number, number] {
  return [value[0]! * scale, value[1]! * scale, value[2]! * scale];
}
function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }

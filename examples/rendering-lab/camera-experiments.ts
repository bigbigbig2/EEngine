import type { PerspectiveCamera } from "../../OEngine/src/index.ts";

export type CameraExperimentKind = "fixed-fov" | "projection-normalized";
export type CameraLodMode = "automatic" | "locked";

export interface CameraSweepCase {
  readonly id: string;
  readonly kind: CameraExperimentKind;
  readonly distanceM: number;
  readonly fovDeg: number;
  readonly target: readonly [number, number, number];
  readonly lodMode: CameraLodMode;
  readonly projectedReferenceHeightPx: number;
}

export const CAMERA_SWEEP_DISTANCES_M = Object.freeze([4, 6, 10, 18, 32, 56]);
export const CAMERA_REFERENCE_DISTANCE_M = 18;
export const CAMERA_REFERENCE_FOV_DEG = 50;
export const CAMERA_REFERENCE_WORLD_HEIGHT_M = 3;
export const CAMERA_REFERENCE_SCREEN_HEIGHT_PX = 220;

export function createCameraSweep(
  kind: CameraExperimentKind,
  target: readonly [number, number, number],
  viewportHeight: number,
  lodMode: CameraLodMode = "automatic"
): readonly CameraSweepCase[] {
  return Object.freeze(CAMERA_SWEEP_DISTANCES_M.map((distanceM) => {
    const fovDeg = kind === "fixed-fov"
      ? CAMERA_REFERENCE_FOV_DEG
      : projectionNormalizedFov(distanceM, CAMERA_REFERENCE_DISTANCE_M, CAMERA_REFERENCE_FOV_DEG);
    const projectedReferenceHeightPx = projectedHeightPx(
      CAMERA_REFERENCE_WORLD_HEIGHT_M,
      distanceM,
      fovDeg,
      viewportHeight
    );
    return Object.freeze({
      id: `${kind}-${distanceM}m-${lodMode}`,
      kind,
      distanceM,
      fovDeg,
      target,
      lodMode,
      projectedReferenceHeightPx
    });
  }));
}

export function projectionNormalizedFov(
  distanceM: number,
  referenceDistanceM: number,
  referenceFovDeg: number
): number {
  if (!Number.isFinite(distanceM) || distanceM <= 0) throw new RangeError("distanceM must be positive");
  if (!Number.isFinite(referenceDistanceM) || referenceDistanceM <= 0) throw new RangeError("referenceDistanceM must be positive");
  if (!Number.isFinite(referenceFovDeg) || referenceFovDeg <= 0 || referenceFovDeg >= 179) throw new RangeError("referenceFovDeg must be in (0, 179)");
  const tangent = referenceDistanceM * Math.tan(referenceFovDeg * Math.PI / 360) / distanceM;
  return 360 / Math.PI * Math.atan(tangent);
}

export function projectedHeightPx(
  worldHeightM: number,
  distanceM: number,
  fovDeg: number,
  viewportHeight: number
): number {
  if (![worldHeightM, distanceM, viewportHeight].every((value) => Number.isFinite(value) && value > 0)) {
    throw new RangeError("projection inputs must be positive finite numbers");
  }
  if (!Number.isFinite(fovDeg) || fovDeg <= 0 || fovDeg >= 179) throw new RangeError("fovDeg must be in (0, 179)");
  return viewportHeight * worldHeightM / (2 * distanceM * Math.tan(fovDeg * Math.PI / 360));
}

export function applyCameraSweepCase(
  camera: PerspectiveCamera,
  sweep: CameraSweepCase,
  direction: readonly [number, number, number]
): void {
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (!Number.isFinite(length) || length <= 0) throw new RangeError("camera direction must be non-zero");
  camera.fov_degrees = sweep.fovDeg;
  camera.transform.position.set(
    sweep.target[0] + direction[0] / length * sweep.distanceM,
    sweep.target[1] + direction[1] / length * sweep.distanceM,
    sweep.target[2] + direction[2] / length * sweep.distanceM
  );
  camera.transform.lookAt({ x: sweep.target[0], y: sweep.target[1], z: sweep.target[2] });
  camera.update();
}

export function cameraDistance(
  position: readonly [number, number, number],
  target: readonly [number, number, number]
): number {
  return Math.hypot(position[0] - target[0], position[1] - target[1], position[2] - target[2]);
}

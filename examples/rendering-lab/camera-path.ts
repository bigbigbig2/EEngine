import type { PerspectiveCamera } from "../../OEngine/src/index.ts";

export type RenderingLabCameraSegment =
  | "overview"
  | "occlusion-run"
  | "transparent-close"
  | "cut-recovery";

export interface RenderingLabCameraKeyframe {
  readonly tSeconds: number;
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly segment: RenderingLabCameraSegment;
  readonly cutId: string | null;
}

export interface RenderingLabCameraPathSample {
  readonly tSeconds: number;
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly segment: RenderingLabCameraSegment;
  readonly cutId: string | null;
}

export const RENDERING_LAB_CAMERA_PATH_ID = "rendering-lab-overview-v2";
export const RENDERING_LAB_CAMERA_PATH: readonly RenderingLabCameraKeyframe[] = Object.freeze([
  { tSeconds: 0, position: [17.5, 9.6, 21], target: [0, -0.1, -0.8], segment: "overview", cutId: null },
  { tSeconds: 3, position: [8.4, 4.4, 11.2], target: [1.8, 0.5, 0.2], segment: "occlusion-run", cutId: null },
  { tSeconds: 6, position: [4.2, 2.4, 6.3], target: [6.4, 0.2, 1.2], segment: "transparent-close", cutId: null },
  { tSeconds: 6.01, position: [18.5, 10.2, 22.8], target: [0, -0.1, -0.8], segment: "cut-recovery", cutId: "overview-cut-1" },
  { tSeconds: 9, position: [16.2, 8.8, 19.4], target: [0.4, 0.1, -0.6], segment: "cut-recovery", cutId: null }
].map((keyframe): RenderingLabCameraKeyframe => Object.freeze({
  ...keyframe,
  segment: keyframe.segment as RenderingLabCameraSegment,
  position: Object.freeze([...keyframe.position] as [number, number, number]),
  target: Object.freeze([...keyframe.target] as [number, number, number])
})));

export const RENDERING_LAB_CAMERA_PATH_DURATION_SECONDS = 9;

export function sampleRenderingLabCameraPath(tSeconds: number): RenderingLabCameraPathSample {
  if (!Number.isFinite(tSeconds) || tSeconds < 0) throw new RangeError("tSeconds must be non-negative");
  const t = Math.min(RENDERING_LAB_CAMERA_PATH_DURATION_SECONDS, tSeconds);
  const cut = RENDERING_LAB_CAMERA_PATH.find((keyframe) => keyframe.cutId !== null);
  if (cut !== undefined && Math.abs(t - cut.tSeconds) < 0.12) return cloneSample(cut, t);
  let nextIndex = RENDERING_LAB_CAMERA_PATH.findIndex((keyframe) => keyframe.tSeconds > t);
  if (nextIndex < 0) nextIndex = RENDERING_LAB_CAMERA_PATH.length - 1;
  const next = RENDERING_LAB_CAMERA_PATH[nextIndex]!;
  const previous = RENDERING_LAB_CAMERA_PATH[Math.max(0, nextIndex - 1)]!;
  if (next.cutId !== null && t >= next.tSeconds) return cloneSample(next, t);
  const span = Math.max(1e-6, next.tSeconds - previous.tSeconds);
  const alpha = Math.max(0, Math.min(1, (t - previous.tSeconds) / span));
  return {
    tSeconds: t,
    position: lerp3(previous.position, next.position, alpha),
    target: lerp3(previous.target, next.target, alpha),
    segment: alpha < 0.5 ? previous.segment : next.segment,
    cutId: null
  };
}

export function applyRenderingLabCameraPath(
  camera: PerspectiveCamera,
  sample: RenderingLabCameraPathSample
): void {
  camera.transform.position.set(...sample.position);
  camera.transform.lookAt({ x: sample.target[0], y: sample.target[1], z: sample.target[2] });
  camera.update();
}

function cloneSample(keyframe: RenderingLabCameraKeyframe, tSeconds: number): RenderingLabCameraPathSample {
  return {
    tSeconds,
    position: [...keyframe.position] as [number, number, number],
    target: [...keyframe.target] as [number, number, number],
    segment: keyframe.segment,
    cutId: keyframe.cutId
  };
}

function lerp3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  alpha: number
): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * alpha,
    a[1] + (b[1] - a[1]) * alpha,
    a[2] + (b[2] - a[2]) * alpha
  ];
}

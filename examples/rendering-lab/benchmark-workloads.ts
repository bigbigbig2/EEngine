import type { RenderingLabCaseId } from "./quality-profile.js";

export const RENDERING_LAB_WORKLOAD_IDS = Object.freeze([
  "comprehensive-full",
  "cube-far-effects-off",
  "cube-near-effects-off",
  "projection-normalized",
  "microtriangle-stress",
  "heavy-overdraw-large-occluder",
  "material-mosaic-7",
  "near-plane-motion"
] as const);

export type RenderingLabWorkloadId = (typeof RENDERING_LAB_WORKLOAD_IDS)[number];

type CameraPose = Readonly<{
  kind: "pose" | "near-plane-motion";
  position: readonly [number, number, number];
  target: readonly [number, number, number];
}>;

type WorkloadCamera =
  | Readonly<{ kind: "overview" }>
  | Readonly<{ kind: "projection-normalized"; lodMode: "automatic" }>
  | CameraPose;

export interface RenderingLabWorkloadProfile {
  readonly id: RenderingLabWorkloadId;
  readonly caseIds: readonly RenderingLabCaseId[];
  readonly camera: WorkloadCamera;
  readonly sseThreshold: number;
  readonly animateScene: boolean;
}

const WORKLOADS: Readonly<Record<RenderingLabWorkloadId, RenderingLabWorkloadProfile>> = Object.freeze({
  "comprehensive-full": workload(
    "comprehensive-full",
    ["full"],
    { kind: "overview" },
    4,
    true
  ),
  "cube-far-effects-off": workload(
    "cube-far-effects-off",
    ["base"],
    { kind: "pose", position: [5.2, 1.2, 12], target: [5.2, -0.4, -0.8] },
    4,
    false
  ),
  "cube-near-effects-off": workload(
    "cube-near-effects-off",
    ["base"],
    { kind: "pose", position: [5.2, -0.05, 1.35], target: [5.2, -0.4, -0.8] },
    4,
    false
  ),
  "projection-normalized": workload(
    "projection-normalized",
    ["base"],
    { kind: "projection-normalized", lodMode: "automatic" },
    4,
    false
  ),
  "microtriangle-stress": workload(
    "microtriangle-stress",
    ["base"],
    { kind: "pose", position: [17.5, 9.6, 21], target: [-5.8, 1.7, -0.4] },
    0.25,
    false
  ),
  "heavy-overdraw-large-occluder": workload(
    "heavy-overdraw-large-occluder",
    ["base"],
    { kind: "pose", position: [17, 1.9, -0.4], target: [-5.8, 1.9, -0.4] },
    4,
    false
  ),
  "material-mosaic-7": workload(
    "material-mosaic-7",
    ["base"],
    { kind: "pose", position: [8, 5, 9], target: [8, -0.5, 0.4] },
    4,
    false
  ),
  "near-plane-motion": workload(
    "near-plane-motion",
    ["base"],
    { kind: "near-plane-motion", position: [5.2, -0.4, 0.28], target: [5.2, -0.4, -0.8] },
    0.25,
    true
  )
});

export function resolveRenderingLabWorkload(
  id: RenderingLabWorkloadId | string = "comprehensive-full"
): RenderingLabWorkloadProfile {
  const result = WORKLOADS[id as RenderingLabWorkloadId];
  if (result === undefined) throw new RangeError(`Unknown Rendering Lab workload '${id}'`);
  return result;
}

function workload(
  id: RenderingLabWorkloadId,
  caseIds: readonly RenderingLabCaseId[],
  camera: WorkloadCamera,
  sseThreshold: number,
  animateScene: boolean
): RenderingLabWorkloadProfile {
  return Object.freeze({
    id,
    caseIds: Object.freeze([...caseIds]),
    camera: freezeCamera(camera),
    sseThreshold,
    animateScene
  });
}

function freezeCamera(camera: WorkloadCamera): WorkloadCamera {
  if (camera.kind === "overview") return Object.freeze({ kind: camera.kind });
  if (camera.kind === "projection-normalized") {
    return Object.freeze({ kind: camera.kind, lodMode: camera.lodMode });
  }
  return Object.freeze({
    kind: camera.kind,
    position: Object.freeze([...camera.position]) as unknown as readonly [number, number, number],
    target: Object.freeze([...camera.target]) as unknown as readonly [number, number, number]
  });
}

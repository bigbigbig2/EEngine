import type { PerspectiveCamera } from "../../camera/PerspectiveCamera.js";
import type { GPUTextureContext } from "../../gpu/GPUTextureContext.js";
import type { GpuRenderWorldRuntime } from "../../gpu/GpuRenderWorld.js";
import type { HierarchicalZBuffer } from "../HierarchicalZBuffer.js";
import type { GPUViewContext } from "../ViewContext.js";
import type { PackedVisibilityJob } from "../features/VisibilityFeature.js";
import type { Fsr3UpscalerRuntime } from "../passes/fsr3/Fsr3UpscalerRuntime.js";
import type { PhysicalEnvironmentRuntime } from "../environment/PhysicalEnvironmentRuntime.js";
import type { PreExposureContract } from "../RadiometryContract.js";
import type { FrameProgram } from "./FrameProgram.js";

/** Only physical, frame-local objects belong here; none enter the topology key. */
export type SceneFrameBindings = Readonly<{
  kind: "scene";
  deviceEpoch: number;
  job: PackedVisibilityJob;
  camera: PerspectiveCamera;
  view: GPUViewContext;
  hzb: HierarchicalZBuffer;
  depth: GPUTextureContext;
  swapchain: GPUTextureView;
  runtime: GpuRenderWorldRuntime;
  preExposure: PreExposureContract;
  fsr3: Fsr3UpscalerRuntime;
  environment: PhysicalEnvironmentRuntime | null;
}>;

export type EmptyFrameBindings = Readonly<{
  kind: "empty";
  deviceEpoch: number;
  swapchain: GPUTextureView;
}>;

export type FrameProgramBindings = SceneFrameBindings | EmptyFrameBindings;

/** Check structural assumptions before a cached graph starts encoding GPU work. */
export function assertFrameProgramBindings(plan: FrameProgram, bindings: FrameProgramBindings): void {
  const request = plan.request;
  if (request.kind !== bindings.kind) throw new Error("Frame Program binding kind changed");
  if (request.capabilityProfile !== String(bindings.deviceEpoch)) {
    throw new Error("Frame Program device epoch changed");
  }
  if (request.kind === "empty" || bindings.kind === "empty") return;
  if (bindings.depth.width !== request.internalWidth || bindings.depth.height !== request.internalHeight ||
      bindings.depth.format !== "depth32float") {
    throw new Error("Frame Program depth descriptor changed");
  }
  if (bindings.job.runtime !== bindings.runtime ||
      bindings.job.width !== request.internalWidth || bindings.job.height !== request.internalHeight) {
    throw new Error("Frame Program scene publication or render domain changed");
  }
  if ((bindings.runtime.virtualGeometry !== null) !== request.virtualGeometry ||
      (bindings.runtime.virtualGeometry?.banks.length ?? 0) !== request.virtualBankCount) {
    throw new Error("Frame Program virtual geometry layout changed");
  }
  if ((bindings.job.prepared.currentHzbLateRecheck !== null) !== request.currentHzbLateRecheck ||
      (bindings.job.prepared.workSet.meshletWorkCandidate?.capacity ?? 0) !== request.meshletWorkCapacity ||
      bindings.job.meshletWorkCompactionPath !== request.meshletWorkCompaction ||
      bindings.job.primitiveIndexPath !== request.primitiveIndex ||
      bindings.job.coneEnabled !== request.coneCulling) {
    throw new Error("Frame Program visibility shape changed");
  }
  const classes = Array.from({ length: 64 }, (_, classId) => classId)
    .filter(classId => (bindings.runtime.activeShadingSummary.binRefCounts[classId] ?? 0) > 0);
  if (classes.length !== request.activeClasses.length ||
      classes.some((id, index) => id !== request.activeClasses[index])) {
    throw new Error("Frame Program material class shape changed");
  }
  for (let setId = 0; setId < 4; setId++) {
    const mask = bindings.runtime.materialResources.bindingSets.find(set => set.id === setId)?.textureBankMask ?? 0;
    if (mask !== request.textureBankMasks[setId]) throw new Error("Frame Program texture bank layout changed");
  }
  if ((bindings.environment !== null) !== request.physicalEnvironment) {
    throw new Error("Frame Program environment profile changed");
  }
}

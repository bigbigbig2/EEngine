import type { PerspectiveCamera } from "../../camera/PerspectiveCamera.js";
import type { GPUTextureContext } from "../../gpu/GPUTextureContext.js";
import type { GpuRenderWorldRuntime } from "../../gpu/GpuRenderWorld.js";
import { shadingProgramUsesTextures } from "../../gpu/GpuShadingProgramAbi.js";
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
  if (plan.buildHzb) {
    const width = Math.max(1, request.internalWidth >>> 1);
    const height = Math.max(1, request.internalHeight >>> 1);
    const current = bindings.hzb.getCurrentTexture();
    if (bindings.hzb.width !== width || bindings.hzb.height !== height ||
        current.width !== width || current.height !== height || current.format !== "rg16float") {
      throw new Error("Frame Program current HZB descriptor changed");
    }
    if (request.previousHzb) {
      const previous = bindings.hzb.getPreviousTexture();
      if (previous.width !== width || previous.height !== height || previous.format !== "rg16float" ||
          previous === current) {
        throw new Error("Frame Program previous HZB descriptor changed or aliases current");
      }
    }
  }
  if (bindings.job.runtime !== bindings.runtime ||
      bindings.job.width !== request.internalWidth || bindings.job.height !== request.internalHeight) {
    throw new Error("Frame Program scene publication or render domain changed");
  }
  if (bindings.view.camera.camera !== bindings.camera ||
      bindings.view.hierarchical_z_buffer !== bindings.hzb ||
      bindings.view.width !== request.internalWidth || bindings.view.height !== request.internalHeight) {
    throw new Error("Frame Program View publication or render domain changed");
  }
  if ((bindings.job.virtualGeometry ?? null) !== bindings.runtime.virtualGeometry) {
    throw new Error("Frame Program virtual Product publication changed");
  }
  if ((bindings.runtime.virtualGeometry !== null) !== request.virtualGeometry ||
      (bindings.runtime.virtualGeometry?.banks.length ?? 0) !== request.virtualBankCount) {
    throw new Error("Frame Program virtual geometry layout changed");
  }
  if ((bindings.job.prepared.currentHzbLateRecheck !== null) !== request.currentHzbLateRecheck ||
      bindings.job.prepared.workSet.meshletWorkCandidate === null) {
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
    const required = request.activeClasses.some(id => (id >> 4) === setId &&
      shadingProgramUsesTextures(id & 15));
    if (required && mask !== request.textureBankMasks[setId]) {
      throw new Error("Frame Program texture bank layout changed");
    }
  }
  if ((bindings.environment !== null) !== request.physicalEnvironment) {
    throw new Error("Frame Program environment profile changed");
  }
  if (bindings.environment !== null) {
    if (bindings.environment.parameters.size < 64) {
      throw new Error("Frame Program environment parameter descriptor changed");
    }
    const views = bindings.environment.luts.views;
    if (!views.transmittance || !views.scattering || !views.higherOrderScattering ||
        !views.irradiance) {
      throw new Error("Frame Program environment LUT publication is incomplete");
    }
  }
  bindings.fsr3.assertPreparedFrame(request.internalWidth, request.internalHeight,
    request.outputWidth, request.outputHeight);
}

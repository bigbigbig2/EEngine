import type { PerspectiveCamera } from "../../camera/PerspectiveCamera.js";
import type { GPUTextureContext } from "../../gpu/GPUTextureContext.js";
import type { GpuRenderWorldRuntime } from "../../gpu/GpuRenderWorld.js";
import type { HierarchicalZBuffer } from "../HierarchicalZBuffer.js";
import type { GPUViewContext } from "../ViewContext.js";
import type { PackedVisibilityJob } from "../features/VisibilityFeature.js";
import type { Fsr3UpscalerRuntime } from "../passes/fsr3/Fsr3UpscalerRuntime.js";
import type { NativeTemporalFactsPass } from "../temporal/NativeTemporalFactsPass.js";
import type { GpuRadiometryPass } from "../temporal/GpuRadiometryPass.js";
import type { PhysicalEnvironmentRuntime } from "../environment/PhysicalEnvironmentRuntime.js";
import type { PreExposureContract } from "../RadiometryContract.js";
import type { FrameProgram } from "./FrameProgram.js";
import type { LocalLightWorkFrame } from "../lighting/LocalLightWorkGenerator.js";
import type { VsmResources } from "../vsm/VsmResources.js";
import type { VsmDirectionalFrameConstants } from "../vsm/VsmReceiverDemandPass.js";
import type { VsmGenerationState } from "../vsm/VsmGeneration.js";

/** Only physical, frame-local objects belong here; none enter the topology key. */
export type SceneFrameBindings = Readonly<{
  kind: "scene";
  deviceEpoch: number;
  frameIndex: number;
  cameraRevision: number;
  sceneRevision: number;
  job: PackedVisibilityJob;
  camera: PerspectiveCamera;
  view: GPUViewContext;
  hzb: HierarchicalZBuffer;
  depth: GPUTextureContext;
  swapchain: GPUTextureView;
  runtime: GpuRenderWorldRuntime;
  preExposure: PreExposureContract;
  fsr3: Fsr3UpscalerRuntime;
  temporalFacts: NativeTemporalFactsPass;
  radiometry: GpuRadiometryPass;
  lightingEnvironmentRevision: number;
  /** GPU light collection publication revision; independent from sky/IBL revision. */
  lightingLightRevision: number;
  localLightWork: LocalLightWorkFrame | null;
  localLightCounters: GPUBuffer;
  lightingSunRevision: number;
  environment: PhysicalEnvironmentRuntime | null;
  /** Persistent VSM owner; null is valid for the explicit shadow-disabled profile. */
  vsm: VsmResources | null;
  /** Frame-local directional light/clipmap constants published by the environment owner. */
  vsmFrame: VsmDirectionalFrameConstants | null;
  /** CPU lifecycle facts consumed by the graph-local VSM invalidation pass. */
  vsmGeneration: VsmGenerationState;
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
  if (request.kind !== bindings.kind) {
    throw new Error("Frame Program binding kind changed");
  }
  if (request.capabilityProfile !== String(bindings.deviceEpoch)) {
    throw new Error("Frame Program device epoch changed");
  }
  if (request.kind === "empty" || bindings.kind === "empty") {
    return;
  }
  if (request.hasLit !== (bindings.localLightWork !== null)) {
    throw new Error("Frame Program LocalLightWork publication is missing or unexpected");
  }
  if (bindings.localLightWork !== null) {
    const local = bindings.localLightWork.request;
    if (
      local.frameIndex !== bindings.frameIndex ||
      local.deviceEpoch !== bindings.deviceEpoch ||
      local.publication.buffer !== bindings.view.environment.lights.buffer_data ||
      local.publication.revision !== bindings.lightingLightRevision ||
      local.view.width !== request.internalWidth ||
      local.view.height !== request.internalHeight
    ) {
      throw new Error("Frame Program LocalLightWork context is stale");
    }
  }
  if (
    bindings.depth.width !== request.internalWidth ||
    bindings.depth.height !== request.internalHeight ||
    bindings.depth.format !== "depth32float"
  ) {
    throw new Error("Frame Program depth descriptor changed");
  }
  if (plan.buildHzb) {
    const width = Math.max(1, request.internalWidth >>> 1);
    const height = Math.max(1, request.internalHeight >>> 1);
    const current = bindings.hzb.getCurrentTexture();
    if (
      bindings.hzb.width !== width ||
      bindings.hzb.height !== height ||
      current.width !== width ||
      current.height !== height ||
      current.format !== "rg16float"
    ) {
      throw new Error("Frame Program current HZB descriptor changed");
    }
    if (request.previousHzb) {
      const previous = bindings.hzb.getPreviousTexture();
      if (
        previous.width !== width ||
        previous.height !== height ||
        previous.format !== "rg16float" ||
        previous === current
      ) {
        throw new Error("Frame Program previous HZB descriptor changed or aliases current");
      }
    }
  }
  if (
    bindings.job.runtime !== bindings.runtime ||
    bindings.job.width !== request.internalWidth ||
    bindings.job.height !== request.internalHeight
  ) {
    throw new Error("Frame Program scene publication or render domain changed");
  }
  if (
    bindings.view.camera.camera !== bindings.camera ||
    bindings.view.hierarchical_z_buffer !== bindings.hzb ||
    bindings.view.width !== request.internalWidth ||
    bindings.view.height !== request.internalHeight
  ) {
    throw new Error("Frame Program View publication or render domain changed");
  }
  if ((bindings.job.virtualGeometry ?? null) !== bindings.runtime.virtualGeometry) {
    throw new Error("Frame Program virtual Product publication changed");
  }
  if (
    !bindings.job.scene.instances ||
    !bindings.job.assets.sparseShading.assetMetadataHeap ||
    !bindings.job.assets.sparseShading.vertexPayloadHeap ||
    !bindings.runtime.materialResources.materialRecords ||
    !bindings.runtime.materialResources.textureRouteRecords ||
    !bindings.runtime.counterSink ||
    !bindings.view.gpu_camera_state.buffer ||
    !bindings.view.gpu_previous_camera_state.buffer
  ) {
    throw new Error("Frame Program Scene/View publication is incomplete");
  }
  if (
    (bindings.runtime.virtualGeometry !== null) !== request.virtualGeometry ||
    (bindings.runtime.virtualGeometry?.banks.length ?? 0) !== request.virtualBankCount
  ) {
    throw new Error("Frame Program virtual geometry layout changed");
  }
  if (
    bindings.runtime.virtualGeometry !== null &&
    (!bindings.runtime.virtualGeometry.metadata ||
      bindings.runtime.virtualGeometry.banks.some((bank) => !bank))
  ) {
    throw new Error("Frame Program virtual geometry bank publication is incomplete");
  }
  if (
    (bindings.job.prepared.currentHzbLateRecheck !== null) !== request.currentHzbLateRecheck ||
    bindings.job.prepared.workSet.meshletWorkCandidate === null
  ) {
    throw new Error("Frame Program visibility shape changed");
  }
  const summary = bindings.runtime.activeShadingSummary;
  const activeSets = Array.from(summary.standardSetRefCounts, (_, setId) => setId).filter(
    (setId) => summary.standardSetRefCounts[setId]! + summary.coatedSetRefCounts[setId]! > 0,
  );
  if (bindings.runtime.nativeMaterials === null) {
    throw new Error("Frame Program requires a native material publication");
  }
  const hasLit = bindings.runtime.nativeMaterials.hasLit;
  if (
    activeSets.length !== request.activeSets.length ||
    activeSets.some((id, index) => id !== request.activeSets[index]) ||
    hasLit !== request.hasLit
  ) {
    throw new Error("Frame Program material set or lighting shape changed");
  }
  let textureBankMask = 0;
  for (const setId of activeSets) {
    const bindingSet = bindings.runtime.materialResources.bindingSets.find((set) => set.id === setId);
    if (!bindingSet) {
      throw new Error(`Frame Program texture set ${setId} is not resident`);
    }
    textureBankMask |= bindingSet.textureBankMask;
    for (let bank = 0; bank < bindingSet.textureBanks.length; bank++) {
      if (!bindingSet.textureBanks[bank] || bindingSet.bankDescriptors[bank]?.bindingSlot !== bank) {
        throw new Error(`Frame Program texture bank ${setId}:${bank} publication is incomplete`);
      }
    }
  }
  if ((textureBankMask || 1) !== (request.textureBankMask ?? 0xffff)) {
    throw new Error("Frame Program texture bank layout changed");
  }
  if ((bindings.environment !== null) !== request.physicalEnvironment) {
    throw new Error("Frame Program environment profile changed");
  }
  const shadowProfile = request.shadowProfile ?? "off";
  if (shadowProfile !== "off" && shadowProfile !== "shadow-disabled" && bindings.vsm === null) {
    throw new Error("Frame Program VSM profile requires a persistent VSM owner");
  }
  if (
    bindings.vsm !== null &&
    shadowProfile !== "off" &&
    shadowProfile !== "shadow-disabled" &&
    bindings.vsm.profile !== shadowProfile
  ) {
    throw new Error("Frame Program VSM capability profile changed");
  }
  if (shadowProfile !== "off" && shadowProfile !== "shadow-disabled" && bindings.vsmFrame === null) {
    throw new Error("Frame Program VSM profile requires directional clipmap constants");
  }
  if (
    plan.products.includes("shadow-geometry-work") &&
    (!bindings.job.shadowFrame || !bindings.job.prepared.shadowGeometry)
  ) {
    throw new Error("Frame Program requires independent light-view Geometry publication");
  }
  if (
    bindings.vsmGeneration.deviceEpoch !== bindings.deviceEpoch ||
    (bindings.vsmFrame !== null &&
      (bindings.vsmFrame.generation !== bindings.vsmGeneration.generation ||
        bindings.vsmFrame.projectionEpoch !== bindings.vsmGeneration.projectionEpoch ||
        bindings.vsmFrame.namespace !== bindings.vsm?.namespace))
  ) {
    throw new Error("Frame Program VSM generation facts are stale");
  }
  if (bindings.environment !== null) {
    if (bindings.environment.parameters.size < 64) {
      throw new Error("Frame Program environment parameter descriptor changed");
    }
    const views = bindings.environment.luts.views;
    if (!views.transmittance || !views.scattering || !views.higherOrderScattering || !views.irradiance) {
      throw new Error("Frame Program environment LUT publication is incomplete");
    }
  }
  bindings.fsr3.assertPreparedFrame(
    request.internalWidth,
    request.internalHeight,
    request.outputWidth,
    request.outputHeight,
  );
  bindings.temporalFacts.assertPreparedFrame(request.internalWidth, request.internalHeight);
}

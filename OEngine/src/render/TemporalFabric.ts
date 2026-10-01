import { TemporalHistoryRegistry, type TemporalHistoryDescriptor, type TemporalHistoryRevision } from "./TemporalHistoryRegistry.js";
import { TemporalJitterController, resolveFrameJitter } from "./TemporalJitterController.js";
import type { PreExposureContract } from "./RadiometryContract.js";
import { SPARSE_LIGHTING_HISTORY_NAMES } from "../gpu/GpuSparseLightingAbi.js";

export interface TemporalFabricFrame {
  readonly frameIndex: number;
  readonly output: readonly [number, number];
  readonly internal: readonly [number, number];
  readonly cameraRevision: number;
  readonly sceneRevision: number;
  readonly representationRevision: number;
  readonly lightRevision: string;
  readonly view: string;
  readonly renderScale: number;
  readonly featureRevision: number;
  readonly formatRevision: number;
  readonly deviceRevision: number;
  readonly preExposure: PreExposureContract;
  readonly temporalEnabled: boolean;
  readonly nssEnabled: boolean;
  readonly taaJitter?: readonly [number, number];
  readonly nssJitter?: readonly [number, number];
}

/** Renderer-level temporal transaction shared by reconstruction, denoisers and future FSR. */
export class TemporalFabric {
  readonly histories: TemporalHistoryRegistry;
  readonly jitter = new TemporalJitterController();
  private activeFrame: number | null = null;

  constructor(descriptors: readonly TemporalHistoryDescriptor[] = [
    { name: "color", semantic: "fsr3-upscaled-radiance", resolutionDomain: "output-full", format: "rgba16float",
      bufferCount: 2, preExposure: "working-linear-rescale", lightingDependent: false },
    { name: "identity", semantic: "temporal-surface-identity", resolutionDomain: "internal-full", format: "rgba32uint",
      bufferCount: 2, preExposure: "none", lightingDependent: false },
    ...SPARSE_LIGHTING_HISTORY_NAMES.map(name => ({ name, semantic: `${name}-unexposed-radiance`,
      resolutionDomain: "internal-full" as const, format: "rgba16float", bufferCount: 2,
      preExposure: "none" as const, lightingDependent: false }))
  ]) { this.histories = new TemporalHistoryRegistry(descriptors); }

  begin(frame: TemporalFabricFrame): readonly [number, number] {
    if (this.activeFrame !== null) throw new Error("Temporal fabric frame is already active");
    if (frame.output[0] < 1 || frame.output[1] < 1 || frame.internal[0] < 1 || frame.internal[1] < 1) {
      throw new RangeError("Temporal fabric resolutions must be positive");
    }
    this.jitter.frame_index = frame.frameIndex;
    const revision: TemporalHistoryRevision = {
      outputWidth: frame.output[0], outputHeight: frame.output[1], internalWidth: frame.internal[0], internalHeight: frame.internal[1],
      camera: frame.cameraRevision, renderScale: frame.renderScale, feature: frame.featureRevision,
      format: frame.formatRevision, light: frame.lightRevision, scene: frame.sceneRevision,
      representation: frame.representationRevision, device: frame.deviceRevision,
      preExposureGeneration: frame.preExposure.generation, view: frame.view
    };
    // Only physically persistent writers are registered. Surface depth/motion
    // are same-frame transient facts, not phantom ping-pong histories.
    const activeNames = frame.temporalEnabled ? ["color", "identity", ...SPARSE_LIGHTING_HISTORY_NAMES] : [];
    this.histories.beginFrame(frame.frameIndex, revision, activeNames, frame.preExposure);
    this.activeFrame = frame.frameIndex;
    return resolveFrameJitter(frame.temporalEnabled, frame.nssEnabled,
      frame.taaJitter ?? this.jitter.Jitter, frame.nssJitter ?? [0, 0]);
  }

  markProduced(name: string): void { this.histories.markProduced(name); }
  commit(frameIndex: number): boolean {
    this.assertFrame(frameIndex); this.activeFrame = null; return this.histories.commitFrame(frameIndex);
  }
  abort(frameIndex: number): void { this.assertFrame(frameIndex); this.histories.abortFrame(frameIndex); this.activeFrame = null; }
  invalidate(): void { this.histories.invalidate("explicit"); }
  private assertFrame(frameIndex: number): void {
    if (this.activeFrame !== frameIndex) throw new Error("Temporal fabric frame mismatch");
  }
}

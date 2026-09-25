/** Owns the optional screen-space providers and final-output feature lifetime. */
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { GpuShadingSurfaceLiteProfile } from "../../gpu/GpuComputeMaterialAbi.js";
import type { FrameProfiler } from "../../debug/FrameProfiler.js";
import type { MainFrameFeatureTopology } from "../MainFrameFeatureTopology.js";
import type { RenderSettingsValues } from "./RenderSettings.js";
import { AOService } from "../features/AOService.js";
import { ScreenSpaceDiffuseService } from "../features/ScreenSpaceDiffuseService.js";
import { ReflectionService } from "../features/ReflectionService.js";
import { PostFeature } from "../features/PostFeature.js";
import { SharedColorPyramidPass } from "../passes/SharedColorPyramidPass.js";
import { RenderDebugViewPass } from "../passes/RenderDebugViewPass.js";

export class OptionalFrameFeatures {
  private _ao: AOService | null = null;
  private _ssgi: ScreenSpaceDiffuseService | null = null;
  private _ssr: ReflectionService | null = null;
  private _post: PostFeature | null = null;
  private _pyramids: SharedColorPyramidPass | null = null;
  private _debug: RenderDebugViewPass | null = null;
  private gtaoKey = "";
  private ssgiKey = "";
  private ssrKey = "";
  private gtaoGeneration = 0;
  private ssgiGeneration = 0;
  private ssrGeneration = 0;
  private outputGeneration = 0;
  private outputKey = "";

  constructor(
    private readonly graphics: GraphicsContext,
    private readonly surfaceProfile: GpuShadingSurfaceLiteProfile,
    private readonly profiler: FrameProfiler,
    private readonly retire: (resource: { destroy(): void }) => void
  ) {}

  get ao(): AOService | null { return this._ao; }
  get ssgi(): ScreenSpaceDiffuseService | null { return this._ssgi; }
  get ssr(): ReflectionService | null { return this._ssr; }
  get post(): PostFeature | null { return this._post; }
  get pyramids(): SharedColorPyramidPass | null { return this._pyramids; }
  get debug(): RenderDebugViewPass | null { return this._debug; }
  get gtaoOwnerGeneration(): number { return this.gtaoGeneration; }
  get ssgiOwnerGeneration(): number { return this.ssgiGeneration; }
  get ssrOwnerGeneration(): number { return this.ssrGeneration; }
  get outputOwnerGeneration(): number { return this.outputGeneration; }

  obtainDebug(): RenderDebugViewPass {
    return this._debug ??= new RenderDebugViewPass(this.graphics, this.surfaceProfile);
  }

  synchronizeScreen(topology: MainFrameFeatureTopology): void {
    const diffuseKey = `${topology.screenSpaceDiffuseTemporal ? 1 : 0}/${topology.screenSpaceDiffuseHalfResolution ? 1 : 0}`;
    if (topology.gtao) {
      if (this._ao === null || this.gtaoKey !== diffuseKey) {
        if (this._ao !== null) this.retire(this._ao);
        this._ao = new AOService(
          this.graphics, topology.screenSpaceDiffuseTemporal,
          topology.screenSpaceDiffuseHalfResolution ? 0.5 : 1, this.surfaceProfile
        );
        this.gtaoGeneration++;
        this.gtaoKey = diffuseKey;
      }
    } else if (this._ao !== null) {
      this.retire(this._ao);
      this._ao = null;
      this.gtaoKey = "";
    }
    if (topology.ssgi) {
      if (this._ssgi === null || this.ssgiKey !== diffuseKey) {
        if (this._ssgi !== null) this.retire(this._ssgi);
        this.profiler.registerGpuCounterFields([
          "ssgiEvaluatedPixels", "ssgiTraceSamples",
          "ssgiHistoryAcceptedPixels", "ssgiHistoryRejectedPixels"
        ]);
        this._ssgi = new ScreenSpaceDiffuseService(
          this.graphics, topology.screenSpaceDiffuseTemporal,
          topology.screenSpaceDiffuseHalfResolution ? 0.5 : 1, this.surfaceProfile
        );
        this.ssgiGeneration++;
        this.ssgiKey = diffuseKey;
      }
    } else if (this._ssgi !== null) {
      this.retire(this._ssgi);
      this._ssgi = null;
      this.ssgiKey = "";
    }
    const ssrKey = `${topology.ssrTemporal ? 1 : 0}/${topology.ssrHalfResolution ? 1 : 0}`;
    if (topology.ssr) {
      if (this._ssr === null || this.ssrKey !== ssrKey) {
        if (this._ssr !== null) this.retire(this._ssr);
        this._ssr = new ReflectionService(
          this.graphics, topology.ssrTemporal,
          topology.ssrHalfResolution ? 0.5 : 1, this.surfaceProfile
        );
        this.ssrGeneration++;
        this.ssrKey = ssrKey;
      }
    } else if (this._ssr !== null) {
      this.retire(this._ssr);
      this._ssr = null;
      this.ssrKey = "";
    }
  }

  synchronizeOutput(
    topology: MainFrameFeatureTopology,
    settings: RenderSettingsValues,
    output: { format: GPUTextureFormat; highDynamicRange: boolean; peakNits: number }
  ): void {
    // A cached graph closes over optional pass owners. Re-enabling a retired
    // pass must compile against its replacement, even when the feature bits
    // return to an earlier value.
    const nextKey = [topology.ssr, topology.bloom, topology.automaticExposure,
      topology.motionBlur, topology.debug].map(Number).join("");
    if (nextKey !== this.outputKey) {
      this.outputKey = nextKey;
      this.outputGeneration++;
    }
    this._post ??= new PostFeature(this.graphics);
    if (topology.ssr || topology.bloom || topology.automaticExposure) {
      this._pyramids ??= new SharedColorPyramidPass(this.graphics);
    } else if (this._pyramids !== null) {
      this.retire(this._pyramids);
      this._pyramids = null;
    }
    // Capture graphs may close over ColorGradingPass. Retaining that owner
    // does not add a normal-frame pass or persistent allocation.
    if (topology.motionBlur) this._post.obtainMotionBlur();
    else if (this._post.motionBlur() !== null) this._post.retireMotionBlur();
    if (this._post.sharpen() !== null) this._post.retireSharpen();
    if (topology.bloom) this._post.obtainBloom();
    else if (this._post.bloom() !== null) this._post.retireBloom();
    if (topology.automaticExposure) {
      this._post.obtainAutomaticExposure();
      this._post.syncExposure({
        exposureCompensation: settings.post.exposureCompensation,
        exposureSpeedUp: settings.post.exposureSpeedUp,
        exposureSpeedDown: settings.post.exposureSpeedDown
      });
    } else if (this._post.automaticExposure() !== null) {
      this._post.retireAutomaticExposure();
    }
    if (!topology.debug && this._debug !== null) {
      this.retire(this._debug);
      this._debug = null;
    }
    this._post.obtainTonemap(output.format);
    this._post.updateTonemap(
      output.format, output.highDynamicRange, output.peakNits,
      settings.post.exposureCompensation
    );
  }

  resize(topology: MainFrameFeatureTopology, settings: RenderSettingsValues, width: number, height: number): void {
    if (topology.gtao) this._ao!.resize(
      Math.max(1, Math.ceil(width * settings.ao.resolutionScale)),
      Math.max(1, Math.ceil(height * settings.ao.resolutionScale))
    );
    if (topology.ssgi) this._ssgi!.resize(
      Math.max(1, Math.ceil(width * settings.ssgi.resolutionScale)),
      Math.max(1, Math.ceil(height * settings.ssgi.resolutionScale))
    );
    if (topology.ssr) this._ssr!.resize(
      Math.max(1, Math.ceil(width * settings.ssr.resolutionScale)),
      Math.max(1, Math.ceil(height * settings.ssr.resolutionScale))
    );
  }

  resetFrameEvidence(): void {
    this._ssr?.resetFrameEvidence();
    this._ssgi?.resetFrameEvidence();
    this._pyramids?.resetFrameEvidence();
    this._post?.bloom()?.resetFrameEvidence();
    this._post?.automaticExposure()?.resetFrameEvidence();
  }

  destroy(): void {
    this._ao?.destroy();
    this._ssgi?.destroy();
    this._ssr?.destroy();
    this._post?.destroy();
    this._pyramids?.destroy();
    this._debug?.destroy();
    this._ao = null;
    this._ssgi = null;
    this._ssr = null;
    this._post = null;
    this._pyramids = null;
    this._debug = null;
  }
}

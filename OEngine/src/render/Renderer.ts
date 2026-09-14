/**
 * Public renderer shell.
 *
 * Device/canvas lifetime and the public API enter through this type. The
 * inherited main-pipeline owner is the only implementation of feature order,
 * graph construction, graph caching, and graph evidence.
 */
import {
  MainRenderPipeline,
  type RendererInitializeOptions
} from "./pipeline/MainRenderPipeline.js";
import type { RendererConfig } from "./RendererConfig.js";
import { resolveRendererDebugConfig } from "../addons/debug/RendererDebugConfig.js";
import type { RendererDebugController } from "../addons/debug/RendererDebugController.js";
import type {
  RenderSettingsChange,
  RenderSettingsPatch
} from "./pipeline/RenderSettings.js";
import type { PerspectiveCamera } from "../camera/PerspectiveCamera.js";
import type { Scene } from "../scene/Scene.js";

export {
  RENDER_FRAME_PHASES
} from "./pipeline/MainRenderPipeline.js";
export type {
  AmbientOcclusionRuntimeEvidence,
  FinalOutputRuntimeEvidence,
  LinearHdrCaptureRegion,
  LinearHdrCaptureResult,
  MainFrameGraphRuntimeEvidence,
  RendererCapabilities,
  RendererGpuOwnerCreationEvidence,
  RendererInitializeOptions,
  RendererMemoryEvidence,
  RenderFramePhase,
  ScreenSpaceGiRuntimeEvidence,
  ScreenSpaceReflectionsRuntimeEvidence,
  SharedColorPyramidRuntimeEvidence,
  SharedDerivedProductsRuntimeEvidence,
  TemporalRuntimeEvidence,
  VisibilitySurfaceMigrationEvidence
} from "./pipeline/MainRenderPipeline.js";
export type { TextureResidencyEvidence } from "../gpu/TextureResidency.js";

export class Renderer extends MainRenderPipeline {
  /** Present only when the development Debug UI was explicitly enabled. */
  debug: RendererDebugController | null = null;
  private readonly constructorDebugConfig: RendererConfig["debug"];
  private recoveryCheckpoint: ReturnType<Renderer["checkpointDeviceRecovery"]> | null = null;
  private recoveryPromise: Promise<Renderer> | null = null;
  private recoveryAttempts = 0;
  private explicitlyDestroyed = false;

  constructor(config: RendererConfig = {}) {
    super(config);
    this.constructorDebugConfig = config.debug;
  }

  override async initialize(options: RendererInitializeOptions = {}): Promise<void> {
    await super.initialize(options);
    const debugConfig = resolveRendererDebugConfig(
      options.config?.debug ?? this.constructorDebugConfig
    );
    if (!debugConfig.enabled) return;
    try {
      const module = await import("../addons/debug/RendererDebugController.js");
      this.debug = module.createRendererDebugController(this, debugConfig);
    } catch (error) {
      console.warn("[OEngine Debug] Debug UI initialization failed; rendering will continue.", error);
    }
  }

  override configure(patch: RenderSettingsPatch): RenderSettingsChange {
    const change = super.configure(patch);
    if (change.changed) this.debug?.refreshControls();
    return change;
  }

  override destroy(): void {
    this.explicitlyDestroyed = true;
    this.recoveryCheckpoint = null;
    this.debug?.destroy();
    this.debug = null;
    super.destroy();
  }

  /**
   * Explicit, bounded production recovery. Replace the application's Renderer
   * reference with the returned instance; old GPU handles are never resurrected.
   * Concurrent calls share one attempt. At most two attempts are allowed. Normal
   * Renderer.destroy() is terminal and cannot be recovered.
   */
  recoverAfterDeviceLoss(): Promise<Renderer> {
    if (this.explicitlyDestroyed) return Promise.reject(new Error("Destroyed Renderer cannot recover"));
    if (this.recoveryPromise !== null) return this.recoveryPromise;
    if (this.recoveryAttempts >= 2) return Promise.reject(new Error("Renderer recovery attempt limit exceeded"));
    try {
      this.recoveryCheckpoint ??= this.checkpointDeviceRecovery();
    } catch (error) {
      return Promise.reject(error);
    }
    const checkpoint = this.recoveryCheckpoint;
    this.recoveryAttempts++;
    this.debug?.destroy();
    this.debug = null;
    super.destroy();
    const replacement = new Renderer(checkpoint.config);
    this.recoveryPromise = replacement.restoreDeviceRecovery(checkpoint).then(() => {
      if (this.explicitlyDestroyed) {
        replacement.destroy();
        throw new Error("Renderer destroyed during recovery");
      }
      this.recoveryCheckpoint = null;
      return replacement;
    }, (error: unknown) => {
      replacement.destroy();
      this.recoveryPromise = null;
      throw error;
    });
    return this.recoveryPromise;
  }

  override render(
    camera: PerspectiveCamera,
    scene: Scene,
    timeDeltaSeconds = 0.01666
  ): boolean {
    return super.render(camera, scene, timeDeltaSeconds);
  }
}

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

export class Renderer extends MainRenderPipeline {
  /** Present only when the development Debug UI was explicitly enabled. */
  debug: RendererDebugController | null = null;
  private readonly constructorDebugConfig: RendererConfig["debug"];

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
    this.debug?.destroy();
    this.debug = null;
    super.destroy();
  }

  override render(
    camera: PerspectiveCamera,
    scene: Scene,
    timeDeltaSeconds = 0.01666
  ): boolean {
    return super.render(camera, scene, timeDeltaSeconds);
  }
}

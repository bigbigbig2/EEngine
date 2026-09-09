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
import type { PerspectiveCamera } from "../camera/PerspectiveCamera.js";
import type { Scene } from "../scene/Scene.js";

export {
  RENDER_FRAME_PHASES,
  ShadeIndirectLightingMode
} from "./pipeline/MainRenderPipeline.js";
export type {
  AmbientOcclusionRuntimeEvidence,
  LinearHdrCaptureRegion,
  LinearHdrCaptureResult,
  MainFrameGraphRuntimeEvidence,
  RendererCapabilities,
  RendererGpuOwnerCreationEvidence,
  RendererInitializeOptions,
  RendererMemoryEvidence,
  RenderFramePhase,
  ScreenSpaceReflectionsRuntimeEvidence,
  TemporalRuntimeEvidence,
  VisibilitySurfaceMigrationEvidence
} from "./pipeline/MainRenderPipeline.js";

export class Renderer extends MainRenderPipeline {
  constructor(config: RendererConfig = {}) {
    super(config);
  }

  override async initialize(options: RendererInitializeOptions = {}): Promise<void> {
    await super.initialize(options);
  }

  override destroy(): void {
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

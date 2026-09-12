import type { FolderApi, Pane } from "tweakpane";
import type { Renderer } from "../../render/Renderer.js";
import type { ResolvedRendererDebugConfig } from "./RendererDebugConfig.js";
import { RendererDebugUI } from "./RendererDebugUI.js";
import { RendererInfoModel } from "./RendererInfoModel.js";

export class RendererDebugController {
  readonly pane: Pane;
  private readonly model: RendererInfoModel;
  private readonly ui: RendererDebugUI;
  private readonly profilerWasEnabled: boolean;
  private readonly unsubscribe: (() => void) | null;
  private readonly refreshTimer: ReturnType<typeof setInterval> | null;
  private destroyed = false;

  constructor(
    private readonly renderer: Renderer,
    config: ResolvedRendererDebugConfig
  ) {
    this.model = new RendererInfoModel(renderer);
    this.profilerWasEnabled = renderer.profiler.enabled;
    const initial = config.info
      ? this.model.snapshot()
      : { sampledFrame: renderer.frame_count, sections: [] };
    this.ui = new RendererDebugUI(renderer, config, initial);
    this.pane = this.ui.pane;
    if (config.info && !this.profilerWasEnabled) {
      renderer.profiler.configure({ enabled: true });
    }
    this.unsubscribe = config.info
      ? renderer.profiler.subscribe((snapshot) => this.model.consume(snapshot))
      : null;
    this.refreshTimer = config.info
      ? setInterval(() => this.ui.updateInfo(this.model.snapshot()), 1000 / config.infoRefreshRate)
      : null;
  }

  refreshControls(): void {
    if (!this.destroyed) this.ui.refreshControls();
  }

  focus(path: string): boolean {
    return !this.destroyed && this.ui.focus(path);
  }

  addExampleFolder(title: string): FolderApi {
    if (this.destroyed) throw new Error("RendererDebugController is destroyed");
    return this.ui.addExampleFolder(title);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.unsubscribe?.();
    this.ui.dispose();
    const profilerHasProductionConsumer =
      this.renderer.render_settings.resolution.mode === "adaptive" ||
      this.renderer.packed_geometry_budget_mode === "adaptive";
    if (!this.profilerWasEnabled && !profilerHasProductionConsumer && this.renderer.profiler.enabled) {
      this.renderer.profiler.configure({ enabled: false });
    }
  }
}

export function createRendererDebugController(
  renderer: Renderer,
  config: ResolvedRendererDebugConfig
): RendererDebugController {
  return new RendererDebugController(renderer, config);
}

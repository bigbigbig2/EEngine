import type { Scene } from "../scene/Scene.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import {
  GPUSceneEnvironmentContext,
  type GPUSceneEnvironmentEvidence
} from "./GPUSceneEnvironmentContext.js";

export interface GPUSceneEnvironmentManagerEvidence {
  readonly contextCount: number;
  readonly prepareCount: number;
}

/** Maintains the single shared light/environment owner for each Scene. */
export class GPUSceneEnvironmentManager {
  private readonly contexts = new Map<Scene, GPUSceneEnvironmentContext>();

  constructor(private readonly graphics: GraphicsContext) {}

  obtain(scene: Scene): GPUSceneEnvironmentContext {
    let context = this.contexts.get(scene);
    if (context === undefined) {
      context = new GPUSceneEnvironmentContext(this.graphics, scene);
      this.contexts.set(scene, context);
    }
    return context;
  }

  get(scene: Scene): GPUSceneEnvironmentContext | undefined {
    return this.contexts.get(scene);
  }

  /** Transactional scene retirement; abort preserves the published owner. */
  release(scene: Scene, command: ShadeGPUCommandContext): boolean {
    const context = this.contexts.get(scene);
    if (context === undefined) return false;
    command.onFinished.addOne(() => {
      if (this.contexts.get(scene) !== context) return;
      this.contexts.delete(scene);
      void command.gpuDone.then(
        () => context.destroy(),
        () => context.destroy()
      );
    });
    return true;
  }

  evidence(): GPUSceneEnvironmentManagerEvidence {
    let prepareCount = 0;
    for (const context of this.contexts.values()) {
      const evidence: GPUSceneEnvironmentEvidence = context.evidence();
      prepareCount += evidence.prepareCount;
    }
    return Object.freeze({ contextCount: this.contexts.size, prepareCount });
  }

  destroy(): void {
    for (const context of this.contexts.values()) context.destroy();
    this.contexts.clear();
  }
}

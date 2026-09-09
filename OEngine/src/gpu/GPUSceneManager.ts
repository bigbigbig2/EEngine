/** Ordinary Scene only: owns the temporary legacy geometry runtime. */

import type { Scene } from "../scene/Scene.js";
import { GPUSceneContext } from "./GPUSceneContext.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import type { GPUSceneEnvironmentManager } from "./GPUSceneEnvironmentManager.js";

export interface LegacySceneOwnerEvidence {
  readonly geometryContextCount: number;
  readonly sceneDatabaseCount: number;
  readonly skinningContextCount: number;
}

/** Creates no owner until a legacy geometry consumer explicitly requests it. */
export class GPUSceneManager {
  readonly isGPUSceneManager = true;
  readonly scene_contexts = new Map<Scene, GPUSceneContext>();

  constructor(
    private readonly graphics: GraphicsContext,
    private readonly environments: GPUSceneEnvironmentManager
  ) {}

  /** 获取已有上下文；首次访问场景时创建并缓存对应的 GPU 数据所有者。 */
  obtain(scene: Scene): GPUSceneContext {
    const graphics = this.graphics;
    let ctx = this.scene_contexts.get(scene);
    if (!ctx) {
      ctx = new GPUSceneContext(
        graphics,
        scene,
        graphics.geometries,
        () => graphics.materials,
        this.environments.obtain(scene)
      );
      this.scene_contexts.set(scene, ctx);
    }
    return ctx;
  }

  evidence(): LegacySceneOwnerEvidence {
    let skinningContextCount = 0;
    for (const context of this.scene_contexts.values()) {
      if (context.skinningCreated) skinningContextCount++;
    }
    return Object.freeze({
      geometryContextCount: this.scene_contexts.size,
      sceneDatabaseCount: this.scene_contexts.size,
      skinningContextCount
    });
  }

  /** 释放所有场景级 GPU 资源并清空缓存。 */
  destroy(): void {
    for (const context of this.scene_contexts.values()) context.destroy();
    this.scene_contexts.clear();
  }
}

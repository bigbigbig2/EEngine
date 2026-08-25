/**
 * GPU 场景管理器：同步场景层级、实例、几何和材质数据，并驱动每帧 GPU 场景更新。
 */

import type { Scene } from "../scene/Scene.js";
import { GPUSceneContext } from "./GPUSceneContext.js";
import type { GraphicsContext } from "./GraphicsContext.js";

/** 为每个 CPU 场景维护唯一的 GPU 场景上下文。 */
export class GPUSceneManager {
  readonly isGPUSceneManager = true;
  readonly scene_contexts = new Map<Scene, GPUSceneContext>();

  constructor(private readonly graphics: GraphicsContext) {}

  /** 获取已有上下文；首次访问场景时创建并缓存对应的 GPU 数据所有者。 */
  obtain(scene: Scene): GPUSceneContext {
    const graphics = this.graphics;
    let ctx = this.scene_contexts.get(scene);
    if (!ctx) {
      ctx = new GPUSceneContext(
        graphics,
        scene,
        graphics.geometries,
        graphics.materials,
      );
      this.scene_contexts.set(scene, ctx);
    }
    return ctx;
  }

  /** 释放所有场景级 GPU 资源并清空缓存。 */
  destroy(): void {
    for (const context of this.scene_contexts.values()) context.destroy();
    this.scene_contexts.clear();
  }
}

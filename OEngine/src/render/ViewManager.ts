/**
 * 视图管理器：维护相机对应的 GPU 视图状态，并协调每个视图的渲染资源。
 */

import type { GraphicsContext } from "../gpu/GraphicsContext.js";
import type { GPUSceneManager } from "../gpu/GPUSceneManager.js";
import type { Camera } from "../camera/Camera.js";
import type { Scene } from "../scene/Scene.js";
import type { GPUCameraStateManager } from "./GPUCameraState.js";
import { GPUViewContext } from "./ViewContext.js";
import type { ViewHandle } from "./ViewContext.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";

export { GPUViewContext, GPU_VIEW_TYPE } from "./ViewContext.js";
export type { ViewHandle } from "./ViewContext.js";

export class GPUViewKey {
  label = "";

  constructor(
    readonly camera: Camera,
    readonly scene: Scene
  ) {}

  static from(camera: Camera, scene: Scene): GPUViewKey {
    return new GPUViewKey(camera, scene);
  }

  hash(): number {
    return (this.scene.id << 16) ^ this.camera.id;
  }

  equals(other: GPUViewKey): boolean {
    return this.scene === other.scene && this.camera === other.camera;
  }

  update(): void {
    this.camera.update();
  }
}

export class ViewManager {
  readonly isViewManager = true;

  private readonly _graphics: GraphicsContext;
  private readonly _scenes: GPUSceneManager;
  private readonly _cameraStates: GPUCameraStateManager;
  private readonly _contexts = new Map<
    Camera,
    Map<Scene, GPUViewContext>
  >();

  constructor(
    graphics: GraphicsContext,
    cameraStates: GPUCameraStateManager,
    scenes: GPUSceneManager
  ) {
    this._graphics = graphics;
    this._cameraStates = cameraStates;
    this._scenes = scenes;
  }

  get graphics(): GraphicsContext {
    return this._graphics;
  }

  get scenes(): GPUSceneManager {
    return this._scenes;
  }

  obtain(key: GPUViewKey, command: ShadeGPUCommandContext): ViewHandle {
    const { camera, scene } = key;
    let byScene = this._contexts.get(camera);
    if (byScene === undefined) {
      byScene = new Map<Scene, GPUViewContext>();
      this._contexts.set(camera, byScene);
    }
    let context = byScene.get(scene);
    if (context === undefined) {
      context = new GPUViewContext(
        this._graphics,
        this._scenes.obtain(scene),
        this._cameraStates.obtain(camera),
        command
      );
      context.label = key.label;
      byScene.set(scene, context);
    }
    return context;
  }

  exists(key: GPUViewKey): boolean {
    return this._contexts.get(key.camera)?.has(key.scene) ?? false;
  }
}

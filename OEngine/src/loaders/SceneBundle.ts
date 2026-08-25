/**
 * SceneBundle：负责资源读取、解码或场景装载。
 */

import type { Node3D } from "../scene/Node3D.js";
import type { Skin } from "../animation/Skin.js";
import type { ShadeAnimationClip } from "../animation/ShadeAnimationClip.js";

export class SceneBundle {
  scenes: Node3D[] = [];
  skins: Skin[] = [];
  clips: ShadeAnimationClip[] = [];

  declare readonly isSceneBundle: true;
}

Object.defineProperty(SceneBundle.prototype, "isSceneBundle", {
  value: true,
  writable: true,
  enumerable: true,
  configurable: true
});

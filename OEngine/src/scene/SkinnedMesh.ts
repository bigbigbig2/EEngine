/**
 * SkinnedMesh：负责场景节点、层级关系或可渲染对象管理。
 */

import { Mesh } from "./Mesh.js";

export class SkinnedMesh extends Mesh {
  declare readonly isSkinnedMesh: boolean;

  override clone(): SkinnedMesh {
    const e = new SkinnedMesh();
    e.copy(this);
    return e;
  }
}

Object.assign(SkinnedMesh.prototype, { isSkinnedMesh: true });

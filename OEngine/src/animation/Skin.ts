/**
 * 蒙皮数据：保存骨骼节点、逆绑定矩阵以及网格蒙皮所需的关联信息。
 */

import type { Node3D } from "../scene/Node3D.js";
import type { SkinnedMesh } from "../scene/SkinnedMesh.js";

export class Skin {
  declare readonly isSkin: boolean;

  name = "";
  joints: Node3D[] = [];
  inverse_bind_matrices: Float32Array = new Float32Array(0);
  meshes: SkinnedMesh[] = [];

  static from({
    name = "",
    joints,
    inverse_bind_matrices,
    meshes = []
  }: {
    name?: string;
    joints: Node3D[];
    inverse_bind_matrices: Float32Array;
    meshes?: SkinnedMesh[];
  }): Skin {
    const s = new Skin();
    s.name = name;
    s.joints = joints;
    s.inverse_bind_matrices = inverse_bind_matrices as Float32Array;
    s.meshes = meshes;
    return s;
  }

  copy(other: Skin): void {
    if (this === other) return;
    this.name = other.name;
    this.joints = other.joints.slice();
    this.inverse_bind_matrices = other.inverse_bind_matrices;
    this.meshes = other.meshes.slice();
  }

  clone(): Skin {
    const e = new Skin();
    e.copy(this);
    return e;
  }
}

(Skin.prototype as { isSkin?: boolean }).isSkin = true;

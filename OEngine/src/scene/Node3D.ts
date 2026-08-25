/**
 * 场景节点：维护局部与全局变换、父子层级，并提供方向查询和树遍历能力。
 */

import { Transform3D } from "../core/math/Transform3D.js";
import { Vec3 } from "../core/math/Vec3.js";
import { ChangeSignal } from "../core/Signal.js";

let nextNodeId = 0;

/** @internal 一次已完成 reparent 的确定性上下文。 */
export interface NodeReparentEvent {
  readonly node: Node3D;
  readonly oldParent: Node3D;
  readonly newParent: Node3D;
  readonly previousGlobals: readonly {
    node: Node3D;
    matrix: Float32Array;
  }[];
}

/** 场景图的基础节点，局部变换通过父节点逐级合成为全局变换。 */
export class Node3D {
  readonly id: number = nextNodeId++;
  name = "";
  transform_local = new Transform3D();
  transform_global = new Transform3D();
  parent: Node3D | null = null;
  children: Node3D[] = [];
  /** @internal Scene 用它维护运行时层级与 registry 的一致性。 */
  readonly _onChildAdded = new ChangeSignal<Node3D, Node3D>();
  /** @internal Scene 用它维护运行时层级与 registry 的一致性。 */
  readonly _onChildRemoved = new ChangeSignal<Node3D, Node3D>();
  /** @internal Scene Synchronizer 的 transform dirty seam。 */
  readonly onTransformChanged = new ChangeSignal<Node3D>();
  /** @internal Scene 用它区分同 Scene reparent 与 attach/detach。 */
  readonly _onReparented = new ChangeSignal<NodeReparentEvent>();
  declare readonly isNode3D: boolean;

  constructor() {
    this.transform_local.subscribe(this.#onLocalTransformChanged, this);
  }

  #onLocalTransformChanged(): void {
    this.onTransformChanged.send1(this);
  }

  get forward(): Vec3 {
    return this.transform_global.forward;
  }

  set forward(v: Vec3 | ArrayLike<number>) {
    const t = v[0] as number;
    const n = v[1] as number;
    const r = v[2] as number;
    if (t === 0 && n === 0 && r === 0) return;
    this.transform_local.rotation._lookRotation(t, n, r, 0, 1, 0);
    this.updateMatrices();
  }

  get right(): Vec3 {
    return this.transform_global.right;
  }

  get position(): Vec3 {
    return this.transform_local.position;
  }

  set position(v: Vec3 | ArrayLike<number>) {
    this.transform_local.position.set(
      v[0] as number,
      v[1] as number,
      v[2] as number
    );
  }

  copy(other: Node3D): void {
    this.transform_local.copy(other.transform_local);
    this.transform_global.copy(other.transform_global);
  }

  clone(): Node3D {
    const e = new Node3D();
    e.copy(this);
    for (const child of this.children) {
      const n = child.clone();
      n.parent = e;
      e.children.push(n);
    }
    return e;
  }

  traverse(callback: (node: Node3D) => void, thisArg?: unknown): void {
    callback.call(thisArg, this);
    for (const c of this.children) c.traverse(callback, thisArg);
  }

  /** 更新当前节点及全部子节点的全局变换矩阵。 */
  updateMatrices(): void {
    if (this.parent === null) {
      this.transform_global.copy(this.transform_local);
    } else {
      this.transform_global.multiplyTransforms(
        this.parent.transform_global,
        this.transform_local
      );
    }
    for (const c of this.children) c.updateMatrices();
  }

  addChildren(children: Node3D[]): void {
    for (const c of children) this.addChild(c);
  }

  addChild(child: Node3D): void {
    if (child === this) throw new Error("Can't add to self");
    if (child.parent !== null) throw new Error("node already attached to something");
    for (let ancestor: Node3D | null = this; ancestor !== null; ancestor = ancestor.parent) {
      if (ancestor === child) throw new Error("Can't create a scene hierarchy cycle");
    }
    child.parent = this;
    this.children.push(child);
    child.updateMatrices();
    this._onChildAdded.send2(this, child);
  }

  removeChild(child: Node3D): boolean {
    const index = this.children.indexOf(child);
    if (index === -1) return false;
    this.children.splice(index, 1);
    child.parent = null;
    child.updateMatrices();
    this._onChildRemoved.send2(this, child);
    return true;
  }

  reparent(parent: Node3D | null): void {
    if (this.parent === parent) return;
    if (parent === null) {
      this.parent?.removeChild(this);
      return;
    }
    // 在解除旧 parent 前完成校验；失败的 reparent 不得留下半拆状态。
    for (
      let ancestor: Node3D | null = parent;
      ancestor !== null;
      ancestor = ancestor.parent
    ) {
      if (ancestor === this) {
        throw new Error("Can't create a scene hierarchy cycle");
      }
    }
    const oldParent = this.parent;
    if (oldParent === null) {
      parent.addChild(this);
      return;
    }

    const previousGlobals: NodeReparentEvent["previousGlobals"][number][] = [];
    this.traverse((node) => {
      previousGlobals.push({
        node,
        matrix: Float32Array.from(node.transform_global.matrix)
      });
    });
    const oldIndex = oldParent.children.indexOf(this);
    if (oldIndex === -1) {
      throw new Error("Node parent/children relationship is inconsistent");
    }
    oldParent.children.splice(oldIndex, 1);
    this.parent = parent;
    parent.children.push(this);
    this.updateMatrices();
    this._onReparented.send1({
      node: this,
      oldParent,
      newParent: parent,
      previousGlobals
    });
    // 新 Scene（跨 Scene reparent）通过目标 parent 的 attach 信号注册子树；
    // 同 Scene 中 registerSubtree 会看到节点已注册，因此不会产生结构 dirty。
    parent._onChildAdded.send2(parent, this);
  }
}

Object.assign(Node3D.prototype, { isNode3D: true });

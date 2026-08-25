/**
 * Scene Change Set：记录 World 状态到渲染状态之间的确定性增量。
 *
 * 记录按单调 revision 保留，因此多个 GPU Scene consumer 可以用各自的
 * lastRevision 重复读取；读取本身不会清空其他 consumer 尚未处理的变化。
 */

import type { Light } from "../light/Light.js";
import type { Mesh } from "./Mesh.js";
import type { Node3D } from "./Node3D.js";

export interface SceneTransformChange {
  readonly node: Node3D;
  readonly previousGlobal: Float32Array;
}

export interface SceneChangeSnapshot {
  readonly revision: number;
  readonly fullResyncRequired: boolean;
  readonly instanceStructureChanged: boolean;
  readonly transformedNodes: readonly SceneTransformChange[];
  readonly changedMeshBounds: readonly Mesh[];
  readonly changedLights: readonly Light[];
}

type SceneChangeEvent =
  | { revision: number; kind: "instance-structure" }
  | {
      revision: number;
      kind: "transform";
      node: Node3D;
      previousGlobal: Float32Array;
      boundsChanged: boolean;
    }
  | { revision: number; kind: "light"; light: Light };

const DEFAULT_HISTORY_CAPACITY = 4096;

export class SceneChangeSet {
  private readonly events: SceneChangeEvent[] = [];
  private eventHead = 0;
  private currentRevision = 0;
  private historyFloorRevision = 0;

  constructor(private readonly historyCapacity = DEFAULT_HISTORY_CAPACITY) {
    if (!Number.isInteger(historyCapacity) || historyCapacity < 1) {
      throw new RangeError("SceneChangeSet historyCapacity must be positive");
    }
  }

  get revision(): number {
    return this.currentRevision;
  }

  recordInstanceStructureChanged(): void {
    this.push({
      revision: ++this.currentRevision,
      kind: "instance-structure"
    });
  }

  recordTransform(
    node: Node3D,
    previousGlobal: ArrayLike<number>,
    boundsChanged = false
  ): void {
    this.push({
      revision: ++this.currentRevision,
      kind: "transform",
      node,
      previousGlobal: Float32Array.from(previousGlobal),
      boundsChanged
    });
  }

  recordLight(light: Light): void {
    this.push({
      revision: ++this.currentRevision,
      kind: "light",
      light
    });
  }

  changesSince(lastRevision: number): SceneChangeSnapshot {
    const fullResyncRequired =
      lastRevision < this.historyFloorRevision ||
      lastRevision > this.currentRevision;
    const firstPreviousGlobal = new Map<Node3D, Float32Array>();
    const changedMeshBounds = new Set<Mesh>();
    const changedLights = new Set<Light>();
    let instanceStructureChanged = fullResyncRequired;

    if (!fullResyncRequired) {
      for (let i = this.eventHead; i < this.events.length; i++) {
        const event = this.events[i]!;
        if (event.revision <= lastRevision) continue;
        if (event.kind === "instance-structure") {
          instanceStructureChanged = true;
        } else if (event.kind === "transform") {
          if (!firstPreviousGlobal.has(event.node)) {
            firstPreviousGlobal.set(event.node, event.previousGlobal);
          }
          if (event.boundsChanged) {
            changedMeshBounds.add(event.node as Mesh);
          }
        } else {
          changedLights.add(event.light);
        }
      }
    }

    return {
      revision: this.currentRevision,
      fullResyncRequired,
      instanceStructureChanged,
      transformedNodes: Array.from(
        firstPreviousGlobal,
        ([node, previousGlobal]) => ({ node, previousGlobal })
      ),
      changedMeshBounds: Array.from(changedMeshBounds),
      changedLights: Array.from(changedLights)
    };
  }

  private push(event: SceneChangeEvent): void {
    this.events.push(event);
    while (this.events.length - this.eventHead > this.historyCapacity) {
      const removed = this.events[this.eventHead++]!;
      this.historyFloorRevision = removed.revision;
    }
    // 避免每次溢出都 shift 整个数组，同时把物理存储保持在有界范围。
    if (
      this.eventHead >= this.historyCapacity &&
      this.eventHead * 2 >= this.events.length
    ) {
      this.events.splice(0, this.eventHead);
      this.eventHead = 0;
    }
  }
}

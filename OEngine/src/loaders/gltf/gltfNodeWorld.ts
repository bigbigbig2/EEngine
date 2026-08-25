/**
 * gltfNodeWorld：解析 glTF 数据并转换为引擎运行时对象。
 */

import {
  mat4Clone,
  mat4FromTRS,
  mat4Identity,
  mat4Invert,
  mat4Multiply,
  mat4Transpose
} from "../../core/math/Mat4.js";
import type {
  GltfAccessor,
  GltfDocument,
  GltfMesh,
  GltfNode,
  GltfScene
} from "./GltfLoader.js";

export class GltfAabb3 {
  min = new Float32Array([
    Number.MAX_VALUE,
    Number.MAX_VALUE,
    Number.MAX_VALUE
  ]);
  max = new Float32Array([
    Number.MIN_VALUE,
    Number.MIN_VALUE,
    Number.MIN_VALUE
  ]);

  constructor(e?: GltfAabb3 | null) {
    if (e) {
      this.min[0] = e.min[0]!;
      this.min[1] = e.min[1]!;
      this.min[2] = e.min[2]!;
      this.max[0] = e.max[0]!;
      this.max[1] = e.max[1]!;
      this.max[2] = e.max[2]!;
    }
  }

  union(e: { min: ArrayLike<number>; max: ArrayLike<number> }): void {
    this.min[0] = Math.min(this.min[0]!, e.min[0]!);
    this.min[1] = Math.min(this.min[1]!, e.min[1]!);
    this.min[2] = Math.min(this.min[2]!, e.min[2]!);
    this.max[0] = Math.max(this.max[0]!, e.max[0]!);
    this.max[1] = Math.max(this.max[1]!, e.max[1]!);
    this.max[2] = Math.max(this.max[2]!, e.max[2]!);
  }

  transform(m: Float32Array): void {
    const corners: [number, number, number][] = [
      [this.min[0]!, this.min[1]!, this.min[2]!],
      [this.min[0]!, this.min[1]!, this.max[2]!],
      [this.min[0]!, this.max[1]!, this.min[2]!],
      [this.min[0]!, this.max[1]!, this.max[2]!],
      [this.max[0]!, this.min[1]!, this.min[2]!],
      [this.max[0]!, this.min[1]!, this.max[2]!],
      [this.max[0]!, this.max[1]!, this.min[2]!],
      [this.max[0]!, this.max[1]!, this.max[2]!]
    ];
    this.min[0] = Number.MAX_VALUE;
    this.min[1] = Number.MAX_VALUE;
    this.min[2] = Number.MAX_VALUE;
    this.max[0] = Number.MIN_VALUE;
    this.max[1] = Number.MIN_VALUE;
    this.max[2] = Number.MIN_VALUE;
    for (const n of corners) {
      const r = n[0]!;
      const s = n[1]!;
      const a = n[2]!;
      let i = m[3]! * r + m[7]! * s + m[11]! * a + m[15]!;
      i = i || 1;
      const x = (m[0]! * r + m[4]! * s + m[8]! * a + m[12]!) / i;
      const y = (m[1]! * r + m[5]! * s + m[9]! * a + m[13]!) / i;
      const z = (m[2]! * r + m[6]! * s + m[10]! * a + m[14]!) / i;
      this.min[0] = Math.min(this.min[0]!, x);
      this.min[1] = Math.min(this.min[1]!, y);
      this.min[2] = Math.min(this.min[2]!, z);
      this.max[0] = Math.max(this.max[0]!, x);
      this.max[1] = Math.max(this.max[1]!, y);
      this.max[2] = Math.max(this.max[2]!, z);
    }
  }

  toBox6(out: Float32Array = new Float32Array(6)): Float32Array {
    out[0] = this.min[0]!;
    out[1] = this.min[1]!;
    out[2] = this.min[2]!;
    out[3] = this.max[0]!;
    out[4] = this.max[1]!;
    out[5] = this.max[2]!;
    return out;
  }
}

export const B_ = GltfAabb3;

function asVec3(a: ArrayLike<number>): { x: number; y: number; z: number } {
  return { x: a[0]!, y: a[1]!, z: a[2]! };
}

function asQuat(a: ArrayLike<number>): { x: number; y: number; z: number; w: number } {
  return { x: a[0]!, y: a[1]!, z: a[2]!, w: a[3]! };
}

export function computeGltfNodeWorld(
  doc: GltfDocument,
  node: GltfNode,
  parentWorld: Float32Array
): void {
  if (node.worldMatrix) return;

  if (node.matrix) {
    node.worldMatrix = mat4Clone(node.matrix);
  } else {
    const local = mat4Identity();
    mat4FromTRS(
      local,
      asVec3(node.translation!),
      asQuat(node.rotation!),
      asVec3(node.scale!)
    );
    node.worldMatrix = local;
  }
  mat4Multiply(node.worldMatrix, parentWorld, node.worldMatrix);

  const nm = mat4Clone(node.worldMatrix);
  nm[12] = 0;
  nm[13] = 0;
  nm[14] = 0;
  mat4Transpose(
    nm,
    mat4Invert(nm, nm) ? nm : (null as unknown as Float32Array)
  );
  node.normalMatrix = nm;

  if ("mesh" in node) {
    const n = doc.meshes![node.mesh!] as GltfMesh;
    if (!n.aabb) {
      n.aabb = new GltfAabb3();
      for (const prim of n.primitives) {
        n.aabb.union(
          doc.accessors![prim.attributes.POSITION!]! as GltfAccessor & {
            min: number[];
            max: number[];
          }
        );
      }
    }
    node.aabb = new GltfAabb3(n.aabb);
    node.aabb.transform(node.worldMatrix);
  }

  if (node.children) {
    for (const childIdx of node.children) {
      const r = doc.nodes![childIdx]!;
      computeGltfNodeWorld(doc, r, node.worldMatrix);
      if (r.aabb) {
        if (node.aabb) node.aabb.union(r.aabb);
        else node.aabb = new GltfAabb3(r.aabb);
      }
    }
  }
}

export const z_ = computeGltfNodeWorld;

export function preprocessGltfWorldMatrices(doc: GltfDocument): void {
  for (const P of Object.values(doc.scenes!)) {
    const scene = P as GltfScene;
    for (const z of scene.nodes) {
      const E = doc.nodes![z]!;
      computeGltfNodeWorld(doc, E, mat4Identity());
      if (E.aabb) {
        if (scene.aabb) scene.aabb.union(E.aabb);
        else scene.aabb = new GltfAabb3(E.aabb);
      }
    }
  }
}

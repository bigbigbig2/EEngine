/**
 * Mesh：负责场景节点、层级关系或可渲染对象管理。
 */

import { Node3D } from "./Node3D.js";
import type { MeshletGeometryBase } from "../geometry/BoxGeometry.js";
import type { ShadeMaterial } from "../material/ShadeMaterial.js";
import {
  mat4MaxColumnScale,
  mat4TransformAABB,
  mat4TransformPoint
} from "../core/math/Mat4.js";
import { deepOrRefEquals } from "../core/math/mathUtils.js";

export class Mesh extends Node3D {
  declare isMesh: boolean;
  geometry!: MeshletGeometryBase;
  material!: ShadeMaterial;
  bounding_box: Float32Array = new Float32Array(6);
  bounding_sphere: Float32Array = new Float32Array(4);
  #version = 0;

  get version(): number {
    return this.#version;
  }

  set needsUpdate(v: boolean) {
    if (v) this.#version++;
  }

  static from(
    geometry: MeshletGeometryBase,
    material: ShadeMaterial,
    transform?: Float32Array | number[] | ArrayLike<number>
  ): Mesh {
    const r = new Mesh();
    r.geometry = geometry;
    r.material = material;
    if (transform !== undefined) {
      r.transform_local.fromMatrix(transform);
    }
    r.updateMatrices();
    return r;
  }

  override clone(): Mesh {
    const e = new Mesh();
    e.copy(this);
    return e;
  }

  override copy(other: Mesh): void {
    if (this === other) return;
    super.copy(other);
    this.geometry = other.geometry;
    this.material = other.material;
    this.name = other.name;
    this.bounding_box.set(other.bounding_box);
    this.bounding_sphere.set(other.bounding_sphere);
    this.#version++;
  }

  equals(other: Mesh): boolean {
    return (
      this.name === other.name &&
      deepOrRefEquals(this.geometry, other.geometry) &&
      deepOrRefEquals(this.material, other.material) &&
      this.transform_global.equals(other.transform_global)
    );
  }

  override updateMatrices(): void {
    super.updateMatrices();
    this.updateBoundsBasic();
    this.#version++;
  }

  updateBoundsBasic(): void {
    const geo = this.geometry;
    const m = this.transform_global.matrix;
    mat4TransformAABB(this.bounding_box, geo.bounding_box, m);

    const sc = geo.bounding_sphere;
    const center = { x: sc[0]!, y: sc[1]!, z: sc[2]! };
    const out = { x: 0, y: 0, z: 0 };
    mat4TransformPoint(out, m, center);
    const rScale = mat4MaxColumnScale(m);
    this.bounding_sphere[0] = out.x;
    this.bounding_sphere[1] = out.y;
    this.bounding_sphere[2] = out.z;
    this.bounding_sphere[3] = sc[3]! * rScale;
  }

  updateBoundsTight(): void {
    if (!this.transform_global.rotation.roughlyEquals({ x: 0, y: 0, z: 0, w: 1 })) {
      throw new Error("not implemented");
    }
    this.updateBoundsBasic();
  }
}

Object.assign(Mesh.prototype, { isMesh: true });

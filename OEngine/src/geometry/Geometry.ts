/**
 * Geometry：负责几何数据、Meshlet 或空间结构处理。
 */

import { hashMix, hashOptional } from "../core/hashMix.js";
import {
  arrayDeepEquals,
  deepOrRefEquals,
  distance3,
  dot3,
  hashArrayItems,
  length3,
  lengthSquared3
} from "../core/math/mathUtils.js";
import {
  aabbFromPositions,
  copyArrayRange,
  hashString
} from "../core/memoryUtils.js";
import { Attribute } from "./Attribute.js";
import { MeshletAttrName } from "./meshletPackedAttrs.js";
import { Miniball, PointCloud } from "./Miniball.js";

export const GeometryFlag = {
  BoundsDirty: 1
} as const;

const faceNrmScratch = new Float64Array(3);
const faceNrmScratchNonIdx = new Float64Array(3);

export function addVec3At(
  e: { [i: number]: number },
  t: number,
  n: ArrayLike<number>,
  r: number
): void {
  const s = n[r + 1]!;
  const a = n[r + 2]!;
  e[t] = (e[t] ?? 0) + n[r]!;
  e[t + 1] = (e[t + 1] ?? 0) + s;
  e[t + 2] = (e[t + 2] ?? 0) + a;
}

export function faceNormalFromTri(
  e: { [i: number]: number },
  t: number,
  n: number,
  r: number,
  s: number,
  a: ArrayLike<number>
): void {
  const i = 3 * n;
  const o = 3 * r;
  const _ = 3 * s;
  const ax = a[i]!;
  const ay = a[i + 1]!;
  const az = a[i + 2]!;
  const bx = a[o]!;
  const by = a[o + 1]!;
  const bz = a[o + 2]!;
  const cx = a[_]!;
  const cy = a[_ + 1]!;
  const cz = a[_ + 2]!;
  const u = cx - bx;
  const l = cy - by;
  const f = cz - bz;
  const h = ax - bx;
  const m = ay - by;
  const g = az - bz;
  const p = l * g - f * m;
  const v = f * h - u * g;
  const A = u * m - l * h;
  const b = lengthSquared3(p, v, A);
  if (b === 0) {
    e[t] = 0;
    e[t + 1] = 1;
    e[t + 2] = 0;
    return;
  }
  const w = 1 / Math.sqrt(b);
  e[t] = p * w;
  e[t + 1] = v * w;
  e[t + 2] = A * w;
}

export function normalizeVec3At(
  e: { [i: number]: number },
  t: number,
  n: ArrayLike<number>,
  r: number
): void {
  const s = n[r]!;
  const a = n[r + 1]!;
  const i = n[r + 2]!;
  const o = lengthSquared3(s, a, i);
  const _ = o !== 0 ? 1 / Math.sqrt(o) : 1;
  e[t] = s * _;
  e[t + 1] = a * _;
  e[t + 2] = i * _;
}

export function tangentHandedness(
  e: number,
  t: number,
  n: number,
  r: number,
  s: number,
  a: number,
  i: number,
  o: number,
  _: number
): number {
  return (t * a - n * s) * i + (n * r - e * a) * o + (e * s - t * r) * _ < 0
    ? -1
    : 1;
}

export function fallbackTangentFromNormal(
  e: number,
  t: number,
  n: number,
  r: number,
  s: { [i: number]: number }
): void {
  let a: number;
  let i: number;
  let o: number;
  let _: number;
  let c: number;
  let d: number;
  if (n < 0) {
    const inv = 1 / (1 - n);
    const mid = e * t * inv;
    a = 1 - e * e * inv;
    i = -mid;
    o = e;
    _ = mid;
    c = t * t * inv - 1;
    d = -t;
  } else {
    const inv = 1 / (1 + n);
    const mid = -e * t * inv;
    a = 1 - e * e * inv;
    i = mid;
    o = -e;
    _ = mid;
    c = 1 - t * t * inv;
    d = -t;
  }
  const u = tangentHandedness(e, t, n, a, i, o, _, c, d);
  const l = 4 * r;
  s[l] = a;
  s[l + 1] = i;
  s[l + 2] = o;
  s[l + 3] = u;
}

export function addScalar3At(
  e: { [i: number]: number },
  t: number,
  n: number,
  r: number,
  s: number
): void {
  e[t] = (e[t] ?? 0) + n;
  e[t + 1] = (e[t + 1] ?? 0) + r;
  e[t + 2] = (e[t + 2] ?? 0) + s;
}

export class Geometry {
  name = "";
  attributes: Attribute[] = [];
  index: Attribute | null = null;
  bounding_box = new Float32Array(6);
  bounding_sphere = new Float32Array(4);
  flags = GeometryFlag.BoundsDirty;

  setFlag(e: number): void {
    this.flags |= e;
  }

  clearFlag(e: number): void {
    this.flags &= ~e;
  }

  writeFlag(e: number, t: boolean): void {
    if (t) this.setFlag(e);
    else this.clearFlag(e);
  }

  getFlag(e: number): boolean {
    return (this.flags & e) === e;
  }

  equals(e: Geometry): boolean {
    return (
      this === e ||
      (this.name === e.name &&
        deepOrRefEquals(this.index, e.index) &&
        arrayDeepEquals(this.attributes, e.attributes))
    );
  }

  hash(): number {
    return hashMix(
      hashString(this.name),
      hashOptional(this.index),
      hashArrayItems(this.attributes, (a) => a.hash())
    );
  }

  getAttribute(e: string): Attribute | undefined {
    const t = this.attributes;
    const n = t.length;
    for (let r = 0; r < n; r++) {
      const a = t[r]!;
      if (a.spec.name === e) return a;
    }
    return undefined;
  }

  hasAttribute(e: string): boolean {
    return this.getAttribute(e) !== undefined;
  }

  setAttribute(e: Attribute): void {
    if (this.hasAttribute(e.spec.name)) this.removeAttribute(e.spec.name);
    this.addAttribute(e);
  }

  addAttribute(e: Attribute): void {
    this.attributes.push(e);
  }

  removeAttribute(e: string): Attribute | undefined {
    const t = this.attributes;
    const n = t.length;
    for (let r = 0; r < n; r++) {
      const a = t[r]!;
      if (a.spec.name === e) {
        t.splice(r, 1);
        return a;
      }
    }
    return undefined;
  }

  getVertexCount(): number {
    const e = this.attributes;
    return e.length === 0 ? 0 : e[0]!.count;
  }

  getIndexCount(): number {
    const e = this.index;
    return e != null ? e.count : this.getVertexCount();
  }

  getPrimitiveCount(): number {
    return this.getIndexCount() / 3;
  }

  ensureIndex(): void {
    if (this.index === null) this.buildIndex();
  }

  buildIndex(): void {
    const e = this.getVertexCount();
    const t = new Uint32Array(e);
    for (let n = 0; n < e; n++) t[n] = n;
    this.index = Attribute.from(t, 1, "index");
  }

  ensureBounds(): void {
    if (this.getFlag(GeometryFlag.BoundsDirty)) this.computeBoundingShapes();
  }

  computeBoundingSphereFromBox(): void {
    const e = this.bounding_box;
    const t = e[0]!;
    const n = e[3]!;
    const r = e[1]!;
    const s = e[4]!;
    const a = e[2]!;
    const i = e[5]!;
    this.bounding_sphere[0] = 0.5 * (t + n);
    this.bounding_sphere[1] = 0.5 * (r + s);
    this.bounding_sphere[2] = 0.5 * (a + i);
    this.bounding_sphere[3] = distance3(t, r, a, n, s, i);
  }

  computeBoundingSphere(): void {
    const e = this.getAttribute(MeshletAttrName.Position);
    if (e === undefined || e.count <= 0) {
      this.bounding_sphere.fill(0);
      return;
    }
    if (e.count === 1) {
      this.bounding_sphere[0] = e.data[0]! as number;
      this.bounding_sphere[1] = e.data[1]! as number;
      this.bounding_sphere[2] = e.data[2]! as number;
      this.bounding_sphere[3] = 0;
      return;
    }
    const t = new PointCloud(e.count, 3, e.data);
    const n = new Miniball(t);
    const r = n.center();
    this.bounding_sphere[0] = r[0]!;
    this.bounding_sphere[1] = r[1]!;
    this.bounding_sphere[2] = r[2]!;
    this.bounding_sphere[3] = n.radius();
  }

  computeBoundingShapes(): void {
    this.computeBoundingBox();
    this.computeBoundingSphereFromBox();
    this.clearFlag(GeometryFlag.BoundsDirty);
  }

  computeBoundingBox(): void {
    const e = this.getAttribute(MeshletAttrName.Position);
    if (e === undefined) {
      this.bounding_box.fill(0);
      this.clearFlag(GeometryFlag.BoundsDirty);
      return;
    }
    aabbFromPositions(
      this.bounding_box,
      e.data,
      e.count * e.spec.itemSize
    );
    this.clearFlag(GeometryFlag.BoundsDirty);
  }

  ensureNormals(): void {
    if (this.getAttribute(MeshletAttrName.Normal) === undefined) {
      this.computeNormals();
    }
  }

  computeNormals(): void {
    const e = this.getVertexCount();
    const t = this.getAttribute(MeshletAttrName.Position);
    if (t === undefined) {
      throw new Error("computeNormals requires position attribute");
    }
    let n = this.getAttribute(MeshletAttrName.Normal);
    if (n === undefined) {
      n = Attribute.from(new Float32Array(3 * e), 3, MeshletAttrName.Normal);
      this.addAttribute(n);
    } else {
      const d = n.data as Float32Array | { fill?: (v: number, s?: number, en?: number) => void };
      if (typeof d.fill === "function") d.fill(0, 0, 3 * e);
      else {
        for (let i = 0; i < 3 * e; i++) (n.data as { [i: number]: number })[i] = 0;
      }
    }
    const r = this.index;
    const pos = t.data;
    const nrm = n.data as { [i: number]: number };
    if (r === null) {
      for (let ri = 0; ri < e; ri += 3) {
        const vi0 = ri;
        const vi1 = ri + 1;
        const vi2 = ri + 2;
        faceNormalFromTri(faceNrmScratchNonIdx, 0, vi0, vi1, vi2, pos);
        copyArrayRange(faceNrmScratchNonIdx, 0, nrm, 3 * vi0, 3);
        copyArrayRange(faceNrmScratchNonIdx, 0, nrm, 3 * vi1, 3);
        copyArrayRange(faceNrmScratchNonIdx, 0, nrm, 3 * vi2, 3);
      }
    } else {
      const idx = r.data;
      const rlen = idx.length;
      for (let s = 0; s < rlen; s += 3) {
        const i0 = idx[s]! as number;
        const i1 = idx[s + 1]! as number;
        const i2 = idx[s + 2]! as number;
        faceNormalFromTri(faceNrmScratch, 0, i0, i1, i2, pos);
        addVec3At(nrm, 3 * i0, faceNrmScratch, 0);
        addVec3At(nrm, 3 * i1, faceNrmScratch, 0);
        addVec3At(nrm, 3 * i2, faceNrmScratch, 0);
      }
      const end = 3 * e;
      for (let off = 0; off < end; off += 3) {
        normalizeVec3At(nrm, off, nrm as ArrayLike<number>, off);
      }
    }
    n.needsUpdate = true;
  }

  private ensureTangentAttribute(): Attribute {
    if (!this.hasAttribute(MeshletAttrName.Tangent)) {
      const e = this.getVertexCount();
      this.addAttribute(
        Attribute.from(new Float32Array(4 * e), 4, MeshletAttrName.Tangent)
      );
    }
    return this.getAttribute(MeshletAttrName.Tangent)!;
  }

  private computeTangentsFromUv(): void {
    const e = this.index;
    const t = this.getAttribute(MeshletAttrName.Position);
    const n = this.getAttribute(MeshletAttrName.Normal);
    const r = this.getAttribute(MeshletAttrName.Uv0);
    if (e === null || t === undefined || n === undefined || r === undefined) {
      throw new Error(
        " .computeTangents() failed. Missing required attributes (index, position, normal or uv)"
      );
    }
    const s = t.data;
    const a = r.data;
    const i = n.data;
    const o = this.ensureTangentAttribute();
    const tanOut = o.data as { [i: number]: number };
    const indexCount = e.count;
    const indexData = e.data;
    const vertCount = t.count;
    const tan1 = new Float32Array(3 * vertCount);
    const tan2 = new Float32Array(3 * vertCount);
    for (let n0 = 0; n0 < indexCount; n0 += 3) {
      const i0 = indexData[n0]! as number;
      const i1 = indexData[n0 + 1]! as number;
      const i2 = indexData[n0 + 2]! as number;
      const c = i0 << 1;
      const d = a[c]! as number;
      const u = a[c + 1]! as number;
      const l = i1 << 1;
      const f = i2 << 1;
      const h = (a[l]! as number) - d;
      const m0 = (a[l + 1]! as number) - u;
      const g = (a[f]! as number) - d;
      const p = (a[f + 1]! as number) - u;
      const v = h * p - g * m0;
      if (v === 0) continue;
      const A = 1 / v;
      const b = c + i0;
      const w = s[b]! as number;
      const x = s[b + 1]! as number;
      const y = s[b + 2]! as number;
      const B = l + i1;
      const P = f + i2;
      const z = (s[B]! as number) - w;
      const E = (s[B + 1]! as number) - x;
      const C = (s[B + 2]! as number) - y;
      const D = (s[P]! as number) - w;
      const Q = (s[P + 1]! as number) - x;
      const k = (s[P + 2]! as number) - y;
      const I = (z * p - D * m0) * A;
      const F = (E * p - Q * m0) * A;
      const M = (C * p - k * m0) * A;
      const j = (D * h - z * g) * A;
      const T = (Q * h - E * g) * A;
      const L = (k * h - C * g) * A;
      addScalar3At(tan1, b, I, F, M);
      addScalar3At(tan1, B, I, F, M);
      addScalar3At(tan1, P, I, F, M);
      addScalar3At(tan2, b, j, T, L);
      addScalar3At(tan2, B, j, T, L);
      addScalar3At(tan2, P, j, T, L);
    }
    for (let vi = 0; vi < vertCount; vi++) {
      const t0 = 3 * vi;
      const nx = i[t0]! as number;
      const ny = i[t0 + 1]! as number;
      const nz = i[t0 + 2]! as number;
      const c = tan1[t0]!;
      const d = tan1[t0 + 1]!;
      const u = tan1[t0 + 2]!;
      if (c === 0 && d === 0 && u === 0) {
        fallbackTangentFromNormal(nx, ny, nz, vi, tanOut);
        continue;
      }
      const l = tan2[t0]!;
      const h = tan2[t0 + 1]!;
      const g = tan2[t0 + 2]!;
      const p = dot3(nx, ny, nz, c, d, u);
      let v = c - nx * p;
      let A = d - ny * p;
      let b = u - nz * p;
      const w = 1 / length3(v, A, b);
      v *= w;
      A *= w;
      b *= w;
      const x = tangentHandedness(nx, ny, nz, v, A, b, l, h, g);
      const y = vi << 2;
      tanOut[y] = v;
      tanOut[y + 1] = A;
      tanOut[y + 2] = b;
      tanOut[y + 3] = x;
    }
    o.needsUpdate = true;
  }

  private computeTangentsFromNormals(): void {
    const e = this.getAttribute(MeshletAttrName.Normal);
    if (e === undefined) {
      throw new Error("computeTangents requires normal attribute");
    }
    const t = this.ensureTangentAttribute().data as { [i: number]: number };
    const n = e.data;
    const r = this.getVertexCount();
    for (let vi = 0; vi < r; vi++) {
      const off = 3 * vi;
      fallbackTangentFromNormal(
        n[off]! as number,
        n[off + 1]! as number,
        n[off + 2]! as number,
        vi,
        t
      );
    }
    this.getAttribute(MeshletAttrName.Tangent)!.needsUpdate = true;
  }

  ensureTangents(): void {
    if (this.getAttribute(MeshletAttrName.Tangent) === undefined) {
      this.computeTangents();
    }
  }

  computeTangents(): void {
    this.ensureNormals();
    if (
      this.hasAttribute(MeshletAttrName.Uv0) &&
      this.hasAttribute(MeshletAttrName.Position) &&
      this.hasAttribute(MeshletAttrName.Normal)
    ) {
      this.computeTangentsFromUv();
    } else {
      this.computeTangentsFromNormals();
    }
  }

  copy(e: Geometry): void {
    this.name = e.name;
    this.index = e.index !== null ? e.index.clone() : null;
    this.attributes = e.attributes.map((a) => a.clone());
    this.flags = e.flags;
    this.bounding_sphere.set(e.bounding_sphere);
    this.bounding_box.set(e.bounding_box);
  }

  clone(): Geometry {
    const e = new Geometry();
    e.copy(this);
    return e;
  }

  update(): void {
    this.ensureBounds();
  }

  get memory_usage_bytes(): number {
    let e = 0;
    if (this.index !== null) e += this.index.memory_usage_bytes;
    for (const t of this.attributes) e += t.memory_usage_bytes;
    return e;
  }
}

(Geometry.prototype as { isGeometry?: boolean }).isGeometry = true;

export const Ao = Geometry;
export { deepOrRefEquals as Ur };
export const co = faceNormalFromTri;
export const _o = addVec3At;
export const uo = normalizeVec3At;
export const mo = tangentHandedness;
export const go = fallbackTangentFromNormal;
export const po = addScalar3At;

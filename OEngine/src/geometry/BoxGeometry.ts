/**
 * BoxGeometry：负责几何数据、Meshlet 或空间结构处理。
 */

import {
  arrayBufferEquals,
  hashArrayBuffer,
  hashMix
} from "../core/hashMix.js";
import { Attribute } from "./Attribute.js";
import { Geometry } from "./Geometry.js";
import type { SourceGeometry } from "../assets/SourceGeometry.js";
import { geometryToSourceGeometry } from "./SourceGeometryAdapter.js";
import { MeshletAttrName } from "./meshletPackedAttrs.js";
import {
  buildMeshletBatchFromGeometry,
  buildMeshletBounds,
  compressMeshlets,
  niFinalizeFromCpu,
  niFromGeometry,
  readMeshletCore,
  readMeshletHeader,
  type MeshletHeader
} from "./niMeshlets.js";

export class MeshletsStub {
  declare readonly isMeshletBatch: boolean;
  count = 0;
  metadata_buffer: ArrayBuffer = new ArrayBuffer(0);
  data_buffer: ArrayBuffer = new ArrayBuffer(0);

  hash(): number {
    const e = this.metadata_buffer;
    return hashMix(this.count, hashArrayBuffer(e, 0, e.byteLength));
  }

  equals(other: MeshletsStub): boolean {
    if (this.count !== other.count) return false;
    const ma = this.metadata_buffer;
    const mb = other.metadata_buffer;
    if (ma.byteLength !== mb.byteLength) return false;
    if (!arrayBufferEquals(ma, 0, mb, 0, ma.byteLength)) return false;
    const da = this.data_buffer;
    const db = other.data_buffer;
    if (da.byteLength !== db.byteLength) return false;
    return arrayBufferEquals(da, 0, db, 0, da.byteLength);
  }

  compress(): number {
    return compressMeshlets(this);
  }

  build_bounds(): void {
    buildMeshletBounds(this);
  }

  read_header(e: number): MeshletHeader {
    return readMeshletHeader(this.metadata_buffer, e);
  }

  read_meshlet(e: number): {
    header: MeshletHeader;
    attribute_index: Uint32Array;
    attribute_position: Float32Array;
  } {
    return readMeshletCore(this.metadata_buffer, this.data_buffer, e);
  }

  build(geometry: unknown): void {
    if (
      geometry != null &&
      typeof geometry === "object" &&
      (geometry as { isGeometry?: boolean }).isGeometry === true
    ) {
      buildMeshletBatchFromGeometry(geometry as Geometry, this);
      return;
    }
    if (
      geometry != null &&
      typeof geometry === "object" &&
      (geometry as { isMeshletGeometry?: boolean }).isMeshletGeometry === true
    ) {
      niFinalizeFromCpu(geometry as import("./BoxGeometry.js").MeshletGeometryBase);
    }
  }

  optimize(): void {}
}

(MeshletsStub.prototype as { isMeshletBatch?: boolean }).isMeshletBatch = true;

let nextMeshletGeometryId = 0;

export class MeshletGeometryBase {
  id = nextMeshletGeometryId++;
  name = "";
  bounding_box = new Float32Array(6);
  bounding_sphere = new Float32Array(4);
  primitive_count = 0;
  meshlets = new MeshletsStub();
  bvh: ArrayBuffer = new ArrayBuffer(0);
  declare isMeshletGeometry: boolean;

  vertexData: Float32Array = new Float32Array(0);
  indexData: Uint16Array | Uint32Array = new Uint16Array(0);
  tangentData: Float32Array | null = null;
  colorData: Float32Array | null = null;
  uv0Data: Float32Array | null = null;
  uv1Data: Float32Array | null = null;
  jointsData: Float32Array | null = null;
  weightsData: Float32Array | null = null;

  getIndexCount(): number {
    return 3 * this.primitive_count;
  }

  getVertexCount(): number {
    return this.vertexData.length / 6;
  }

  hash(): number {
    return this.meshlets.hash();
  }

  equals(other: MeshletGeometryBase): boolean {
    return this.meshlets.equals(other.meshlets);
  }
}

(MeshletGeometryBase.prototype as { isMeshletGeometry?: boolean }).isMeshletGeometry = true;

export function buildBoxMesh(
  width = 1,
  height = 1,
  depth = 1,
  segW = 1,
  segH = 1,
  segD = 1
): Geometry {
  const i = new Geometry();
  i.name = "Box";
  const r = Math.floor(segW);
  const s = Math.floor(segH);
  const a = Math.floor(segD);
  const o: number[] = [];
  const _: number[] = [];
  const c: number[] = [];
  const d: number[] = [];
  let u = 0;

  function l(
    e: number,
    t: number,
    n: number,
    rSign: number,
    sSign: number,
    aDim: number,
    iDim: number,
    lThick: number,
    f: number,
    h: number
  ): void {
    const m = aDim / f;
    const g = iDim / h;
    const p = aDim / 2;
    const v = iDim / 2;
    const A = lThick / 2;
    const b = f + 1;
    const w = h + 1;
    let x = 0;
    const y = new Float32Array(3);
    for (let row = 0; row < w; row++) {
      const iRow = row * g - v;
      for (let col = 0; col < b; col++) {
        y[e] = (col * m - p) * rSign;
        y[t] = iRow * sSign;
        y[n] = A;
        _.push(y[0]!, y[1]!, y[2]!);
        y[e] = 0;
        y[t] = 0;
        y[n] = lThick > 0 ? 1 : -1;
        c.push(y[0]!, y[1]!, y[2]!);
        d.push(col / f);
        d.push(1 - row / h);
        x += 1;
      }
    }
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < f; col++) {
        const nIdx = u + col + b * (row + 1);
        const rIdx = u + (col + 1) + b * (row + 1);
        const sIdx = u + (col + 1) + b * row;
        o.push(u + col + b * row, nIdx, sIdx);
        o.push(nIdx, rIdx, sIdx);
      }
    }
    u += x;
  }

  l(2, 1, 0, -1, -1, depth, height, width, a, s);
  l(2, 1, 0, 1, -1, depth, height, -width, a, s);
  l(0, 2, 1, 1, 1, width, depth, height, r, a);
  l(0, 2, 1, 1, -1, width, depth, -height, r, a);
  l(0, 1, 2, 1, -1, width, height, depth, r, s);
  l(0, 1, 2, -1, -1, width, height, -depth, r, s);

  i.index = Attribute.from(new Uint32Array(o), 1, "index");
  i.addAttribute(
    Attribute.from(new Float32Array(_), 3, MeshletAttrName.Position)
  );
  i.addAttribute(
    Attribute.from(new Float32Array(c), 3, MeshletAttrName.Normal)
  );
  i.addAttribute(
    Attribute.from(new Float32Array(d), 2, MeshletAttrName.Uv0)
  );
  return i;
}

export function buildBoxSourceGeometry(
  width = 1,
  height = 1,
  depth = 1,
  segW = 1,
  segH = 1,
  segD = 1
): SourceGeometry {
  return geometryToSourceGeometry(
    buildBoxMesh(width, height, depth, segW, segH, segD),
    { sourceId: `box:${width}:${height}:${depth}:${segW}:${segH}:${segD}` }
  );
}

export class BoxGeometry extends MeshletGeometryBase {
  constructor(width = 1, height = 1, depth = 1) {
    super();
    niFromGeometry(buildBoxMesh(width, height, depth), this);
  }
}

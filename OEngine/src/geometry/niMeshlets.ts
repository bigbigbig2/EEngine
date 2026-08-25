/**
 * Meshlet 构建器：压缩顶点属性、划分 Meshlet，并生成用于 GPU 驱动渲染的层级与包围体数据。
 */

import { aabbFromPositions, alignCeil } from "../core/memoryUtils.js";
import type { MeshletGeometryBase, MeshletsStub } from "./BoxGeometry.js";
import type { Geometry } from "./Geometry.js";
import { MeshletGeometryBase as MeshletGeoCtor } from "./BoxGeometry.js";
import { encode_meshlet_element } from "./MeshletTypes.js";
import { meshoptimizer } from "./meshoptimizer.js";
import {
  BVH_NULL_NODE,
  DynamicBvh,
  exportDynamicBvhNodes,
  optimizeDynamicBvh
} from "../gpu/DynamicBvh.js";
import {
  decodeVertexColor,
  decodeVertexJoints,
  decodeVertexNormal,
  decodeVertexTangent,
  decodeVertexUv1,
  decodeVertexWeights,
  MESHLET_ATTR_DEFAULTS,
  MeshletAttrFlag,
  MeshletAttrName,
  meshletAttributeSectionOffset,
  meshletAttrSectionOffset,
  packVertexColors,
  packVertexJoints,
  packVertexNormals,
  packVertexTangents,
  packVertexUv1,
  packVertexWeights,
  packedIndexWordCount,
  remeshMeshletVertices
} from "./meshletPackedAttrs.js";

export const MESHLET_MAX_VERTICES = 128;
export const MESHLET_MAX_TRIANGLES = 128;

export const MESHLET_HEADER_BYTES = 40;
export const MESHLET_HEADER_OFF = {
  bounds_box: 0,
  address: 24,
  primitive_count: 28,
  vertex_count: 32,
  flags: 36
} as const;
export const MESHLET_HEADER_WORD_OFF = {
  bounds_box: 0,
  address: 6,
  primitive_count: 7,
  vertex_count: 8,
  flags: 9
} as const;

export interface BuiltMeshlet {
  vertices: Uint32Array;
  triangles: Uint8Array;
  vertexCount: number;
  primitiveCount: number;
  bounds: Float32Array;
}

export function clusterMeshlets(
  indices: ArrayLike<number>,
  positions: Float32Array,
  maxVerts = MESHLET_MAX_VERTICES,
  maxTris = MESHLET_MAX_TRIANGLES
): BuiltMeshlet[] {
  const triCount = Math.floor(indices.length / 3);
  if (triCount === 0) return [];
  if (!meshoptimizer.supported || meshoptimizer.buildMeshlets === undefined) {
    throw new Error("WebAssembly meshoptimizer is not supported");
  }
  const sourceIndices =
    indices instanceof Uint32Array ? indices : Uint32Array.from(indices);
  const built = meshoptimizer.buildMeshlets(
    sourceIndices,
    positions,
    3,
    maxVerts,
    maxTris,
    0
  );
  const out = new Array<BuiltMeshlet>(built.meshletCount);
  for (let i = 0; i < built.meshletCount; i++) {
    const row = 4 * i;
    const vertexOffset = built.meshlets[row]!;
    const triangleOffset = built.meshlets[row + 1]!;
    const vertexCount = built.meshlets[row + 2]!;
    const primitiveCount = built.meshlets[row + 3]!;
    const vertices = built.vertices.slice(
      vertexOffset,
      vertexOffset + vertexCount
    );
    const triangles = built.triangles.slice(
      triangleOffset,
      triangleOffset + 3 * primitiveCount
    );
    remeshMeshletVertices(
      vertices,
      triangles,
      primitiveCount,
      vertexCount
    );
    out[i] = {
      vertices,
      triangles,
      vertexCount,
      primitiveCount,
      bounds: boundsFromIndexed(positions, vertices)
    };
  }
  return out;
}

function boundsFromIndexed(
  positions: Float32Array,
  globalVerts: Uint32Array
): Float32Array {
  const box = new Float32Array(6);
  if (globalVerts.length === 0) return box;
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < globalVerts.length; i++) {
    const o = 3 * globalVerts[i]!;
    const x = positions[o] ?? 0;
    const y = positions[o + 1] ?? 0;
    const z = positions[o + 2] ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  box.set([minX, minY, minZ, maxX, maxY, maxZ]);
  return box;
}

function packTriangleBytes(triangles: Uint8Array, primCount: number): Uint32Array {
  const n = 3 * primCount;
  const words = Math.ceil(n / 4);
  const out = new Uint32Array(words);
  let e = 0;
  let t = 0;
  for (let i = 0; i < n; i++) {
    e |= (triangles[i]! & 0xff) << (8 * t);
    t++;
    if (t >= 4) {
      out[(i >>> 2)] = e >>> 0;
      e = 0;
      t = 0;
    }
  }
  if (t > 0) {
    out[words - 1] = e >>> 0;
  }
  return out;
}

export interface FillMeshletsAttrs {
  normals?: Float32Array | null;
  tangents?: Float32Array | null;
  colors?: Float32Array | null;
  uv0?: Float32Array | null;
  uv1?: Float32Array | null;
  joints?: Float32Array | null;
  weights?: Float32Array | null;
}

export function writeMeshoptimizerMeshlets(
  stub: MeshletsStub,
  meshlets: BuiltMeshlet[],
  positions: Float32Array,
  normalsOrAttrs?: Float32Array | null | FillMeshletsAttrs,
  tangents?: Float32Array | null
): void {
  let attrs: FillMeshletsAttrs;
  if (
    normalsOrAttrs != null &&
    !(normalsOrAttrs instanceof Float32Array) &&
    typeof normalsOrAttrs === "object"
  ) {
    attrs = normalsOrAttrs as FillMeshletsAttrs;
  } else {
    attrs = {
      normals: normalsOrAttrs as Float32Array | null | undefined,
      tangents
    };
  }

  const count = meshlets.length;
  const meta = new ArrayBuffer(count * MESHLET_HEADER_BYTES);
  const metaF = new Float32Array(meta);
  const metaU = new Uint32Array(meta);

  const hasNormals = attrs.normals != null && attrs.normals.length >= 3;
  const hasTangents = attrs.tangents != null && attrs.tangents.length >= 4;
  const hasColor = attrs.colors != null && attrs.colors.length >= 3;
  const hasUv0 = attrs.uv0 != null && attrs.uv0.length >= 2;
  const hasUv1 = attrs.uv1 != null && attrs.uv1.length >= 2;
  const hasJoints = attrs.joints != null && attrs.joints.length >= 4;
  const hasWeights = attrs.weights != null && attrs.weights.length >= 4;

  let initialFlags = 0;
  if (!hasNormals) initialFlags |= MeshletAttrFlag.Normal;
  if (!hasTangents) initialFlags |= MeshletAttrFlag.Tangent;
  if (!hasColor) initialFlags |= MeshletAttrFlag.Color;
  if (!hasUv0) initialFlags |= MeshletAttrFlag.Uv0;
  if (!hasUv1) initialFlags |= MeshletAttrFlag.Uv1;
  if (!hasJoints) initialFlags |= MeshletAttrFlag.Joints;
  if (!hasWeights) initialFlags |= MeshletAttrFlag.Weights;

  let dataWords = 0;
  for (const m of meshlets) {
    dataWords += packedIndexWordCount(m.primitiveCount);
    dataWords += 3 * m.vertexCount;
    dataWords += hasNormals ? m.vertexCount : 1;
    dataWords += hasTangents ? m.vertexCount : 1;
    dataWords += hasColor ? m.vertexCount : 1;
    dataWords += hasUv0 ? 2 * m.vertexCount : 2;
    dataWords += hasUv1 ? m.vertexCount : 1;
    dataWords += hasJoints ? 2 * m.vertexCount : 2;
    dataWords += hasWeights ? m.vertexCount : 1;
  }
  const data = new ArrayBuffer(Math.max(dataWords, 1) * 4);
  const dataU = new Uint32Array(data);
  const dataF = new Float32Array(data);
  let cursor = 0;

  for (let i = 0; i < count; i++) {
    const m = meshlets[i]!;
    const address = cursor;
    const packed = packTriangleBytes(m.triangles, m.primitiveCount);
    dataU.set(packed, cursor);
    cursor += packed.length;

    for (let v = 0; v < m.vertexCount; v++) {
      const g = m.vertices[v]!;
      const po = 3 * g;
      const wo = cursor + 3 * v;
      dataF[wo] = positions[po] ?? 0;
      dataF[wo + 1] = positions[po + 1] ?? 0;
      dataF[wo + 2] = positions[po + 2] ?? 0;
    }
    cursor += 3 * m.vertexCount;

    if (hasNormals) {
      const nLocal = new Float32Array(3 * m.vertexCount);
      const src = attrs.normals;
      const hasN = src != null && src.length >= 3;
      for (let v = 0; v < m.vertexCount; v++) {
        if (hasN) {
          const g = m.vertices[v]!;
          const po = 3 * g;
          nLocal[3 * v] = src![po] ?? 0;
          nLocal[3 * v + 1] = src![po + 1] ?? 0;
          nLocal[3 * v + 2] = src![po + 2] ?? 0;
        } else {
          nLocal[3 * v] = 0;
          nLocal[3 * v + 1] = 0;
          nLocal[3 * v + 2] = 1;
        }
      }
      packVertexNormals(dataU, cursor, m.vertexCount, nLocal);
      cursor += m.vertexCount;
    } else {
      dataU[cursor++] = MESHLET_ATTR_DEFAULTS[MeshletAttrName.Normal] as number;
    }

    if (hasTangents) {
      const tLocal = new Float32Array(4 * m.vertexCount);
      const src = attrs.tangents;
      const hasT = src != null && src.length >= 4;
      for (let v = 0; v < m.vertexCount; v++) {
        if (hasT) {
          const g = m.vertices[v]!;
          const to = 4 * g;
          tLocal[4 * v] = src![to] ?? 1;
          tLocal[4 * v + 1] = src![to + 1] ?? 0;
          tLocal[4 * v + 2] = src![to + 2] ?? 0;
          tLocal[4 * v + 3] = src![to + 3] ?? 1;
        } else {
          tLocal[4 * v] = 0;
          tLocal[4 * v + 1] = 0;
          tLocal[4 * v + 2] = 1;
          tLocal[4 * v + 3] = 1;
        }
      }
      packVertexTangents(dataU, cursor, m.vertexCount, tLocal);
      cursor += m.vertexCount;
    } else {
      dataU[cursor++] = MESHLET_ATTR_DEFAULTS[MeshletAttrName.Tangent] as number;
    }

    if (hasColor) {
      const cLocal = new Float32Array(3 * m.vertexCount);
      const src = attrs.colors;
      const hasC = src != null && src.length >= 3;
      for (let v = 0; v < m.vertexCount; v++) {
        if (hasC) {
          const g = m.vertices[v]!;
          const co = 3 * g;
          cLocal[3 * v] = src![co] ?? 1;
          cLocal[3 * v + 1] = src![co + 1] ?? 1;
          cLocal[3 * v + 2] = src![co + 2] ?? 1;
        } else {
          cLocal[3 * v] = 1;
          cLocal[3 * v + 1] = 1;
          cLocal[3 * v + 2] = 1;
        }
      }
      packVertexColors(dataU, cursor, m.vertexCount, cLocal);
      cursor += m.vertexCount;
    } else {
      dataU[cursor++] = MESHLET_ATTR_DEFAULTS[MeshletAttrName.Color] as number;
    }

    if (hasUv0) {
      const src = attrs.uv0;
      const hasU = src != null && src.length >= 2;
      for (let v = 0; v < m.vertexCount; v++) {
        const wo = cursor + 2 * v;
        if (hasU) {
          const g = m.vertices[v]!;
          const uo = 2 * g;
          dataF[wo] = src![uo] ?? 0;
          dataF[wo + 1] = src![uo + 1] ?? 0;
        } else {
          dataF[wo] = 0;
          dataF[wo + 1] = 0;
        }
      }
      cursor += 2 * m.vertexCount;
    } else {
      const defaults = MESHLET_ATTR_DEFAULTS[MeshletAttrName.Uv0] as number[];
      dataU[cursor++] = defaults[0]! >>> 0;
      dataU[cursor++] = defaults[1]! >>> 0;
    }

    if (hasUv1) {
      const uLocal = new Float32Array(2 * m.vertexCount);
      const src = attrs.uv1;
      const hasU1 = src != null && src.length >= 2;
      for (let v = 0; v < m.vertexCount; v++) {
        if (hasU1) {
          const g = m.vertices[v]!;
          const uo = 2 * g;
          uLocal[2 * v] = src![uo] ?? 0;
          uLocal[2 * v + 1] = src![uo + 1] ?? 0;
        }
      }
      packVertexUv1(dataU, cursor, m.vertexCount, uLocal);
      cursor += m.vertexCount;
    } else {
      dataU[cursor++] = MESHLET_ATTR_DEFAULTS[MeshletAttrName.Uv1] as number;
    }

    if (hasJoints) {
      const jLocal = new Float32Array(4 * m.vertexCount);
      const src = attrs.joints;
      const hasJ = src != null && src.length >= 4;
      for (let v = 0; v < m.vertexCount; v++) {
        if (hasJ) {
          const g = m.vertices[v]!;
          const jo = 4 * g;
          jLocal[4 * v] = src![jo] ?? 0;
          jLocal[4 * v + 1] = src![jo + 1] ?? 0;
          jLocal[4 * v + 2] = src![jo + 2] ?? 0;
          jLocal[4 * v + 3] = src![jo + 3] ?? 0;
        }
      }
      packVertexJoints(dataU, cursor, m.vertexCount, jLocal);
      cursor += 2 * m.vertexCount;
    } else {
      const defaults = MESHLET_ATTR_DEFAULTS[MeshletAttrName.Joints] as number[];
      dataU[cursor++] = defaults[0]! >>> 0;
      dataU[cursor++] = defaults[1]! >>> 0;
    }

    if (hasWeights) {
      const wLocal = new Float32Array(4 * m.vertexCount);
      const src = attrs.weights!;
      for (let v = 0; v < m.vertexCount; v++) {
        const g = m.vertices[v]!;
        const wo = 4 * g;
        wLocal[4 * v] = src[wo] ?? 0;
        wLocal[4 * v + 1] = src[wo + 1] ?? 0;
        wLocal[4 * v + 2] = src[wo + 2] ?? 0;
        wLocal[4 * v + 3] = src[wo + 3] ?? 0;
      }
      packVertexWeights(dataU, cursor, m.vertexCount, wLocal);
      cursor += m.vertexCount;
    } else {
      dataU[cursor++] = MESHLET_ATTR_DEFAULTS[MeshletAttrName.Weights] as number;
    }

    const ho = (i * MESHLET_HEADER_BYTES) / 4;
    metaF[ho] = m.bounds[0]!;
    metaF[ho + 1] = m.bounds[1]!;
    metaF[ho + 2] = m.bounds[2]!;
    metaF[ho + 3] = m.bounds[3]!;
    metaF[ho + 4] = m.bounds[4]!;
    metaF[ho + 5] = m.bounds[5]!;
    metaU[ho + MESHLET_HEADER_WORD_OFF.flags] = initialFlags >>> 0;
    metaU[ho + MESHLET_HEADER_WORD_OFF.vertex_count] =
      m.vertexCount >>> 0;
    metaU[ho + MESHLET_HEADER_WORD_OFF.primitive_count] =
      m.primitiveCount >>> 0;
    metaU[ho + MESHLET_HEADER_WORD_OFF.address] = address >>> 0;
  }

  stub.count = count;
  stub.metadata_buffer = meta;
  stub.data_buffer = data;
}

const DI_ATTR_ORDER = [
  "position",
  "normal",
  "tangent",
  "color",
  "uv0",
  "uv1",
  "joints",
  "weights"
] as const;

const DI_CI: Record<(typeof DI_ATTR_ORDER)[number], number> = {
  position: 3,
  normal: 1,
  tangent: 1,
  color: 1,
  uv0: 2,
  uv1: 1,
  joints: 2,
  weights: 1
};

const DI_QI: Partial<Record<(typeof DI_ATTR_ORDER)[number], number>> = {
  normal: MeshletAttrFlag.Normal,
  tangent: MeshletAttrFlag.Tangent,
  color: MeshletAttrFlag.Color,
  uv0: MeshletAttrFlag.Uv0,
  uv1: MeshletAttrFlag.Uv1,
  joints: MeshletAttrFlag.Joints,
  weights: MeshletAttrFlag.Weights
};

export function meshletAttrAllEqual(
  data: ArrayBuffer,
  wordOffset: number,
  vertexCount: number,
  wordsPerVert: number
): boolean {
  if (vertexCount <= 1) return true;
  const total = vertexCount * wordsPerVert;
  const a = new Uint32Array(data, wordOffset * 4, total);
  for (let e = wordsPerVert; e < total; e += wordsPerVert) {
    for (let t = 0; t < wordsPerVert; t++) {
      if (a[e + t] !== a[t]) return false;
    }
  }
  return true;
}

export function compressMeshlets(stub: MeshletsStub): number {
  const count = stub.count;
  if (count <= 0) return 0;
  const meta = stub.metadata_buffer;
  const data = stub.data_buffer;
  if (meta.byteLength < count * MESHLET_HEADER_BYTES) return 0;
  if (data.byteLength === 0) return 0;

  const oldLen = data.byteLength;
  const dataWords = oldLen >>> 2;
  const out = new ArrayBuffer(oldLen);
  const outU = new Uint32Array(out);
  const srcU = new Uint32Array(data);
  const metaU = new Uint32Array(meta);

  const addresses: number[] = [];
  for (let mi = 0; mi < count; mi++) {
    const ho = (mi * MESHLET_HEADER_BYTES) / 4;
    addresses.push(
      metaU[ho + MESHLET_HEADER_WORD_OFF.address]! >>> 0
    );
  }

  let outCursor = 0;

  for (let mi = 0; mi < count; mi++) {
    const ho = (mi * MESHLET_HEADER_BYTES) / 4;
    const address = addresses[mi]!;
    const prim =
      metaU[ho + MESHLET_HEADER_WORD_OFF.primitive_count]! >>> 0;
    const vc =
      metaU[ho + MESHLET_HEADER_WORD_OFF.vertex_count]! >>> 0;
    const flags =
      metaU[ho + MESHLET_HEADER_WORD_OFF.flags]! >>> 0;
    const endWord = mi + 1 < count ? addresses[mi + 1]! : dataWords;

    const newAddress = outCursor;
    const indexWords = packedIndexWordCount(prim);
    for (let w = 0; w < indexWords; w++) {
      outU[outCursor + w] = srcU[address + w] ?? 0;
    }
    outCursor += indexWords;

    let srcOff = address + indexWords;
    let newFlags = flags;

    for (let ai = 0; ai < DI_ATTR_ORDER.length; ai++) {
      const name = DI_ATTR_ORDER[ai]!;
      const ci = DI_CI[name];
      const qi = DI_QI[name];
      const remaining = endWord - srcOff;
      if (remaining <= 0) break;

      let srcWords: number;
      if (name === "position") {
        srcWords = vc * 3;
        if (remaining < srcWords) break;
      } else {
        const flagBit = qi ?? 0;
        const compressedWords = ci;
        srcWords = attrSectionWordCount(
          flags,
          flagBit,
          vc,
          remaining,
          ci,
          compressedWords
        );
        if (srcWords <= 0) break;
      }

      const canFold = qi !== undefined;
      const alreadyCompressed = canFold && (flags & qi!) !== 0;

      if (
        canFold &&
        !alreadyCompressed &&
        vc > 1 &&
        srcWords === vc * ci &&
        meshletAttrAllEqual(data, srcOff, vc, ci)
      ) {
        newFlags |= qi!;
        for (let w = 0; w < ci; w++) {
          outU[outCursor + w] = srcU[srcOff + w] ?? 0;
        }
        outCursor += ci;
      } else {
        for (let w = 0; w < srcWords; w++) {
          outU[outCursor + w] = srcU[srcOff + w] ?? 0;
        }
        outCursor += srcWords;
      }
      srcOff += srcWords;
    }

    metaU[ho + MESHLET_HEADER_WORD_OFF.address] =
      newAddress >>> 0;
    metaU[ho + MESHLET_HEADER_WORD_OFF.flags] =
      newFlags >>> 0;
  }

  const saved = oldLen - outCursor * 4;
  const trimmed = out.slice(0, outCursor * 4);
  stub.data_buffer = trimmed;
  return Math.max(0, saved);
}

export function expandMortonBits10(e: number): number {
  let t = e >>> 0;
  t = 50331903 & (t | (t << 16));
  t = 50393103 & (t | (t << 8));
  t = 51130563 & (t | (t << 4));
  t = 153391689 & (t | (t << 2));
  return t >>> 0;
}

export function mortonKeyPs(
  x: number,
  y: number,
  z: number,
  sceneBox: Float32Array
): number {
  const sx = sceneBox[0]!;
  const sy = sceneBox[1]!;
  const sz = sceneBox[2]!;
  const dx = sceneBox[3]! - sx;
  const dy = sceneBox[4]! - sy;
  const dz = sceneBox[5]! - sz;
  const nx = dx > 0 ? (x - sx) / dx : 0;
  const ny = dy > 0 ? (y - sy) / dy : 0;
  const nz = dz > 0 ? (z - sz) / dz : 0;
  const ix = Math.round(1023 * nx);
  const iy = Math.round(1023 * ny);
  const iz = Math.round(1023 * nz);
  const bx = expandMortonBits10(Math.min(1023, Math.max(0, ix)));
  const by = expandMortonBits10(Math.min(1023, Math.max(0, iy)));
  const bz = expandMortonBits10(Math.min(1023, Math.max(0, iz)));
  return (bx | (by << 1) | (bz << 2)) >>> 0;
}

export function triangleAabbZs(
  out: Float32Array,
  offset: number,
  positions: Float32Array,
  i0: number,
  i1: number,
  i2: number
): void {
  const a = 3 * i0;
  const b = 3 * i1;
  const c = 3 * i2;
  const ax = positions[a] ?? 0;
  const ay = positions[a + 1] ?? 0;
  const az = positions[a + 2] ?? 0;
  const bx = positions[b] ?? 0;
  const by = positions[b + 1] ?? 0;
  const bz = positions[b + 2] ?? 0;
  const cx = positions[c] ?? 0;
  const cy = positions[c + 1] ?? 0;
  const cz = positions[c + 2] ?? 0;
  out[offset] = Math.min(ax, bx, cx);
  out[offset + 1] = Math.min(ay, by, cy);
  out[offset + 2] = Math.min(az, bz, cz);
  out[offset + 3] = Math.max(ax, bx, cx);
  out[offset + 4] = Math.max(ay, by, cy);
  out[offset + 5] = Math.max(az, bz, cz);
}

export function buildCsBvh(
  stub: MeshletsStub,
  primitiveCount: number,
  sceneBox: Float32Array
): ArrayBuffer {
  const meshletCount = stub.count;
  if (primitiveCount <= 0 || meshletCount <= 0) return new ArrayBuffer(0);

  const bvh = new DynamicBvh();
  const nodeCount = primitiveCount + Math.max(0, primitiveCount - 1);
  bvh.release_all();
  bvh.allocate_linear(nodeCount);

  const meshletRoots = new Uint32Array(meshletCount);
  const topNodeCount = Math.max(0, meshletCount - 1);
  const lowerNodeCount = nodeCount - topNodeCount;
  const lowerNodes = new Uint32Array(lowerNodeCount);
  for (let i = 0; i < lowerNodeCount; i++) {
    lowerNodes[i] = nodeCount - 1 - i;
  }

  const keys = new Uint32Array(meshletCount);
  const order = new Uint32Array(meshletCount);
  for (let i = 0; i < meshletCount; i++) {
    const bounds = readMeshletHeader(stub.metadata_buffer, i).bounds_box;
    keys[i] = mortonKeyPs(
      0.5 * (bounds[0]! + bounds[3]!),
      0.5 * (bounds[1]! + bounds[4]!),
      0.5 * (bounds[2]! + bounds[5]!),
      sceneBox
    );
    order[i] = i;
  }
  order.sort((a, b) => keys[a]! - keys[b]!);

  const triangleBounds = new Float32Array(6);
  const level = new Uint32Array(MESHLET_MAX_TRIANGLES);
  let lowerCursor = 0;
  for (let orderedIndex = 0; orderedIndex < meshletCount; orderedIndex++) {
    const meshlet = order[orderedIndex]!;
    const core = readMeshletCore(
      stub.metadata_buffer,
      stub.data_buffer,
      meshlet
    );
    const primitiveCountInMeshlet = core.header.primitive_count;
    for (let triangle = 0; triangle < primitiveCountInMeshlet; triangle++) {
      const index = 3 * triangle;
      triangleAabbZs(
        triangleBounds,
        0,
        core.attribute_position,
        core.attribute_index[index]!,
        core.attribute_index[index + 1]!,
        core.attribute_index[index + 2]!
      );
      const leaf = lowerNodes[lowerCursor++]!;
      bvh.node_set_aabb(leaf, triangleBounds);
      bvh.node_set_user_data(
        leaf,
        encode_meshlet_element(meshlet, triangle)
      );
      bvh.node_set_child1(leaf, BVH_NULL_NODE);
      level[triangle] = leaf;
    }

    let count = primitiveCountInMeshlet;
    while (count > 1) {
      let output = 0;
      let input = 0;
      while (input + 1 < count) {
        const first = level[input++]!;
        const second = level[input++]!;
        const parent = lowerNodes[lowerCursor++]!;
        bvh.node_assign_children(parent, second, first);
        level[output++] = parent;
      }
      while (input < count) level[output++] = level[input++]!;
      count = output;
    }
    meshletRoots[orderedIndex] = level[0]!;
  }

  const topNodes = new Uint32Array(topNodeCount);
  for (let i = 0; i < topNodeCount; i++) {
    topNodes[i] = topNodeCount - 1 - i;
  }
  let topCursor = 0;
  let count = meshletCount;
  while (count > 1) {
    let output = 0;
    let input = 0;
    while (input + 1 < count) {
      const first = meshletRoots[input++]!;
      const second = meshletRoots[input++]!;
      const parent = topNodes[topCursor++]!;
      bvh.node_assign_children(parent, second, first);
      meshletRoots[output++] = parent;
    }
    while (input < count) meshletRoots[output++] = meshletRoots[input++]!;
    count = output;
  }

  const root = meshletRoots[0]!;
  bvh.node_set_parent(root, BVH_NULL_NODE);
  bvh.root = root;
  optimizeDynamicBvh(bvh, root, 7);
  bvh.trim();
  return exportDynamicBvhNodes(bvh);
}
export interface MeshletHeader {
  bounds_box: Float32Array;
  address: number;
  primitive_count: number;
  vertex_count: number;
  flags: number;
}

export function readMeshletHeader(
  metadata: ArrayBuffer,
  index: number
): MeshletHeader {
  const base = index * MESHLET_HEADER_BYTES;
  const f32 = new Float32Array(metadata, base, 6);
  const u32 = new Uint32Array(metadata, base, 10);
  return {
    bounds_box: new Float32Array(f32),
    address:
      u32[MESHLET_HEADER_WORD_OFF.address]! >>> 0,
    primitive_count:
      u32[MESHLET_HEADER_WORD_OFF.primitive_count]! >>> 0,
    vertex_count:
      u32[MESHLET_HEADER_WORD_OFF.vertex_count]! >>> 0,
    flags: u32[MESHLET_HEADER_WORD_OFF.flags]! >>> 0
  };
}

export function buildMeshletBounds(stub: MeshletsStub): void {
  const count = stub.count;
  if (count <= 0) return;
  const meta = stub.metadata_buffer;
  const data = stub.data_buffer;
  if (meta.byteLength < count * MESHLET_HEADER_BYTES) return;
  if (data.byteLength === 0) return;

  const scratch = new Float32Array(384);
  const metaF = new Float32Array(meta);
  const dataF = new Float32Array(data);
  const dataWords = data.byteLength >>> 2;

  for (let r = 0; r < count; r++) {
    const s = readMeshletHeader(meta, r);
    const a = s.vertex_count;
    if (a <= 0) continue;
    const indexBytes = alignCeil(3 * s.primitive_count, 4);
    const o = meshletAttrSectionOffset(
      MeshletAttrName.Position,
      s.flags,
      a
    );
    const posWord =
      s.address +
      (indexBytes >>> 2) +
      o;
    const posWordAlt =
      meshletAttributeSectionOffset(s.address, s.primitive_count) + o;
    const word = posWord === posWordAlt ? posWord : posWordAlt;
    const floats = 3 * a;
    if (word + floats > dataWords) continue;
    for (let i = 0; i < floats; i++) {
      scratch[i] = dataF[word + i] ?? 0;
    }
    const ho = (r * MESHLET_HEADER_BYTES) / 4;
    aabbFromPositions(metaF.subarray(ho, ho + 6), scratch, floats);
  }
}

export const build_bounds = buildMeshletBounds;

export function packedIndexByteLength(primitiveCount: number): number {
  return Math.ceil((3 * primitiveCount) / 4) * 4;
}

function attrSectionWordCount(
  flags: number,
  flagBit: number,
  vertexCount: number,
  remaining: number,
  wordsPer = 1,
  compressedWords = 1
): number {
  if ((flags & flagBit) !== 0) {
    return remaining >= compressedWords ? compressedWords : 0;
  }
  const need = vertexCount * wordsPer;
  if (remaining >= need) return need;
  return 0;
}

export function readMeshletCore(
  metadata: ArrayBuffer,
  data: ArrayBuffer,
  index: number
): {
  header: MeshletHeader;
  attribute_index: Uint32Array;
  attribute_position: Float32Array;
} {
  const header = readMeshletHeader(metadata, index);
  const n = 3 * header.primitive_count;
  const attribute_index = new Uint32Array(n);
  const dataU8 = new Uint8Array(data);
  const byteBase = header.address << 2;
  for (let i = 0; i < n; i++) {
    attribute_index[i] = dataU8[byteBase + i] ?? 0;
  }
  const o = 4 * packedIndexWordCount(header.primitive_count);
  const posByte = byteBase + o;
  const vc = header.vertex_count;
  const posWords = vc * 3;
  const attribute_position = new Float32Array(posWords);
  const dataF = new Float32Array(data);
  const posWord = posByte >>> 2;
  for (let i = 0; i < posWords; i++) {
    attribute_position[i] = dataF[posWord + i] ?? 0;
  }
  return { header, attribute_index, attribute_position };
}

export function readMeshlet(
  metadata: ArrayBuffer,
  data: ArrayBuffer,
  index: number,
  dataEndWord?: number
): {
  header: MeshletHeader;
  attribute_index: Uint32Array;
  attribute_position: Float32Array;
  attribute_normal: Float32Array | null;
  attribute_tangent: Float32Array | null;
  attribute_color: Float32Array | null;
  attribute_uv0: Float32Array | null;
  attribute_uv1: Float32Array | null;
  attribute_joints: Float32Array | null;
  attribute_weights: Float32Array | null;
} {
  const core = readMeshletCore(metadata, data, index);
  const header = core.header;
  const attribute_index = core.attribute_index;
  const attribute_position = core.attribute_position;
  const dataU32 = new Uint32Array(data);
  const dataF = new Float32Array(data);
  const attrWord = meshletAttributeSectionOffset(
    header.address,
    header.primitive_count
  );
  const vc = header.vertex_count;
  const posWords = vc * 3;

  let offset = attrWord + posWords;
  const end = dataEndWord ?? (data.byteLength >>> 2);

  let attribute_normal: Float32Array | null = null;
  {
    const remaining = end - offset;
    const words = attrSectionWordCount(
      header.flags,
      MeshletAttrFlag.Normal,
      vc,
      remaining
    );
    if (words > 0) {
      const compressed =
        words === 1 && (header.flags & MeshletAttrFlag.Normal) !== 0;
      attribute_normal = new Float32Array(3 * vc);
      for (let v = 0; v < vc; v++) {
        const local = compressed ? 0 : v;
        const packed = dataU32[offset + local] ?? 0;
        const [nx, ny, nz] = decodeVertexNormal(packed);
        attribute_normal[3 * v] = nx;
        attribute_normal[3 * v + 1] = ny;
        attribute_normal[3 * v + 2] = nz;
      }
      offset += words;
    }
  }

  let attribute_tangent: Float32Array | null = null;
  {
    const remaining = end - offset;
    const words = attrSectionWordCount(
      header.flags,
      MeshletAttrFlag.Tangent,
      vc,
      remaining
    );
    if (words > 0) {
      const compressed =
        words === 1 && (header.flags & MeshletAttrFlag.Tangent) !== 0;
      attribute_tangent = new Float32Array(4 * vc);
      for (let v = 0; v < vc; v++) {
        const local = compressed ? 0 : v;
        const packed = dataU32[offset + local] ?? 0;
        const [tx, ty, tz, tw] = decodeVertexTangent(packed);
        attribute_tangent[4 * v] = tx;
        attribute_tangent[4 * v + 1] = ty;
        attribute_tangent[4 * v + 2] = tz;
        attribute_tangent[4 * v + 3] = tw;
      }
      offset += words;
    }
  }

  let attribute_color: Float32Array | null = null;
  {
    const remaining = end - offset;
    const words = attrSectionWordCount(
      header.flags,
      MeshletAttrFlag.Color,
      vc,
      remaining
    );
    if (words > 0) {
      const compressed =
        words === 1 && (header.flags & MeshletAttrFlag.Color) !== 0;
      attribute_color = new Float32Array(3 * vc);
      for (let v = 0; v < vc; v++) {
        const local = compressed ? 0 : v;
        const packed = dataU32[offset + local] ?? 0;
        const [r, g, b] = decodeVertexColor(packed);
        attribute_color[3 * v] = r;
        attribute_color[3 * v + 1] = g;
        attribute_color[3 * v + 2] = b;
      }
      offset += words;
    }
  }

  let attribute_uv0: Float32Array | null = null;
  {
    const remaining = end - offset;
    const words = attrSectionWordCount(
      header.flags,
      MeshletAttrFlag.Uv0,
      vc,
      remaining,
      2,
      2
    );
    if (words > 0) {
      const compressed =
        words === 2 && (header.flags & MeshletAttrFlag.Uv0) !== 0;
      attribute_uv0 = new Float32Array(2 * vc);
      for (let v = 0; v < vc; v++) {
        const local = compressed ? 0 : v * 2;
        attribute_uv0[2 * v] = dataF[offset + local] ?? 0;
        attribute_uv0[2 * v + 1] = dataF[offset + local + 1] ?? 0;
      }
      offset += words;
    }
  }

  let attribute_uv1: Float32Array | null = null;
  {
    const remaining = end - offset;
    const words = attrSectionWordCount(
      header.flags,
      MeshletAttrFlag.Uv1,
      vc,
      remaining
    );
    if (words > 0) {
      const compressed =
        words === 1 && (header.flags & MeshletAttrFlag.Uv1) !== 0;
      attribute_uv1 = new Float32Array(2 * vc);
      for (let v = 0; v < vc; v++) {
        const local = compressed ? 0 : v;
        const packed = dataU32[offset + local] ?? 0;
        const [s, t] = decodeVertexUv1(packed);
        attribute_uv1[2 * v] = s;
        attribute_uv1[2 * v + 1] = t;
      }
      offset += words;
    }
  }

  let attribute_joints: Float32Array | null = null;
  {
    const remaining = end - offset;
    const words = attrSectionWordCount(
      header.flags,
      MeshletAttrFlag.Joints,
      vc,
      remaining,
      2,
      2
    );
    if (words > 0) {
      const compressed =
        words === 2 && (header.flags & MeshletAttrFlag.Joints) !== 0;
      attribute_joints = new Float32Array(4 * vc);
      for (let v = 0; v < vc; v++) {
        const local = compressed ? 0 : v * 2;
        const lo = dataU32[offset + local] ?? 0;
        const hi = dataU32[offset + local + 1] ?? 0;
        const [j0, j1, j2, j3] = decodeVertexJoints(lo, hi);
        attribute_joints[4 * v] = j0;
        attribute_joints[4 * v + 1] = j1;
        attribute_joints[4 * v + 2] = j2;
        attribute_joints[4 * v + 3] = j3;
      }
      offset += words;
    }
  }

  let attribute_weights: Float32Array | null = null;
  {
    const remaining = end - offset;
    const words = attrSectionWordCount(
      header.flags,
      MeshletAttrFlag.Weights,
      vc,
      remaining
    );
    if (words > 0) {
      const compressed =
        words === 1 && (header.flags & MeshletAttrFlag.Weights) !== 0;
      attribute_weights = new Float32Array(4 * vc);
      for (let v = 0; v < vc; v++) {
        const local = compressed ? 0 : v;
        const packed = dataU32[offset + local] ?? 0;
        const [w0, w1, w2, w3] = decodeVertexWeights(packed);
        attribute_weights[4 * v] = w0;
        attribute_weights[4 * v + 1] = w1;
        attribute_weights[4 * v + 2] = w2;
        attribute_weights[4 * v + 3] = w3;
      }
      offset += words;
    }
  }

  return {
    header,
    attribute_index,
    attribute_position,
    attribute_normal,
    attribute_tangent,
    attribute_color,
    attribute_uv0,
    attribute_uv1,
    attribute_joints,
    attribute_weights
  };
}

export function expandMeshletsToCpu(geo: MeshletGeometryBase): boolean {
  const stub = geo.meshlets;
  const count = stub.count;
  if (count <= 0 || stub.metadata_buffer.byteLength < count * MESHLET_HEADER_BYTES) {
    return false;
  }
  if (stub.data_buffer.byteLength === 0) return false;

  let totalVerts = 0;
  let totalPrims = 0;
  for (let i = 0; i < count; i++) {
    const h = readMeshletHeader(stub.metadata_buffer, i);
    totalVerts += h.vertex_count;
    totalPrims += h.primitive_count;
  }
  if (totalPrims === 0 || totalVerts === 0) return false;

  const vertexData = new Float32Array(totalVerts * 6);
  let tangentData: Float32Array | null = null;
  let colorData: Float32Array | null = null;
  let uv0Data: Float32Array | null = null;
  let uv1Data: Float32Array | null = null;
  let jointsData: Float32Array | null = null;
  let weightsData: Float32Array | null = null;
  const use32 = totalVerts > 65535;
  const indexData = use32
    ? new Uint32Array(totalPrims * 3)
    : new Uint16Array(totalPrims * 3);

  const addresses: number[] = [];
  for (let i = 0; i < count; i++) {
    addresses.push(readMeshletHeader(stub.metadata_buffer, i).address);
  }
  const dataWords = stub.data_buffer.byteLength >>> 2;

  let vBase = 0;
  let iBase = 0;
  for (let m = 0; m < count; m++) {
    const endWord = m + 1 < count ? addresses[m + 1]! : dataWords;
    const {
      header,
      attribute_index,
      attribute_position,
      attribute_normal,
      attribute_tangent,
      attribute_color,
      attribute_uv0,
      attribute_uv1,
      attribute_joints,
      attribute_weights
    } = readMeshlet(stub.metadata_buffer, stub.data_buffer, m, endWord);
    const vc = header.vertex_count;
    const pc = header.primitive_count;
    if (attribute_tangent && !tangentData) {
      tangentData = new Float32Array(totalVerts * 4);
    }
    if (attribute_color && !colorData) {
      colorData = new Float32Array(totalVerts * 3);
    }
    if (attribute_uv0 && !uv0Data) {
      uv0Data = new Float32Array(totalVerts * 2);
    }
    if (attribute_uv1 && !uv1Data) {
      uv1Data = new Float32Array(totalVerts * 2);
    }
    if (attribute_joints && !jointsData) {
      jointsData = new Float32Array(totalVerts * 4);
    }
    if (attribute_weights && !weightsData) {
      weightsData = new Float32Array(totalVerts * 4);
    }
    for (let v = 0; v < vc; v++) {
      const po = v * 3;
      const vo = (vBase + v) * 6;
      vertexData[vo] = attribute_position[po] ?? 0;
      vertexData[vo + 1] = attribute_position[po + 1] ?? 0;
      vertexData[vo + 2] = attribute_position[po + 2] ?? 0;
      if (attribute_normal) {
        vertexData[vo + 3] = attribute_normal[po] ?? 0;
        vertexData[vo + 4] = attribute_normal[po + 1] ?? 1;
        vertexData[vo + 5] = attribute_normal[po + 2] ?? 0;
      } else {
        vertexData[vo + 3] = 0;
        vertexData[vo + 4] = 1;
        vertexData[vo + 5] = 0;
      }
      if (attribute_tangent && tangentData) {
        const to = v * 4;
        const tvo = (vBase + v) * 4;
        tangentData[tvo] = attribute_tangent[to] ?? 1;
        tangentData[tvo + 1] = attribute_tangent[to + 1] ?? 0;
        tangentData[tvo + 2] = attribute_tangent[to + 2] ?? 0;
        tangentData[tvo + 3] = attribute_tangent[to + 3] ?? 1;
      }
      if (attribute_color && colorData) {
        const co = v * 3;
        const cvo = (vBase + v) * 3;
        colorData[cvo] = attribute_color[co] ?? 1;
        colorData[cvo + 1] = attribute_color[co + 1] ?? 1;
        colorData[cvo + 2] = attribute_color[co + 2] ?? 1;
      }
      if (attribute_uv0 && uv0Data) {
        const uo = v * 2;
        const uvo = (vBase + v) * 2;
        uv0Data[uvo] = attribute_uv0[uo] ?? 0;
        uv0Data[uvo + 1] = attribute_uv0[uo + 1] ?? 0;
      }
      if (attribute_uv1 && uv1Data) {
        const uo = v * 2;
        const uvo = (vBase + v) * 2;
        uv1Data[uvo] = attribute_uv1[uo] ?? 0;
        uv1Data[uvo + 1] = attribute_uv1[uo + 1] ?? 0;
      }
      if (attribute_joints && jointsData) {
        const jo = v * 4;
        const jvo = (vBase + v) * 4;
        jointsData[jvo] = attribute_joints[jo] ?? 0;
        jointsData[jvo + 1] = attribute_joints[jo + 1] ?? 0;
        jointsData[jvo + 2] = attribute_joints[jo + 2] ?? 0;
        jointsData[jvo + 3] = attribute_joints[jo + 3] ?? 0;
      }
      if (attribute_weights && weightsData) {
        const wo = v * 4;
        const wvo = (vBase + v) * 4;
        weightsData[wvo] = attribute_weights[wo] ?? 0;
        weightsData[wvo + 1] = attribute_weights[wo + 1] ?? 0;
        weightsData[wvo + 2] = attribute_weights[wo + 2] ?? 0;
        weightsData[wvo + 3] = attribute_weights[wo + 3] ?? 0;
      }
    }
    for (let t = 0; t < 3 * pc; t++) {
      indexData[iBase + t] = vBase + (attribute_index[t] ?? 0);
    }
    vBase += vc;
    iBase += 3 * pc;
  }

  geo.vertexData = vertexData;
  geo.indexData = indexData;
  geo.tangentData = tangentData;
  geo.colorData = colorData;
  geo.uv0Data = uv0Data;
  geo.uv1Data = uv1Data;
  geo.jointsData = jointsData;
  geo.weightsData = weightsData;
  if (geo.primitive_count <= 0) geo.primitive_count = totalPrims;
  return true;
}

export function rebuildBvhFromMeshlets(
  stub: MeshletsStub,
  sceneBox: Float32Array
): ArrayBuffer {
  let prims = 0;
  for (let i = 0; i < stub.count; i++) {
    prims += readMeshletHeader(stub.metadata_buffer, i).primitive_count;
  }
  return buildCsBvh(stub, prims, sceneBox);
}

export const Cs = buildCsBvh;

export function buildMeshletBatchFromGeometry(
  src: Geometry,
  target: MeshletsStub
): { positions: Float32Array; indices: Uint32Array } {
  const posAttr = src.getAttribute(MeshletAttrName.Position);
  if (posAttr === undefined || posAttr.count <= 0) {
    target.count = 0;
    target.metadata_buffer = new ArrayBuffer(0);
    target.data_buffer = new ArrayBuffer(0);
    return {
      positions: new Float32Array(0),
      indices: new Uint32Array(0)
    };
  }

  src.ensureIndex();
  src.ensureNormals();
  src.ensureTangents();

  const positions = Float32Array.from(
    posAttr.data as ArrayLike<number>
  );
  const indices = Uint32Array.from(
    src.index!.data as ArrayLike<number>
  );
  const clusters = clusterMeshlets(
    indices,
    positions,
    MESHLET_MAX_VERTICES,
    MESHLET_MAX_TRIANGLES
  );
  const nrm = src.getAttribute(MeshletAttrName.Normal);
  const tan = src.getAttribute(MeshletAttrName.Tangent);
  const col = src.getAttribute(MeshletAttrName.Color);
  const uv0 = src.getAttribute(MeshletAttrName.Uv0);
  const uv1 = src.getAttribute(MeshletAttrName.Uv1);
  const joints = src.getAttribute(MeshletAttrName.Joints);
  const weights = src.getAttribute(MeshletAttrName.Weights);
  writeMeshoptimizerMeshlets(target, clusters, positions, {
    normals: nrm
      ? Float32Array.from(nrm.data as ArrayLike<number>)
      : null,
    tangents: tan
      ? Float32Array.from(tan.data as ArrayLike<number>)
      : null,
    colors: col
      ? Float32Array.from(col.data as ArrayLike<number>)
      : null,
    uv0: uv0 ? Float32Array.from(uv0.data as ArrayLike<number>) : null,
    uv1: uv1 ? Float32Array.from(uv1.data as ArrayLike<number>) : null,
    joints: joints
      ? Float32Array.from(joints.data as ArrayLike<number>)
      : null,
    weights: weights
      ? Float32Array.from(weights.data as ArrayLike<number>)
      : null
  });
  target.build_bounds();
  target.optimize();
  return { positions, indices };
}

export function niFromGeometry(
  src: Geometry,
  out: MeshletGeometryBase = new MeshletGeoCtor()
): MeshletGeometryBase {
  src.ensureBounds();
  src.computeBoundingSphereFromBox();
  out.name = src.name;
  out.primitive_count = src.getPrimitiveCount();
  out.bounding_box.set(src.bounding_box);
  out.bounding_sphere.set(src.bounding_sphere);

  const built = buildMeshletBatchFromGeometry(src, out.meshlets);
  const positions = built.positions;
  const indices = built.indices;
  if (positions.length === 0) {
    out.bvh = new ArrayBuffer(0);
    return out;
  }

  const nrm = src.getAttribute(MeshletAttrName.Normal);
  const tan = src.getAttribute(MeshletAttrName.Tangent);
  const col = src.getAttribute(MeshletAttrName.Color);
  const uv0 = src.getAttribute(MeshletAttrName.Uv0);
  const uv1 = src.getAttribute(MeshletAttrName.Uv1);
  const joints = src.getAttribute(MeshletAttrName.Joints);
  const weights = src.getAttribute(MeshletAttrName.Weights);

  out.meshlets.compress();
  out.bvh = buildCsBvh(
    out.meshlets,
    out.primitive_count,
    out.bounding_box
  );

  const vc = positions.length / 3;
  const vertexData = new Float32Array(vc * 6);
  for (let i = 0; i < vc; i++) {
    vertexData[6 * i] = positions[3 * i]!;
    vertexData[6 * i + 1] = positions[3 * i + 1]!;
    vertexData[6 * i + 2] = positions[3 * i + 2]!;
    if (nrm) {
      vertexData[6 * i + 3] = nrm.data[3 * i]! as number;
      vertexData[6 * i + 4] = nrm.data[3 * i + 1]! as number;
      vertexData[6 * i + 5] = nrm.data[3 * i + 2]! as number;
    } else {
      vertexData[6 * i + 4] = 1;
    }
  }
  out.vertexData = vertexData;
  out.indexData = indices;
  if (tan) out.tangentData = Float32Array.from(tan.data as ArrayLike<number>);
  if (col) out.colorData = Float32Array.from(col.data as ArrayLike<number>);
  if (uv0) out.uv0Data = Float32Array.from(uv0.data as ArrayLike<number>);
  if (uv1) out.uv1Data = Float32Array.from(uv1.data as ArrayLike<number>);
  if (joints)
    out.jointsData = Float32Array.from(joints.data as ArrayLike<number>);
  if (weights)
    out.weightsData = Float32Array.from(weights.data as ArrayLike<number>);

  return out;
}

export const Ni = niFromGeometry;

export function niFinalizeFromCpu(geo: MeshletGeometryBase): MeshletGeometryBase {
  const posCount = geo.getVertexCount();
  const positions = new Float32Array(posCount * 3);
  for (let i = 0; i < posCount; i++) {
    const vo = i * 6;
    positions[i * 3] = geo.vertexData[vo] ?? 0;
    positions[i * 3 + 1] = geo.vertexData[vo + 1] ?? 0;
    positions[i * 3 + 2] = geo.vertexData[vo + 2] ?? 0;
  }

  const idx = geo.indexData;
  const indices =
    idx instanceof Uint32Array ? idx : Uint32Array.from(idx);

  if (geo.primitive_count <= 0 && indices.length >= 3) {
    geo.primitive_count = Math.floor(indices.length / 3);
  }

  ensureBoxFromPositions(geo, positions, posCount);

  const clusters = clusterMeshlets(
    indices,
    positions,
    MESHLET_MAX_VERTICES,
    MESHLET_MAX_TRIANGLES
  );

  if (clusters.length === 0 && geo.primitive_count > 0) {
  }

  const normals = new Float32Array(posCount * 3);
  for (let i = 0; i < posCount; i++) {
    const vo = i * 6;
    normals[i * 3] = geo.vertexData[vo + 3] ?? 0;
    normals[i * 3 + 1] = geo.vertexData[vo + 4] ?? 1;
    normals[i * 3 + 2] = geo.vertexData[vo + 5] ?? 0;
  }

  writeMeshoptimizerMeshlets(geo.meshlets, clusters, positions, {
    normals,
    tangents:
      geo.tangentData && geo.tangentData.length >= posCount * 4
        ? geo.tangentData
        : null,
    colors:
      geo.colorData && geo.colorData.length >= posCount * 3
        ? geo.colorData
        : null,
    uv0:
      geo.uv0Data && geo.uv0Data.length >= posCount * 2 ? geo.uv0Data : null,
    uv1:
      geo.uv1Data && geo.uv1Data.length >= posCount * 2 ? geo.uv1Data : null,
    joints:
      geo.jointsData && geo.jointsData.length >= posCount * 4
        ? geo.jointsData
        : null,
    weights:
      geo.weightsData && geo.weightsData.length >= posCount * 4
        ? geo.weightsData
        : null
  });
  geo.meshlets.compress();
  geo.meshlets.build_bounds();
  geo.bvh = buildCsBvh(geo.meshlets, geo.primitive_count, geo.bounding_box);
  return geo;
}

function ensureBoxFromPositions(
  geo: MeshletGeometryBase,
  positions: Float32Array,
  count: number
): void {
  const b = geo.bounding_box;
  const empty =
    b[0] === 0 &&
    b[1] === 0 &&
    b[2] === 0 &&
    b[3] === 0 &&
    b[4] === 0 &&
    b[5] === 0;
  if (!empty && count > 0) {
    sphereFromBox(geo.bounding_sphere, b);
    return;
  }
  if (count === 0) return;
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    const x = positions[o]!,
      y = positions[o + 1]!,
      z = positions[o + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  b.set([minX, minY, minZ, maxX, maxY, maxZ]);
  sphereFromBox(geo.bounding_sphere, b);
}

function sphereFromBox(sphere: Float32Array, box: Float32Array): void {
  const t = box[0]!,
    n = box[3]!,
    r = box[1]!,
    s = box[4]!,
    a = box[2]!,
    i = box[5]!;
  sphere[0] = 0.5 * (t + n);
  sphere[1] = 0.5 * (r + s);
  sphere[2] = 0.5 * (a + i);
  sphere[3] = Math.hypot(n - t, s - r, i - a) * 0.5;
}

/**
 * meshletPackedAttrs：负责几何数据、Meshlet 或空间结构处理。
 */

const U16_MAX = 65535;

function sign1(e: number): number {
  return e >= 0 ? 1 : -1;
}

export function octahedralEncode2(
  out: Float32Array,
  offset: number,
  n: number,
  r: number,
  s: number
): void {
  const a = 1 / (Math.abs(n) + Math.abs(r) + Math.abs(s) || 1e-20);
  let i = n * a;
  let o = s * a;
  if (r < 0) {
    const e = Math.abs(i);
    i = (1 - Math.abs(o)) * sign1(i);
    o = (1 - e) * sign1(o);
  }
  out[offset] = i;
  out[offset + 1] = o;
}

export function packVertexNormals(
  out: Uint32Array,
  outOffset: number,
  count: number,
  normals: ArrayLike<number>
): void {
  const s = new Float32Array(2);
  for (let a = 0; a < count; a++) {
    const n = 3 * a;
    octahedralEncode2(s, 0, normals[n]!, normals[n + 2]!, normals[n + 1]!);
    const i = 0.5 * s[1]! + 0.5;
    const o = Math.floor((0.5 * s[0]! + 0.5) * U16_MAX);
    const _ = Math.floor(i * U16_MAX);
    out[outOffset + a] = ((65535 & o) | ((65535 & _) << 16)) >>> 0;
  }
}

export function packVertexTangents(
  out: Uint32Array,
  outOffset: number,
  count: number,
  tangents: ArrayLike<number>
): void {
  const s = new Float32Array(2);
  for (let a = 0; a < count; a++) {
    const n = 4 * a;
    const hand = tangents[n + 3]!;
    octahedralEncode2(s, 0, tangents[n]!, tangents[n + 2]!, tangents[n + 1]!);
    const o = 0.5 * s[1]! + 0.5;
    const _ = Math.floor(32767 * (0.5 * s[0]! + 0.5));
    const c = Math.floor(o * U16_MAX);
    out[outOffset + a] =
      (((32767 & _) << 1) | ((65535 & c) << 16) | (hand >= 0 ? 1 : 0)) >>> 0;
  }
}

export function uvOctahedralUnitDecode(
  u: number,
  v: number
): [number, number, number] {
  let sx = u * 2 - 1;
  let sy = v * 2 - 1;
  let z = 1 - Math.abs(sx) - Math.abs(sy);
  const j = Math.max(-z, 0);
  sx += sx > 0 ? -j : j;
  sy += sy > 0 ? -j : j;
  const len = Math.hypot(sx, sy, z);
  if (len > 1e-20) {
    const inv = 1 / len;
    return [sx * inv, sy * inv, z * inv];
  }
  return [0, 1, 0];
}

export function decodeVertexNormal(packed: number): [number, number, number] {
  const lo = packed & 0xffff;
  const hi = (packed >>> 16) & 0xffff;
  return uvOctahedralUnitDecode(lo / 65535, hi / 65535);
}

export function decodeVertexTangent(
  packed: number
): [number, number, number, number] {
  const hand = ((packed & 1) as number) * 2 - 1;
  const ox = (packed >>> 1) & 0x7fff;
  const oy = (packed >>> 16) & 0xffff;
  const [x, y, z] = uvOctahedralUnitDecode(ox / 32767, oy / 65535);
  return [x, y, z, hand];
}

function unorm8(e: number): number {
  return Math.max(0, Math.min(255, Math.round(e * 255))) | 0;
}

export function packVertexColors(
  out: Uint32Array,
  outOffset: number,
  count: number,
  colors: ArrayLike<number>
): void {
  for (let a = 0; a < count; a++) {
    const n = 3 * a;
    const r = unorm8(colors[n]!);
    const g = unorm8(colors[n + 1]!);
    const b = unorm8(colors[n + 2]!);
    out[outOffset + a] = (r | (g << 8) | (b << 16)) >>> 0;
  }
}

export function decodeVertexColor(packed: number): [number, number, number] {
  const r = (packed & 0xff) / 255;
  const g = ((packed >>> 8) & 0xff) / 255;
  const b = ((packed >>> 16) & 0xff) / 255;
  return [r, g, b];
}

export function packVertexUv1(
  out: Uint32Array,
  outOffset: number,
  count: number,
  uvs: ArrayLike<number>
): void {
  for (let a = 0; a < count; a++) {
    const n = 2 * a;
    const s = Math.round(65535 * (uvs[n] ?? 0));
    const t = Math.round(65535 * (uvs[n + 1] ?? 0));
    out[outOffset + a] = ((65535 & s) | ((65535 & t) << 16)) >>> 0;
  }
}

export function decodeVertexUv1(packed: number): [number, number] {
  return [(packed & 0xffff) / 65535, ((packed >>> 16) & 0xffff) / 65535];
}

export function packVertexJoints(
  out: Uint32Array,
  outOffset: number,
  count: number,
  joints: ArrayLike<number>
): void {
  for (let a = 0; a < count; a++) {
    const t = 4 * a;
    const j0 = 65535 & (joints[t]! | 0);
    const j1 = 65535 & (joints[t + 1]! | 0);
    const j2 = 65535 & (joints[t + 2]! | 0);
    const j3 = 65535 & (joints[t + 3]! | 0);
    const o = outOffset + 2 * a;
    out[o] = (j0 | (j1 << 16)) >>> 0;
    out[o + 1] = (j2 | (j3 << 16)) >>> 0;
  }
}

export function decodeVertexJoints(
  lo: number,
  hi: number
): [number, number, number, number] {
  return [lo & 0xffff, (lo >>> 16) & 0xffff, hi & 0xffff, (hi >>> 16) & 0xffff];
}

export function packVertexWeights(
  out: Uint32Array,
  outOffset: number,
  count: number,
  weights: ArrayLike<number>
): void {
  for (let a = 0; a < count; a++) {
    const t = 4 * a;
    let s = Math.max(0, Math.min(255, Math.round(255 * (weights[t] ?? 0))));
    let g = Math.max(0, Math.min(255, Math.round(255 * (weights[t + 1] ?? 0))));
    let i = Math.max(0, Math.min(255, Math.round(255 * (weights[t + 2] ?? 0))));
    let o = Math.max(0, Math.min(255, Math.round(255 * (weights[t + 3] ?? 0))));
    const rem = 255 - (s + g + i + o);
    if (rem !== 0) {
      let e = 0;
      let mx = s;
      if (g > mx) {
        mx = g;
        e = 1;
      }
      if (i > mx) {
        mx = i;
        e = 2;
      }
      if (o > mx) {
        mx = o;
        e = 3;
      }
      const n = Math.max(0, Math.min(255, mx + rem));
      if (e === 0) s = n;
      else if (e === 1) g = n;
      else if (e === 2) i = n;
      else o = n;
    }
    out[outOffset + a] =
      ((255 & s) | ((255 & g) << 8) | ((255 & i) << 16) | ((255 & o) << 24)) >>>
      0;
  }
}

export function decodeVertexWeights(
  packed: number
): [number, number, number, number] {
  return [
    (packed & 0xff) / 255,
    ((packed >>> 8) & 0xff) / 255,
    ((packed >>> 16) & 0xff) / 255,
    ((packed >>> 24) & 0xff) / 255
  ];
}

export const MeshletAttrName = {
  Position: "position",
  Normal: "normal",
  Tangent: "tangent",
  Uv0: "uv0",
  Uv1: "uv1",
  Color: "color",
  Joints: "joints",
  Weights: "weights"
} as const;

export type MeshletAttrNameValue =
  (typeof MeshletAttrName)[keyof typeof MeshletAttrName];

export const MESHLET_ATTR_ORDER = Object.freeze([
  MeshletAttrName.Position,
  MeshletAttrName.Normal,
  MeshletAttrName.Tangent,
  MeshletAttrName.Color,
  MeshletAttrName.Uv0,
  MeshletAttrName.Uv1,
  MeshletAttrName.Joints,
  MeshletAttrName.Weights
] as const);

export const MESHLET_ATTR_WORDS: Record<MeshletAttrNameValue, number> = {
  [MeshletAttrName.Position]: 3,
  [MeshletAttrName.Normal]: 1,
  [MeshletAttrName.Tangent]: 1,
  [MeshletAttrName.Color]: 1,
  [MeshletAttrName.Uv0]: 2,
  [MeshletAttrName.Uv1]: 1,
  [MeshletAttrName.Joints]: 2,
  [MeshletAttrName.Weights]: 1
};

export const MeshletAttrFlag = {
  Normal: 1,
  Tangent: 2,
  Color: 4,
  Uv0: 8,
  Uv1: 16,
  Joints: 32,
  Weights: 64
} as const;

export const MESHLET_ATTR_FLAG_BIT: Partial<
  Record<MeshletAttrNameValue, number>
> = {
  [MeshletAttrName.Normal]: MeshletAttrFlag.Normal,
  [MeshletAttrName.Tangent]: MeshletAttrFlag.Tangent,
  [MeshletAttrName.Color]: MeshletAttrFlag.Color,
  [MeshletAttrName.Uv0]: MeshletAttrFlag.Uv0,
  [MeshletAttrName.Uv1]: MeshletAttrFlag.Uv1,
  [MeshletAttrName.Joints]: MeshletAttrFlag.Joints,
  [MeshletAttrName.Weights]: MeshletAttrFlag.Weights
};

export const MESHLET_ATTR_ORDER_INDEX: Record<MeshletAttrNameValue, number> =
  Object.freeze(
    Object.fromEntries(
      MESHLET_ATTR_ORDER.map((e, t) => [e, t])
    ) as Record<MeshletAttrNameValue, number>
  );

function computeDefaultNormalPacked(): number {
  const e = new Uint32Array(1);
  packVertexNormals(e, 0, 1, [0, 0, 1]);
  return e[0]!;
}
function computeDefaultTangentPacked(): number {
  const e = new Uint32Array(1);
  packVertexTangents(e, 0, 1, [0, 0, 1, 1]);
  return e[0]!;
}

export const MESHLET_ATTR_DEFAULTS: Partial<
  Record<MeshletAttrNameValue, number | number[]>
> = {
  [MeshletAttrName.Normal]: computeDefaultNormalPacked(),
  [MeshletAttrName.Tangent]: computeDefaultTangentPacked(),
  [MeshletAttrName.Color]: 0xffffffff,
  [MeshletAttrName.Uv0]: [0, 0],
  [MeshletAttrName.Uv1]: 0,
  [MeshletAttrName.Joints]: [0, 0],
  [MeshletAttrName.Weights]: 0
};

export function meshletAttrLi(
  attr: MeshletAttrNameValue,
  flags: number,
  vertexCount: number
): number {
  const r = MESHLET_ATTR_FLAG_BIT[attr];
  const n =
    r !== undefined && (flags & r) !== 0 ? 1 : vertexCount;
  return n * MESHLET_ATTR_WORDS[attr];
}

export function meshletAttrWordCount(
  attr: MeshletAttrNameValue,
  flags: number,
  vertexCount: number
): number {
  if (attr === MeshletAttrName.Position) {
    return vertexCount * MESHLET_ATTR_WORDS.position;
  }
  return meshletAttrLi(attr, flags, vertexCount);
}

export function meshletAttrSectionOffset(
  attr: MeshletAttrNameValue,
  flags: number,
  vertexCount: number
): number {
  const r = MESHLET_ATTR_ORDER_INDEX[attr];
  if (typeof r !== "number") {
    throw new Error(`Unrecognized ordered attribute '${attr}'`);
  }
  let s = 0;
  for (let e = 0; e < r; e++) {
    s += meshletAttrLi(MESHLET_ATTR_ORDER[e]!, flags, vertexCount);
  }
  return s;
}

export function packedIndexWordCount(primitiveCount: number): number {
  return (3 * primitiveCount + 3) >>> 2;
}

export function meshletAttributeSectionOffset(
  address: number,
  primitiveCount: number
): number {
  return address + packedIndexWordCount(primitiveCount);
}

export function meshletAttrAllEqualWords(
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

export const MESHLET_OPT_WORKSPACE = 128;

export function remeshMeshletVertices(
  vertices: Uint32Array | number[],
  triangles: Uint8Array | Uint32Array | number[],
  primCount: number,
  maxVerts: number
): void {
  const s = triangles;
  const a = vertices;
  const n = primCount;
  const r = maxVerts;
  const i = new Uint8Array(MESHLET_OPT_WORKSPACE);
  let o = 128;
  for (let e = 0; e < n; ++e) {
    let t = -1;
    let best = -1;
    for (let a0 = e; a0 < n; ++a0) {
      const score =
        (o - i[s[3 * a0 + 0]!]! < 3 ? 1 : 0) +
        (o - i[s[3 * a0 + 1]!]! < 3 ? 1 : 0) +
        (o - i[s[3 * a0 + 2]!]! < 3 ? 1 : 0);
      if (score > best) {
        t = a0;
        best = score;
        if (best >= 2) break;
      }
    }
    if (t < 0) t = e;
    const va = s[3 * t + 0]!;
    const vb = s[3 * t + 1]!;
    const vc = s[3 * t + 2]!;
    const d = 3 * e;
    if (t > e) {
      if (typeof (s as Uint8Array).copyWithin === "function") {
        (s as Uint8Array).copyWithin(d + 3, d, d + 3 * (t - e));
      } else {
        for (let k = 3 * (t - e) - 1; k >= 0; k--) {
          (s as number[])[d + 3 + k] = (s as number[])[d + k]!;
        }
      }
    }
    s[3 * e + 0] = va;
    s[3 * e + 1] = vb;
    s[3 * e + 2] = vc;
    o++;
    i[va] = o;
    i[vb] = o;
    i[vc] = o;
  }
  const remapTarget = new Uint32Array(MESHLET_OPT_WORKSPACE);
  const firstSeen = new Int16Array(MESHLET_OPT_WORKSPACE);
  for (let e = 0; e < r; e++) firstSeen[e] = -1;
  let d = 0;
  for (let e = 0; e < 3 * n; ++e) {
    const t = s[e]! as number;
    if (firstSeen[t]! < 0) {
      firstSeen[t] = d;
      remapTarget[d] = a[t]! as number;
      d++;
    }
    s[e] = firstSeen[t]!;
  }
  if (d > r) {
    throw new Error(`Vertex offset ${d} exceeds vertex count ${r}`);
  }
  for (let e = 0; e < d; e++) {
    a[e] = remapTarget[e]!;
  }
}

export const MESHLET_HEADER_LAYOUT = Object.freeze({
  boundsBoxFloats: 6,
  u32Fields: 4,
  bytes: 40,
  words: 10,
  addressWord: 6,
  primitiveCountWord: 7,
  vertexCountWord: 8,
  flagsWord: 9
} as const);

export function writeMeshletHeaderWords(
  metaF: Float32Array,
  metaU: Uint32Array,
  index: number,
  header: {
    bounds_box: ArrayLike<number>;
    address: number;
    primitive_count: number;
    vertex_count: number;
    flags: number;
  }
): void {
  const ho = index * MESHLET_HEADER_LAYOUT.words;
  const b = header.bounds_box;
  for (let i = 0; i < 6; i++) metaF[ho + i] = b[i] ?? 0;
  metaU[ho + MESHLET_HEADER_LAYOUT.flagsWord] = header.flags >>> 0;
  metaU[ho + MESHLET_HEADER_LAYOUT.vertexCountWord] =
    header.vertex_count >>> 0;
  metaU[ho + MESHLET_HEADER_LAYOUT.primitiveCountWord] =
    header.primitive_count >>> 0;
  metaU[ho + MESHLET_HEADER_LAYOUT.addressWord] = header.address >>> 0;
}

export function readMeshletHeaderWords(
  metadata: ArrayBuffer,
  index: number
): {
  bounds_box: Float32Array;
  address: number;
  primitive_count: number;
  vertex_count: number;
  flags: number;
} {
  const base = index * MESHLET_HEADER_LAYOUT.bytes;
  const f32 = new Float32Array(metadata, base, 6);
  const u32 = new Uint32Array(metadata, base, MESHLET_HEADER_LAYOUT.words);
  return {
    bounds_box: new Float32Array(f32),
    address: u32[MESHLET_HEADER_LAYOUT.addressWord]! >>> 0,
    primitive_count:
      u32[MESHLET_HEADER_LAYOUT.primitiveCountWord]! >>> 0,
    vertex_count: u32[MESHLET_HEADER_LAYOUT.vertexCountWord]! >>> 0,
    flags: u32[MESHLET_HEADER_LAYOUT.flagsWord]! >>> 0
  };
}

export function writeMeshletAttributePacked(
  indexReader: {
    readUint32(): number;
    position: number;
  },
  attr: {
    data: ArrayLike<number>;
    spec: { itemSize: number };
  },
  out: {
    writeFloat32(v: number): void;
    writeUint32(v: number): void;
    writeUint32Array(e: ArrayLike<number>, t?: number, n?: number): void;
    writeFloat32Array(e: ArrayLike<number>, t?: number, n?: number): void;
  },
  attrName: MeshletAttrNameValue,
  vertexCount: number
): void {
  const a = attr.data;
  const s = vertexCount;
  switch (attrName) {
    case MeshletAttrName.Position: {
      for (let t = 0; t < s; t++) {
        const idx = indexReader.readUint32();
        for (let e = 0; e < 3; e++) out.writeFloat32(a[3 * idx + e]!);
      }
      break;
    }
    case MeshletAttrName.Normal: {
      const r = new Float32Array(3 * s);
      gatherAttrLocal(r, indexReader, attr, s);
      const packed = new Uint32Array(s);
      packVertexNormals(packed, 0, s, r);
      out.writeUint32Array(packed, 0, s);
      break;
    }
    case MeshletAttrName.Tangent: {
      const r = new Float32Array(4 * s);
      gatherAttrLocal(r, indexReader, attr, s);
      const packed = new Uint32Array(s);
      packVertexTangents(packed, 0, s, r);
      out.writeUint32Array(packed, 0, s);
      break;
    }
    case MeshletAttrName.Color: {
      const r = new Float32Array(3 * s);
      gatherAttrLocal(r, indexReader, attr, s);
      const packed = new Uint32Array(s);
      packVertexColors(packed, 0, s, r);
      out.writeUint32Array(packed, 0, s);
      break;
    }
    case MeshletAttrName.Uv1: {
      const r = new Float32Array(2 * s);
      gatherAttrLocal(r, indexReader, attr, s);
      const packed = new Uint32Array(s);
      packVertexUv1(packed, 0, s, r);
      out.writeUint32Array(packed, 0, s);
      break;
    }
    case MeshletAttrName.Uv0: {
      const r = new Float32Array(2 * s);
      gatherAttrLocal(r, indexReader, attr, s);
      out.writeFloat32Array(r, 0, 2 * s);
      break;
    }
    case MeshletAttrName.Joints: {
      const r = new Uint16Array(4 * s);
      gatherAttrLocal(r, indexReader, attr, s);
      for (let e = 0; e < s; e++) {
        const t = 4 * e;
        const lo =
          (65535 & r[t + 0]!) | ((65535 & r[t + 1]!) << 16);
        const hi =
          (65535 & r[t + 2]!) | ((65535 & r[t + 3]!) << 16);
        out.writeUint32(lo >>> 0);
        out.writeUint32(hi >>> 0);
      }
      break;
    }
    case MeshletAttrName.Weights: {
      const r = new Float32Array(4 * s);
      gatherAttrLocal(r, indexReader, attr, s);
      const packed = new Uint32Array(s);
      packVertexWeights(packed, 0, s, r);
      out.writeUint32Array(packed, 0, s);
      break;
    }
    default:
      throw new Error(`Unrecognized attribute attribute '${attrName}'`);
  }
}

function gatherAttrLocal(
  e: { [i: number]: number },
  t: { readUint32(): number },
  n: { data: ArrayLike<number>; spec: { itemSize: number } },
  r: number
): void {
  const s = n.data;
  const a = n.spec.itemSize;
  for (let i = 0; i < r; i++) {
    const idx = t.readUint32();
    for (let j = 0; j < a; j++) {
      e[i * a + j] = s[idx * a + j]!;
    }
  }
}

export const ji = writeMeshletAttributePacked;

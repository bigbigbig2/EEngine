/**
 * usdFaceVarying：解析 USD 数据并转换为引擎运行时对象。
 */

export function expandFaceVaryingAttr(
  faceVertexCounts: ArrayLike<number>,
  attr: Float32Array,
  itemSize: number
): Float32Array {
  const r = faceVertexCounts.length;
  let triCount = 0;
  for (let t = 0; t < r; t++) {
    const n = faceVertexCounts[t]!;
    if (n >= 3) triCount += n - 2;
  }
  const a = new Float32Array(3 * triCount * itemSize);
  let i = 0;
  let o = 0;
  for (let s = 0; s < r; s++) {
    const face = faceVertexCounts[s]!;
    if (face < 3) {
      o += face;
      continue;
    }
    for (let e = 1; e < face - 1; e++) {
      for (let c = 0; c < itemSize; c++) a[i++] = attr[o * itemSize + c]!;
      for (let c = 0; c < itemSize; c++) a[i++] = attr[(o + e) * itemSize + c]!;
      for (let c = 0; c < itemSize; c++) a[i++] = attr[(o + e + 1) * itemSize + c]!;
    }
    o += face;
  }
  return a;
}

export function gatherIndexedAttr(
  indices: ArrayLike<number>,
  attr: Float32Array,
  itemSize: number
): Float32Array {
  const r = new Float32Array(indices.length * itemSize);
  for (let s = 0; s < indices.length; s++) {
    const a = indices[s]! * itemSize;
    for (let e = 0; e < itemSize; e++) r[s * itemSize + e] = attr[a + e]!;
  }
  return r;
}

export function gatherPrimvarIndices(
  st: Float32Array,
  indices: ArrayLike<number>
): Float32Array {
  const n = new Float32Array(2 * indices.length);
  for (let r = 0; r < indices.length; r++) {
    const s = 2 * indices[r]!;
    n[2 * r] = st[s]!;
    n[2 * r + 1] = st[s + 1]!;
  }
  return n;
}

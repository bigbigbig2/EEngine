import type { GlbByteRange, GlbCookAccessor, GlbCookAttributeSemantic, GlbCookPrimitive } from "../../../loaders/gltf/streaming/GlbSceneCatalog.js";
import {
  WEB_GEOMETRY_ATTRIBUTE_COLOR,
  WEB_GEOMETRY_ATTRIBUTE_NORMAL,
  WEB_GEOMETRY_ATTRIBUTE_POSITION,
  WEB_GEOMETRY_ATTRIBUTE_TANGENT,
  WEB_GEOMETRY_ATTRIBUTE_UV0,
  WEB_GEOMETRY_ATTRIBUTE_UV1,
  WEB_GEOMETRY_CANONICAL_VERTEX_FLOATS,
  WEB_GEOMETRY_MESHLET_BLEND,
  WEB_GEOMETRY_MESHLET_CASTS_SHADOW,
  WEB_GEOMETRY_MESHLET_MASK,
  WEB_GEOMETRY_MESHLET_OPAQUE,
  WEB_GEOMETRY_MESHLET_TWO_SIDED,
  type WebCanonicalGeometryDomainV1
} from "../wasm/WebGeometryCookerAbi.js";

export interface GlbPrimitiveRangeReader {
  readonly signal?: AbortSignal;
  readRange(range: GlbByteRange): Promise<ArrayBuffer>;
}

const ATTRIBUTE_LAYOUT: Readonly<Record<GlbCookAttributeSemantic, { readonly offset: number; readonly bit: number }>> = Object.freeze({
  POSITION: { offset: 0, bit: WEB_GEOMETRY_ATTRIBUTE_POSITION },
  NORMAL: { offset: 3, bit: WEB_GEOMETRY_ATTRIBUTE_NORMAL },
  TANGENT: { offset: 6, bit: WEB_GEOMETRY_ATTRIBUTE_TANGENT },
  TEXCOORD_0: { offset: 10, bit: WEB_GEOMETRY_ATTRIBUTE_UV0 },
  TEXCOORD_1: { offset: 12, bit: WEB_GEOMETRY_ATTRIBUTE_UV1 },
  COLOR_0: { offset: 14, bit: WEB_GEOMETRY_ATTRIBUTE_COLOR }
});

/** Converts one bounded GLB primitive shard into the browser-first WASM ABI. */
export async function canonicalizeGlbPrimitiveV1(unit: GlbCookPrimitive, reader: GlbPrimitiveRangeReader): Promise<WebCanonicalGeometryDomainV1> {
  if (unit.mode !== 4 || unit.vertexCount < 3 || unit.triangleCount < 1) throw new Error("GLB cook unit is not a non-empty triangle list");
  const vertices = new Float32Array(unit.vertexCount * WEB_GEOMETRY_CANONICAL_VERTEX_FLOATS);
  for (let vertex = 0; vertex < unit.vertexCount; vertex++) {
    const at = vertex * WEB_GEOMETRY_CANONICAL_VERTEX_FLOATS;
    vertices[at + 5] = 1;
    vertices[at + 6] = 1;
    vertices[at + 9] = 1;
    vertices.fill(1, at + 14, at + 18);
  }

  let attributeMask = 0;
  for (const semantic of ["POSITION", "NORMAL", "TANGENT", "TEXCOORD_0", "TEXCOORD_1", "COLOR_0"] as const) {
    const accessor = unit.attributes[semantic];
    if (!accessor) continue;
    requireAttributeEncoding(accessor, semantic, unit.vertexCount);
    const values = await readAccessorValues(accessor, reader);
    const layout = ATTRIBUTE_LAYOUT[semantic];
    for (let vertex = 0; vertex < accessor.count; vertex++) {
      const target = vertex * WEB_GEOMETRY_CANONICAL_VERTEX_FLOATS + layout.offset;
      for (let component = 0; component < accessor.componentCount; component++) vertices[target + component] = values[vertex * accessor.componentCount + component]!;
    }
    attributeMask |= layout.bit;
  }

  const indices = unit.indices
    ? await decodeIndices(unit.indices, unit.vertexCount, reader)
    : Uint32Array.from({ length: unit.vertexCount }, (_, index) => index);
  if (indices.length !== unit.triangleCount * 3) throw new Error("GLB cook unit triangle count disagrees with its indices");

  const alpha = unit.material.alphaMode === "OPAQUE"
    ? WEB_GEOMETRY_MESHLET_OPAQUE
    : unit.material.alphaMode === "MASK"
      ? WEB_GEOMETRY_MESHLET_MASK
      : WEB_GEOMETRY_MESHLET_BLEND;
  const meshletFlags = alpha |
    (unit.material.doubleSided ? WEB_GEOMETRY_MESHLET_TWO_SIDED : 0) |
    WEB_GEOMETRY_MESHLET_CASTS_SHADOW;
  return Object.freeze({
    materialId: unit.material.materialIndex,
    meshletFlags,
    attributeMask,
    generateNormals: (attributeMask & WEB_GEOMETRY_ATTRIBUTE_NORMAL) === 0,
    vertices,
    indices
  });
}

async function decodeIndices(accessor: GlbCookAccessor, vertexCount: number, reader: GlbPrimitiveRangeReader): Promise<Uint32Array> {
  if (accessor.componentCount !== 1 || accessor.normalized || ![5121, 5123, 5125].includes(accessor.componentType) || accessor.byteStride !== componentBytes(accessor.componentType) || accessor.count === 0 || accessor.count % 3 !== 0) throw new Error("GLB index accessor encoding is invalid");
  const values = await readAccessorValues(accessor, reader), output = new Uint32Array(accessor.count);
  for (let index = 0; index < accessor.count; index++) { const value = values[index]!; if (!Number.isInteger(value) || value < 0 || value >= vertexCount) throw new Error(`GLB index ${value} exceeds vertex count ${vertexCount}`); output[index] = value; }
  return output;
}

async function readAccessorValues(accessor: GlbCookAccessor, reader: GlbPrimitiveRangeReader): Promise<Float32Array> {
  const output = new Float32Array(accessor.count * accessor.componentCount);
  if (accessor.byteLength > 0) {
    const bytes = await readExact(reader, accessor), view = new DataView(bytes);
    for (let vertex = 0; vertex < accessor.count; vertex++) {
      const source = vertex * accessor.byteStride;
      for (let component = 0; component < accessor.componentCount; component++) output[vertex * accessor.componentCount + component] = readComponent(view, source + component * componentBytes(accessor.componentType), accessor.componentType, accessor.normalized);
    }
  }
  if (!accessor.sparse) return validateFiniteValues(output, accessor);
  const indicesBytes = await reader.readRange(accessor.sparse.indices);
  const valuesBytes = await reader.readRange(accessor.sparse.values);
  const indicesView = new DataView(indicesBytes), valuesView = new DataView(valuesBytes);
  const indexBytes = componentBytes(accessor.sparse.indices.componentType), valueBytes = componentBytes(accessor.componentType);
  const seen = new Set<number>();
  for (let sparseIndex = 0; sparseIndex < accessor.sparse.count; sparseIndex++) {
    const indexOffset = sparseIndex * indexBytes;
    const target = accessor.sparse.indices.componentType === 5121 ? indicesView.getUint8(indexOffset) : accessor.sparse.indices.componentType === 5123 ? indicesView.getUint16(indexOffset, true) : indicesView.getUint32(indexOffset, true);
    if (target >= accessor.count || seen.has(target)) throw new Error(`GLB accessor ${accessor.accessorIndex} sparse index is invalid`);
    seen.add(target);
    const valueOffset = sparseIndex * accessor.componentCount * valueBytes;
    for (let component = 0; component < accessor.componentCount; component++) output[target * accessor.componentCount + component] = readComponent(valuesView, valueOffset + component * valueBytes, accessor.componentType, accessor.normalized);
  }
  return validateFiniteValues(output, accessor);
}

function validateFiniteValues(values: Float32Array, accessor: GlbCookAccessor): Float32Array { for (const value of values) if (!Number.isFinite(value)) throw new Error(`GLB accessor ${accessor.accessorIndex} contains non-finite data`); return values; }

async function readExact(reader: GlbPrimitiveRangeReader, accessor: GlbCookAccessor): Promise<ArrayBuffer> {
  if (reader.signal?.aborted) throw reader.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  const bytes = await reader.readRange(accessor);
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== accessor.byteLength) throw new Error(`GLB accessor ${accessor.accessorIndex} range returned the wrong byte length`);
  return bytes;
}

function requireAttributeEncoding(accessor: GlbCookAccessor, semantic: GlbCookAttributeSemantic, vertexCount: number): void {
  if (accessor.count !== vertexCount || accessor.byteStride < accessor.componentCount * componentBytes(accessor.componentType)) throw new Error(`GLB ${semantic} accessor shape/stride is invalid`);
  const encodingIs = (types: readonly number[], normalized: boolean): boolean => types.includes(accessor.componentType) && accessor.normalized === normalized;
  const valid = semantic === "POSITION"
    ? accessor.componentCount === 3 && encodingIs([5126], false)
    : semantic === "NORMAL"
      ? accessor.componentCount === 3 && (encodingIs([5126], false) || encodingIs([5120, 5122], true))
      : semantic === "TANGENT"
        ? accessor.componentCount === 4 && (encodingIs([5126], false) || encodingIs([5120, 5122], true))
        : semantic === "COLOR_0"
          ? [3, 4].includes(accessor.componentCount) && (encodingIs([5126], false) || encodingIs([5121, 5123], true))
          : accessor.componentCount === 2 && (encodingIs([5126], false) || encodingIs([5121, 5123], true));
  if (!valid) throw new Error(`GLB ${semantic} accessor component encoding is invalid`);
}

function readComponent(view: DataView, at: number, type: GlbCookAccessor["componentType"], normalized: boolean): number {
  switch (type) {
    case 5120: { const value = view.getInt8(at); return normalized ? Math.max(value / 127, -1) : value; }
    case 5121: { const value = view.getUint8(at); return normalized ? value / 255 : value; }
    case 5122: { const value = view.getInt16(at, true); return normalized ? Math.max(value / 32767, -1) : value; }
    case 5123: { const value = view.getUint16(at, true); return normalized ? value / 65535 : value; }
    case 5125: return view.getUint32(at, true);
    case 5126: return view.getFloat32(at, true);
  }
}

function componentBytes(type: GlbCookAccessor["componentType"]): number { return type === 5120 || type === 5121 ? 1 : type === 5122 || type === 5123 ? 2 : 4; }

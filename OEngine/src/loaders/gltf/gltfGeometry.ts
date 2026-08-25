/**
 * gltfGeometry：解析 glTF 数据并转换为引擎运行时对象。
 */

import { deepEquals, deepHash } from "../../core/deepHashEquals.js";
import { HashMap } from "../../core/HashMap.js";
import { HashSet } from "../../core/HashSet.js";
import { Attribute, AttributeSpec } from "../../geometry/Attribute.js";
import type { MeshletGeometryBase } from "../../geometry/BoxGeometry.js";
import { Geometry } from "../../geometry/Geometry.js";
import { MeshletAttrName } from "../../geometry/meshletPackedAttrs.js";
import { niFromGeometry } from "../../geometry/niMeshlets.js";
import {
  ShadeDataType,
  ctorFromDataType,
  type ShadeDataTypeName
} from "../../texture/ShadeDataType.js";
import type {
  GltfAccessor,
  GltfBufferView,
  GltfDocument,
  GltfPrimitive
} from "./GltfLoader.js";

export interface GltfAttrCacheKey {
  attribute_accessor: number;
  name: string;
}

export interface GltfGeometryBuildContext {
  attrCache: HashMap<GltfAttrCacheKey, Attribute>;
  primJsonCache: Map<string, MeshletGeometryBase>;
  geomIntern: HashSet<MeshletGeometryBase>;
}

export function createGltfGeometryBuildContext(): GltfGeometryBuildContext {
  return {
    attrCache: new HashMap<GltfAttrCacheKey, Attribute>({
      keyHashFunction: (k) => deepHash(k),
      keyEqualityFunction: (a, b) => deepEquals(a, b)
    }),
    primJsonCache: new Map(),
    geomIntern: new HashSet<MeshletGeometryBase>()
  };
}

export const GLTF_COMPONENT = {
  BYTE: 5120,
  UNSIGNED_BYTE: 5121,
  SHORT: 5122,
  UNSIGNED_SHORT: 5123,
  UNSIGNED_INT: 5125,
  FLOAT: 5126
} as const;

export const GLTF_TRIANGLES = 4;

export function gltfTypeItemSize(type: string): number {
  switch (type) {
    case "SCALAR":
      return 1;
    case "VEC2":
      return 2;
    case "VEC3":
      return 3;
    case "VEC4":
      return 4;
    case "MAT4":
      return 16;
    default:
      return 0;
  }
}

export function gltfAttributeName(semantic: string): string {
  switch (semantic) {
    case "POSITION":
      return MeshletAttrName.Position;
    case "NORMAL":
      return MeshletAttrName.Normal;
    case "TEXCOORD_0":
      return MeshletAttrName.Uv0;
    case "TEXCOORD_1":
      return MeshletAttrName.Uv1;
    case "TANGENT":
      return MeshletAttrName.Tangent;
    case "COLOR_0":
      return MeshletAttrName.Color;
    case "JOINTS_0":
      return MeshletAttrName.Joints;
    case "WEIGHTS_0":
      return MeshletAttrName.Weights;
    default:
      return semantic;
  }
}

function componentBytes(componentType: number): number {
  switch (componentType) {
    case GLTF_COMPONENT.BYTE:
    case GLTF_COMPONENT.UNSIGNED_BYTE:
      return 1;
    case GLTF_COMPONENT.SHORT:
    case GLTF_COMPONENT.UNSIGNED_SHORT:
      return 2;
    case GLTF_COMPONENT.UNSIGNED_INT:
    case GLTF_COMPONENT.FLOAT:
      return 4;
    default:
      return 0;
  }
}

type TypedArrayCtor =
  | Int8ArrayConstructor
  | Uint8ArrayConstructor
  | Int16ArrayConstructor
  | Uint16ArrayConstructor
  | Uint32ArrayConstructor
  | Float32ArrayConstructor;

function typedArrayCtor(componentType: number): TypedArrayCtor {
  switch (componentType) {
    case GLTF_COMPONENT.BYTE:
      return Int8Array;
    case GLTF_COMPONENT.UNSIGNED_BYTE:
      return Uint8Array;
    case GLTF_COMPONENT.SHORT:
      return Int16Array;
    case GLTF_COMPONENT.UNSIGNED_SHORT:
      return Uint16Array;
    case GLTF_COMPONENT.UNSIGNED_INT:
      return Uint32Array;
    case GLTF_COMPONENT.FLOAT:
      return Float32Array;
    default:
      throw new Error(`Unsupported type ${componentType}`);
  }
}

export interface DecodedAccessor {
  name: string;
  itemSize: number;
  count: number;
  normalized: boolean;
  data: ArrayLike<number> & { length: number; BYTES_PER_ELEMENT?: number };
  typed: ArrayBufferView;
}

export function readAccessor(
  doc: GltfDocument,
  accessorIndex: number,
  name: string
): DecodedAccessor {
  const a = doc.accessors![accessorIndex]!;
  const itemSize = gltfTypeItemSize(a.type);
  const c = componentBytes(a.componentType);
  if (itemSize <= 0 || c <= 0) {
    throw new Error(
      `Unsupported accessor layout type=${a.type} componentType=${a.componentType}`
    );
  }
  const Ctor = typedArrayCtor(a.componentType);
  const elementByteSize = c * itemSize;
  let d: InstanceType<TypedArrayCtor>;

  if (a.bufferView === undefined) {
    d = new Ctor(a.count * itemSize) as InstanceType<TypedArrayCtor>;
  } else {
    const i = doc.bufferViews![a.bufferView] as GltfBufferView;
    const o = doc.buffers![i.buffer]!;
    const stride = i.byteStride ?? elementByteSize;
    if (stride < elementByteSize) {
      throw new Error(
        `Accessor byteStride ${stride} is smaller than element size ${elementByteSize}`
      );
    }
    const byteOffset = a.byteOffset! + i.byteOffset!;
    if (stride === elementByteSize && byteOffset % c === 0) {
      d = new Ctor(
        o,
        byteOffset,
        a.count * itemSize
      ) as InstanceType<TypedArrayCtor>;
    } else {
      d = new Ctor(a.count * itemSize) as InstanceType<TypedArrayCtor>;
      const source = new DataView(o);
      for (let element = 0; element < a.count; element++) {
        const sourceBase = byteOffset + element * stride;
        const targetBase = element * itemSize;
        for (let component = 0; component < itemSize; component++) {
          d[targetBase + component] = readComponent(
            source,
            sourceBase + component * c,
            a.componentType
          );
        }
      }
    }
  }

  if (a.sparse !== undefined && a.sparse.count > 0) {
    d = new Ctor(d) as InstanceType<TypedArrayCtor>;
    const sparse = a.sparse;
    const indicesView = doc.bufferViews![sparse.indices.bufferView]!;
    const valuesView = doc.bufferViews![sparse.values.bufferView]!;
    const indicesBuffer = doc.buffers![indicesView.buffer]!;
    const valuesBuffer = doc.buffers![valuesView.buffer]!;
    const indices = new DataView(indicesBuffer);
    const values = new DataView(valuesBuffer);
    const indexBytes = componentBytes(sparse.indices.componentType);
    if (
      sparse.indices.componentType !== GLTF_COMPONENT.UNSIGNED_BYTE &&
      sparse.indices.componentType !== GLTF_COMPONENT.UNSIGNED_SHORT &&
      sparse.indices.componentType !== GLTF_COMPONENT.UNSIGNED_INT
    ) {
      throw new Error(
        `Unsupported sparse index type ${sparse.indices.componentType}`
      );
    }
    const indicesBase =
      (indicesView.byteOffset ?? 0) + (sparse.indices.byteOffset ?? 0);
    const valuesBase =
      (valuesView.byteOffset ?? 0) + (sparse.values.byteOffset ?? 0);
    for (let sparseIndex = 0; sparseIndex < sparse.count; sparseIndex++) {
      const targetIndex = readComponent(
        indices,
        indicesBase + sparseIndex * indexBytes,
        sparse.indices.componentType
      );
      if (targetIndex < 0 || targetIndex >= a.count) {
        throw new Error(`Sparse accessor index ${targetIndex} is out of range`);
      }
      for (let component = 0; component < itemSize; component++) {
        d[targetIndex * itemSize + component] = readComponent(
          values,
          valuesBase + (sparseIndex * itemSize + component) * c,
          a.componentType
        );
      }
    }
  }
  return {
    name,
    itemSize,
    count: a.count,
    normalized: a.normalized === true,
    data: d as unknown as ArrayLike<number> & { length: number },
    typed: d
  };
}

function readComponent(
  view: DataView,
  byteOffset: number,
  componentType: number
): number {
  switch (componentType) {
    case GLTF_COMPONENT.BYTE:
      return view.getInt8(byteOffset);
    case GLTF_COMPONENT.UNSIGNED_BYTE:
      return view.getUint8(byteOffset);
    case GLTF_COMPONENT.SHORT:
      return view.getInt16(byteOffset, true);
    case GLTF_COMPONENT.UNSIGNED_SHORT:
      return view.getUint16(byteOffset, true);
    case GLTF_COMPONENT.UNSIGNED_INT:
      return view.getUint32(byteOffset, true);
    case GLTF_COMPONENT.FLOAT:
      return view.getFloat32(byteOffset, true);
    default:
      throw new Error(`Unsupported type ${componentType}`);
  }
}

export function accessorToAttribute(
  doc: GltfDocument,
  accessorIndex: number,
  name: string,
  ctx?: GltfGeometryBuildContext
): Attribute {
  if (ctx) {
    const key: GltfAttrCacheKey = {
      attribute_accessor: accessorIndex,
      name
    };
    const hit = ctx.attrCache.get(key);
    if (hit !== undefined) return hit;
    const built = accessorToAttributeUncached(doc, accessorIndex, name);
    ctx.attrCache.set(key, built);
    return built;
  }
  return accessorToAttributeUncached(doc, accessorIndex, name);
}

function accessorToAttributeUncached(
  doc: GltfDocument,
  accessorIndex: number,
  name: string
): Attribute {
  const a = doc.accessors![accessorIndex] as GltfAccessor;
  const dec = readAccessor(doc, accessorIndex, name);
  const typed = dec.typed as unknown as ArrayLike<number> & {
    length: number;
    constructor: unknown;
  };
  const attr = Attribute.from(typed, dec.itemSize, name);
  if (a.normalized === true) attr.spec.normalized = true;
  return normalizeGltfAttribute(attr);
}

export const GLTF_ATTR_TARGET_SPEC: Record<
  string,
  { type: ShadeDataTypeName; itemSize: number; normalized: boolean }
> = {
  [MeshletAttrName.Position]: {
    type: ShadeDataType.Float32,
    itemSize: 3,
    normalized: false
  },
  [MeshletAttrName.Color]: {
    type: ShadeDataType.Float32,
    itemSize: 3,
    normalized: false
  }
};

type AttrConverter = (
  e: { [i: number]: number },
  t: number,
  n: ArrayLike<number>,
  r: number,
  s: number
) => void;

const GLTF_ATTR_CONVERTERS: Array<[AttributeSpec, AttributeSpec, AttrConverter]> = [
  [
    AttributeSpec.from(ShadeDataType.Uint16, 4, true),
    AttributeSpec.from(ShadeDataType.Float32, 3, false),
    (e, t, n, r, s) => {
      for (let a = 0; a < s; a++) {
        const sOff = r + 4 * a;
        const i = t + 3 * a;
        const o = n[sOff + 1]!;
        const _ = n[sOff + 2]!;
        e[i] = n[sOff]! / 65535;
        e[i + 1] = o / 65535;
        e[i + 2] = _ / 65535;
      }
    }
  ],
  [
    AttributeSpec.from(ShadeDataType.Uint8, 4, true),
    AttributeSpec.from(ShadeDataType.Float32, 3, false),
    (e, t, n, r, s) => {
      for (let a = 0; a < s; a++) {
        const sOff = r + 4 * a;
        const i = t + 3 * a;
        const o = n[sOff + 1]!;
        const _ = n[sOff + 2]!;
        e[i] = n[sOff]! / 255;
        e[i + 1] = o / 255;
        e[i + 2] = _ / 255;
      }
    }
  ],
  [
    AttributeSpec.from(ShadeDataType.Float32, 4, false),
    AttributeSpec.from(ShadeDataType.Float32, 3, false),
    (e, t, n, r, s) => {
      for (let a = 0; a < s; a++) {
        const sOff = r + 4 * a;
        const i = t + 3 * a;
        e[i] = n[sOff]!;
        e[i + 1] = n[sOff + 1]!;
        e[i + 2] = n[sOff + 2]!;
      }
    }
  ]
];

function convertAttributeToTarget(
  e: Attribute,
  targetType: ShadeDataTypeName,
  targetItemSize: number,
  targetNormalized: boolean
): Attribute {
  const s = e.spec;
  if (
    s.type === targetType &&
    s.itemSize === targetItemSize &&
    s.normalized === targetNormalized
  ) {
    return e;
  }
  for (let a = 0; a < GLTF_ATTR_CONVERTERS.length; a++) {
    const [i, o, convert] = GLTF_ATTR_CONVERTERS[a]!;
    if (
      i.type !== s.type ||
      i.itemSize !== s.itemSize ||
      i.normalized !== s.normalized
    ) {
      continue;
    }
    if (
      o.type !== targetType ||
      o.itemSize !== targetItemSize ||
      o.normalized !== targetNormalized
    ) {
      continue;
    }
    const Ctor = ctorFromDataType(o.type);
    const c = new Ctor(o.itemSize * e.count) as unknown as {
      [i: number]: number;
      length: number;
    };
    convert(c, 0, e.data as ArrayLike<number>, 0, e.count);
    const d = new Attribute();
    d.spec = o.clone();
    d.spec.name = e.spec.name;
    d.data = c as Attribute["data"];
    d.count = e.count;
    return d;
  }
  throw new Error(
    `No converter found for ${s} -> ${JSON.stringify({
      target_type: targetType,
      target_count: targetItemSize,
      target_normalized: targetNormalized
    })}`
  );
}

export function normalizeGltfAttribute(e: Attribute): Attribute {
  const t = GLTF_ATTR_TARGET_SPEC[e.spec.name];
  if (t === undefined) return e;
  return convertAttributeToTarget(e, t.type, t.itemSize, t.normalized);
}

function primitiveToGeometryUncached(
  doc: GltfDocument,
  primitive: GltfPrimitive,
  name: string,
  ctx?: GltfGeometryBuildContext
): MeshletGeometryBase {
  if ((primitive.mode ?? GLTF_TRIANGLES) !== GLTF_TRIANGLES) {
    throw new Error("Unsupported draw method");
  }

  const n = new Geometry();
  const attrs = primitive.attributes;
  const accessors = doc.accessors!;

  for (const semantic in attrs) {
    const mapped = gltfAttributeName(semantic);
    if (n.getAttribute(mapped) !== undefined) {
      console.warn(
        `attribute '${mapped}' already exists, skipping. Primitive.attributes = ${JSON.stringify(attrs)}`
      );
    }
    const accIdx = attrs[semantic]!;
    let attr: Attribute;
    try {
      attr = accessorToAttribute(doc, accIdx, mapped, ctx);
    } catch (err) {
      console.warn(`Failed to parse attribute '${mapped}'. Skipping`, err);
      continue;
    }
    n.addAttribute(attr);
    if (semantic === "POSITION") {
      const acc = accessors[accIdx] as GltfAccessor;
      if (acc.min !== undefined && acc.max !== undefined) {
        n.bounding_box.set([...acc.min, ...acc.max]);
        n.clearFlag(1);
      }
    }
  }

  if (primitive.indices !== undefined) {
    n.index = accessorToAttribute(doc, primitive.indices, "index", ctx);
  }

  if (name) n.name = name;

  return niFromGeometry(n);
}

export function primitiveToGeometry(
  doc: GltfDocument,
  primitive: GltfPrimitive,
  name = "",
  ctx?: GltfGeometryBuildContext
): MeshletGeometryBase {
  if (!ctx) {
    return primitiveToGeometryUncached(doc, primitive, name);
  }
  const jsonKey = JSON.stringify(primitive);
  let r = ctx.primJsonCache.get(jsonKey);
  if (r === undefined) {
    r = primitiveToGeometryUncached(doc, primitive, name, ctx);
    const s = ctx.geomIntern.get(r);
    if (s !== undefined) r = s;
    else ctx.geomIntern.add(r);
    ctx.primJsonCache.set(jsonKey, r);
  }
  return r;
}

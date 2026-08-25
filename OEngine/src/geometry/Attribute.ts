/**
 * Attribute：负责几何数据、Meshlet 或空间结构处理。
 */

import { arrayShallowEquals } from "../core/arrayUtils.js";
import { hashFloat, hashMix } from "../core/hashMix.js";
import { bufferCopyStride, hashString } from "../core/memoryUtils.js";
import { fmin } from "../core/math/mathUtils.js";
import {
  DATA_TYPE_BYTE_SIZE,
  enumKeyOf
} from "../core/TableSpec.js";
import {
  ShadeDataType,
  type ShadeDataTypeName,
  inferDataTypeFromArray,
  ctorFromDataType
} from "../texture/ShadeDataType.js";
import type { BinaryReader } from "../loaders/BinaryReader.js";

export class AttributeSpec {
  name = "";
  type: ShadeDataTypeName = ShadeDataType.Float32;
  itemSize = 1;
  normalized = false;

  static from(
    type: ShadeDataTypeName | string,
    itemSize: number,
    normalized = false,
    name = ""
  ): AttributeSpec {
    const s = new AttributeSpec();
    s.fromJSON({ name, type: type as ShadeDataTypeName, itemSize, normalized });
    return s;
  }

  static fromJSON(e: {
    name?: string;
    type: string;
    itemSize: number;
    normalized?: boolean;
  }): AttributeSpec {
    const t = new AttributeSpec();
    t.fromJSON(e);
    return t;
  }

  fromJSON({
    name: e = "",
    type: t,
    itemSize: n,
    normalized: r = false
  }: {
    name?: string;
    type: string;
    itemSize: number;
    normalized?: boolean;
  }): void {
    this.name = e;
    this.type = t as ShadeDataTypeName;
    this.itemSize = n;
    this.normalized = r;
  }

  toJSON(): {
    name: string;
    type: string;
    itemSize: number;
    normalized: boolean;
  } {
    return {
      name: this.name,
      type: this.type,
      itemSize: this.itemSize,
      normalized: this.normalized
    };
  }

  toString(): string {
    let e = "";
    if (this.name !== "") e += `${this.name}:`;
    e += `${this.itemSize}x${enumKeyOf(ShadeDataType as unknown as Record<string, unknown>, this.type) ?? this.type}`;
    if (this.normalized) e += "-norm";
    return e;
  }

  hash(): number {
    return hashString(this.name);
  }

  equals(e: AttributeSpec): boolean {
    return (
      this.type === e.type &&
      this.itemSize === e.itemSize &&
      this.normalized === e.normalized &&
      this.name === e.name
    );
  }

  copy(e: AttributeSpec): void {
    this.type = e.type;
    this.name = e.name;
    this.itemSize = e.itemSize;
    this.normalized = e.normalized;
  }

  clone(): AttributeSpec {
    const e = new AttributeSpec();
    e.copy(this);
    return e;
  }

  getByteSize(): number {
    const b = DATA_TYPE_BYTE_SIZE[this.type];
    if (b === undefined) {
      throw new Error(`Unsupported data type '${this.type}'`);
    }
    return this.itemSize * b;
  }

  static byName(e: AttributeSpec, t: AttributeSpec): number {
    return e.name.localeCompare(t.name);
  }
}

(AttributeSpec.prototype as { isAttributeSpec?: boolean }).isAttributeSpec = true;

export function typedArrayEquals(
  t: ArrayLike<number> & {
    length: number;
    constructor: unknown;
    byteLength?: number;
    buffer?: ArrayBuffer;
    byteOffset?: number;
  },
  n: ArrayLike<number> & {
    length: number;
    constructor: unknown;
    byteLength?: number;
    buffer?: ArrayBuffer;
    byteOffset?: number;
  }
): boolean {
  if (t === n) return true;
  const r = t.length;
  if (r !== n.length) return false;
  const s = t.constructor;
  if (s !== n.constructor) return false;
  if (r === 0) return true;
  if (r < 128) return arrayShallowEquals(t, n);

  const a = t.byteLength ?? 0;
  if (a !== (n.byteLength ?? 0)) return false;
  const i = t.buffer;
  const o = n.buffer;
  const _ = t.byteOffset ?? 0;
  const c = n.byteOffset ?? 0;
  if (i != null && o != null && i === o && _ === c) return true;

  let d: ArrayLike<number> = t;
  let u: ArrayLike<number> = n;
  const bpe =
    (s as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
  const f = bufferCopyStride(_, c, a);
  if (i != null && o != null) {
    if (bpe < 4 && f === 4) {
      d = new Uint32Array(i, _, a >>> 2);
      u = new Uint32Array(o, c, a >>> 2);
    } else if (bpe < 2 && f === 2) {
      d = new Uint16Array(i, _, a >>> 1);
      u = new Uint16Array(o, c, a >>> 1);
    }
  }
  return arrayShallowEquals(d, u);
}

export class Attribute {
  spec = new AttributeSpec();
  data: ArrayLike<number> & {
    length: number;
    constructor: unknown;
    byteLength?: number;
    buffer?: ArrayBuffer;
    byteOffset?: number;
  } = new Float32Array(0);
  count = 0;
  private __version = 0;

  get version(): number {
    return this.__version;
  }

  set needsUpdate(e: boolean) {
    if (e) this.__version++;
  }

  get name(): string {
    return this.spec.name;
  }

  get itemSize(): number {
    return this.spec.itemSize;
  }

  equals(e: Attribute): boolean {
    return (
      this.spec.equals(e.spec) &&
      this.count === e.count &&
      typedArrayEquals(this.data, e.data)
    );
  }

  hash(): number {
    const data = this.data;
    const sampleLen = fmin(data.length, 1024);
    const stride = Math.max(1, Math.ceil(sampleLen / 31));
    let a = sampleLen;
    for (let t = 0; t < sampleLen; t += stride) {
      a = (a << 5) - a + hashFloat(data[t]!);
    }
    const sampled = a >>> 0;
    return hashMix(this.spec.hash(), this.count, sampled);
  }

  copy(e: Attribute): void {
    this.spec.copy(e.spec);
    this.count = e.count;
    const Ctor = e.data.constructor as new (
      src: ArrayLike<number>
    ) => typeof e.data;
    this.data = new Ctor(e.data as ArrayLike<number>);
  }

  clone(): Attribute {
    const e = new Attribute();
    e.copy(this);
    return e;
  }

  static from(
    e: ArrayLike<number> & { length: number; constructor: unknown },
    t = 1,
    n = ""
  ): Attribute {
    const r = inferDataTypeFromArray(e as unknown as ArrayBufferView);
    const s = new Attribute();
    s.spec.type = r as ShadeDataTypeName;
    s.spec.name = n;
    s.spec.itemSize = t;
    s.count = e.length / t;
    s.data = e as Attribute["data"];
    return s;
  }

  get memory_usage_bytes(): number {
    if (this.data != null && typeof this.data.byteLength === "number") {
      return this.data.byteLength;
    }
    return 0;
  }
}

(Attribute.prototype as { isAttribute?: boolean }).isAttribute = true;

export function gatherAttributeByIndices(
  e: { [i: number]: number },
  t: BinaryReader,
  n: Attribute,
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

export { inferDataTypeFromArray as dataTypeFromArray, ctorFromDataType };

export const Ji = AttributeSpec;
export const Ki = Attribute;
export const Xi = typedArrayEquals;
export const Mi = gatherAttributeByIndices;
export const Yi = inferDataTypeFromArray;
export const Zi = ctorFromDataType;

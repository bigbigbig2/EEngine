/**
 * WgslStruct：提供渲染器共享的基础数据结构与通用工具。
 */

import { alignCeil, hashString } from "./memoryUtils.js";
import { hashMix } from "./hashMix.js";
import { arrayShallowEquals } from "./arrayUtils.js";
import { arrayDeepEquals } from "./math/mathUtils.js";
import { BitSet } from "./BitSet.js";
import { LineBuilder } from "./LineBuilder.js";
import {
  WebGPUType,
  ArrayType,
  CodeChunk,
  PRIMITIVE_BY_TAG
} from "./WebGPUTypes.js";

export const STRUCT_PACK_ALIGN = 16;

const ARRAY_TYPE_RE =
  /array\s*<\s*(?<type>[^,]+)\s*(?:,\s*(?<count>[0-9]+))?\s*>/;

export function parseWgslType(e: string): WebGPUType {
  const t = e.match(ARRAY_TYPE_RE);
  if (t !== null) {
    const g = t.groups!;
    const n = g.type!.trim();
    const r = g.count === undefined ? -1 : parseInt(g.count, 10);
    const s = parseWgslType(n);
    return ArrayType.from(s, r);
  }
  const n = PRIMITIVE_BY_TAG[e];
  if (n === undefined) throw new Error(`Unsupported type '${e}'`);
  return n;
}

export function findAlignedClearRange(
  e: BitSet,
  t: number,
  n: number,
  r: number
): number {
  let s = alignCeil(r, t);
  for (;;) {
    s = alignCeil(e.nextClearBit(s), t);
    const end = s + n;
    let a = -1;
    for (let i = s; i < end; i++) {
      if (e.get(i)) {
        a = i;
        break;
      }
    }
    if (a === -1) return s;
    s = alignCeil(a + 1, t);
  }
}

export class WgslAttribute {
  name = "";
  parameters: unknown[] = [];

  getParameterInteger(e: number): number {
    return parseInt(String(this.parameters[e]), 10);
  }

  static from(e: string, ...t: unknown[]): WgslAttribute {
    const n = new WgslAttribute();
    n.name = e;
    n.parameters = t;
    return n;
  }

  equals(t: WgslAttribute): boolean {
    return this.name === t.name && arrayShallowEquals(this.parameters, t.parameters);
  }

  hash(): number {
    return hashString(this.name) ^ this.parameters.length;
  }

  generate(): string {
    let e = `@${this.name}`;
    const t = this.parameters;
    const n = t.length;
    if (n > 0) {
      e += "(";
      for (let r = 0; r < n; r++) {
        e += String(t[r]);
        if (r !== n - 1) e += ", ";
      }
      e += ")";
    }
    return e;
  }
}

export const ATTR_ALIGN = "align";

export class WgslStructField {
  attributes: WgslAttribute[] = [];
  offset = 0;
  type!: WebGPUType;
  name!: string;

  setAttribute(e: string, ...t: unknown[]): void {
    const n = WgslAttribute.from(e, ...t);
    this.attributes.push(n);
  }

  getAttribute(e: string): WgslAttribute | undefined {
    const t = this.attributes;
    const n = t.length;
    for (let r = 0; r < n; r++) {
      const n0 = t[r]!;
      if (n0.name === e) return n0;
    }
    return undefined;
  }

  get size(): number {
    const e = this.getAttribute("size");
    let t = this.type.size;
    if (e !== undefined) t = e.getParameterInteger(0);
    return t;
  }

  get align(): number {
    const e = this.getAttribute(ATTR_ALIGN);
    let t = this.type.align;
    if (e !== undefined) t = e.getParameterInteger(0);
    return t;
  }

  static from(e: string, t: WebGPUType, ...n: WgslAttribute[]): WgslStructField {
    const r = new WgslStructField();
    r.name = e;
    r.type = t;
    r.attributes = n;
    return r;
  }

  equals(e: WgslStructField): boolean {
    return (
      this.name === e.name &&
      this.offset === e.offset &&
      this.type.equals(e.type) &&
      arrayDeepEquals(this.attributes, e.attributes)
    );
  }

  copy(e: WgslStructField): this {
    this.name = e.name;
    this.offset = e.offset;
    this.type = e.type;
    this.attributes = e.attributes.slice();
    return this;
  }

  clone(): WgslStructField {
    const e = new WgslStructField();
    e.copy(this);
    return e;
  }

  hash(): number {
    return hashMix(hashString(this.name), this.offset, this.type.hash());
  }

  generate(): string {
    let e = "";
    const t = this.attributes;
    const n = t.length;
    for (let r = 0; r < n; r++) e += t[r]!.generate() + " ";
    return `${e}${this.name} : ${this.type.wgsl_ref}`;
  }
}

(WgslStructField.prototype as { isWGSLStructField?: boolean }).isWGSLStructField =
  true;

let structNameSeq = 0;

export function nextStructName(): string {
  return "Struct_" + structNameSeq++;
}

export function resetStructNameSeq(n = 0): void {
  structNameSeq = n;
}

export class StructType extends WebGPUType {
  #ee = "";
  fields: WgslStructField[] = [];
  #_e = false;
  #W = 0;
  #Z = 0;
  #ae: CodeChunk | undefined;

  override get tag(): string {
    return this.#ee;
  }
  override set tag(e: string) {
    this.#ee = e;
  }

  override get size(): number {
    return this.#W;
  }
  override get align(): number {
    return this.#Z;
  }

  copy(e: StructType): this {
    this.#ee = e.#ee;
    this.#W = e.#W;
    this.#Z = e.#Z;
    this.fields = e.fields.map((f) => f.clone());
    return this;
  }

  clone(): StructType {
    const e = new StructType();
    e.copy(this);
    e.#ee = nextStructName();
    return e;
  }

  make(e: Record<string, unknown>): string {
    const t = new LineBuilder();
    t.add(`${this.wgsl_ref}(`);
    t.indent();
    const n = this.fields;
    const r = n.length;
    for (let s = 0; s < r; s++) {
      const name = n[s]!.name;
      const a = e[name];
      if (a === undefined) throw new Error(`Missing field '${name}'`);
      t.add(`${a},`);
    }
    t.dedent();
    t.add(")");
    return t.build();
  }

  pack(): this {
    if (this.fields.length <= 1) return this;
    const e: WgslStructField[] = [];
    const t: WgslStructField[] = [];
    for (const n of this.fields) {
      if (n.type.runtime_sized) t.push(n);
      else e.push(n);
    }
    const n = ((fields: WgslStructField[]) => {
      const t0 = fields.length;
      const order = new Uint32Array(t0);
      for (let i = 0; i < t0; i++) order[i] = i;
      order.sort((a, b) => {
        const r = (STRUCT_PACK_ALIGN - (fields[a]!.size % STRUCT_PACK_ALIGN)) % STRUCT_PACK_ALIGN;
        const s = (STRUCT_PACK_ALIGN - (fields[b]!.size % STRUCT_PACK_ALIGN)) % STRUCT_PACK_ALIGN;
        return r !== s ? r - s : a - b;
      });
      let r = 0;
      for (let i = 0; i < t0; i++) {
        const f = fields[i]!;
        r += alignCeil(f.size, f.align);
      }
      const s = BitSet.fixedSize(r);
      let a = 0;
      const offsets = new Uint32Array(t0);
      for (let i = 0; i < t0; i++) {
        const idx = order[i]!;
        const o = fields[idx]!;
        const _ = findAlignedClearRange(s, o.align, o.size, a);
        offsets[idx] = _;
        s.setRange(_, _ + o.size - 1);
        if (_ === a) a = s.nextClearBit(a + o.size);
      }
      const o = new Uint32Array(t0);
      for (let i = 0; i < t0; i++) o[i] = i;
      o.sort((x, y) => offsets[x]! - offsets[y]!);
      const out = new Array<WgslStructField>(t0);
      for (let i = 0; i < t0; i++) out[i] = fields[o[i]!]!;
      return out;
    })(e);
    this.fields = n.concat(t);
    if (this.#_e) {
      this.#ce();
    }
    return this;
  }

  override equals(e: unknown): boolean {
    return (
      e === this ||
      (e instanceof StructType &&
        this.#ee === e.#ee &&
        arrayDeepEquals(this.fields, e.fields))
    );
  }

  override hash(): number {
    return hashMix(
      hashString((this as { name?: string }).name as string),
      this.#W,
      this.#Z,
      this.fields.length
    );
  }

  override get requires_declaration(): boolean {
    return true;
  }

  override get runtime_sized(): boolean {
    const e = this.fields;
    for (let t = 0; t < e.length; t++) {
      if (e[t]!.type.runtime_sized) return true;
    }
    return false;
  }

  static from(
    e: Record<string, string | WebGPUType>,
    t: string = nextStructName()
  ): StructType {
    const n = new StructType();
    n.#ee = t;
    for (const key in e) {
      const r = e[key]!;
      let s: WebGPUType;
      if (typeof r === "string") s = parseWgslType(r);
      else {
        if ((r as { isWebGPUType?: boolean }).isWebGPUType !== true) {
          throw new Error(`Unsupported type declarator '${String(r)}'`);
        }
        s = r;
      }
      n.#de(WgslStructField.from(key, s));
    }
    n.#ce();
    return n;
  }

  static fromFields(...e: WgslStructField[]): StructType {
    const t = new StructType();
    t.#ee = nextStructName();
    for (const n of e) t.#de(n);
    t.#ce();
    return t;
  }

  has(e: string): boolean {
    return this.fields.some((t) => t.name === e);
  }

  get(e: string): WgslStructField {
    const t = this.fields.find((f) => f.name === e);
    if (t === undefined) throw new Error(`Field '${e}' not found`);
    return t;
  }

  #de(e: WgslStructField): void {
    this.fields.push(e);
  }

  #ce(): void {
    const e = this.fields;
    const t = e.length;
    let n = 1;
    let r = 0;
    for (let s = 0; s < t; s++) {
      const f = e[s]!;
      const a = alignCeil(r, f.align);
      if (n < f.align) n = f.align;
      f.offset = a;
      r = f.offset + f.size;
    }
    this.#Z = n;
    this.#W = alignCeil(r, n);
    this.#ae = undefined;
    this.#_e = true;
  }

  override get wgsl_ref(): string {
    return this.#ee;
  }

  override get wgsl_declaration(): string {
    const e = new LineBuilder();
    e.add(`struct ${this.#ee}{`);
    e.indent();
    for (let t = 0; t < this.fields.length; t++) {
      e.add(`${this.fields[t]!.generate()},`);
    }
    e.dedent();
    e.add("}");
    return e.build();
  }

  override get declaration_chunk(): CodeChunk {
    if (this.#ae === undefined) {
      const e = CodeChunk.from(this.wgsl_declaration);
      const t = this.fields;
      const n = t.length;
      for (let r = 0; r < n; r++) {
        const ty = t[r]!.type;
        if (ty.requires_declaration) e.addDependency(ty.declaration_chunk);
      }
      this.#ae = e;
    }
    return this.#ae;
  }
}

(StructType.prototype as { isStruct?: boolean }).isStruct = true;

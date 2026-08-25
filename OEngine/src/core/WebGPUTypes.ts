/**
 * WebGPU 类型系统：描述 WGSL 类型的大小、对齐、声明方式和缓冲区布局。
 */

import { alignCeil, hashString } from "./memoryUtils.js";
import { hashMix } from "./hashMix.js";
import { arrayDeepEquals } from "./math/mathUtils.js";

export function pushUnique<T>(e: T[], t: T): boolean {
  if (e.indexOf(t) === -1) {
    e.push(t);
    return true;
  }
  return false;
}

export const WGSL_EXT_SUBGROUPS = "subgroups";
export const WGSL_EXT_TEXTURE_FORMATS_TIER1 = "texture-formats-tier1";

export class WebGPUType {
  get tag(): string {
    return "";
  }
  get align(): number {
    return 0;
  }
  get size(): number {
    return 0;
  }
  get aligned_size(): number {
    return alignCeil(this.size, this.align);
  }
  get runtime_sized(): boolean {
    return false;
  }
  get requires_declaration(): boolean {
    return false;
  }
  toString(): string {
    return this.wgsl_declaration;
  }
  get declaration_chunk(): CodeChunk {
    throw new Error("Not Implemented");
  }
  get wgsl_ref(): string {
    return this.wgsl_declaration;
  }
  get wgsl_declaration(): string {
    return this.tag;
  }
  equals(_e: unknown): boolean {
    return false;
  }
  hash(): number {
    return 0;
  }
}

(WebGPUType.prototype as { isWebGPUType?: boolean }).isWebGPUType = true;

export class PrimitiveType extends WebGPUType {
  #W = 0;
  #Z = 0;
  #ee = "";

  override get tag(): string {
    return this.#ee;
  }
  override get size(): number {
    return this.#W;
  }
  override get align(): number {
    return this.#Z;
  }

  from(e: string, t: number, n: number): void {
    this.#ee = e;
    this.#W = n;
    this.#Z = t;
  }

  static from(e: string, t: number, n: number): PrimitiveType {
    const r = new PrimitiveType();
    r.from(e, t, n);
    return Object.freeze(r) as PrimitiveType;
  }

  override get wgsl_declaration(): string {
    return this.tag;
  }

  override hash(): number {
    return hashString(this.tag);
  }

  override equals(e: unknown): boolean {
    return (
      this === e ||
      (e instanceof PrimitiveType &&
        this.tag === e.tag &&
        this.#W === e.size &&
        this.#Z === e.align)
    );
  }
}

(PrimitiveType.prototype as { isPrimitive?: boolean }).isPrimitive = true;

export class AtomicType extends PrimitiveType {
  static override from(e: string, t: number, n: number): AtomicType {
    const r = new AtomicType();
    r.from(e, t, n);
    return Object.freeze(r) as AtomicType;
  }
}

(AtomicType.prototype as { isAtomic?: boolean }).isAtomic = true;

export const WGSL_bool = PrimitiveType.from("bool", 4, 4);
export const WGSL_i32 = PrimitiveType.from("i32", 4, 4);
export const WGSL_u32 = PrimitiveType.from("u32", 4, 4);
export const WGSL_f32 = PrimitiveType.from("f32", 4, 4);
export const WGSL_f16 = PrimitiveType.from("f16", 2, 2);
export const WGSL_vec2i = PrimitiveType.from("vec2<i32>", 8, 8);
export const WGSL_vec2u = PrimitiveType.from("vec2<u32>", 8, 8);
export const WGSL_vec2f = PrimitiveType.from("vec2<f32>", 8, 8);
export const WGSL_vec3i = PrimitiveType.from("vec3<i32>", 16, 12);
export const WGSL_vec3u = PrimitiveType.from("vec3<u32>", 16, 12);
export const WGSL_vec3f = PrimitiveType.from("vec3<f32>", 16, 12);
export const WGSL_vec4i = PrimitiveType.from("vec4<i32>", 16, 16);
export const WGSL_vec4u = PrimitiveType.from("vec4<u32>", 16, 16);
export const WGSL_vec4f = PrimitiveType.from("vec4<f32>", 16, 16);
export const WGSL_mat2x2f = PrimitiveType.from("mat2x2<f32>", 8, 16);
export const WGSL_mat3x2f = PrimitiveType.from("mat3x2<f32>", 8, 24);
export const WGSL_mat4x2f = PrimitiveType.from("mat4x2<f32>", 8, 32);
export const WGSL_mat2x3f = PrimitiveType.from("mat2x3<f32>", 16, 32);
export const WGSL_mat3x3f = PrimitiveType.from("mat3x3<f32>", 16, 48);
export const WGSL_mat4x3f = PrimitiveType.from("mat4x3<f32>", 16, 64);
export const WGSL_mat2x4f = PrimitiveType.from("mat2x4<f32>", 16, 32);
export const WGSL_mat3x4f = PrimitiveType.from("mat3x4<f32>", 16, 48);
export const WGSL_mat4x4f = PrimitiveType.from("mat4x4<f32>", 16, 64);
export const WGSL_vec2h = PrimitiveType.from("vec2<f16>", 4, 4);
export const WGSL_vec3h = PrimitiveType.from("vec3<f16>", 8, 6);
export const WGSL_vec4h = PrimitiveType.from("vec4<f16>", 8, 8);
export const WGSL_mat2x2h = PrimitiveType.from("mat2x2<f16>", 4, 8);
export const WGSL_mat3x2h = PrimitiveType.from("mat3x2<f16>", 4, 12);
export const WGSL_mat4x2h = PrimitiveType.from("mat4x2<f16>", 4, 16);
export const WGSL_mat2x3h = PrimitiveType.from("mat2x3<f16>", 8, 16);
export const WGSL_mat3x3h = PrimitiveType.from("mat3x3<f16>", 8, 24);
export const WGSL_mat4x3h = PrimitiveType.from("mat4x3<f16>", 8, 32);
export const WGSL_mat2x4h = PrimitiveType.from("mat2x4<f16>", 8, 16);
export const WGSL_mat3x4h = PrimitiveType.from("mat3x4<f16>", 8, 24);
export const WGSL_mat4x4h = PrimitiveType.from("mat4x4<f16>", 8, 32);
export const WGSL_atomic_u32 = AtomicType.from("atomic<u32>", 4, 4);
export const WGSL_atomic_i32 = AtomicType.from("atomic<i32>", 4, 4);

export const PRIMITIVE_BY_TAG: Record<string, PrimitiveType> = {
  i32: WGSL_i32,
  u32: WGSL_u32,
  f32: WGSL_f32,
  f16: WGSL_f16,
  "atomic<u32>": WGSL_atomic_u32,
  "atomic<i32>": WGSL_atomic_i32,
  "vec2<i32>": WGSL_vec2i,
  "vec2<u32>": WGSL_vec2u,
  "vec2<f32>": WGSL_vec2f,
  "vec2<f16>": WGSL_vec2h,
  "vec3<i32>": WGSL_vec3i,
  "vec3<u32>": WGSL_vec3u,
  "vec3<f32>": WGSL_vec3f,
  "vec3<f16>": WGSL_vec3h,
  "vec4<i32>": WGSL_vec4i,
  "vec4<u32>": WGSL_vec4u,
  "vec4<f32>": WGSL_vec4f,
  "vec4<f16>": WGSL_vec4h,
  "mat2x2<f32>": WGSL_mat2x2f,
  "mat2x2<f16>": WGSL_mat2x2h,
  "mat3x2<f32>": WGSL_mat3x2f,
  "mat3x2<f16>": WGSL_mat3x2h,
  "mat4x2<f32>": WGSL_mat4x2f,
  "mat4x2<f16>": WGSL_mat4x2h,
  "mat2x3<f32>": WGSL_mat2x3f,
  "mat2x3<f16>": WGSL_mat2x3h,
  "mat3x3<f32>": WGSL_mat3x3f,
  "mat3x3<f16>": WGSL_mat3x3h,
  "mat4x3<f32>": WGSL_mat4x3f,
  "mat4x3<f16>": WGSL_mat4x3h,
  "mat2x4<f32>": WGSL_mat2x4f,
  "mat2x4<f16>": WGSL_mat2x4h,
  "mat3x4<f32>": WGSL_mat3x4f,
  "mat3x4<f16>": WGSL_mat3x4h,
  "mat4x4<f32>": WGSL_mat4x4f,
  "mat4x4<f16>": WGSL_mat4x4h,
  vec2i: WGSL_vec2i,
  vec3i: WGSL_vec3i,
  vec4i: WGSL_vec4i,
  vec2u: WGSL_vec2u,
  vec3u: WGSL_vec3u,
  vec4u: WGSL_vec4u,
  vec2f: WGSL_vec2f,
  vec3f: WGSL_vec3f,
  vec4f: WGSL_vec4f,
  mat2x2f: WGSL_mat2x2f,
  mat3x2f: WGSL_mat3x2f,
  mat4x2f: WGSL_mat4x2f,
  mat2x3f: WGSL_mat2x3f,
  mat3x3f: WGSL_mat3x3f,
  mat4x3f: WGSL_mat4x3f,
  mat2x4f: WGSL_mat2x4f,
  mat3x4f: WGSL_mat3x4f,
  mat4x4f: WGSL_mat4x4f,
  vec2h: WGSL_vec2h,
  vec3h: WGSL_vec3h,
  vec4h: WGSL_vec4h,
  mat2x2h: WGSL_mat2x2h,
  mat3x2h: WGSL_mat3x2h,
  mat4x2h: WGSL_mat4x2h,
  mat2x3h: WGSL_mat2x3h,
  mat3x3h: WGSL_mat3x3h,
  mat4x3h: WGSL_mat4x3h,
  mat2x4h: WGSL_mat2x4h,
  mat3x4h: WGSL_mat3x4h,
  mat4x4h: WGSL_mat4x4h
};

export class CodeChunk {
  #te = "";
  #ne: CodeChunk[] = [];
  #re: string[] = [];

  get isCodeChunk(): boolean {
    return true;
  }

  static empty: CodeChunk;

  get text(): string {
    return this.#te;
  }

  addExtension(e: string): boolean {
    return pushUnique(this.#re, e);
  }

  addDependency(e: CodeChunk): boolean {
    if (this.#ne.includes(e)) return false;
    if (e.findDependencyRecursive(this)) {
      throw new Error(`Circular dependency detected: ${this} -> ${e}`);
    }
    this.#se(e);
    return true;
  }

  #se(e: CodeChunk): void {
    this.#ne.push(e);
  }

  static from(e: string, t: CodeChunk[] = []): CodeChunk {
    const n = new CodeChunk();
    n.#te = e;
    const r = t.length;
    for (let i = 0; i < r; i++) {
      const dep = t[i]!;
      if (!n.addDependency(dep)) {
        console.warn(`Duplicate dependency[${i}] : ${dep}`);
      }
    }
    return n;
  }

  allDirectDependenciesIncludedInSet(e: Set<CodeChunk>): boolean {
    const t = this.#ne;
    const n = t.length;
    for (let r = 0; r < n; r++) {
      if (!e.has(t[r]!)) return false;
    }
    return true;
  }

  findDependencyRecursive(e: CodeChunk): boolean {
    const t = this.#ne;
    const n = t.length;
    for (let r = 0; r < n; r++) {
      const n0 = t[r]!;
      if (n0.equals(e) || n0.findDependencyRecursive(e)) return true;
    }
    return false;
  }

  collectDependencies(): CodeChunk[] {
    const e = new Set<CodeChunk>();
    const t = this.#ne.slice();
    let n = t.length;
    while (n > 0) {
      n--;
      const r = t[n]!;
      if (e.has(r)) continue;
      e.add(r);
      const s = r.#ne;
      const a = s.length;
      for (let i = 0; i < a; i++) t[n++] = s[i]!;
    }
    return Array.from(e);
  }

  coalesceDependencies(): CodeChunk[] {
    const e = new Set<CodeChunk>();
    const t = this.collectDependencies();
    const n: CodeChunk[] = [];
    let r = t.length;
    while (r > 0) {
      const s = r;
      for (let i = r - 1; i >= 0; i--) {
        const a = t[i]!;
        if (a.allDirectDependenciesIncludedInSet(e)) {
          n.push(a);
          e.add(a);
          t.splice(i, 1);
          r--;
        }
      }
      if (s === r) throw new Error(`${r} dependencies could not be satisfied`);
    }
    return n;
  }

  compile(): { text: string; extensions: string[] } {
    const e = this.coalesceDependencies();
    e.push(this);
    const t: Record<string, boolean> = {};
    const n: string[] = [];
    const r = e.length;
    for (let s = 0; s < r; s++) {
      const chunk = e[s]!;
      n.push(chunk.#te);
      const a = chunk.#re;
      for (let i = 0; i < a.length; i++) t[a[i]!] = true;
    }
    const s = Object.keys(t).sort();
    return { text: n.join("\n"), extensions: s };
  }

  toString(): string {
    return this.#te;
  }

  hash(): number {
    return hashString(this.#te) ^ this.#ne.length;
  }

  copy(e: CodeChunk): void {
    this.#te = e.#te;
    this.#ne = e.#ne.slice();
    this.#re = e.#re.slice();
  }

  clone(): CodeChunk {
    const e = new CodeChunk();
    e.copy(this);
    return e;
  }

  equals(e: CodeChunk): boolean {
    return this === e || (this.#te === e.#te && arrayDeepEquals(this.#ne, e.#ne));
  }
}

CodeChunk.empty = Object.freeze(CodeChunk.from("")) as CodeChunk;

export class ArrayType extends WebGPUType {
  count = -1;
  type: WebGPUType | null = null;
  #ae: CodeChunk | undefined;

  override get align(): number {
    return this.type!.align;
  }

  override get size(): number {
    const e = this.type!;
    return this.count * alignCeil(e.size, e.align);
  }

  override equals(e: unknown): boolean {
    return (
      this === e ||
      (e instanceof ArrayType &&
        this.type!.equals(e.type) &&
        this.count === e.count)
    );
  }

  override hash(): number {
    return hashMix(this.type!.hash(), this.count);
  }

  override get runtime_sized(): boolean {
    return this.count < 0;
  }

  static from(e: WebGPUType, t = -1): ArrayType {
    const n = new ArrayType();
    n.type = e;
    n.count = t;
    return n;
  }

  override get requires_declaration(): boolean {
    return this.type!.requires_declaration;
  }

  override get declaration_chunk(): CodeChunk {
    if (this.#ae === undefined) {
      this.#ae = this.type!.requires_declaration
        ? this.type!.declaration_chunk
        : CodeChunk.empty;
    }
    return this.#ae;
  }

  override get wgsl_ref(): string {
    const e = this.type!;
    return this.runtime_sized
      ? `array< ${e.wgsl_ref} >`
      : `array< ${e.wgsl_ref}, ${this.count} >`;
  }

  override get wgsl_declaration(): string {
    const e = this.type!.wgsl_ref;
    return this.runtime_sized
      ? `array< ${e} >`
      : `array< ${e}, ${this.count} >`;
  }

  static f32: ArrayType = Object.freeze(ArrayType.from(WGSL_f32)) as ArrayType;
  static u32: ArrayType = Object.freeze(ArrayType.from(WGSL_u32)) as ArrayType;
  static vec4u: ArrayType = Object.freeze(
    ArrayType.from(WGSL_vec4u)
  ) as ArrayType;
  static vec4f: ArrayType = Object.freeze(
    ArrayType.from(WGSL_vec4f)
  ) as ArrayType;
}

(ArrayType.prototype as { isArray?: boolean }).isArray = true;

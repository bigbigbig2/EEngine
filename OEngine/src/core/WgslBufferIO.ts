/**
 * WgslBufferIO：提供渲染器共享的基础数据结构与通用工具。
 */

import { alignCeil, detectNativeEndianness } from "./memoryUtils.js";
import { BinaryReader } from "../loaders/BinaryReader.js";
import {
  ArrayType,
  WebGPUType,
  WGSL_bool,
  WGSL_u32,
  WGSL_i32,
  WGSL_f32,
  WGSL_vec2i,
  WGSL_vec3i,
  WGSL_vec4i,
  WGSL_vec2u,
  WGSL_vec3u,
  WGSL_vec4u,
  WGSL_vec2f,
  WGSL_vec3f,
  WGSL_vec4f,
  WGSL_mat4x4f,
  WGSL_mat3x3f,
  WGSL_mat3x2f,
  WGSL_mat2x3f,
  WGSL_atomic_u32,
  WGSL_atomic_i32
} from "./WebGPUTypes.js";
import { StructType } from "./WgslStruct.js";

export function readFloat32N(e: BinaryReader, t: number): Float32Array {
  const n = new Float32Array(t);
  e.readFloat32Array(n, 0, t);
  return n;
}

export function readInt32N(e: BinaryReader, t: number): Uint32Array {
  const n = new Uint32Array(t);
  e.readInt32Array(n as unknown as Int32Array, 0, t);
  return n;
}

export function readUint32N(e: BinaryReader, t: number): Uint32Array {
  const n = new Uint32Array(t);
  e.readUint32Array(n, 0, t);
  return n;
}

export function readWgslValue(e: BinaryReader, t: WebGPUType): unknown {
  e.position = alignCeil(e.position, t.align);
  if (t instanceof ArrayType) {
    return ((e: BinaryReader, t: ArrayType) => {
      let n = t.count;
      const r: unknown[] = [];
      const s = t.type!;
      const a = s.aligned_size;
      const i = e.position;
      if (t.runtime_sized) n = Math.floor((e.capacity - e.position) / a);
      for (let k = 0; k < n; k++) {
        e.position = i + k * a;
        r[k] = readWgslValue(e, s);
      }
      e.position = i + n * a;
      return r;
    })(e, t);
  }
  if (t instanceof StructType) {
    return ((e: BinaryReader, t: StructType) => {
      const n = t.fields;
      const r = e.position;
      const s: Record<string, unknown> = {};
      for (let i = 0; i < n.length; i++) {
        const a = n[i]!;
        e.position = r + a.offset;
        s[a.name] = readWgslValue(e, a.type);
      }
      return s;
    })(e, t);
  }
  switch (t) {
    case WGSL_bool:
      return e.readUint32() !== 0;
    case WGSL_u32:
    case WGSL_atomic_u32:
      return e.readUint32();
    case WGSL_i32:
    case WGSL_atomic_i32:
      return e.readInt32();
    case WGSL_f32:
      return e.readFloat32();
    case WGSL_vec2u:
      return readUint32N(e, 2);
    case WGSL_vec3u:
      return readUint32N(e, 3);
    case WGSL_vec4u:
      return readUint32N(e, 4);
    case WGSL_vec2i:
      return readInt32N(e, 2);
    case WGSL_vec3i:
      return readInt32N(e, 3);
    case WGSL_vec4i:
      return readInt32N(e, 4);
    case WGSL_vec2f:
      return readFloat32N(e, 2);
    case WGSL_vec3f:
      return readFloat32N(e, 3);
    case WGSL_vec4f:
      return readFloat32N(e, 4);
    case WGSL_mat4x4f:
      return readFloat32N(e, 16);
    default:
      throw new Error(`Unsupported type ${t}`);
  }
}

export function writeWgslValue(
  e: unknown,
  t: BinaryReader,
  n: WebGPUType
): void {
  if (n instanceof ArrayType) {
    const r = n.count;
    const s = n.type!.aligned_size;
    const a = t.position;
    const arr = e as unknown[];
    for (let i = 0; i < r; i++) {
      t.position = a + i * s;
      writeWgslValue(arr[i], t, n.type!);
    }
    t.position = a + r * s;
    return;
  }
  if (n instanceof StructType) {
    const r = n.fields;
    const s = t.position;
    const a = r.length;
    const obj = e as Record<string, unknown>;
    for (let i = 0; i < a; i++) {
      const field = r[i]!;
      t.position = s + field.offset;
      const v = obj[field.name];
      if (v !== undefined) writeWgslValue(v, t, field.type);
    }
    return;
  }
  switch (n) {
    case WGSL_bool:
      t.writeUint32(e ? 1 : 0);
      return;
    case WGSL_u32:
    case WGSL_atomic_u32:
      t.writeUint32(e as number);
      return;
    case WGSL_i32:
    case WGSL_atomic_i32:
      t.writeInt32(e as number);
      return;
    case WGSL_f32:
      t.writeFloat32(e as number);
      return;
    case WGSL_vec2i:
      t.writeInt32Array(e as ArrayLike<number>, 0, 2);
      return;
    case WGSL_vec3i:
      t.writeInt32Array(e as ArrayLike<number>, 0, 3);
      return;
    case WGSL_vec4i:
      t.writeInt32Array(e as ArrayLike<number>, 0, 4);
      return;
    case WGSL_vec2u:
      t.writeUint32Array(e as ArrayLike<number>, 0, 2);
      return;
    case WGSL_vec3u:
      t.writeUint32Array(e as ArrayLike<number>, 0, 3);
      return;
    case WGSL_vec4u:
      t.writeUint32Array(e as ArrayLike<number>, 0, 4);
      return;
    case WGSL_vec2f:
      t.writeFloat32Array(e as ArrayLike<number>, 0, 2);
      return;
    case WGSL_vec3f:
      t.writeFloat32Array(e as ArrayLike<number>, 0, 3);
      return;
    case WGSL_vec4f:
      t.writeFloat32Array(e as ArrayLike<number>, 0, 4);
      return;
    case WGSL_mat4x4f:
      t.writeFloat32Array(e as ArrayLike<number>, 0, 16);
      return;
    case WGSL_mat3x3f:
      t.writeFloat32Array(e as ArrayLike<number>, 0, 9);
      return;
    case WGSL_mat3x2f:
    case WGSL_mat2x3f:
      t.writeFloat32Array(e as ArrayLike<number>, 0, 6);
      return;
    default:
      throw new Error(`Unsupported type ${n}`);
  }
}

export const wgslScratchReader = new BinaryReader();
wgslScratchReader.endianness = detectNativeEndianness();

export function writeWgslToBuffer(
  e: unknown,
  t: WebGPUType,
  n: ArrayBuffer,
  r = 0
): void {
  wgslScratchReader.fromArrayBuffer(n);
  wgslScratchReader.position = r;
  writeWgslValue(e, wgslScratchReader, t);
}

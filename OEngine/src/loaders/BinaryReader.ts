/**
 * BinaryReader：负责资源读取、解码或场景装载。
 */

import { floatToHalf, halfToFloat } from "./float16.js";

export const BinaryEndianness = {
  BigEndian: false,
  LittleEndian: true
} as const;

export type BinaryEndiannessValue =
  (typeof BinaryEndianness)[keyof typeof BinaryEndianness];

export const or = BinaryEndianness;

export class BinaryReader {
  endianness: boolean = BinaryEndianness.LittleEndian;

  position = 0;
  capacity = 1024;
  data: ArrayBuffer = new ArrayBuffer(1024);
  dataView: DataView = new DataView(this.data);
  private _u8 = new Uint8Array(this.data);
  private __growFactor = 1.1;

  get length(): never {
    throw new Error("Deprecated, use 'capacity' instead");
  }
  set length(arg: number) {
    void arg;
    throw new Error("Deprecated, use 'capacity' instead");
  }

  setCapacity(capacity: number): void {
    if (capacity < this.position) {
      throw new Error(
        `Attempting to set capacity(=${capacity}) below current position(=${this.position})`
      );
    }
    if (this.capacity === capacity) return;
    const t = this._u8;
    const n = new Uint8Array(capacity);
    if (this.position > 0) {
      n.set(t.subarray(0, Math.min(t.length, capacity, this.position)));
    }
    this.data = n.buffer;
    this._u8 = n;
    this.dataView = new DataView(this.data);
    this.capacity = capacity;
  }

  ensureCapacity(min_capacity: number): void {
    const t = this.capacity;
    if (t >= min_capacity) return;
    const n = Math.ceil(Math.max(min_capacity, t * this.__growFactor, t + 1024));
    this.setCapacity(((n + 3) >> 2) << 2);
  }

  trim(): this {
    this.setCapacity(this.position);
    return this;
  }

  fromArrayBuffer(data: ArrayBuffer): void {
    this.data = data;
    this.dataView = new DataView(data);
    this._u8 = new Uint8Array(data);
    this.capacity = data.byteLength;
    this.position = 0;
  }

  static fromArrayBuffer(v: ArrayBuffer): BinaryReader {
    const t = new BinaryReader();
    t.fromArrayBuffer(v);
    return t;
  }

  static fromEndianness(type: boolean): BinaryReader {
    const t = new BinaryReader();
    t.endianness = type;
    return t;
  }

  get raw_bytes(): Uint8Array {
    return this._u8;
  }

  toString(): string {
    return `BinaryBuffer[position=${this.position}, capacity=${this.capacity}, endianness=${this.endianness}]`;
  }

  toHexString(): string {
    const e = this._u8;
    const t = Math.min(e.length, this.position);
    let n = "";
    for (let r = 0; r < t; r++) {
      n += e[r]!.toString(16).padStart(2, "0").toUpperCase();
    }
    return n;
  }

  skip(byte_count: number): void {
    this.position += byte_count;
  }


  readASCIICharacters(length: number, null_terminated = false): string {
    let n = "";
    for (let r = 0; r < length; r++) {
      const e = this.readUint8();
      if (null_terminated && e === 0) break;
      n += String.fromCharCode(e);
    }
    return n;
  }

  readUint8(): number {
    const v = this.dataView.getUint8(this.position);
    this.position += 1;
    return v;
  }

  readUint16(): number {
    const v = this.dataView.getUint16(this.position, this.endianness);
    this.position += 2;
    return v;
  }

  readUint16LE(): number {
    const v = this.dataView.getUint16(
      this.position,
      BinaryEndianness.LittleEndian
    );
    this.position += 2;
    return v;
  }

  readUint16BE(): number {
    const v = this.dataView.getUint16(this.position, BinaryEndianness.BigEndian);
    this.position += 2;
    return v;
  }

  readUint24(): number {
    return this.endianness === BinaryEndianness.BigEndian
      ? this.readUint24BE()
      : this.readUint24LE();
  }

  readUint24LE(): number {
    const e = this.dataView.getUint8(this.position);
    const t = this.dataView.getUint8(this.position + 1);
    const n = this.dataView.getUint8(this.position + 2);
    this.position += 3;
    return e | (t << 8) | (n << 16);
  }

  readUint24BE(): number {
    const e = this.dataView.getUint8(this.position);
    const t = this.dataView.getUint8(this.position + 1);
    const n = this.dataView.getUint8(this.position + 2);
    this.position += 3;
    return n | (t << 8) | (e << 16);
  }

  readUint32(): number {
    const v = this.dataView.getUint32(this.position, this.endianness);
    this.position += 4;
    return v;
  }

  readUint32LE(): number {
    const v = this.dataView.getUint32(
      this.position,
      BinaryEndianness.LittleEndian
    );
    this.position += 4;
    return v;
  }

  readUint32BE(): number {
    const v = this.dataView.getUint32(this.position, BinaryEndianness.BigEndian);
    this.position += 4;
    return v;
  }

  readFloat32(): number {
    const v = this.dataView.getFloat32(this.position, this.endianness);
    this.position += 4;
    return v;
  }

  readFloat64(): number {
    const v = this.dataView.getFloat64(this.position, this.endianness);
    this.position += 8;
    return v;
  }

  readInt8(): number {
    const v = this.dataView.getInt8(this.position);
    this.position += 1;
    return v;
  }

  readInt16(): number {
    const v = this.dataView.getInt16(this.position, this.endianness);
    this.position += 2;
    return v;
  }

  readInt32(): number {
    const v = this.dataView.getInt32(this.position, this.endianness);
    this.position += 4;
    return v;
  }

  readInt64(): bigint {
    const v = this.dataView.getBigInt64(this.position, this.endianness);
    this.position += 8;
    return v;
  }

  readUint64(): bigint {
    const v = this.dataView.getBigUint64(this.position, this.endianness);
    this.position += 8;
    return v;
  }

  readFloat16(): number {
    return halfToFloat(this.readUint16());
  }

  readFloat32Array(
    destination: Float32Array | number[],
    destination_offset = 0,
    length = destination.length
  ): void {
    for (let i = 0; i < length; i++) {
      destination[destination_offset + i] = this.readFloat32();
    }
  }

  readFloat64Array(
    destination: Float64Array,
    destination_offset = 0,
    length = destination.length
  ): void {
    for (let i = 0; i < length; i++) {
      destination[destination_offset + i] = this.readFloat64();
    }
  }

  readUint32Array(
    destination: Uint32Array | number[] | ArrayLike<number>,
    destination_offset = 0,
    length = destination.length
  ): void {
    const output = destination as { [index: number]: number };
    for (let i = 0; i < length; i++) {
      output[destination_offset + i] = this.readUint32();
    }
  }

  readUint16Array(
    destination: Uint16Array,
    destination_offset = 0,
    length = destination.length
  ): void {
    for (let i = 0; i < length; i++) {
      destination[destination_offset + i] = this.readUint16();
    }
  }

  readUint8Array(
    destination: Uint8Array,
    destination_offset = 0,
    length = destination.length
  ): void {
    for (let i = 0; i < length; i++) {
      destination[destination_offset + i] = this.readUint8();
    }
  }

  readInt8Array(
    destination: Int8Array,
    destination_offset = 0,
    length = destination.length
  ): void {
    for (let i = 0; i < length; i++) {
      destination[destination_offset + i] = this.readInt8();
    }
  }

  readInt16Array(
    destination: Int16Array,
    destination_offset = 0,
    length = destination.length
  ): void {
    for (let i = 0; i < length; i++) {
      destination[destination_offset + i] = this.readInt16();
    }
  }

  readInt32Array(
    destination: Int32Array,
    destination_offset = 0,
    length = destination.length
  ): void {
    for (let i = 0; i < length; i++) {
      destination[destination_offset + i] = this.readInt32();
    }
  }

  readFloat16Array(
    destination: Float32Array | number[],
    destination_offset = 0,
    length = destination.length
  ): void {
    for (let i = 0; i < length; i++) {
      destination[destination_offset + i] = this.readFloat16();
    }
  }

  readUTF8String(): string | null | undefined {
    const e = this.readUint32();
    if (e === 0xffffffff) return null;
    if (e === 0xfffffffe) return undefined;
    const t = this._u8;
    let n = "";
    let r = this.position;
    let s = 0;
    while (r < this.capacity && s < e) {
      const b0 = t[r++]!;
      let a: number | undefined;
      if (b0 === 0) break;
      if (128 & b0) {
        if (192 === (224 & b0)) {
          a = ((31 & b0) << 6) | (63 & t[r++]!);
        } else if (224 === (240 & b0)) {
          a =
            ((31 & b0) << 12) |
            ((63 & t[r++]!) << 6) |
            (63 & t[r++]!);
        } else if (240 === (248 & b0)) {
          a =
            ((7 & b0) << 18) |
            ((63 & t[r++]!) << 12) |
            ((63 & t[r++]!) << 6) |
            (63 & t[r++]!);
          if (a > 65535) {
            a -= 65536;
            n += String.fromCharCode(((a >>> 10) & 1023) | 55296);
            s++;
            a = 56320 | (1023 & a);
          }
        }
      } else {
        a = b0;
      }
      s++;
      n += String.fromCharCode(a as number);
    }
    this.position = r;
    return n;
  }

  readBytes(
    destination: Uint8Array,
    destination_offset = 0,
    length = destination.length - destination_offset
  ): void {
    destination.set(
      this._u8.subarray(this.position, this.position + length),
      destination_offset
    );
    this.position += length;
  }

  readUintVar(): number {
    let cont = true;
    let t = 0;
    let n = 0;
    while (cont) {
      const r = this.readUint8();
      cont = !!(128 & r);
      t |= (127 & r) << n;
      n += 7;
    }
    return t;
  }


  writeUint8(value: number): void {
    const t = this.position + 1;
    this.ensureCapacity(t);
    this.dataView.setUint8(this.position, value);
    this.position = t;
  }

  writeUint8Array(
    source: ArrayLike<number>,
    source_offset = 0,
    length = source.length - source_offset
  ): void {
    for (let r = 0; r < length; r++) {
      this.writeUint8(source[source_offset + r]!);
    }
  }

  writeUint16(value: number): void {
    const t = this.position + 2;
    this.ensureCapacity(t);
    this.dataView.setUint16(this.position, value, this.endianness);
    this.position = t;
  }

  writeUint16LE(value: number): void {
    const t = this.position + 2;
    this.ensureCapacity(t);
    this.dataView.setUint16(this.position, value, BinaryEndianness.LittleEndian);
    this.position = t;
  }

  writeUint16BE(value: number): void {
    const t = this.position + 2;
    this.ensureCapacity(t);
    this.dataView.setUint16(this.position, value, BinaryEndianness.BigEndian);
    this.position = t;
  }

  writeUint16Array(
    source: ArrayLike<number>,
    source_offset = 0,
    length = source.length - source_offset
  ): void {
    for (let r = 0; r < length; r++) {
      this.writeUint16(source[source_offset + r]!);
    }
  }

  writeUint32(value: number): void {
    const t = this.position + 4;
    this.ensureCapacity(t);
    this.dataView.setUint32(this.position, value, this.endianness);
    this.position = t;
  }

  writeUint32LE(value: number): void {
    const t = this.position + 4;
    this.ensureCapacity(t);
    this.dataView.setUint32(this.position, value, BinaryEndianness.LittleEndian);
    this.position = t;
  }

  writeUint32BE(value: number): void {
    const t = this.position + 4;
    this.ensureCapacity(t);
    this.dataView.setUint32(this.position, value, BinaryEndianness.BigEndian);
    this.position = t;
  }

  writeUint32Array(
    source: ArrayLike<number>,
    source_offset = 0,
    length = source.length - source_offset
  ): void {
    this.ensureCapacity(this.position + 4 * length);
    for (let r = 0; r < length; r++) {
      this.writeUint32(source[source_offset + r]!);
    }
  }

  writeUint64(value: bigint): void {
    const t = this.position + 8;
    this.ensureCapacity(t);
    this.dataView.setBigUint64(this.position, value, this.endianness);
    this.position = t;
  }

  writeInt8(value: number): void {
    const t = this.position + 1;
    this.ensureCapacity(t);
    this.dataView.setInt8(this.position, value);
    this.position = t;
  }

  writeInt16(value: number): void {
    const t = this.position + 2;
    this.ensureCapacity(t);
    this.dataView.setInt16(this.position, value, this.endianness);
    this.position = t;
  }

  writeInt32(value: number): void {
    const t = this.position + 4;
    this.ensureCapacity(t);
    this.dataView.setInt32(this.position, value, this.endianness);
    this.position = t;
  }

  writeInt64(value: bigint): void {
    const t = this.position + 8;
    this.ensureCapacity(t);
    this.dataView.setBigInt64(this.position, value, this.endianness);
    this.position = t;
  }

  writeInt8Array(
    source: ArrayLike<number>,
    source_offset = 0,
    length = source.length - source_offset
  ): void {
    this.ensureCapacity(this.position + length);
    for (let r = 0; r < length; r++) {
      this.writeInt8(source[source_offset + r]!);
    }
  }

  writeInt16Array(
    source: ArrayLike<number>,
    source_offset = 0,
    length = source.length - source_offset
  ): void {
    this.ensureCapacity(this.position + 2 * length);
    for (let r = 0; r < length; r++) {
      this.writeInt16(source[source_offset + r]!);
    }
  }

  writeInt32Array(
    source: ArrayLike<number>,
    source_offset = 0,
    length = source.length - source_offset
  ): void {
    this.ensureCapacity(this.position + 4 * length);
    for (let r = 0; r < length; r++) {
      this.writeInt32(source[source_offset + r]!);
    }
  }

  writeFloat32(value: number): void {
    const t = this.position + 4;
    this.ensureCapacity(t);
    this.dataView.setFloat32(this.position, value, this.endianness);
    this.position = t;
  }

  writeFloat64(value: number): void {
    const t = this.position + 8;
    this.ensureCapacity(t);
    this.dataView.setFloat64(this.position, value, this.endianness);
    this.position = t;
  }

  writeFloat16(value: number): void {
    this.writeUint16(floatToHalf(value));
  }

  writeFloat32Array(
    source: ArrayLike<number>,
    source_offset = 0,
    length = source.length - source_offset
  ): void {
    for (let r = 0; r < length; r++) {
      this.writeFloat32(source[source_offset + r]!);
    }
  }

  writeFloat16Array(
    source: ArrayLike<number>,
    source_offset = 0,
    length = source.length - source_offset
  ): void {
    for (let r = 0; r < length; r++) {
      this.writeFloat16(source[source_offset + r]!);
    }
  }

  writeBytes(
    array: ArrayLike<number> | Uint8Array,
    source_offset = 0,
    length = (array as Uint8Array).length - source_offset
  ): void {
    const r = source_offset + length;
    const s = this.position;
    const a = s + length;
    this.ensureCapacity(a);
    if (array instanceof Uint8Array || ArrayBuffer.isView(array)) {
      const u = array as Uint8Array;
      if (source_offset === 0 && u.length === length) this._u8.set(u, s);
      else this._u8.set(u.subarray(source_offset, r), s);
    } else {
      for (let i = 0; i < length; i++) {
        this._u8[s + i] = array[source_offset + i]! as number;
      }
    }
    this.position = a;
  }

  writeUTF8String(string: string | null | undefined): void {
    if (string === null) {
      this.writeUint32(0xffffffff);
      return;
    }
    if (string === undefined) {
      this.writeUint32(0xfffffffe);
      return;
    }
    let t = 0;
    const n = string.length;
    if (n >= 0xfffffffe) throw new Error("String is too long");
    this.writeUint32(n);
    let r = this.position;
    const s = Math.max(32, n + (n >> 1) + 7);
    this.ensureCapacity(s + r);
    let a = this._u8;
    let i = this.capacity;
    while (t < n) {
      let ch = string.charCodeAt(t++);
      if (ch >= 55296 && ch <= 56319) {
        if (t < n) {
          const lo = string.charCodeAt(t);
          if (56320 === (64512 & lo)) {
            ++t;
            ch = ((1023 & ch) << 10) + (1023 & lo) + 65536;
          }
        }
        if (ch >= 55296 && ch <= 56319) continue;
      }
      if (r + 4 > i) {
        this.ensureCapacity(r + 4);
        i = this.capacity;
        a = this._u8;
      }
      if (4294967168 & ch) {
        if (4294965248 & ch) {
          if (4294901760 & ch) {
            if (4292870144 & ch) continue;
            a[r++] = ((ch >> 18) & 7) | 240;
            a[r++] = ((ch >> 12) & 63) | 128;
            a[r++] = ((ch >> 6) & 63) | 128;
          } else {
            a[r++] = ((ch >> 12) & 15) | 224;
            a[r++] = ((ch >> 6) & 63) | 128;
          }
        } else {
          a[r++] = ((ch >> 6) & 31) | 192;
        }
        a[r++] = (63 & ch) | 128;
      } else {
        a[r++] = ch;
      }
    }
    this.position = r;
  }

  writeASCIIString(string: string): void {
    const t = string.length;
    const n = this.position;
    const r = n + t;
    this.ensureCapacity(r);
    for (let i = 0; i < t; i++) {
      const c = string.charCodeAt(i);
      if (c > 128) {
        throw new Error(
          `Character ${String.fromCharCode(c)} can't be represented by a US-ASCII byte.`
        );
      }
      this._u8[n + i] = c;
    }
    this.position = r;
  }


  static copyUTF8String(
    source: BinaryReader,
    target: BinaryReader
  ): string | null | undefined {
    const n = source.readUTF8String();
    target.writeUTF8String(n);
    return n;
  }

  static copyUintVar(source: BinaryReader, target: BinaryReader): number {
    const n = source.readUintVar();
    target.writeUintVar(n);
    return n;
  }

  static copyUint8(source: BinaryReader, target: BinaryReader): number {
    const n = source.readUint8();
    target.writeUint8(n);
    return n;
  }

  static copyUint16(source: BinaryReader, target: BinaryReader): number {
    const n = source.readUint16();
    target.writeUint16(n);
    return n;
  }

  static copyUint32(source: BinaryReader, target: BinaryReader): number {
    const n = source.readUint32();
    target.writeUint32(n);
    return n;
  }

  static copyFloat32(source: BinaryReader, target: BinaryReader): number {
    const n = source.readFloat32();
    target.writeFloat32(n);
    return n;
  }

  static copyFloat64(source: BinaryReader, target: BinaryReader): number {
    const n = source.readFloat64();
    target.writeFloat64(n);
    return n;
  }

  static copyBytes(
    source: BinaryReader,
    target: BinaryReader,
    length: number
  ): Uint8Array {
    const r = new Uint8Array(length);
    source.readBytes(r, 0, length);
    target.writeBytes(r, 0, length);
    return r;
  }

  writeUintVar(value: number): void {
    let first = true;
    let n = value;
    while (first || n !== 0) {
      first = false;
      let b = 127 & n;
      n >>= 7;
      if (n > 0) b |= 128;
      this.writeUint8(b);
    }
  }

  writeUint24(value: number): void {
    if (this.endianness === BinaryEndianness.BigEndian) this.writeUint24BE(value);
    else this.writeUint24LE(value);
  }

  writeUint24LE(value: number): void {
    const t = this.position + 3;
    this.ensureCapacity(t);
    this.dataView.setUint8(this.position, 255 & value);
    this.dataView.setUint8(this.position + 1, (value >> 8) & 255);
    this.dataView.setUint8(this.position + 2, (value >> 16) & 255);
    this.position = t;
  }

  writeUint24BE(value: number): void {
    const t = this.position + 3;
    this.ensureCapacity(t);
    this.dataView.setUint8(this.position, (value >> 16) & 255);
    this.dataView.setUint8(this.position + 1, (value >> 8) & 255);
    this.dataView.setUint8(this.position + 2, 255 & value);
    this.position = t;
  }
}

export interface BinaryReader {
  readonly isBinaryBuffer: boolean;
}

(BinaryReader.prototype as { isBinaryBuffer: boolean }).isBinaryBuffer = true;

/**
 * 结构化表：根据字段描述生成紧凑的数据布局，并提供类型安全的读写和容量管理。
 */

import { ChangeSignal } from "./Signal.js";
import { WeightedCache } from "./WeightedCache.js";
import {
  hashString,
  stringApproxByteSize,
  copyArrayBufferRange,
  copyArrayRange,
  hashViaMethod,
  equalsViaMethod
} from "./memoryUtils.js";
import { arrayShallowEquals } from "./arrayUtils.js";
import { hashMix } from "./hashMix.js";
import { hashArrayItems, fmax } from "./math/mathUtils.js";
import {
  BinaryEndianness,
  type BinaryEndiannessValue
} from "../loaders/BinaryReader.js";
import { ShadeDataType, type ShadeDataTypeName } from "../texture/ShadeDataType.js";

export const DATA_TYPE_BYTE_SIZE: Record<string, number> = {
  [ShadeDataType.Uint8]: 1,
  [ShadeDataType.Uint16]: 2,
  [ShadeDataType.Uint32]: 4,
  [ShadeDataType.Uint64]: 8,
  [ShadeDataType.Int8]: 1,
  [ShadeDataType.Int16]: 2,
  [ShadeDataType.Int32]: 4,
  [ShadeDataType.Int64]: 8,
  [ShadeDataType.Float16]: 2,
  [ShadeDataType.Float32]: 4,
  [ShadeDataType.Float64]: 8
};

export const DATA_VIEW_GETTERS: Record<string, string> = {
  [ShadeDataType.Uint8]: "getUint8",
  [ShadeDataType.Uint16]: "getUint16",
  [ShadeDataType.Uint32]: "getUint32",
  [ShadeDataType.Uint64]: "getBigUint64",
  [ShadeDataType.Int8]: "getInt8",
  [ShadeDataType.Int16]: "getInt16",
  [ShadeDataType.Int32]: "getInt32",
  [ShadeDataType.Int64]: "getBigInt64",
  [ShadeDataType.Float32]: "getFloat32",
  [ShadeDataType.Float64]: "getFloat64"
};

export const DATA_VIEW_SETTERS: Record<string, string> = {
  [ShadeDataType.Uint8]: "setUint8",
  [ShadeDataType.Uint16]: "setUint16",
  [ShadeDataType.Uint32]: "setUint32",
  [ShadeDataType.Uint64]: "setBigUint64",
  [ShadeDataType.Int8]: "setInt8",
  [ShadeDataType.Int16]: "setInt16",
  [ShadeDataType.Int32]: "setInt32",
  [ShadeDataType.Int64]: "setBigInt64",
  [ShadeDataType.Float32]: "setFloat32",
  [ShadeDataType.Float64]: "setFloat64"
};

export function sizeOfDataType(e: string): number {
  const t = DATA_TYPE_BYTE_SIZE[e];
  if (t === undefined) throw new Error(`Unsupported type '${e}'`);
  return t;
}

export function enumKeyOf(e: Record<string, unknown>, t: unknown): string | undefined {
  for (const n in e) {
    if (e[n] === t) return n;
  }
  return undefined;
}

export class CompiledFunctionKey {
  name: string | undefined;
  args: string[];
  body: string;
  __hash = 0.1;

  constructor({
    name: e,
    body: t,
    args: n = []
  }: {
    name?: string;
    body: string;
    args?: string[];
  }) {
    this.name = e;
    this.args = n;
    this.body = t;
    this.__hash = 0.1;
  }

  updateHash(): void {
    this.__hash = hashMix(
      hashString(this.name as string),
      hashString(this.body),
      hashArrayItems(this.args, hashString)
    );
  }

  computeByteSize(): number {
    let e = stringApproxByteSize(this.body);
    if (this.name !== undefined) e += stringApproxByteSize(this.name);
    const t = this.args.length;
    for (let n = 0; n < t; n++) e += stringApproxByteSize(this.args[n]!);
    return e;
  }

  equals(t: CompiledFunctionKey): boolean {
    return (
      this.name === t.name &&
      this.body === t.body &&
      arrayShallowEquals(this.args, t.args)
    );
  }

  hash(): number {
    if (this.__hash === 0.1) this.updateHash();
    return this.__hash;
  }
}

export class FunctionCompiler {
  readonly cache: WeightedCache<CompiledFunctionKey, Function>;

  constructor() {
    this.cache = new WeightedCache<CompiledFunctionKey, Function>({
      maxWeight: 10383360,
      keyWeigher: (e) => e.computeByteSize(),
      keyHashFunction: hashViaMethod as (k: CompiledFunctionKey) => number,
      keyEqualityFunction: equalsViaMethod as (
        a: CompiledFunctionKey,
        b: CompiledFunctionKey
      ) => boolean
    });
  }

  compile({
    code: e,
    args: t = [],
    name: n
  }: {
    code: string;
    args?: string[];
    name?: string;
  }): Function {
    const r = new CompiledFunctionKey({ body: e, args: t, name: n });
    const s = this.cache.get(r);
    if (s === null) {
      // eslint-disable-next-line no-new-func -- evidence: new Function(t.join(","), e)
      const fn = new Function(t.join(","), e);
      if (n !== undefined) {
        Object.defineProperty(fn, "name", { value: n });
      }
      this.cache.put(r, fn);
      return fn;
    }
    return s;
  }

  static INSTANCE = new FunctionCompiler();
}

export function compileCellWriter(
  e: string,
  t: number,
  n: BinaryEndiannessValue = BinaryEndianness.BigEndian
): (dataView: DataView, byteOffset: number, value: unknown) => void {
  const setter = DATA_VIEW_SETTERS[e];
  if (setter === undefined) throw new Error(`Unsupported type '${e}'`);
  const le = n === BinaryEndianness.BigEndian ? "false" : "true";
  const needsEndian =
    e !== ShadeDataType.Uint8 && e !== ShadeDataType.Int8;
  const code = needsEndian
    ? `dataView.${setter}(byteOffset+${t}, value, ${le});`
    : `dataView.${setter}(byteOffset+${t}, value);`;
  return FunctionCompiler.INSTANCE.compile({
    args: ["dataView, byteOffset, value"],
    code
  }) as (dataView: DataView, byteOffset: number, value: unknown) => void;
}

export function compileCellReader(
  e: string,
  t: number,
  n: BinaryEndiannessValue = BinaryEndianness.BigEndian
): (dataView: DataView, byteOffset: number) => unknown {
  const getter = DATA_VIEW_GETTERS[e];
  if (getter === undefined) throw new Error(`Unsupported type '${e}'`);
  const le = n === BinaryEndianness.BigEndian ? "false" : "true";
  const needsEndian =
    e !== ShadeDataType.Uint8 && e !== ShadeDataType.Int8;
  const code = needsEndian
    ? `return dataView.${getter}(byteOffset+${t}, ${le});`
    : `return dataView.${getter}(byteOffset+${t});`;
  return FunctionCompiler.INSTANCE.compile({
    args: ["dataView, byteOffset"],
    code
  }) as (dataView: DataView, byteOffset: number) => unknown;
}

export type CellReader = (dataView: DataView, byteOffset: number) => unknown;
export type CellWriter = (
  dataView: DataView,
  byteOffset: number,
  value: unknown
) => void;
export type RowReader = (
  dataView: DataView,
  byteOffset: number,
  result: unknown[]
) => void;
export type RowWriter = (
  dataView: DataView,
  byteOffset: number,
  record: ArrayLike<unknown>
) => void;

export class TableSpec {
  readonly types: ShadeDataTypeName[] | string[];
  readonly endianType: BinaryEndiannessValue;
  readonly columnOffsets: Uint32Array;
  readonly bytesPerRecord: number;
  readonly readRowMethod: RowReader;
  readonly writeRowMethod: RowWriter;
  readonly cellWriters: CellWriter[];
  readonly cellReaders: CellReader[];

  constructor(
    e: string[],
    t: BinaryEndiannessValue = BinaryEndianness.LittleEndian
  ) {
    const n = e.length;
    this.types = e;
    this.endianType = t;
    this.columnOffsets = new Uint32Array(n);
    let r = 0;
    for (let i = 0; i < n; i++) {
      const ty = e[i]!;
      this.columnOffsets[i] = r;
      r += sizeOfDataType(ty);
    }
    this.bytesPerRecord = r;

    const endian = t;
    this.readRowMethod = ((types: string[], end: BinaryEndiannessValue) => {
      let off = 0;
      const lines: string[] = [];
      const s = types.length;
      for (let a = 0; a < s; a++) {
        const ty = types[a]!;
        const getter = DATA_VIEW_GETTERS[ty];
        if (getter === undefined) throw new Error(`Unsupported type '${ty}'`);
        const le = end === BinaryEndianness.BigEndian ? "false" : "true";
        const needsEndian =
          ty !== ShadeDataType.Uint8 && ty !== ShadeDataType.Int8;
        if (needsEndian) {
          lines.push(
            `result[${a}] = dataView.${getter}(${off} + byteOffset, ${le});`
          );
        } else {
          lines.push(`result[${a}] = dataView.${getter}(${off} + byteOffset);`);
        }
        off += sizeOfDataType(ty);
      }
      return FunctionCompiler.INSTANCE.compile({
        args: ["dataView, byteOffset, result"],
        code: lines.join("\n")
      }) as RowReader;
    })(e, endian);

    this.writeRowMethod = ((types: string[], end: BinaryEndiannessValue) => {
      let off = 0;
      const lines: string[] = [];
      const s = types.length;
      for (let a = 0; a < s; a++) {
        const ty = types[a]!;
        const setter = DATA_VIEW_SETTERS[ty];
        if (setter === undefined) throw new Error(`Unsupported type '${ty}'`);
        const le = end === BinaryEndianness.BigEndian ? "false" : "true";
        const needsEndian =
          ty !== ShadeDataType.Uint8 && ty !== ShadeDataType.Int8;
        if (needsEndian) {
          lines.push(
            `dataView.${setter}(${off} + byteOffset, record[${a}], ${le});`
          );
        } else {
          lines.push(
            `dataView.${setter}(${off} + byteOffset, record[${a}]);`
          );
        }
        off += sizeOfDataType(ty);
      }
      return FunctionCompiler.INSTANCE.compile({
        args: ["dataView, byteOffset, record"],
        code: lines.join("\n")
      }) as RowWriter;
    })(e, endian);

    this.cellWriters = new Array(n);
    this.cellReaders = new Array(n);
    for (let r = 0; r < n; r++) {
      this.cellReaders[r] = compileCellReader(e[r]!, this.columnOffsets[r]!, t);
      this.cellWriters[r] = compileCellWriter(e[r]!, this.columnOffsets[r]!, t);
    }
  }

  getColumnCount(): number {
    return this.types.length;
  }

  hash(): number {
    let e = this.endianType === BinaryEndianness.BigEndian ? 1 : 0;
    e += hashArrayItems(this.types, hashString);
    return e;
  }

  equals(t: TableSpec): boolean {
    return (
      this.endianType === t.endianType &&
      arrayShallowEquals(this.types, t.types)
    );
  }

  toString(): string {
    return `TableSpec{types=[${this.types.join(", ")}], endian=${enumKeyOf(BinaryEndianness as unknown as Record<string, unknown>, this.endianType)}}`;
  }

  static get(
    e: string[],
    t: BinaryEndiannessValue = BinaryEndianness.BigEndian
  ): TableSpec {
    const n = e.join(".") + ":" + t;
    const r = tableSpecCache.get(n);
    if (r !== null) return r;
    const s = Object.freeze(new TableSpec(e));
    tableSpecCache.put(n, s);
    return s;
  }
}

(TableSpec.prototype as { isRowFirstTableSpec?: boolean }).isRowFirstTableSpec =
  true;

export const tableSpecCache = new WeightedCache<string, TableSpec>({
  keyHashFunction: hashString as (k: string) => number
});

function allocTableBuffer(byteLength: number, shared = false): ArrayBuffer {
  if (shared) {
    const g = globalThis as {
      crossOriginIsolated?: boolean;
      SharedArrayBuffer?: typeof SharedArrayBuffer;
    };
    if (g.crossOriginIsolated && typeof g.SharedArrayBuffer === "function") {
      return new g.SharedArrayBuffer(byteLength) as unknown as ArrayBuffer;
    }
    console.error(
      "SharedArrayBuffer not supported because origin is not isolated, defaulting to ArrayBuffer instead"
    );
  }
  return new ArrayBuffer(byteLength);
}

export class StructuredTable {
  spec: TableSpec;
  data: ArrayBuffer;
  length = 0;
  capacity = 8;
  dataView: DataView;
  readonly on = { added: new ChangeSignal() };

  constructor(e: TableSpec, t = false) {
    this.spec = e;
    this.data = allocTableBuffer(8 * e.bytesPerRecord, t);
    this.length = 0;
    this.capacity = 8;
    this.dataView = new DataView(this.data);
    this.on = { added: new ChangeSignal() };
  }

  set array_buffer(e: ArrayBuffer) {
    this.data = e;
    this.dataView = new DataView(e);
    this.capacity = Math.floor(e.byteLength / this.spec.bytesPerRecord);
    this.length = 0;
  }

  get array_buffer(): ArrayBuffer {
    return this.data;
  }

  hash(): number {
    const e = this.data.byteLength;
    const t = this.dataView;
    let n = e;
    const r = e >> 2;
    const s = fmax(Math.floor(r / 31), 1);
    const a = Math.floor(r / s);
    for (let i = 0; i < a; i++) {
      n = (n << 5) - n + t.getUint32((i * s) << 2);
    }
    return n;
  }

  setCapacity(e: number): void {
    if (this.capacity === e) return;
    const t = this.data;
    const n = this.spec.bytesPerRecord;
    const r = e * n;
    let next: ArrayBuffer;
    try {
      const Ctor = this.data.constructor as new (n: number) => ArrayBuffer;
      next = new Ctor(r);
    } catch {
      throw new Error("failed to create a new array buffer of size: " + r);
    }
    if (next.byteLength !== r) {
      throw new Error(
        "Generated array was truncated unexpectedly from " +
          r +
          " to " +
          next.byteLength
      );
    }
    const s = new Uint8Array(next);
    const a = new Uint8Array(t);
    const i = this.length * n;
    try {
      s.set(a.subarray(0, i), 0);
    } catch (err) {
      if (err instanceof RangeError) {
        throw new Error(
          "Failed to copy contents of original due to to size violation. OldSize: " +
            i +
            ", NewSize: " +
            next.byteLength
        );
      }
      throw err;
    }
    this.data = next;
    this.capacity = e;
    this.dataView = new DataView(this.data, 0);
  }

  trim(): void {
    this.setCapacity(this.length);
  }

  resize(e: number): void {
    if (this.capacity < e) {
      const t = Math.max(Math.ceil(1.5 * e), e + 32);
      this.setCapacity(t);
    } else if (0.5 * this.capacity > e) {
      this.setCapacity(e);
    }
  }

  writeCellValue(e: number, t: number, n: unknown): void {
    const r = this.spec;
    r.cellWriters[t]!(this.dataView, e * r.bytesPerRecord, n);
  }

  readCellValue(e: number, t: number): unknown {
    const n = this.spec;
    return n.cellReaders[t]!(this.dataView, e * n.bytesPerRecord);
  }

  removeRows(e: number, t: number): void {
    const n = new Uint8Array(this.data);
    const r = this.spec.bytesPerRecord;
    const s = e * r;
    n.copyWithin(s, s + t * r, this.length * r);
    this.length -= t;
    this.resize(this.length);
  }

  insertRows(e: number, t: number): void {
    const n = this.length + t;
    this.resize(n);
    const r = this.spec.bytesPerRecord;
    new Uint8Array(this.data).copyWithin((e + t) * r, e * r, n * r);
    this.length = n;
  }

  createEmptyRow(): number {
    const e = this.length + 1;
    this.resize(e);
    const t = this.length;
    this.length = e;
    return t;
  }

  addRow(e: ArrayLike<unknown>): number {
    const t = this.createEmptyRow();
    this.spec.writeRowMethod(
      this.dataView,
      this.spec.bytesPerRecord * t,
      e
    );
    this.on.added.send2(t, e);
    return t;
  }

  addRows(_e?: unknown, _t?: unknown): never {
    throw new Error("deprecated, use .addRow and .writeRow instead");
  }

  copyRow(e: number, t: number): void {
    if (e === t) return;
    const n = this.spec.bytesPerRecord;
    const r = e * n;
    const s = t * n;
    const a = this.dataView;
    for (let i = 0; i < n; i++) {
      const v = a.getUint8(r + i);
      a.setUint8(s + i, v);
    }
  }

  readRow(e: number, t: unknown[] = []): unknown[] {
    const n = this.spec;
    n.readRowMethod(this.dataView, n.bytesPerRecord * e, t);
    return t;
  }

  writeRow(e: number, t: ArrayLike<unknown>): void {
    const n = this.spec;
    n.writeRowMethod(this.dataView, n.bytesPerRecord * e, t);
  }

  clearRow(e: number): void {
    const t = this.spec.bytesPerRecord;
    const n = e * t;
    const r = this.dataView;
    for (let i = 0; i < t; i++) r.setUint8(n + i, 0);
  }

  reverse_rows(): void {
    const e = this.spec.bytesPerRecord;
    const t = new Uint8Array(e);
    const n = new Uint8Array(this.data);
    const r = this.length;
    if (r <= 1) return;
    const s = r - 1;
    const a = s >>> 1;
    for (let i = 0; i <= a; i++) {
      const off = i * e;
      copyArrayRange(n, off, t, 0, e);
      const j = (s - i) * e;
      n.copyWithin(off, j, j + e);
      n.set(t, j);
    }
  }

  clear(): void {
    this.length = 0;
    this.setCapacity(0);
  }

  toRowArray(): unknown[][] {
    const e: unknown[][] = [];
    for (let t = 0; t < this.length; t++) {
      e.push(this.readRow(t));
    }
    return e;
  }

  printToConsole(): void {
    console.table(this.toRowArray());
  }

  copy(e: StructuredTable): void {
    if (!this.spec.equals(e.spec)) throw new Error("Different table specs");
    const t = e.length;
    this.resize(t);
    this.length = e.length;
    copyArrayBufferRange(
      e.data,
      0,
      this.data,
      0,
      e.spec.bytesPerRecord * t
    );
  }

  equals(e: StructuredTable | null | undefined): boolean {
    if (e === this) return true;
    if (e == null) return false;
    if (!this.spec.equals(e.spec)) return false;
    const t = this.length;
    if (t !== e.length) return false;
    const n = t * this.spec.bytesPerRecord;
    const r = this.dataView;
    const s = e.dataView;
    for (let i = 0; i < n; i++) {
      if (r.getUint8(i) !== s.getUint8(i)) return false;
    }
    return true;
  }
}


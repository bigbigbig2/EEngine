/**
 * ShadeDataType：负责纹理数据、采样参数和 GPU 纹理资源管理。
 */

export const ShadeDataType = {
  Uint8: "uint8",
  Uint16: "uint16",
  Uint32: "uint32",
  Uint64: "uint64",
  Int8: "int8",
  Int16: "int16",
  Int32: "int32",
  Int64: "int64",
  Float16: "float16",
  Float32: "float32",
  Float64: "float64"
} as const;

export type ShadeDataTypeName = (typeof ShadeDataType)[keyof typeof ShadeDataType];

export function inferDataTypeFromArray(data: ArrayLike<number> | ArrayBufferView): string {
  const ctor = (Object.getPrototypeOf(data) as { constructor: Function }).constructor;
  const float16Ctor = float16ArrayCtor();
  switch (ctor) {
    case Uint8Array:
    case Uint8ClampedArray:
      return ShadeDataType.Uint8;
    case Uint16Array:
      return ShadeDataType.Uint16;
    case Uint32Array:
      return ShadeDataType.Uint32;
    case Int8Array:
      return ShadeDataType.Int8;
    case Int16Array:
      return ShadeDataType.Int16;
    case Int32Array:
      return ShadeDataType.Int32;
    case Float32Array:
      return ShadeDataType.Float32;
    case float16Ctor:
      return ShadeDataType.Float16;
    case Array:
    case Float64Array:
      return ShadeDataType.Float64;
    default:
      throw new Error(`unsupported constructor type ${String(ctor)}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TypedArrayCtor = new (lengthOrBuffer: any, byteOffset?: number, length?: number) => ArrayBufferView &
  ArrayLike<number>;

function float16ArrayCtor(): TypedArrayCtor | undefined {
  const g = globalThis as { Float16Array?: TypedArrayCtor };
  return typeof g.Float16Array === "function" ? g.Float16Array : undefined;
}

const DATA_TYPE_CTOR: Record<string, TypedArrayCtor | undefined> = {
  [ShadeDataType.Uint8]: Uint8Array,
  [ShadeDataType.Uint16]: Uint16Array,
  [ShadeDataType.Uint32]: Uint32Array,
  [ShadeDataType.Int8]: Int8Array,
  [ShadeDataType.Int16]: Int16Array,
  [ShadeDataType.Int32]: Int32Array,
  [ShadeDataType.Float16]: float16ArrayCtor(),
  [ShadeDataType.Float32]: Float32Array,
  [ShadeDataType.Float64]: Float64Array
};

export function ctorFromDataType(e: string): TypedArrayCtor {
  if (e === ShadeDataType.Float16) {
    const f16 = float16ArrayCtor();
    if (f16) return f16;
    throw new Error(`Unsupported data type '${e}'`);
  }
  const t = DATA_TYPE_CTOR[e];
  if (t === undefined) throw new Error(`Unsupported data type '${e}'`);
  return t;
}

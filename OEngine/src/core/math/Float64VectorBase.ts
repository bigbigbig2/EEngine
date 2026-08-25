/**
 * Float64VectorBase：提供渲染系统使用的数学运算与基础数据结构。
 */

export type Float64VectorStorage = Omit<
  Float64Array,
  "length" | "set" | "toString"
>;

export const Float64VectorBase = Float64Array as unknown as {
  new (length: number): Float64VectorStorage;
};

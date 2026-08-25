/**
 * enums：定义材质参数、着色模型或材质资源绑定。
 */

export const ShadeDrawMode = {
  Points: 0,
  Lines: 1,
  Triangles: 2
} as const;
export type ShadeDrawMode = (typeof ShadeDrawMode)[keyof typeof ShadeDrawMode];

export const ShadeDrawSide = {
  Front: 0,
  Double: 1,
  Back: 2
} as const;
export type ShadeDrawSide = (typeof ShadeDrawSide)[keyof typeof ShadeDrawSide];

export const ShadeTransparencyMode = {
  Opaque: 0,
  AlphaTested: 1,
  Transparent: 2
} as const;
export type ShadeTransparencyMode =
  (typeof ShadeTransparencyMode)[keyof typeof ShadeTransparencyMode];

/**
 * ShadeIndirectLightingMode：负责渲染管线编排、视图状态或渲染目标管理。
 */

export const ShadeIndirectLightingMode: { IBL: number; Brick4: number; LPV: number } = {
  IBL: 0,
  Brick4: 1,
  LPV: 2
};

export type ShadeIndirectLightingMode = number;

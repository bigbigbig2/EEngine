/**
 * TextureFilterType：负责纹理数据、采样参数和 GPU 纹理资源管理。
 */

export const TextureFilterType: {
  Nearest: number;
  Linear: number;
  Mitchell: number;
  LinearNormal: number;
  MagicKernelSharp: number;
  CatmullRom: number;
  Wronski2021: number;
} = {
  Nearest: 0,
  Linear: 1,
  Mitchell: 2,
  LinearNormal: 3,
  MagicKernelSharp: 4,
  CatmullRom: 5,
  Wronski2021: 6
};

export type TextureFilterType = number;

/**
 * ShadeTextureFlags：负责纹理数据、采样参数和 GPU 纹理资源管理。
 */

export const ShadeTextureFlags: { GenerateMipMaps: number } = {
  GenerateMipMaps: 1
};

export type ShadeTextureFlags = number;

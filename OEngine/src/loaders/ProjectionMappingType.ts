/**
 * ProjectionMappingType：负责资源读取、解码或场景装载。
 */

export const ProjectionMappingType: { Equirectangular: number; Octahedral: number } = {
  Equirectangular: 0,
  Octahedral: 1
};

export type ProjectionMappingType = number;

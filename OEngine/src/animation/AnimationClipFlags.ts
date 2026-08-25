/**
 * AnimationClipFlags：提供动画数据、曲线采样或蒙皮更新能力。
 */

export const AnimationClipFlags: { Playing: number; Loop: number } = {
  Playing: 1,
  Loop: 2
};

export type AnimationClipFlags = number;

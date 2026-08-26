/** Compute HZB 的 CPU 数值参考。生产渲染不调用本模块中的金字塔构建。 */

export type HzbLevel = {
  readonly width: number;
  readonly height: number;
  /** 每个 texel 依次保存 reverse-Z 的 farthest(min)、nearest(max)。 */
  readonly minMax: Float32Array;
};

export function hzbMipLevelCount(width: number, height: number): number {
  const maximum = Math.max(Math.floor(width), Math.floor(height));
  return maximum <= 0 ? 0 : Math.floor(Math.log2(maximum)) + 1;
}

export function hzbLevelDimensions(
  width: number,
  height: number,
  mip: number
): readonly [number, number] {
  if (mip < 0 || !Number.isInteger(mip)) {
    throw new RangeError(`HZB mip must be a non-negative integer, got ${mip}`);
  }
  return [
    Math.max(1, Math.floor(width) >> mip),
    Math.max(1, Math.floor(height) >> mip)
  ];
}

export function sanitizeReverseZDepth(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function coverageBounds(
  outputCoordinate: number,
  sourceSize: number,
  outputSize: number
): readonly [number, number] {
  const first = Math.floor(outputCoordinate * sourceSize / outputSize);
  const end = Math.ceil((outputCoordinate + 1) * sourceSize / outputSize);
  return [Math.max(0, first), Math.min(sourceSize, Math.max(first + 1, end))];
}

export function reduceDepthToHzbLevel(
  source: ArrayLike<number>,
  sourceWidth: number,
  sourceHeight: number,
  outputWidth = Math.max(1, Math.floor(sourceWidth) >> 1),
  outputHeight = Math.max(1, Math.floor(sourceHeight) >> 1)
): HzbLevel {
  if (sourceWidth < 1 || sourceHeight < 1) {
    throw new RangeError("HZB source dimensions must be positive");
  }
  if (source.length < sourceWidth * sourceHeight) {
    throw new RangeError("HZB depth source is smaller than its dimensions");
  }
  const minMax = new Float32Array(outputWidth * outputHeight * 2);
  for (let oy = 0; oy < outputHeight; oy++) {
    const [firstY, endY] = coverageBounds(oy, sourceHeight, outputHeight);
    for (let ox = 0; ox < outputWidth; ox++) {
      const [firstX, endX] = coverageBounds(ox, sourceWidth, outputWidth);
      let farthest = 1;
      let nearest = 0;
      for (let sy = firstY; sy < endY; sy++) {
        for (let sx = firstX; sx < endX; sx++) {
          const depth = sanitizeReverseZDepth(source[sy * sourceWidth + sx]!);
          farthest = Math.min(farthest, depth);
          nearest = Math.max(nearest, depth);
        }
      }
      const output = (oy * outputWidth + ox) * 2;
      minMax[output] = farthest;
      minMax[output + 1] = nearest;
    }
  }
  return { width: outputWidth, height: outputHeight, minMax };
}

export function reduceHzbLevel(source: HzbLevel): HzbLevel {
  const outputWidth = Math.max(1, source.width >> 1);
  const outputHeight = Math.max(1, source.height >> 1);
  const output = new Float32Array(outputWidth * outputHeight * 2);
  for (let oy = 0; oy < outputHeight; oy++) {
    const [firstY, endY] = coverageBounds(oy, source.height, outputHeight);
    for (let ox = 0; ox < outputWidth; ox++) {
      const [firstX, endX] = coverageBounds(ox, source.width, outputWidth);
      let farthest = 1;
      let nearest = 0;
      for (let sy = firstY; sy < endY; sy++) {
        for (let sx = firstX; sx < endX; sx++) {
          const input = (sy * source.width + sx) * 2;
          farthest = Math.min(farthest, source.minMax[input]!);
          nearest = Math.max(nearest, source.minMax[input + 1]!);
        }
      }
      const destination = (oy * outputWidth + ox) * 2;
      output[destination] = farthest;
      output[destination + 1] = nearest;
    }
  }
  return { width: outputWidth, height: outputHeight, minMax: output };
}

export function buildHzbReference(
  depth: ArrayLike<number>,
  width: number,
  height: number
): readonly HzbLevel[] {
  const firstWidth = Math.max(1, Math.floor(width) >> 1);
  const firstHeight = Math.max(1, Math.floor(height) >> 1);
  const levels: HzbLevel[] = [
    reduceDepthToHzbLevel(depth, width, height, firstWidth, firstHeight)
  ];
  const count = hzbMipLevelCount(firstWidth, firstHeight);
  while (levels.length < count) {
    levels.push(reduceHzbLevel(levels[levels.length - 1]!));
  }
  return levels;
}

/** reverse-Z：候选物体最近深度仍在遮挡物最远深度之后时才可拒绝。 */
export function isReverseZOccluded(
  candidateNearestDepth: number,
  hzbFarthestDepth: number,
  epsilon = 1e-6
): boolean {
  const candidate = sanitizeReverseZDepth(candidateNearestDepth);
  const occluder = sanitizeReverseZDepth(hzbFarthestDepth);
  return candidate + Math.max(0, epsilon) < occluder;
}

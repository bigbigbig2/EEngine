/**
 * HilbertNoiseTexture：负责渲染管线编排、视图状态或渲染目标管理。
 */

import { Sampler2D } from "../texture/Sampler2D.js";
import { ShadeImage } from "../texture/ShadeImage.js";
import { ShadeTexture } from "../texture/ShadeTexture.js";
import { ShadeTextureFlags } from "../texture/ShadeTextureFlags.js";
import { TextureFilterType } from "../texture/TextureFilterType.js";

export const HILBERT_NOISE_SIZE = 64;

export function hilbertIndex(
  xValue: number,
  yValue: number,
  size: number
): number {
  let index = 0;
  let x = xValue;
  let y = yValue;
  for (let scale = size >>> 1; scale >= 1; scale >>>= 1) {
    const xBit = (x & scale) > 0 ? 1 : 0;
    const yBit = (y & scale) > 0 ? 1 : 0;
    index += scale * scale * ((3 * xBit) ^ yBit);
    if (yBit === 0) {
      if (xBit === 1) {
        x = size - 1 - x;
        y = size - 1 - y;
      }
      const swap = x;
      x = y;
      y = swap;
    }
  }
  return index;
}

function createHilbertNoiseTexture(): ShadeTexture {
  const data = new Uint16Array(HILBERT_NOISE_SIZE * HILBERT_NOISE_SIZE);
  for (let y = 0; y < HILBERT_NOISE_SIZE; y++) {
    for (let x = 0; x < HILBERT_NOISE_SIZE; x++) {
      data[y * HILBERT_NOISE_SIZE + x] = hilbertIndex(
        x,
        y,
        HILBERT_NOISE_SIZE
      );
    }
  }

  const image = ShadeImage.fromSampler2D(
    new Sampler2D(data, 1, HILBERT_NOISE_SIZE, HILBERT_NOISE_SIZE)
  );
  image.color_space = 0;
  image.normalized = false;

  const texture = ShadeTexture.from(image);
  texture.minFilter = TextureFilterType.Nearest;
  texture.magFilter = TextureFilterType.Nearest;
  texture.wrapS = 1;
  texture.wrapT = 1;
  texture.clearFlag(ShadeTextureFlags.GenerateMipMaps);
  return texture;
}

export const HILBERT_NOISE_TEXTURE = createHilbertNoiseTexture();

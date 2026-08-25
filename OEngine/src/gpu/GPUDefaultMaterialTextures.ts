/**
 * GPUDefaultMaterialTextures：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import { Sampler2D } from "../texture/Sampler2D.js";
import { ShadeImage } from "../texture/ShadeImage.js";
import { ShadeTexture } from "../texture/ShadeTexture.js";
import { ShadeTextureFlags } from "../texture/ShadeTextureFlags.js";
import { TextureFilterType } from "../texture/TextureFilterType.js";

function createSolidShadeTexture(
  rgba: readonly [number, number, number, number]
): ShadeTexture {
  const image = ShadeImage.fromSampler2D(
    new Sampler2D(new Uint8Array(rgba), 4, 1, 1)
  );
  image.color_space = 2;
  const texture = ShadeTexture.from(image);
  texture.wrapS = 0;
  texture.wrapT = 0;
  texture.mipmapFilter = TextureFilterType.Nearest;
  texture.minFilter = TextureFilterType.Nearest;
  texture.magFilter = TextureFilterType.Nearest;
  texture.clearFlag(ShadeTextureFlags.GenerateMipMaps);
  return texture;
}

export const DEFAULT_MATERIAL_WHITE_TEXTURE = createSolidShadeTexture(
  [255, 255, 255, 255]
);

export const DEFAULT_MATERIAL_BLACK_TEXTURE = createSolidShadeTexture(
  [0, 0, 0, 255]
);

export const DEFAULT_MATERIAL_NORMAL_TEXTURE = createSolidShadeTexture(
  [128, 128, 255, 255]
);
DEFAULT_MATERIAL_NORMAL_TEXTURE.label = "normal";


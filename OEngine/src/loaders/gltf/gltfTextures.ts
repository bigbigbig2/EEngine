/**
 * gltfTextures：解析 glTF 数据并转换为引擎运行时对象。
 */

import { ShadeImage, ShadeTexture } from "../../texture/ShadeTexture.js";
import { TextureFilterType } from "../../texture/TextureFilterType.js";
import type { GltfDocument } from "./GltfLoader.js";
import { dedupeByHashEquals } from "./gltfDedup.js";

const GL_NEAREST = 9728;
const GL_LINEAR = 9729;
const GL_NEAREST_MIPMAP_NEAREST = 9984;
const GL_LINEAR_MIPMAP_NEAREST = 9985;
const GL_NEAREST_MIPMAP_LINEAR = 9986;
const GL_LINEAR_MIPMAP_LINEAR = 9987;

const FILTER_MAP: Record<number, number> = {
  [GL_NEAREST]: TextureFilterType.Nearest,
  [GL_LINEAR]: TextureFilterType.Linear,
  [GL_NEAREST_MIPMAP_NEAREST]: TextureFilterType.Nearest,
  [GL_LINEAR_MIPMAP_NEAREST]: TextureFilterType.Nearest,
  [GL_NEAREST_MIPMAP_LINEAR]: TextureFilterType.Linear,
  [GL_LINEAR_MIPMAP_LINEAR]: TextureFilterType.Linear
};

const WRAP_MAP: Record<number, number> = {
  33071: 0,
  33648: 2,
  10497: 1
};

const DEFAULT_SAMPLER: GltfSamplerDef = {};

function mipmapFilterFromMin(minFilter: number | undefined): number {
  if (minFilter === undefined) return TextureFilterType.Linear;
  switch (minFilter) {
    case GL_LINEAR_MIPMAP_NEAREST:
    case GL_LINEAR_MIPMAP_LINEAR:
      return TextureFilterType.Linear;
    default:
      return TextureFilterType.Nearest;
  }
}

export interface GltfSamplerDef {
  magFilter?: number;
  minFilter?: number;
  wrapS?: number;
  wrapT?: number;
}

export interface GltfTextureDef {
  source?: number;
  sampler?: number;
  extensions?: {
    EXT_texture_webp?: { source?: number };
  };
}

export function imageFromBitmap(bitmap: ImageBitmap): ShadeImage {
  return ShadeImage.fromImageBitmap(bitmap);
}

export function textureFromGltf(
  texDef: GltfTextureDef,
  images: (ShadeImage | undefined)[],
  samplers: GltfSamplerDef[] | undefined
): ShadeTexture {
  let sourceIndex: number | undefined;
  const s = texDef.extensions;
  if (s !== undefined) sourceIndex = s.EXT_texture_webp?.source;
  if (sourceIndex === undefined) sourceIndex = texDef.source;
  const img = images[sourceIndex!]!;

  const a: GltfSamplerDef =
    texDef.sampler === undefined ? DEFAULT_SAMPLER : samplers![texDef.sampler]!;

  const i = ShadeTexture.from(img);
  i.magFilter = FILTER_MAP[a.magFilter ?? -1] ?? TextureFilterType.Linear;
  i.minFilter = FILTER_MAP[a.minFilter ?? -1] ?? TextureFilterType.Linear;
  i.mipmapFilter = mipmapFilterFromMin(a.minFilter);
  i.wrapS = WRAP_MAP[a.wrapS ?? -1] ?? 1;
  i.wrapT = WRAP_MAP[a.wrapT ?? -1] ?? 1;
  return i;
}

export function buildGltfTextures(doc: GltfDocument): ShadeTexture[] {
  const rawImages = (doc.images ?? []) as ImageBitmap[];
  const u = rawImages.map(imageFromBitmap);
  const texDefs = (doc.textures ?? []) as GltfTextureDef[];
  const samplers = doc.samplers as GltfSamplerDef[] | undefined;
  const h = texDefs.map((t) => {
    return textureFromGltf(t, u, samplers);
  });
  dedupeByHashEquals(h);
  return h;
}

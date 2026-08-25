/**
 * ShadeTexture：负责纹理数据、采样参数和 GPU 纹理资源管理。
 */

import { hashMix, hashOptional } from "../core/hashMix.js";
import { ShadeTextureFlags } from "./ShadeTextureFlags.js";
import { TextureFilterType } from "./TextureFilterType.js";
import { ShadeImage } from "./ShadeImage.js";

export { ShadeImage, ShadeImageStub } from "./ShadeImage.js";
export type { Sampler2DLike } from "./ShadeImage.js";
export { ShadeDataType, inferDataTypeFromArray } from "./ShadeDataType.js";
export type { ShadeDataTypeName } from "./ShadeDataType.js";
export { Sampler2D } from "./Sampler2D.js";
export type { SamplerData } from "./Sampler2D.js";

export class ShadeTexture {
  label = "";

  #image: ShadeImage | undefined;

  get isShadeTexture(): boolean {
    return true;
  }

  get image(): ShadeImage | undefined {
    return this.#image;
  }

  setFlag(flag: number): void {
    this.flags |= flag;
  }

  clearFlag(flag: number): void {
    this.flags &= ~flag;
  }

  writeFlag(flag: number, value: boolean): void {
    if (value) this.setFlag(flag);
    else this.clearFlag(flag);
  }

  getFlag(flag: number): boolean {
    return (this.flags & flag) === flag;
  }

  flags: number = ShadeTextureFlags.GenerateMipMaps;

  minFilter: number = TextureFilterType.Linear;
  magFilter: number = TextureFilterType.Linear;
  mipmapFilter: number = TextureFilterType.Linear;

  wrapS = 1;
  wrapT = 1;
  wrapR = 1;

  dimensions = 2;

  mipmapGenerationFilter: number = TextureFilterType.Linear;

  static from(source: ShadeImage): ShadeTexture {
    const t = new ShadeTexture();
    t.#image = source;
    t.dimensions = source.depth > 1 ? 3 : 2;
    return t;
  }

  hash(): number {
    return hashMix(
      hashOptional(this.#image),
      this.flags,
      this.minFilter,
      this.magFilter,
      this.mipmapFilter,
      this.wrapS,
      this.wrapT,
      this.wrapR
    );
  }

  equals(other: ShadeTexture): boolean {
    return (
      this.#image === other.#image &&
      this.flags === other.flags &&
      this.minFilter === other.minFilter &&
      this.magFilter === other.magFilter &&
      this.mipmapFilter === other.mipmapFilter &&
      this.wrapS === other.wrapS &&
      this.wrapT === other.wrapT &&
      this.wrapR === other.wrapR
    );
  }
}

export type { ShadeImage as ShadeImageType };

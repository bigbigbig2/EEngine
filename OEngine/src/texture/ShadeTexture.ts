/**
 * ShadeTexture：负责纹理数据、采样参数和 GPU 纹理资源管理。
 */

import { hashMix, hashOptional } from "../core/hashMix.js";
import { hashString } from "../core/memoryUtils.js";
import type { ImageTextureSource } from "../assets/ImageTextureSource.js";
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
  /**
   * Globally unique immutable raw-source content key (hash or URI + version).
   * Equal keys assert identical source data; a per-texture counter alone is insufficient.
   * Assign before cook/upload. When bytes change, replace both the immutable raw
   * image source and its ShadeTexture, then republish. Cooked sources
   * use their assetId automatically. Unversioned images produce session-local products.
   * This is CPU provenance, not a GPU residency generation or per-frame upload trigger.
   */
  private appearanceContentVersion: string | undefined;
  get appearance_content_version(): string | undefined {
    return this.appearanceContentVersion;
  }
  set appearance_content_version(value: string | undefined) {
    if (value !== undefined && (typeof value !== "string" || value.length === 0))
      throw new RangeError("Appearance content version must be nonempty");
    if (this.appearanceContentVersion !== undefined && value !== this.appearanceContentVersion) {
      throw new Error("Replace the immutable raw image and ShadeTexture for a new content version");
    }
    this.appearanceContentVersion = value;
  }

  #image: ShadeImage | undefined;
  #imageSource: ImageTextureSource | undefined;

  get isShadeTexture(): boolean {
    return true;
  }

  get image(): ShadeImage | undefined {
    return this.#image;
  }

  /** Device-independent cooked source consumed by TextureResidency. */
  get image_source(): ImageTextureSource | undefined {
    return this.#imageSource;
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

  static fromImageSource(source: ImageTextureSource): ShadeTexture {
    const texture = new ShadeTexture();
    texture.#imageSource = source;
    texture.flags = 0;
    const plane = source.directory.planes[0]!;
    const address = (mode: string) => mode === "repeat" ? 1 : mode === "mirror-repeat" ? 2 : 0;
    texture.wrapS = address(plane.addressU);
    texture.wrapT = address(plane.addressV);
    return texture;
  }

  hash(): number {
    return hashMix(
      this.appearance_content_version === undefined ? 0 : hashString(this.appearance_content_version),
      hashOptional(this.#image),
      this.#imageSource === undefined ? 0 : hashString(this.#imageSource.identity),
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
      this.appearance_content_version === other.appearance_content_version &&
      this.#image === other.#image &&
      this.#imageSource === other.#imageSource &&
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

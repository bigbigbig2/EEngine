/**
 * STATIC_GRAPHICS_ENGINE_ASSETS：负责渲染管线编排、视图状态或渲染目标管理。
 */

import { ShadeTexture } from "../texture/ShadeTexture.js";
import { ShadeTextureFlags } from "../texture/ShadeTextureFlags.js";
import { load_shade_image_from_url } from "../texture/deserialize_shade_image.js";

export const STATIC_GRAPHICS_ENGINE_ASSETS = new (class {
  stbn_vec1!: ShadeTexture;
  stbn_vec2!: ShadeTexture;
  stbn_vec3!: ShadeTexture;
  split_sum!: ShadeTexture;

  #initialization: Promise<void> | undefined;

  init(): Promise<void> {
    if (this.#initialization === undefined) {
      this.#initialization = this.#load();
    }
    return this.#initialization;
  }

  async #load(): Promise<void> {
    const url = (name: string): string =>
      new URL(`./assets/textures/${name}`, import.meta.url).href;
    const [stbnVec1, stbnVec2, stbnVec3, splitSum] = await Promise.all([
      load_shade_image_from_url(url("stbn_vec1.bin")),
      load_shade_image_from_url(url("stbn_vec2.bin")),
      load_shade_image_from_url(url("stbn_vec3.bin")),
      load_shade_image_from_url(url("split_sum.bin"))
    ]);

    this.stbn_vec1 = ShadeTexture.from(stbnVec1);
    this.stbn_vec2 = ShadeTexture.from(stbnVec2);
    this.stbn_vec3 = ShadeTexture.from(stbnVec3);
    this.stbn_vec1.clearFlag(ShadeTextureFlags.GenerateMipMaps);
    this.stbn_vec2.clearFlag(ShadeTextureFlags.GenerateMipMaps);
    this.stbn_vec3.clearFlag(ShadeTextureFlags.GenerateMipMaps);
    this.split_sum = ShadeTexture.from(splitSum);
    this.split_sum.clearFlag(ShadeTextureFlags.GenerateMipMaps);
  }
})();

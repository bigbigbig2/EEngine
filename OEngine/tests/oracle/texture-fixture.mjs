import { initializePcTextureCodecs, cookPcTextureRgba } from "../../.test-dist/assets/codec/PcTextureCook.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";

let codecs;
export async function fixtureTexture(semantic, mips, exactAlpha = false) {
  codecs ??= initializePcTextureCodecs();
  const first = mips[0];
  const { product } = await cookPcTextureRgba(
    await codecs,
    first.payload,
    first.logicalWidth,
    first.logicalHeight,
    { semantic, exactAlpha, sourceUri: "fixture://native-bc" },
    mips.slice(1).map((mip) => mip.payload),
  );
  return ShadeTexture.fromProduct(product);
}

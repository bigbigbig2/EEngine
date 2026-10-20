import createKtxPcModule from "./vendor/pc-texture/ktx_pc.js";
import createImageDecodeModule from "./vendor/image-import/image_decode.js";
import { imageMipCount, imageTextureHash } from "../ImageTextureProduct.js";
import type { CanonicalImageMip } from "./ImageTextureCook.js";

/** libktx remains a cold container/import dependency, never a final BC source.
 * Authored complete chains survive the conversion to canonical image items. */
export async function importCanonicalKtx(input: ArrayBuffer, color: boolean): Promise<CanonicalImageMip[]> {
  const identityResponse = await fetch(new URL("./vendor/pc-texture/source.json", import.meta.url));
  if (!identityResponse.ok) throw new Error("KTX import identity fetch failed");
  const identity = await identityResponse.json();
  if (identity.pins.ktx !== "4d6fc70eaf62ad0558e63e8d97eb9766118327a6") throw new Error("KTX revision mismatch");
  const binaryResponse = await fetch(new URL("./vendor/pc-texture/ktx_pc.wasm", import.meta.url));
  if (!binaryResponse.ok) throw new Error("KTX import binary fetch failed");
  const wasmBinary = await binaryResponse.arrayBuffer();
  if (await imageTextureHash(new Uint8Array(wasmBinary)) !== identity.hashes["ktx_pc.wasm"]) throw new Error("KTX binary hash mismatch");
  const native = await createKtxPcModule({ wasmBinary });
  const texture = new native.Texture(new Uint8Array(input), true);
  try {
    if (texture.status() !== 0) throw new Error(`KTX metadata: ${texture.message()}`);
    const width = texture.get(0), height = texture.get(1), levels = texture.get(4);
    const transfer = texture.get(9), format = texture.get(11), transcode = texture.get(12) !== 0;
    if (texture.get(3) !== 2 || texture.get(2) > 1 || texture.get(5) > 1 ||
        texture.get(6) !== 1 || texture.get(7) !== 0 ||
        width < 1 || height < 1 || width > 2048 || height > 2048 ||
        levels < 1 || levels > imageMipCount(width, height) ||
        ![1, 2].includes(transfer) ||
        (transcode ? ![163, 166].includes(texture.get(8)) : ![37, 43, 139, 145, 146].includes(format))) {
      throw new Error("KTX input is outside the admitted canonical 2D import profile");
    }
    const outputBytes = Math.ceil(width * height * 4 * 4 / 3) + levels * 16;
    if (input.byteLength + texture.get(13) + outputBytes + 16 * 1024 ** 2 > 96 * 1024 ** 2) {
      throw new RangeError("KTX complete decode exceeds the admitted native heap");
    }
    if (texture.load() !== 0 || (transcode && texture.transcode(13) !== 0)) {
      throw new Error(`KTX canonical decode: ${texture.message()}`);
    }
    let decoder;
    if (!transcode && [139, 145, 146].includes(format)) {
      const receipt = await (await fetch(new URL("./vendor/image-import/source.json", import.meta.url))).json();
      const response = await fetch(new URL("./vendor/image-import/image_decode.wasm", import.meta.url));
      if (!response.ok || receipt.revision !== "99f52d63aa6799cbdaecfe977111dc5ec3b31d47") throw new Error("Cold block decoder identity unavailable");
      const binary = await response.arrayBuffer();
      if (await imageTextureHash(new Uint8Array(binary)) !== receipt.hashes["image_decode.wasm"]) throw new Error("Cold block decoder hash mismatch");
      decoder = await createImageDecodeModule({ wasmBinary: binary });
    }
    const inputs: CanonicalImageMip[] = [];
    for (let level = 0; level < (levels === imageMipCount(width, height) ? levels : 1); level++) {
      const w = Math.max(1, Math.floor(width / 2 ** level));
      const h = Math.max(1, Math.floor(height / 2 ** level));
      const encoded = texture.image(level);
      let rgba: Uint8Array;
      if (decoder) {
        const bytes = Math.ceil(w / 4) * Math.ceil(h / 4) * (format === 139 ? 8 : 16);
        if (encoded.length !== bytes) throw new Error("KTX BC payload domain mismatch");
        let source = 0, destination = 0;
        try {
          source = decoder._malloc(bytes);
          destination = decoder._malloc(w * h * 4);
          if (!source || !destination) throw new Error("Cold decode allocation failed");
          decoder.HEAPU8.set(encoded, source);
          if (decoder._image_decode(source, w, h, format === 139 ? 4 : 7, destination) !== 1) throw new Error("Cold BC decode failed");
          rgba = decoder.HEAPU8.slice(destination, destination + w * h * 4);
          if (format === 139) {
            for (let at = 0; at < rgba.length; at += 4) rgba[at + 1] = rgba[at + 2] = rgba[at]!;
          }
        } finally {
          if (source) decoder._free(source);
          if (destination) decoder._free(destination);
        }
      } else {
        if (encoded.length !== w * h * 4) throw new Error("KTX RGBA payload domain mismatch");
        rgba = encoded.slice();
      }
      if ((transfer === 2) !== color) {
        for (let at = 0; at < rgba.length; at++) {
          if (at % 4 === 3) continue;
          const value = rgba[at]! / 255;
          const converted = transfer === 2
            ? (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
            : (value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055);
          rgba[at] = Math.round(Math.min(1, Math.max(0, converted)) * 255);
        }
      }
      inputs.push({ width: w, height: h, rgba });
    }
    return inputs;
  } finally {
    texture.delete();
  }
}

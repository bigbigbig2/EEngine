import {
  validateTextureProduct,
  textureProductHash,
  pcTextureStorageExtent,
  pcTextureFormat,
  textureProductMipCount,
} from "../../.test-dist/assets/TextureProduct.js";
import {
  encodedTextureMipByteLength,
  physicalTextureExtent,
} from "../../.test-dist/assets/codec/TextureFormatLayout.js";

// Structural blocks are only used with fake devices. GPU fixtures use the pinned encoder.
export async function textureProduct(
  width = 16,
  height = width,
  semantic = "orm-linear",
  exactAlpha = false,
  seed = 1,
) {
  const [storageWidth, storageHeight] = pcTextureStorageExtent(width, height);
  const chunks = new Map(),
    planes = [];
  const roles =
    semantic === "alpha-mask"
      ? ["coverage"]
      : exactAlpha
        ? ["color", "coverage"]
        : [semantic === "occlusion-linear" ? "scalar" : "color"];
  for (const role of roles) {
    const format = role === "coverage" ? "r8unorm" : pcTextureFormat(semantic),
      mips = [];
    for (let level = 0; level < textureProductMipCount(storageWidth, storageHeight); level++) {
      const w = Math.max(1, storageWidth >> level),
        h = Math.max(1, storageHeight >> level);
      const [physicalWidth, physicalHeight] = physicalTextureExtent(format, w, h);
      const payload = new Uint8Array(encodedTextureMipByteLength(format, w, h)).fill(seed);
      const chunkId = `${role}-mip-${level}`;
      chunks.set(chunkId, payload);
      mips.push({
        level,
        width: w,
        height: h,
        physicalWidth,
        physicalHeight,
        byteLength: payload.byteLength,
        chunkId,
        hash: await textureProductHash(payload),
      });
    }
    planes.push({ role, format, mips });
  }
  return validateTextureProduct(
    {
      schemaVersion: 3,
      sourceWidth: width,
      sourceHeight: height,
      storageWidth,
      storageHeight,
      sourceBytes: width * height * 4,
      sourceHash: await textureProductHash(new Uint8Array([seed])),
      sourceUri: "fixture://structural",
      semantic,
      channel: 0,
      exactAlpha: exactAlpha || semantic === "alpha-mask",
      uvScaleBias: [1, 1, 0, 0],
      recipe: {
        encoder: "structural-test-only",
        revision: "1",
        binaryHash: "a".repeat(64),
        filter: "provided",
        quality: "external-final",
      },
      planes,
    },
    chunks,
  );
}

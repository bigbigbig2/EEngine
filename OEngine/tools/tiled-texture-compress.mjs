import { zstdCompressSync, constants } from "node:zlib";

export const tiledCompressionIdentity = Object.freeze({
  codec: "zstd-bc-v1",
  version: "1.5.7",
  level: 9,
  checksum: true,
  contentSize: true,
  dictionary: false,
  encoder: "node:zlib",
  node: process.version,
  zstd: process.versions.zstd,
});

export async function compressTiledTexturePage(bytes) {
  if (
    process.versions.zstd !== tiledCompressionIdentity.version ||
    (bytes.byteLength !== 10368 && bytes.byteLength !== 20736)
  ) {
    throw new Error("Tiled compression requires Zstd 1.5.7 and one BC physical page");
  }
  // Node's streaming async convenience encoder omits the pledged content size.
  // One-shot compression preserves the fixed single-page frame contract.
  const result = zstdCompressSync(bytes, {
    params: {
      [constants.ZSTD_c_compressionLevel]: 9,
      [constants.ZSTD_c_checksumFlag]: 1,
      [constants.ZSTD_c_contentSizeFlag]: 1,
      [constants.ZSTD_c_dictIDFlag]: 0,
      [constants.ZSTD_c_nbWorkers]: 0,
    },
  });
  return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
}

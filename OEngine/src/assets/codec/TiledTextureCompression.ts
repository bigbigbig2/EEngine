export const TILED_TEXTURE_TRANSPORT = Object.freeze({
  codec: "zstd-bc-v1",
  encoderVersion: "1.5.7",
  level: 9,
  checksum: true,
  contentSize: true,
  dictionary: false,
} as const);

export const TILED_ZSTD_MEMORY_BYTES = 4 * 1024 * 1024;

/** ZSTD_COMPRESSBOUND from the pinned 1.5.7, restricted to one physical BC tile. */
export function tiledTextureCompressedBound(nativeBytes: number): number {
  if (nativeBytes !== 20736 && nativeBytes !== 10368) {
    throw new RangeError("Tiled Zstd output must be one BC7/BC4 page");
  }
  return nativeBytes + (nativeBytes >> 8) + ((131072 - nativeBytes) >> 11);
}

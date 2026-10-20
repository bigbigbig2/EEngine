import createTiledZstdModule from "./vendor/tiled-zstd/tiled_zstd.js";
import { TILED_ZSTD_WASM_BYTES, TILED_ZSTD_WASM_HASH } from "./vendor/tiled-zstd/identity.js";
import { TILED_ZSTD_MEMORY_BYTES, tiledTextureCompressedBound } from "./TiledTextureCompression.js";
import { textureProductHash } from "../TextureProduct.js";

/** One sequential decoder per Worker; its input/output arena never escapes. */
export async function createTiledTextureDecoder(binary: ArrayBuffer) {
  if (
    binary.byteLength !== TILED_ZSTD_WASM_BYTES ||
    (await textureProductHash(new Uint8Array(binary))) !== TILED_ZSTD_WASM_HASH
  ) {
    throw new Error("Tiled Zstd binary identity mismatch");
  }
  const module = await createTiledZstdModule({ wasmBinary: binary });
  if (module.HEAPU8.byteLength !== TILED_ZSTD_MEMORY_BYTES || module._tiled_init() !== 1) {
    throw new Error("Tiled Zstd fixed workspace initialization failed");
  }
  const input = module._tiled_input();
  const output = module._tiled_output();
  return {
    memoryBytes: module.HEAPU8.byteLength,
    decode(encoded: Uint8Array, nativeBytes: number): ArrayBuffer {
      if (!encoded.byteLength || encoded.byteLength > tiledTextureCompressedBound(nativeBytes)) {
        throw new RangeError("Tiled Zstd encoded domain exceeds page bound");
      }
      module.HEAPU8.set(encoded, input);
      const result = module._tiled_decode(encoded.byteLength, nativeBytes);
      if (result !== nativeBytes) {
        throw new Error(`Tiled Zstd frame rejected (${result})`);
      }
      return module.HEAPU8.slice(output, output + nativeBytes).buffer as ArrayBuffer;
    },
  };
}

export async function loadTiledTextureDecoder() {
  const response = await fetch(new URL("./vendor/tiled-zstd/tiled_zstd.wasm", import.meta.url));
  if (
    !response.ok ||
    (response.headers.get("content-encoding") ?? "identity") !== "identity" ||
    response.headers.get("content-length") !== String(TILED_ZSTD_WASM_BYTES)
  ) {
    await response.body?.cancel();
    throw new Error("Tiled Zstd binary response exceeds fixed input");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Tiled Zstd binary body is missing");
  }
  const bytes = new Uint8Array(TILED_ZSTD_WASM_BYTES);
  let offset = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        break;
      }
      if (offset + part.value.byteLength > bytes.length) {
        throw new RangeError("Tiled Zstd binary body overflow");
      }
      bytes.set(part.value, offset);
      offset += part.value.byteLength;
    }
    if (offset !== bytes.length) {
      throw new Error("Tiled Zstd binary body is truncated");
    }
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
  return createTiledTextureDecoder(bytes.buffer);
}

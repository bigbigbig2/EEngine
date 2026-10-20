import { imageTextureHash } from "../ImageTextureProduct.js";

interface Decoder {
  HEAPU8: Uint8Array;
  _malloc(bytes: number): number;
  _free(address: number): void;
  _geometry_zstd_decode(input: number, bytes: number, output: number, decoded: number): number;
}
let pending: Promise<Decoder> | undefined;

async function fetchBounded(url: URL, limit: number): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Geometry Zstd dependency unavailable: ${url}`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > limit) {
        throw new RangeError(`Geometry Zstd dependency exceeds ${limit} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function decoder(): Promise<Decoder> {
  if (!pending) {
    pending = (async () => {
      const manifest = JSON.parse(
        new TextDecoder().decode(
          await fetchBounded(new URL("./vendor/geometry-zstd/source.json", import.meta.url), 16384)
        )
      );
      const wasm = await fetchBounded(
        new URL("./vendor/geometry-zstd/geometry_zstd.wasm", import.meta.url),
        1024 * 1024
      );
      if (
        (await imageTextureHash(wasm)) !== manifest.hashes["geometry_zstd.wasm"] ||
        manifest.memoryBytes !== 4194304
      ) {
        throw new Error("Geometry Zstd binary identity mismatch");
      }
      const { default: create } = await import("./vendor/geometry-zstd/geometry_zstd.js");
      return create({ wasmBinary: wasm });
    })().catch((error) => {
      pending = undefined;
      throw error;
    });
  }
  return pending;
}

/** Full upstream decompression with a fixed heap and independently validated frame contract. */
export async function decodeGeometryZstd(encoded: Uint8Array, decodedBytes: number): Promise<Uint8Array> {
  if (encoded.length < 1 || encoded.length > 262144 || decodedBytes !== 262144) {
    throw new RangeError("Geometry Zstd extent exceeds the page contract");
  }
  const module = await decoder();
  const input = module._malloc(encoded.length);
  const output = module._malloc(decodedBytes);
  try {
    if (!input || !output) throw new Error("Geometry Zstd fixed heap exhausted");
    module.HEAPU8.set(encoded, input);
    const result = module._geometry_zstd_decode(input, encoded.length, output, decodedBytes);
    if (result !== 0) throw new Error(`Geometry Zstd frame rejected (${result})`);
    return module.HEAPU8.slice(output, output + decodedBytes);
  } finally {
    if (input) module._free(input);
    if (output) module._free(output);
  }
}

export function geometryZstdMemoryBytes(): number {
  return pending ? 4194304 : 0;
}

import createImageResampleModule, { type ImageResampleModule } from "./vendor/image-resample/image_resample.js";
import type { CanonicalImageMip } from "./ImageTextureCook.js";
import { imageTextureHash } from "../ImageTextureProduct.js";

let module: Promise<ImageResampleModule> | undefined;

/** Retained only for canonical provided/coverage filtering, not BC encoding.
 * Uses the unchanged pinned Basis resampler; no local replacement filter. */
export async function resampleCanonicalMip(input: CanonicalImageMip, srgb: boolean, normal: boolean): Promise<CanonicalImageMip> {
  if (input.rgba.length !== input.width * input.height * 4 || Math.max(input.width, input.height) > 2048) {
    throw new RangeError("Canonical Web resampler input exceeds its complete admitted domain");
  }
  module ??= (async () => {
    const identityResponse = await fetch(new URL("./vendor/image-resample/source.json", import.meta.url));
    if (!identityResponse.ok) throw new Error("Canonical resampler identity fetch failed");
    const identity = await identityResponse.json();
    if (identity.pins.basis !== "99f52d63aa6799cbdaecfe977111dc5ec3b31d47") throw new Error("Canonical resampler revision mismatch");
    const response = await fetch(new URL("./vendor/image-resample/image_resample.wasm", import.meta.url));
    if (!response.ok) throw new Error("Canonical resampler fetch failed");
    const wasmBinary = await response.arrayBuffer();
    if (await imageTextureHash(new Uint8Array(wasmBinary)) !== identity.hashes["image_resample.wasm"]) throw new Error("Canonical resampler hash mismatch");
    return createImageResampleModule({ wasmBinary });
  })();
  void module.catch(() => { module = undefined; });
  const native = await module;
  const width = Math.max(1, Math.floor(input.width / 2));
  const height = Math.max(1, Math.floor(input.height / 2));
  let source = 0;
  let destination = 0;
  try {
    source = native._malloc(input.rgba.byteLength);
    destination = native._malloc(width * height * 4);
    if (!source || !destination) throw new Error("Canonical resampler allocation failed");
    native.HEAPU8.set(input.rgba, source);
    if (native._image_resample(source, input.width, input.height, destination, width, height, Number(srgb), Number(normal)) !== 1) {
      throw new Error("Canonical resampler failed");
    }
    return { width, height, rgba: native.HEAPU8.slice(destination, destination + width * height * 4) };
  } finally {
    if (source) native._free(source);
    if (destination) native._free(destination);
  }
}

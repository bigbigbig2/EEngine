import type { ShadeTexture } from "../texture/ShadeTexture.js";
import type { SelectedTextureVariantV2 } from "../assets/TextureAssetPackage.js";

export interface TextureVariation {
  readonly known: boolean;
  readonly low: readonly [number, number, number, number];
  readonly high: readonly [number, number, number, number];
}
export interface TextureSurfacePublication {
  readonly slot: number;
  readonly generation: number;
  readonly revision: number;
  /** Descriptor is validated on GPU; CPU residency does not decide shading work. */
  readonly localVariationSlot: number;
  readonly variation: TextureVariation;
}
const UNKNOWN: TextureVariation = Object.freeze({ known: false,
  low: [0, 0, 0, 0] as const, high: [1, 1, 1, 1] as const });
const linear = (value: number): number => value <= 0.04045
  ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);

export function decodedTextureVariation(texture: ShadeTexture,
  selected?: SelectedTextureVariantV2): TextureVariation {
  let payloads: readonly Uint8Array[];
  let srgb: boolean;
  if (selected !== undefined) {
    if (selected.format !== "rgba8unorm" && selected.format !== "rgba8unorm-srgb") return UNKNOWN;
    payloads = selected.payloads;
    srgb = selected.format === "rgba8unorm-srgb";
  } else {
    const image = texture.image;
    if (!image || image.depth !== 1 || image.channel_count !== 4 || image.data_type !== "uint8") return UNKNOWN;
    const source = image.source;
    const data = source && typeof source === "object" && "data" in source
      ? (source as { data: unknown }).data : source;
    const bytes = data instanceof Uint8Array || data instanceof Uint8ClampedArray
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : data instanceof ArrayBuffer ? new Uint8Array(data) : undefined;
    if (!bytes || bytes.byteLength !== image.width * image.height * 4) return UNKNOWN;
    payloads = [bytes];
    srgb = image.color_space === 1;
  }
  if (payloads.length === 0) return UNKNOWN;
  const low: [number, number, number, number] = [1, 1, 1, 1];
  const high: [number, number, number, number] = [0, 0, 0, 0];
  for (const payload of payloads) {
    if (!payload.byteLength || payload.byteLength % 4 !== 0) return UNKNOWN;
    for (let offset = 0; offset < payload.byteLength; offset += 4) {
      for (let channel = 0; channel < 4; channel++) {
        const encoded = payload[offset + channel]! / 255;
        const value = srgb && channel < 3 ? linear(encoded) : encoded;
        low[channel] = Math.min(low[channel]!, value);
        high[channel] = Math.max(high[channel]!, value);
      }
    }
  }
  const scratch = new DataView(new ArrayBuffer(4));
  for (let channel = 0; channel < 4; channel++) {
    const nonconstant = low[channel] !== high[channel];
    const margin = selected === undefined && (nonconstant || (srgb && channel < 3)) ? 1 / 255 : 0;
    const minimum = Math.max(0, low[channel]! - margin);
    const maximum = Math.min(1, high[channel]! + margin);
    scratch.setFloat32(0, minimum, true);
    if (scratch.getFloat32(0, true) > minimum) scratch.setUint32(0, scratch.getUint32(0, true) - 1, true);
    low[channel] = scratch.getFloat32(0, true);
    scratch.setFloat32(0, maximum, true);
    if (scratch.getFloat32(0, true) < maximum) scratch.setUint32(0, scratch.getUint32(0, true) + 1, true);
    high[channel] = scratch.getFloat32(0, true);
  }
  return Object.freeze({ known: true, low: Object.freeze(low), high: Object.freeze(high) });
}

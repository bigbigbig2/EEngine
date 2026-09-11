/**
 * Test/reference only. Production source files must not import this module.
 *
 * This deterministic, low-quality implementation exists for tiny contract and
 * GPU upload oracles. It is not an asset-production codec authority.
 */
import {
  writeEncodedTextureAssetPackageV2,
  type EncodedTextureMipV2,
  type EncodedTextureVariantV2,
  type TextureCookRecipeV2,
  type TextureCookSourceV2,
  type TextureSemanticV2
} from "../TextureAssetPackage.js";
import { physicalTextureExtent, textureFormatBlockLayout } from "./TextureFormatLayout.js";

export const REFERENCE_TEXTURE_CODEC_ID = "oengine-reference-texture-codec";
export const REFERENCE_TEXTURE_CODEC_REVISION = "v2-oracle-only";
export const REFERENCE_TEXTURE_CODEC_HASH = "0".repeat(64);

interface CpuMip {
  readonly width: number;
  readonly height: number;
  readonly rgba8: Uint8Array;
}

export async function cookReferenceTextureAssetPackageV2(
  source: TextureCookSourceV2,
  recipe: TextureCookRecipeV2 = {}
): Promise<ArrayBuffer> {
  return writeEncodedTextureAssetPackageV2(source, encodeReferenceTextureVariantsV2(source, recipe));
}

export function encodeReferenceTextureVariantsV2(
  source: TextureCookSourceV2,
  recipe: TextureCookRecipeV2 = {}
): readonly EncodedTextureVariantV2[] {
  validateSource(source);
  const includeDesktopBc = recipe.includeDesktopBc ?? true;
  const includePortableFallback = recipe.includePortableFallback ?? true;
  if (!includeDesktopBc && !includePortableFallback) {
    throw new RangeError("Reference texture codec requires at least one output variant");
  }
  const desktopBcEligible = source.width >= 4 && source.height >= 4 &&
    source.width % 4 === 0 && source.height % 4 === 0;
  if (includeDesktopBc && !desktopBcEligible && !includePortableFallback) {
    throw new RangeError("The reference BC profile requires base dimensions divisible by 4");
  }
  const mips = buildOfflineMips(source);
  const variants: EncodedTextureVariantV2[] = [];
  if (includeDesktopBc && desktopBcEligible) {
    const format = desktopFormat(source.semantic);
    variants.push(encodedVariant(
      "desktop-bc",
      source.semantic,
      format,
      mips,
      mips.map((mip) => encodeBlockCompressed(mip.rgba8, mip.width, mip.height, format))
    ));
  }
  if (includePortableFallback) {
    const format = source.semantic === "base-color-srgb" || source.semantic === "emissive-srgb"
      ? "rgba8unorm-srgb" as const
      : "rgba8unorm" as const;
    variants.push(encodedVariant(
      "portable-rgba8",
      source.semantic,
      format,
      mips,
      mips.map((mip) => mip.rgba8.slice())
    ));
  }
  return Object.freeze(variants);
}

function encodedVariant(
  profile: string,
  semantic: TextureSemanticV2,
  format: GPUTextureFormat,
  mips: readonly CpuMip[],
  payloads: readonly Uint8Array[]
): EncodedTextureVariantV2 {
  const layout = textureFormatBlockLayout(format);
  return Object.freeze({
    profile,
    semantic,
    format,
    ...layout,
    codecId: REFERENCE_TEXTURE_CODEC_ID,
    codecRevision: REFERENCE_TEXTURE_CODEC_REVISION,
    codecBinaryHash: REFERENCE_TEXTURE_CODEC_HASH,
    mips: Object.freeze(mips.map((mip, level): EncodedTextureMipV2 => {
      const [physicalWidth, physicalHeight] = physicalTextureExtent(format, mip.width, mip.height);
      return Object.freeze({
        level,
        logicalWidth: mip.width,
        logicalHeight: mip.height,
        physicalWidth,
        physicalHeight,
        payload: payloads[level]!
      });
    }))
  });
}

function buildOfflineMips(source: TextureCookSourceV2): CpuMip[] {
  const result: CpuMip[] = [{ width: source.width, height: source.height, rgba8: source.rgba8.slice() }];
  const baseCoverage = source.semantic === "alpha-mask"
    ? alphaCoverage(source.rgba8, source.alphaCutoff ?? 0.5)
    : 0;
  while (result.at(-1)!.width > 1 || result.at(-1)!.height > 1) {
    const previous = result.at(-1)!;
    const width = Math.max(1, Math.floor(previous.width / 2));
    const height = Math.max(1, Math.floor(previous.height / 2));
    const rgba8 = downsample(previous, width, height, source.semantic);
    if (source.semantic === "alpha-mask") preserveAlphaCoverage(rgba8, baseCoverage, source.alphaCutoff ?? 0.5);
    result.push({ width, height, rgba8 });
  }
  return result;
}

function downsample(source: CpuMip, width: number, height: number, semantic: TextureSemanticV2): Uint8Array {
  const output = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const samples: number[][] = [];
    const beginX = Math.floor(x * source.width / width);
    const endX = Math.max(beginX + 1, Math.floor((x + 1) * source.width / width));
    const beginY = Math.floor(y * source.height / height);
    const endY = Math.max(beginY + 1, Math.floor((y + 1) * source.height / height));
    for (let sy = beginY; sy < Math.min(source.height, endY); sy++) {
      for (let sx = beginX; sx < Math.min(source.width, endX); sx++) {
        const offset = (sy * source.width + sx) * 4;
        samples.push([...source.rgba8.subarray(offset, offset + 4)]);
      }
    }
    const target = (y * width + x) * 4;
    if (semantic === "normal-linear") {
      let nx = 0, ny = 0, nz = 0;
      for (const sample of samples) {
        nx += sample[0]! / 127.5 - 1;
        ny += sample[1]! / 127.5 - 1;
        nz += sample[2]! / 127.5 - 1;
      }
      const length = Math.hypot(nx, ny, nz) || 1;
      output[target] = toByte(nx / length * 0.5 + 0.5);
      output[target + 1] = toByte(ny / length * 0.5 + 0.5);
      output[target + 2] = toByte(nz / length * 0.5 + 0.5);
      output[target + 3] = average(samples, 3);
    } else {
      const srgb = semantic === "base-color-srgb" || semantic === "emissive-srgb";
      for (let channel = 0; channel < 4; channel++) {
        if (srgb && channel < 3) {
          const linear = samples.reduce((sum, sample) => sum + srgbToLinear(sample[channel]! / 255), 0) / samples.length;
          output[target + channel] = toByte(linearToSrgb(linear));
        } else output[target + channel] = average(samples, channel);
      }
    }
  }
  return output;
}

function encodeBlockCompressed(
  rgba: Uint8Array,
  width: number,
  height: number,
  format: GPUTextureFormat
): Uint8Array {
  const layout = textureFormatBlockLayout(format);
  const output = new Uint8Array(Math.ceil(width / 4) * Math.ceil(height / 4) * layout.bytesPerBlock);
  let offset = 0;
  for (let by = 0; by < height; by += 4) for (let bx = 0; bx < width; bx += 4) {
    const block = gatherBlock(rgba, width, height, bx, by);
    if (format === "bc4-r-unorm") {
      output.set(encodeBc4(block, 3), offset); offset += 8;
    } else if (format === "bc5-rg-unorm") {
      output.set(encodeBc4(block, 0), offset); output.set(encodeBc4(block, 1), offset + 8); offset += 16;
    } else if (format === "bc3-rgba-unorm-srgb") {
      output.set(encodeBc4(block, 3), offset); output.set(encodeBc1(block), offset + 8); offset += 16;
    } else {
      output.set(encodeBc1(block), offset); offset += 8;
    }
  }
  return output;
}

function gatherBlock(rgba: Uint8Array, width: number, height: number, beginX: number, beginY: number): Uint8Array {
  const block = new Uint8Array(64);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const sx = Math.min(width - 1, beginX + x), sy = Math.min(height - 1, beginY + y);
    block.set(rgba.subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4), (y * 4 + x) * 4);
  }
  return block;
}

function encodeBc1(block: Uint8Array): Uint8Array {
  let min = [255, 255, 255], max = [0, 0, 0];
  for (let i = 0; i < 16; i++) for (let c = 0; c < 3; c++) {
    min[c] = Math.min(min[c]!, block[i * 4 + c]!);
    max[c] = Math.max(max[c]!, block[i * 4 + c]!);
  }
  let c0 = rgb565(max), c1 = rgb565(min);
  if (c0 === c1) {
    if (c0 === 0xffff) c1--;
    else c0++;
  }
  if (c0 < c1) [c0, c1] = [c1, c0];
  const p0 = from565(c0), p1 = from565(c1);
  const palette = [p0, p1, mix3(p0, p1, 2, 1), mix3(p0, p1, 1, 2)];
  let indices = 0;
  for (let i = 0; i < 16; i++) {
    let best = 0, error = Infinity;
    for (let p = 0; p < 4; p++) {
      const dr = block[i * 4]! - palette[p]![0]!;
      const dg = block[i * 4 + 1]! - palette[p]![1]!;
      const db = block[i * 4 + 2]! - palette[p]![2]!;
      const candidate = dr * dr + dg * dg + db * db;
      if (candidate < error) { error = candidate; best = p; }
    }
    indices |= best << (i * 2);
  }
  const output = new Uint8Array(8), view = new DataView(output.buffer);
  view.setUint16(0, c0, true); view.setUint16(2, c1, true); view.setUint32(4, indices >>> 0, true);
  return output;
}

function encodeBc4(block: Uint8Array, channel: number): Uint8Array {
  let low = 255, high = 0;
  for (let i = 0; i < 16; i++) {
    const value = block[i * 4 + channel]!;
    low = Math.min(low, value); high = Math.max(high, value);
  }
  const palette = [high, low];
  for (let i = 1; i <= 6; i++) palette.push(Math.round(((7 - i) * high + i * low) / 7));
  let bits = 0n;
  for (let i = 0; i < 16; i++) {
    const value = block[i * 4 + channel]!;
    let best = 0, error = Infinity;
    for (let p = 0; p < 8; p++) {
      const candidate = Math.abs(value - palette[p]!);
      if (candidate < error) { error = candidate; best = p; }
    }
    bits |= BigInt(best) << BigInt(i * 3);
  }
  const output = new Uint8Array(8); output[0] = high; output[1] = low;
  for (let i = 0; i < 6; i++) output[i + 2] = Number((bits >> BigInt(i * 8)) & 0xffn);
  return output;
}

function desktopFormat(semantic: TextureSemanticV2): GPUTextureFormat {
  if (semantic === "normal-linear") return "bc5-rg-unorm";
  if (semantic === "alpha-mask") return "bc4-r-unorm";
  if (semantic === "orm-linear") return "bc1-rgba-unorm";
  return "bc3-rgba-unorm-srgb";
}

function rgb565(rgb: number[]): number { return ((rgb[0]! >> 3) << 11) | ((rgb[1]! >> 2) << 5) | (rgb[2]! >> 3); }
function from565(value: number): number[] { return [Math.round(((value >> 11) & 31) * 255 / 31), Math.round(((value >> 5) & 63) * 255 / 63), Math.round((value & 31) * 255 / 31)]; }
function mix3(a: number[], b: number[], aw: number, bw: number): number[] { return [0, 1, 2].map((c) => Math.round((a[c]! * aw + b[c]! * bw) / 3)); }
function average(samples: number[][], channel: number): number { return Math.round(samples.reduce((sum, sample) => sum + sample[channel]!, 0) / samples.length); }
function toByte(value: number): number { return Math.max(0, Math.min(255, Math.round(value * 255))); }
function srgbToLinear(value: number): number { return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; }
function linearToSrgb(value: number): number { return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055; }
function alphaCoverage(bytes: Uint8Array, cutoff: number): number { let covered = 0; for (let i = 3; i < bytes.length; i += 4) if (bytes[i]! / 255 >= cutoff) covered++; return covered / (bytes.length / 4); }
function preserveAlphaCoverage(bytes: Uint8Array, target: number, cutoff: number): void {
  let low = 0, high = 8;
  for (let iteration = 0; iteration < 12; iteration++) {
    const scale = (low + high) * 0.5;
    let covered = 0;
    for (let i = 3; i < bytes.length; i += 4) if (Math.min(1, bytes[i]! / 255 * scale) >= cutoff) covered++;
    if (covered / (bytes.length / 4) < target) low = scale; else high = scale;
  }
  for (let i = 3; i < bytes.length; i += 4) bytes[i] = Math.min(255, Math.round(bytes[i]! * high));
}
function validateSource(source: TextureCookSourceV2): void {
  if (!Number.isInteger(source.width) || source.width <= 0 || source.width > 16384) throw new RangeError("Texture width is invalid");
  if (!Number.isInteger(source.height) || source.height <= 0 || source.height > 16384) throw new RangeError("Texture height is invalid");
  if (source.rgba8.byteLength !== source.width * source.height * 4) throw new RangeError("Texture source byte length must equal width × height × 4");
  if (!source.sourceUri) throw new RangeError("Texture source provenance URI is required");
}

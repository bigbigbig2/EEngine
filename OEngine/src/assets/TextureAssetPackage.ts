import {
  openRuntimeAssetPackageV2,
  selectRuntimeAssetVariantV2,
  writeRuntimeAssetPackageV2,
  type RuntimeAssetManifestV2,
  type RuntimeAssetPackageV2
} from "./RuntimeAssetManifestV2.js";

export const TEXTURE_ASSET_SCHEMA_VERSION = 2;
export const TEXTURE_COOKER_VERSION = "oengine-texture-cooker-v2.0.0";

export type TextureSemanticV2 =
  | "base-color-srgb"
  | "normal-linear"
  | "orm-linear"
  | "alpha-mask"
  | "emissive-srgb";

export interface TextureCookSourceV2 {
  readonly width: number;
  readonly height: number;
  readonly rgba8: Uint8Array;
  readonly semantic: TextureSemanticV2;
  readonly sourceUri: string;
  readonly alphaCutoff?: number;
}

export interface TextureCookRecipeV2 {
  readonly includeDesktopBc?: boolean;
  readonly includePortableFallback?: boolean;
}

export interface TextureMipV2 {
  readonly level: number;
  readonly width: number;
  readonly height: number;
  readonly chunkId: string;
}

export interface TextureVariantMetadataV2 {
  readonly id: string;
  readonly profile: "desktop-bc" | "portable-rgba8";
  readonly format: GPUTextureFormat;
  readonly blockWidth: number;
  readonly blockHeight: number;
  readonly bytesPerBlock: number;
  readonly mips: readonly TextureMipV2[];
}

export interface TextureAssetPackageV2 {
  readonly runtime: RuntimeAssetPackageV2;
  readonly width: number;
  readonly height: number;
  readonly semantic: TextureSemanticV2;
  readonly alphaCutoff: number;
  readonly variants: readonly TextureVariantMetadataV2[];
  readonly evidence: TextureAssetLoadEvidenceV2;
}

export interface TextureAssetLoadEvidenceV2 {
  readonly schemaVersion: 1;
  readonly sourceBytes: number;
  readonly packageBytes: number;
  readonly decodedPeakBytes: number;
  readonly expectedResidentBytesByVariant: Readonly<Record<string, number>>;
}

export interface SelectedTextureVariantV2 extends TextureVariantMetadataV2 {
  readonly payloads: readonly Uint8Array[];
}

export interface TextureUploadEvidenceV2 {
  readonly selectedVariant: string;
  readonly physicalFormat: GPUTextureFormat;
  readonly uploadBytes: number;
  readonly residentBytes: number;
  readonly runtimeMipPasses: 0;
  readonly transcodeBytes: 0;
}

export interface UploadedTextureAssetV2 {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly variant: SelectedTextureVariantV2;
  readonly evidence: TextureUploadEvidenceV2;
}

const TEXTURE_METADATA_CHUNK_ID = "texture-metadata";
const TEXTURE_METADATA_SECTION = 0x200;
const TEXTURE_PAYLOAD_SECTION_BEGIN = 0x1000;

export async function cookTextureAssetPackageV2(
  source: TextureCookSourceV2,
  recipe: TextureCookRecipeV2 = {}
): Promise<ArrayBuffer> {
  validateSource(source);
  const includeDesktopBc = recipe.includeDesktopBc ?? true;
  const includePortableFallback = recipe.includePortableFallback ?? true;
  if (!includeDesktopBc && !includePortableFallback) {
    throw new RangeError("Texture cooker requires at least one output variant");
  }
  if (includeDesktopBc && (
    source.width < 4 || source.height < 4 ||
    source.width % 4 !== 0 || source.height % 4 !== 0 ||
    !isPowerOfTwo(source.width) || !isPowerOfTwo(source.height)
  )) {
    throw new RangeError("The first desktop BC profile requires power-of-two dimensions divisible by 4; use the portable fallback for other sources");
  }
  const mips = buildOfflineMips(source);
  const variants: TextureVariantMetadataV2[] = [];
  const chunks: Array<{
    id: string;
    sectionType: number;
    semantic: string;
    compression: string;
    decodedBytes: number;
    expectedResidentBytes: number;
    data: Uint8Array;
  }> = [];
  let sectionType = TEXTURE_PAYLOAD_SECTION_BEGIN;
  if (includeDesktopBc) {
    const format = desktopFormat(source.semantic);
    // Without the 2026 texture-compression-unaligned feature, WebGPU requires
    // compressed copy extents to stay block-aligned. Keep the offline 2x2/1x1
    // tail in the portable variant and clamp this physical variant at 4x4.
    const compressedMips = mips.filter((mip) => mip.width >= 4 && mip.height >= 4);
    const encoded = compressedMips.map((mip) => encodeBlockCompressed(mip.rgba8, mip.width, mip.height, source.semantic, format));
    const metadata = variantMetadata("desktop-bc", format, compressedMips, encoded, () => sectionType++);
    variants.push(metadata.variant);
    chunks.push(...metadata.chunks);
  }
  if (includePortableFallback) {
    const format = source.semantic === "base-color-srgb" || source.semantic === "emissive-srgb"
      ? "rgba8unorm-srgb" as const
      : "rgba8unorm" as const;
    const metadata = variantMetadata("portable-rgba8", format, mips, mips.map((mip) => mip.rgba8), () => sectionType++);
    variants.push(metadata.variant);
    chunks.push(...metadata.chunks);
  }
  const textureMetadata = new TextEncoder().encode(JSON.stringify({
    schemaVersion: TEXTURE_ASSET_SCHEMA_VERSION,
    width: source.width,
    height: source.height,
    semantic: source.semantic,
    alphaCutoff: source.alphaCutoff ?? 0.5,
    variants
  }));
  chunks.unshift({
    id: TEXTURE_METADATA_CHUNK_ID,
    sectionType: TEXTURE_METADATA_SECTION,
    semantic: "texture-metadata",
    compression: "none",
    decodedBytes: textureMetadata.byteLength,
    expectedResidentBytes: 0,
    data: textureMetadata
  });
  const sourceHash = await sha256Hex(source.rgba8);
  const recipeHash = await sha256Hex(new TextEncoder().encode(JSON.stringify({
    cooker: TEXTURE_COOKER_VERSION,
    semantic: source.semantic,
    alphaCutoff: source.alphaCutoff ?? 0.5,
    includeDesktopBc,
    includePortableFallback
  })));
  const assetId = await sha256Hex(new TextEncoder().encode(`${sourceHash}:${recipeHash}:texture-v2`));
  return writeRuntimeAssetPackageV2({
    manifest: {
      assetSchemaVersion: TEXTURE_ASSET_SCHEMA_VERSION,
      assetId,
      assetType: "texture-2d",
      cookerVersion: TEXTURE_COOKER_VERSION,
      recipeHash,
      sourceProvenance: { uri: source.sourceUri, contentHash: sourceHash },
      dependencies: [],
      variants: variants.map((variant) => ({
        id: variant.id,
        profile: variant.profile,
        requiredFeatures: variant.profile === "desktop-bc" ? ["texture-compression-bc"] : [],
        chunkIds: [TEXTURE_METADATA_CHUNK_ID, ...variant.mips.map((mip) => mip.chunkId)]
      }))
    },
    chunks
  });
}

export async function openTextureAssetPackageV2(bytes: ArrayBuffer): Promise<TextureAssetPackageV2> {
  const runtime = await openRuntimeAssetPackageV2(bytes);
  if (runtime.manifest.assetType !== "texture-2d" || runtime.manifest.assetSchemaVersion !== TEXTURE_ASSET_SCHEMA_VERSION) {
    throw new Error("Runtime package is not a supported Texture Package V2");
  }
  const metadataBytes = runtime.chunks.get(TEXTURE_METADATA_CHUNK_ID);
  if (metadataBytes === undefined) throw new Error("Texture Package V2 metadata chunk is missing");
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadataBytes));
  } catch (error) {
    throw new Error(`Texture Package V2 metadata is invalid: ${errorMessage(error)}`);
  }
  const metadata = validateTextureMetadata(raw, runtime.manifest);
  const expectedResidentBytesByVariant: Record<string, number> = {};
  let decodedPeakBytes = 0;
  for (const variant of runtime.manifest.variants) {
    let variantResidentBytes = 0;
    let variantDecodedBytes = 0;
    for (const id of variant.chunkIds) {
      if (id === TEXTURE_METADATA_CHUNK_ID) continue;
      const chunk = runtime.manifest.chunks.find((candidate) => candidate.id === id);
      if (chunk === undefined) throw new Error(`Texture variant '${variant.id}' references missing chunk '${id}'`);
      variantResidentBytes += chunk.expectedResidentBytes;
      variantDecodedBytes += chunk.decodedBytes;
    }
    expectedResidentBytesByVariant[variant.id] = variantResidentBytes;
    decodedPeakBytes = Math.max(decodedPeakBytes, variantDecodedBytes);
  }
  return Object.freeze({
    runtime,
    ...metadata,
    evidence: Object.freeze({
      schemaVersion: 1,
      sourceBytes: metadata.width * metadata.height * 4,
      packageBytes: bytes.byteLength,
      decodedPeakBytes,
      expectedResidentBytesByVariant: Object.freeze(expectedResidentBytesByVariant)
    })
  });
}

export function selectTextureAssetVariantV2(
  asset: TextureAssetPackageV2,
  availableFeatures: ReadonlySet<string>
): SelectedTextureVariantV2 {
  const selected = selectRuntimeAssetVariantV2(
    asset.runtime.manifest,
    availableFeatures,
    ["desktop-bc", "portable-rgba8"]
  );
  const variant = asset.variants.find((candidate) => candidate.id === selected.id);
  if (variant === undefined) throw new Error(`Texture variant '${selected.id}' has no typed metadata`);
  return Object.freeze({
    ...variant,
    payloads: Object.freeze(variant.mips.map((mip) => {
      const bytes = asset.runtime.chunks.get(mip.chunkId);
      if (bytes === undefined) throw new Error(`Texture mip chunk '${mip.chunkId}' is missing`);
      return bytes;
    }))
  });
}

export function uploadTextureAssetPackageV2(
  device: GPUDevice,
  asset: TextureAssetPackageV2
): UploadedTextureAssetV2 {
  const variant = selectTextureAssetVariantV2(asset, device.features);
  const texture = device.createTexture({
    label: `TextureAssetV2/${asset.runtime.manifest.assetId.slice(0, 12)}/${variant.id}`,
    size: [asset.width, asset.height, 1],
    mipLevelCount: variant.mips.length,
    format: variant.format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
  });
  let uploadBytes = 0;
  try {
    for (let index = 0; index < variant.mips.length; index++) {
      const mip = variant.mips[index]!;
      const payload = variant.payloads[index]!;
      const blockRows = Math.ceil(mip.height / variant.blockHeight);
      const tightBytesPerRow = Math.ceil(mip.width / variant.blockWidth) * variant.bytesPerBlock;
      const paddedBytesPerRow = alignUp(tightBytesPerRow, 256);
      const upload = blockRows === 1 || paddedBytesPerRow === tightBytesPerRow
        ? payload
        : padRows(payload, tightBytesPerRow, paddedBytesPerRow, blockRows);
      const layout: GPUImageDataLayout = blockRows === 1
        ? {}
        : { bytesPerRow: paddedBytesPerRow, rowsPerImage: blockRows };
      device.queue.writeTexture(
        { texture, mipLevel: mip.level },
        upload.slice().buffer,
        layout,
        { width: mip.width, height: mip.height, depthOrArrayLayers: 1 }
      );
      uploadBytes += upload.byteLength;
    }
  } catch (error) {
    texture.destroy();
    throw error;
  }
  const residentBytes = variant.payloads.reduce((sum, payload) => sum + payload.byteLength, 0);
  return Object.freeze({
    texture,
    view: texture.createView(),
    variant,
    evidence: Object.freeze({
      selectedVariant: variant.id,
      physicalFormat: variant.format,
      uploadBytes,
      residentBytes,
      runtimeMipPasses: 0,
      transcodeBytes: 0
    })
  });
}

interface CpuMip { readonly width: number; readonly height: number; readonly rgba8: Uint8Array; }

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
    for (let oy = 0; oy < 2; oy++) for (let ox = 0; ox < 2; ox++) {
      const sx = Math.min(source.width - 1, x * 2 + ox);
      const sy = Math.min(source.height - 1, y * 2 + oy);
      const offset = (sy * source.width + sx) * 4;
      samples.push([...source.rgba8.subarray(offset, offset + 4)]);
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

function variantMetadata(
  profile: TextureVariantMetadataV2["profile"],
  format: GPUTextureFormat,
  mips: readonly CpuMip[],
  payloads: readonly Uint8Array[],
  nextSection: () => number
): { variant: TextureVariantMetadataV2; chunks: Array<any> } {
  const layout = blockLayout(format);
  const id = `${profile}-${format}`;
  const typedMips = mips.map((mip, level) => ({
    level,
    width: mip.width,
    height: mip.height,
    chunkId: `${id}-mip-${level}`
  }));
  return {
    variant: Object.freeze({ id, profile, format, ...layout, mips: Object.freeze(typedMips) }),
    chunks: typedMips.map((mip, index) => ({
      id: mip.chunkId,
      sectionType: nextSection(),
      semantic: `texture-mip-${mip.level}`,
      compression: profile === "desktop-bc" ? format : "none",
      decodedBytes: mips[index]!.rgba8.byteLength,
      expectedResidentBytes: payloads[index]!.byteLength,
      data: payloads[index]!
    }))
  };
}

function validateTextureMetadata(raw: unknown, manifest: RuntimeAssetManifestV2): Omit<TextureAssetPackageV2, "runtime" | "evidence"> {
  if (!isRecord(raw) || raw.schemaVersion !== TEXTURE_ASSET_SCHEMA_VERSION) throw new Error("Texture metadata schema is invalid");
  assertDimension(raw.width, "width"); assertDimension(raw.height, "height");
  if (!isTextureSemantic(raw.semantic)) throw new Error(`Unsupported texture semantic '${String(raw.semantic)}'`);
  if (typeof raw.alphaCutoff !== "number" || raw.alphaCutoff < 0 || raw.alphaCutoff > 1) throw new Error("Texture alphaCutoff is invalid");
  if (!Array.isArray(raw.variants) || raw.variants.length === 0) throw new Error("Texture metadata has no variants");
  const manifestVariants = new Set(manifest.variants.map((variant) => variant.id));
  const variants = raw.variants.map((variant: unknown, index: number): TextureVariantMetadataV2 => {
    if (!isRecord(variant) || !manifestVariants.has(String(variant.id))) throw new Error(`Texture variant ${index} is invalid`);
    const format = String(variant.format) as GPUTextureFormat;
    const layout = blockLayout(format);
    if (variant.blockWidth !== layout.blockWidth || variant.blockHeight !== layout.blockHeight || variant.bytesPerBlock !== layout.bytesPerBlock) {
      throw new Error(`Texture variant '${String(variant.id)}' block layout is invalid`);
    }
    if (variant.profile !== "desktop-bc" && variant.profile !== "portable-rgba8") throw new Error(`Texture variant '${String(variant.id)}' profile is invalid`);
    if (!Array.isArray(variant.mips)) throw new Error(`Texture variant '${String(variant.id)}' mips are invalid`);
    const mips = variant.mips.map((mip: unknown, level: number): TextureMipV2 => {
      if (!isRecord(mip) || mip.level !== level || mip.width !== Math.max(1, Math.floor(raw.width / 2 ** level)) || mip.height !== Math.max(1, Math.floor(raw.height / 2 ** level)) || typeof mip.chunkId !== "string") {
        throw new Error(`Texture variant '${String(variant.id)}' mip ${level} is invalid`);
      }
      if (!manifest.chunks.some((chunk) => chunk.id === mip.chunkId)) throw new Error(`Texture mip chunk '${mip.chunkId}' is not declared`);
      return Object.freeze({ level, width: mip.width, height: mip.height, chunkId: mip.chunkId });
    });
    const expectedLevels = variant.profile === "desktop-bc"
      ? Math.floor(Math.log2(Math.min(raw.width, raw.height))) - 1
      : Math.floor(Math.log2(Math.max(raw.width, raw.height))) + 1;
    if (mips.length !== expectedLevels) throw new Error(`Texture variant '${String(variant.id)}' mip chain is incomplete`);
    return Object.freeze({ id: String(variant.id), profile: variant.profile, format, ...layout, mips: Object.freeze(mips) });
  });
  return Object.freeze({ width: raw.width, height: raw.height, semantic: raw.semantic, alphaCutoff: raw.alphaCutoff, variants: Object.freeze(variants) });
}

function desktopFormat(semantic: TextureSemanticV2): GPUTextureFormat {
  if (semantic === "normal-linear") return "bc5-rg-unorm";
  if (semantic === "alpha-mask") return "bc4-r-unorm";
  if (semantic === "orm-linear") return "bc1-rgba-unorm";
  return "bc3-rgba-unorm-srgb";
}

function blockLayout(format: GPUTextureFormat): { blockWidth: number; blockHeight: number; bytesPerBlock: number } {
  if (format === "rgba8unorm" || format === "rgba8unorm-srgb") return { blockWidth: 1, blockHeight: 1, bytesPerBlock: 4 };
  if (format === "bc1-rgba-unorm") return { blockWidth: 4, blockHeight: 4, bytesPerBlock: 8 };
  if (format === "bc4-r-unorm") return { blockWidth: 4, blockHeight: 4, bytesPerBlock: 8 };
  if (format === "bc3-rgba-unorm-srgb" || format === "bc5-rg-unorm") return { blockWidth: 4, blockHeight: 4, bytesPerBlock: 16 };
  throw new Error(`Texture Package V2 format '${format}' is unsupported`);
}

function encodeBlockCompressed(rgba: Uint8Array, width: number, height: number, semantic: TextureSemanticV2, format: GPUTextureFormat): Uint8Array {
  const layout = blockLayout(format);
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
  void semantic;
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
  for (let i = 0; i < 16; i++) for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c]!, block[i * 4 + c]!); max[c] = Math.max(max[c]!, block[i * 4 + c]!); }
  let c0 = rgb565(max), c1 = rgb565(min);
  if (c0 === c1) c0 = Math.min(0xffff, c0 + 1);
  if (c0 < c1) [c0, c1] = [c1, c0];
  const p0 = from565(c0), p1 = from565(c1);
  const palette = [p0, p1, mix3(p0, p1, 2, 1), mix3(p0, p1, 1, 2)];
  let indices = 0;
  for (let i = 0; i < 16; i++) {
    let best = 0, error = Infinity;
    for (let p = 0; p < 4; p++) {
      const dr = block[i * 4]! - palette[p]![0]!, dg = block[i * 4 + 1]! - palette[p]![1]!, db = block[i * 4 + 2]! - palette[p]![2]!;
      const candidate = dr * dr + dg * dg + db * db;
      if (candidate < error) { error = candidate; best = p; }
    }
    indices |= best << (i * 2);
  }
  const out = new Uint8Array(8), view = new DataView(out.buffer);
  view.setUint16(0, c0, true); view.setUint16(2, c1, true); view.setUint32(4, indices >>> 0, true);
  return out;
}

function encodeBc4(block: Uint8Array, channel: number): Uint8Array {
  let low = 255, high = 0;
  for (let i = 0; i < 16; i++) { const value = block[i * 4 + channel]!; low = Math.min(low, value); high = Math.max(high, value); }
  const palette = [high, low];
  for (let i = 1; i <= 6; i++) palette.push(Math.round(((7 - i) * high + i * low) / 7));
  let bits = 0n;
  for (let i = 0; i < 16; i++) {
    const value = block[i * 4 + channel]!;
    let best = 0, error = Infinity;
    for (let p = 0; p < 8; p++) { const candidate = Math.abs(value - palette[p]!); if (candidate < error) { error = candidate; best = p; } }
    bits |= BigInt(best) << BigInt(i * 3);
  }
  const out = new Uint8Array(8); out[0] = high; out[1] = low;
  for (let i = 0; i < 6; i++) out[i + 2] = Number((bits >> BigInt(i * 8)) & 0xffn);
  return out;
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
function padRows(source: Uint8Array, tight: number, padded: number, rows: number): Uint8Array { const output = new Uint8Array(padded * rows); for (let row = 0; row < rows; row++) output.set(source.subarray(row * tight, (row + 1) * tight), row * padded); return output; }
function alignUp(value: number, alignment: number): number { return Math.ceil(value / alignment) * alignment; }
function isPowerOfTwo(value: number): boolean { return (value & (value - 1)) === 0; }
function assertDimension(value: unknown, name: string): asserts value is number { if (!Number.isInteger(value) || Number(value) <= 0 || Number(value) > 16384) throw new RangeError(`Texture ${name} is invalid`); }
function validateSource(source: TextureCookSourceV2): void { assertDimension(source.width, "width"); assertDimension(source.height, "height"); if (source.rgba8.byteLength !== source.width * source.height * 4) throw new RangeError("Texture source byte length must equal width × height × 4"); if (!isTextureSemantic(source.semantic)) throw new RangeError(`Unsupported texture semantic '${source.semantic}'`); if (!source.sourceUri) throw new RangeError("Texture source provenance URI is required"); }
function isTextureSemantic(value: unknown): value is TextureSemanticV2 { return value === "base-color-srgb" || value === "normal-linear" || value === "orm-linear" || value === "alpha-mask" || value === "emissive-srgb"; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
async function sha256Hex(bytes: Uint8Array): Promise<string> { const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer)); return [...digest].map((value) => value.toString(16).padStart(2, "0")).join(""); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

import {
  openRuntimeAssetPackageV2,
  selectRuntimeAssetVariantV2,
  writeRuntimeAssetPackageV2,
  type RuntimeAssetManifestV2,
  type RuntimeAssetPackageV2
} from "./RuntimeAssetManifestV2.js";
import {
  RuntimeAssetResidencyState,
  type RuntimeAssetResidencyBudget,
  type RuntimeAssetResidencyReservation
} from "./RuntimeAssetResidency.js";
import {
  encodedTextureMipByteLength,
  physicalTextureExtent,
  textureFormatBlockLayout
} from "./codec/TextureFormatLayout.js";
import { requiredTextureCompressionFeature } from "./codec/TextureCodecPolicy.js";

export const TEXTURE_ASSET_SCHEMA_VERSION = 2;
export const TEXTURE_COOKER_VERSION = "oengine-texture-package-writer-v2.1.0";

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
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  readonly physicalWidth: number;
  readonly physicalHeight: number;
  readonly chunkId: string;
}

export interface TextureEncodedSourceV2 {
  readonly width: number;
  readonly height: number;
  readonly semantic: TextureSemanticV2;
  readonly sourceUri: string;
  readonly sourceByteLength: number;
  readonly sourceContentHash: string;
  readonly alphaCutoff?: number;
}

export type TexturePackageSourceV2 = TextureCookSourceV2 | TextureEncodedSourceV2;

export interface TextureVariantMetadataV2 {
  readonly id: string;
  readonly profile: string;
  readonly format: GPUTextureFormat;
  readonly blockWidth: number;
  readonly blockHeight: number;
  readonly bytesPerBlock: number;
  readonly codecId: string;
  readonly codecRevision: string;
  readonly codecBinaryHash: string;
  readonly mips: readonly TextureMipV2[];
}

export interface EncodedTextureMipV2 {
  readonly level: number;
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  readonly physicalWidth: number;
  readonly physicalHeight: number;
  readonly payload: Uint8Array;
}

export interface EncodedTextureVariantV2 {
  readonly profile: string;
  readonly semantic: TextureSemanticV2;
  readonly format: GPUTextureFormat;
  readonly blockWidth: number;
  readonly blockHeight: number;
  readonly bytesPerBlock: number;
  readonly codecId: string;
  readonly codecRevision: string;
  readonly codecBinaryHash: string;
  readonly mips: readonly EncodedTextureMipV2[];
}

export interface TextureAssetPackageV2 {
  readonly runtime: RuntimeAssetPackageV2;
  readonly width: number;
  readonly height: number;
  readonly sourceByteLength: number;
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
  readonly residency: RuntimeAssetResidencyState;
}

export interface TextureUploadOptionsV2 {
  readonly budget?: RuntimeAssetResidencyBudget;
}

export interface TextureAssetLayerUploadV2 {
  readonly variant: SelectedTextureVariantV2;
  readonly evidence: TextureUploadEvidenceV2;
  readonly residency: RuntimeAssetResidencyState;
  commit(resourceId: string): void;
  abort(): void;
}

const TEXTURE_METADATA_CHUNK_ID = "texture-metadata";
const TEXTURE_METADATA_SECTION = 0x200;
const TEXTURE_PAYLOAD_SECTION_BEGIN = 0x1000;

export async function writeEncodedTextureAssetPackageV2(
  source: TexturePackageSourceV2,
  encodedVariants: readonly EncodedTextureVariantV2[]
): Promise<ArrayBuffer> {
  validatePackageSource(source);
  if (encodedVariants.length === 0) throw new RangeError("Texture package requires at least one encoded variant");
  const variants = encodedVariants.map((encoded, index) => validateEncodedVariant(source, encoded, index));
  if (new Set(variants.map((variant) => variant.id)).size !== variants.length) {
    throw new RangeError("Texture encoded variant ids must be unique");
  }
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
  for (let variantIndex = 0; variantIndex < variants.length; variantIndex++) {
    const variant = variants[variantIndex]!;
    const encoded = encodedVariants[variantIndex]!;
    for (let mipIndex = 0; mipIndex < variant.mips.length; mipIndex++) {
      const mip = variant.mips[mipIndex]!;
      const payload = encoded.mips[mipIndex]!.payload;
      chunks.push({
        id: mip.chunkId,
        sectionType: sectionType++,
        semantic: `texture-mip-${mip.level}`,
        compression: variant.format,
        decodedBytes: mip.logicalWidth * mip.logicalHeight * 4,
        expectedResidentBytes: payload.byteLength,
        data: payload
      });
    }
  }
  const textureMetadata = new TextEncoder().encode(canonicalJson({
    schemaVersion: TEXTURE_ASSET_SCHEMA_VERSION,
    width: source.width,
    height: source.height,
    sourceByteLength: textureSourceByteLength(source),
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
  const sourceHash = await textureSourceHash(source);
  const recipeHash = await sha256Hex(new TextEncoder().encode(canonicalJson({
    cooker: TEXTURE_COOKER_VERSION,
    semantic: source.semantic,
    alphaCutoff: source.alphaCutoff ?? 0.5,
    variants: variants.map((variant) => ({
      id: variant.id,
      profile: variant.profile,
      format: variant.format,
      codecId: variant.codecId,
      codecRevision: variant.codecRevision,
      codecBinaryHash: variant.codecBinaryHash
    }))
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
        requiredFeatures: requiredFeaturesForFormat(variant.format),
        requiredLimits: [
          { name: "maxTextureArrayLayers", min: 1 },
          { name: "maxTextureDimension2D", min: Math.max(source.width, source.height) }
        ],
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
      sourceBytes: metadata.sourceByteLength,
      packageBytes: bytes.byteLength,
      decodedPeakBytes,
      expectedResidentBytesByVariant: Object.freeze(expectedResidentBytesByVariant)
    })
  });
}

export function selectTextureAssetVariantV2(
  asset: TextureAssetPackageV2,
  availableFeatures: ReadonlySet<string>,
  availableLimits?: Pick<GPUSupportedLimits, "maxTextureArrayLayers" | "maxTextureDimension2D">
): SelectedTextureVariantV2 {
  const selected = selectRuntimeAssetVariantV2(
    asset.runtime.manifest,
    availableFeatures,
    ["desktop-bc", "worker-transcoded", "portable-rgba8"],
    availableLimits === undefined ? undefined : {
      maxTextureArrayLayers: Number(availableLimits.maxTextureArrayLayers),
      maxTextureDimension2D: Number(availableLimits.maxTextureDimension2D)
    }
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
  asset: TextureAssetPackageV2,
  options: TextureUploadOptionsV2 = {}
): UploadedTextureAssetV2 {
  const variant = selectTextureAssetVariantV2(asset, device.features, device.limits);
  let texture: GPUTexture | undefined;
  let staged: TextureAssetLayerUploadV2 | undefined;
  try {
    texture = device.createTexture({
      label: `TextureAssetV2/${asset.runtime.manifest.assetId.slice(0, 12)}/${variant.id}`,
      size: [asset.width, asset.height, 1],
      mipLevelCount: variant.mips.length,
      format: variant.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    staged = stageTextureAssetPackageV2ToLayer(device, asset, texture, 0, options);
    const view = texture.createView();
    staged.commit(`TextureAssetV2/${asset.runtime.manifest.assetId}`);
    return Object.freeze({
      texture,
      view,
      variant: staged.variant,
      residency: staged.residency,
      evidence: staged.evidence
    });
  } catch (error) {
    staged?.abort();
    texture?.destroy();
    throw error;
  }
}

/**
 * Production-owner seam: writes a cooked mip chain directly into one immutable
 * TextureResidency array layer. Publication remains controlled by commit/abort.
 */
export function stageTextureAssetPackageV2ToLayer(
  device: GPUDevice,
  asset: TextureAssetPackageV2,
  texture: GPUTexture,
  arrayLayer: number,
  options: TextureUploadOptionsV2 = {}
): TextureAssetLayerUploadV2 {
  if (!Number.isInteger(arrayLayer) || arrayLayer < 0) {
    throw new RangeError("Texture Package V2 array layer must be a non-negative integer");
  }
  const variant = selectTextureAssetVariantV2(asset, device.features, device.limits);
  const manifestVariant = asset.runtime.manifest.variants.find(
    (candidate) => candidate.id === variant.id
  )!;
  const selectedChunks = manifestVariant.chunkIds.map((id) =>
    asset.runtime.manifest.chunks.find((chunk) => chunk.id === id)!
  );
  const residency = new RuntimeAssetResidencyState(asset.runtime.manifest, manifestVariant);
  const reservation: RuntimeAssetResidencyReservation = residency.request(
    manifestVariant.chunkIds,
    options.budget ?? {
      maxUploadBytes: selectedChunks.reduce((sum, chunk) => sum + chunk.compressedBytes, 0),
      maxResidentBytes: selectedChunks.reduce((sum, chunk) => sum + chunk.expectedResidentBytes, 0)
    }
  );
  let uploadBytes = 0;
  let settled = false;
  try {
    for (let index = 0; index < variant.mips.length; index++) {
      const mip = variant.mips[index]!;
      const payload = variant.payloads[index]!;
      const physicalWidth = mip.physicalWidth;
      const physicalHeight = mip.physicalHeight;
      const blockRows = physicalHeight / variant.blockHeight;
      const tightBytesPerRow = physicalWidth / variant.blockWidth * variant.bytesPerBlock;
      const paddedBytesPerRow = alignUp(tightBytesPerRow, 256);
      const upload = blockRows === 1 || paddedBytesPerRow === tightBytesPerRow
        ? payload
        : padRows(payload, tightBytesPerRow, paddedBytesPerRow, blockRows);
      const layout: GPUImageDataLayout = blockRows === 1
        ? {}
        : { bytesPerRow: paddedBytesPerRow, rowsPerImage: blockRows };
      device.queue.writeTexture(
        { texture, mipLevel: mip.level, origin: { x: 0, y: 0, z: arrayLayer } },
        upload.slice().buffer,
        layout,
        {
          width: mip.logicalWidth,
          height: mip.logicalHeight,
          depthOrArrayLayers: 1
        }
      );
      uploadBytes += upload.byteLength;
    }
  } catch (error) {
    residency.abort(reservation);
    throw error;
  }
  const residentBytes = variant.payloads.reduce((sum, payload) => sum + payload.byteLength, 0);
  const evidence = Object.freeze({
    selectedVariant: variant.id,
    physicalFormat: variant.format,
    uploadBytes,
    residentBytes,
    runtimeMipPasses: 0 as const,
    transcodeBytes: 0 as const
  });
  return Object.freeze({
    variant,
    residency,
    evidence,
    commit(resourceId: string): void {
      if (settled) throw new Error("Texture Package V2 layer upload is already settled");
      if (resourceId.length === 0) throw new RangeError("Texture Package V2 resident resource id is empty");
      let mipByteOffset = 0;
      const ranges = Object.fromEntries(manifestVariant.chunkIds.map((chunkId) => {
        const mipIndex = variant.mips.findIndex((mip) => mip.chunkId === chunkId);
        if (mipIndex < 0) {
          const chunk = selectedChunks.find((candidate) => candidate.id === chunkId)!;
          return [chunkId, {
            resourceId: "cpu-metadata",
            byteOffset: chunk.byteOffset,
            byteLength: chunk.expectedResidentBytes
          }];
        }
        const byteLength = variant.payloads[mipIndex]!.byteLength;
        const range = [chunkId, { resourceId, byteOffset: mipByteOffset, byteLength }] as const;
        mipByteOffset += byteLength;
        return range;
      }));
      residency.commit(reservation, ranges);
      settled = true;
    },
    abort(): void {
      if (settled) return;
      settled = true;
      residency.abort(reservation);
    }
  });
}

function validateEncodedVariant(
  source: TexturePackageSourceV2,
  encoded: EncodedTextureVariantV2,
  index: number
): TextureVariantMetadataV2 {
  if (encoded.semantic !== source.semantic) {
    throw new RangeError(`Encoded texture variant ${index} semantic does not match its source`);
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(encoded.profile)) {
    throw new RangeError(`Encoded texture variant ${index} profile is not canonical`);
  }
  for (const [name, value] of [["codecId", encoded.codecId], ["codecRevision", encoded.codecRevision]] as const) {
    if (value.length === 0) throw new RangeError(`Encoded texture variant ${index} ${name} is empty`);
  }
  if (!/^[0-9a-f]{64}$/i.test(encoded.codecBinaryHash)) {
    throw new RangeError(`Encoded texture variant ${index} codecBinaryHash is invalid`);
  }
  const layout = textureFormatBlockLayout(encoded.format);
  if (encoded.blockWidth !== layout.blockWidth || encoded.blockHeight !== layout.blockHeight ||
      encoded.bytesPerBlock !== layout.bytesPerBlock) {
    throw new RangeError(`Encoded texture variant ${index} block layout does not match ${encoded.format}`);
  }
  const expectedLevels = Math.floor(Math.log2(Math.max(source.width, source.height))) + 1;
  if (encoded.mips.length !== expectedLevels) {
    throw new RangeError(`Encoded texture variant ${index} mip chain is incomplete`);
  }
  const id = `${encoded.profile}-${encoded.format}`;
  const mips = encoded.mips.map((mip, level): TextureMipV2 => {
    const logicalWidth = Math.max(1, Math.floor(source.width / 2 ** level));
    const logicalHeight = Math.max(1, Math.floor(source.height / 2 ** level));
    const [physicalWidth, physicalHeight] = physicalTextureExtent(encoded.format, logicalWidth, logicalHeight);
    if (mip.level !== level || mip.logicalWidth !== logicalWidth || mip.logicalHeight !== logicalHeight ||
        mip.physicalWidth !== physicalWidth || mip.physicalHeight !== physicalHeight) {
      throw new RangeError(`Encoded texture variant ${index} mip ${level} extent is invalid`);
    }
    const expectedBytes = encodedTextureMipByteLength(encoded.format, logicalWidth, logicalHeight);
    if (!(mip.payload instanceof Uint8Array) || mip.payload.byteLength !== expectedBytes) {
      throw new RangeError(`Encoded texture variant ${index} mip ${level} payload byte length is invalid`);
    }
    return Object.freeze({
      level,
      logicalWidth,
      logicalHeight,
      physicalWidth,
      physicalHeight,
      chunkId: `${id}-mip-${level}`
    });
  });
  return Object.freeze({
    id,
    profile: encoded.profile,
    format: encoded.format,
    ...layout,
    codecId: encoded.codecId,
    codecRevision: encoded.codecRevision,
    codecBinaryHash: encoded.codecBinaryHash.toLowerCase(),
    mips: Object.freeze(mips)
  });
}

function validateTextureMetadata(raw: unknown, manifest: RuntimeAssetManifestV2): Omit<TextureAssetPackageV2, "runtime" | "evidence"> {
  if (!isRecord(raw) || raw.schemaVersion !== TEXTURE_ASSET_SCHEMA_VERSION) throw new Error("Texture metadata schema is invalid");
  assertDimension(raw.width, "width"); assertDimension(raw.height, "height");
  if (!Number.isSafeInteger(raw.sourceByteLength) || raw.sourceByteLength <= 0) throw new Error("Texture sourceByteLength is invalid");
  if (!isTextureSemantic(raw.semantic)) throw new Error(`Unsupported texture semantic '${String(raw.semantic)}'`);
  if (typeof raw.alphaCutoff !== "number" || raw.alphaCutoff < 0 || raw.alphaCutoff > 1) throw new Error("Texture alphaCutoff is invalid");
  if (!Array.isArray(raw.variants) || raw.variants.length === 0) throw new Error("Texture metadata has no variants");
  const manifestVariants = new Map(manifest.variants.map((variant) => [variant.id, variant]));
  const variants = raw.variants.map((variant: unknown, index: number): TextureVariantMetadataV2 => {
    if (!isRecord(variant)) throw new Error(`Texture variant ${index} is invalid`);
    const manifestVariant = manifestVariants.get(String(variant.id));
    if (manifestVariant === undefined) throw new Error(`Texture variant ${index} is not declared by the manifest`);
    const format = String(variant.format) as GPUTextureFormat;
    const layout = textureFormatBlockLayout(format);
    if (variant.blockWidth !== layout.blockWidth || variant.blockHeight !== layout.blockHeight || variant.bytesPerBlock !== layout.bytesPerBlock) {
      throw new Error(`Texture variant '${String(variant.id)}' block layout is invalid`);
    }
    if (typeof variant.profile !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(variant.profile)) {
      throw new Error(`Texture variant '${String(variant.id)}' profile is invalid`);
    }
    if (variant.profile !== manifestVariant.profile) throw new Error(`Texture variant '${String(variant.id)}' profile does not match its manifest record`);
    if (typeof variant.codecId !== "string" || variant.codecId.length === 0 ||
        typeof variant.codecRevision !== "string" || variant.codecRevision.length === 0 ||
        typeof variant.codecBinaryHash !== "string" || !/^[0-9a-f]{64}$/i.test(variant.codecBinaryHash)) {
      throw new Error(`Texture variant '${String(variant.id)}' codec provenance is invalid`);
    }
    const expectedFeatures = requiredFeaturesForFormat(format);
    if (!sameStrings(manifestVariant.requiredFeatures, expectedFeatures)) {
      throw new Error(`Texture variant '${String(variant.id)}' capability contract is invalid`);
    }
    const expectedLimits = [
      { name: "maxTextureArrayLayers", min: 1 },
      { name: "maxTextureDimension2D", min: Math.max(raw.width, raw.height) }
    ];
    if (canonicalJson(manifestVariant.requiredLimits) !== canonicalJson(expectedLimits)) {
      throw new Error(`Texture variant '${String(variant.id)}' limit contract is invalid`);
    }
    if (!Array.isArray(variant.mips)) throw new Error(`Texture variant '${String(variant.id)}' mips are invalid`);
    const mips = variant.mips.map((mip: unknown, level: number): TextureMipV2 => {
      const logicalWidth = Math.max(1, Math.floor(raw.width / 2 ** level));
      const logicalHeight = Math.max(1, Math.floor(raw.height / 2 ** level));
      const [physicalWidth, physicalHeight] = physicalTextureExtent(format, logicalWidth, logicalHeight);
      if (!isRecord(mip) || mip.level !== level || mip.logicalWidth !== logicalWidth ||
          mip.logicalHeight !== logicalHeight || mip.physicalWidth !== physicalWidth ||
          mip.physicalHeight !== physicalHeight || typeof mip.chunkId !== "string") {
        throw new Error(`Texture variant '${String(variant.id)}' mip ${level} is invalid`);
      }
      const chunk = manifest.chunks.find((candidate) => candidate.id === mip.chunkId);
      if (chunk === undefined) throw new Error(`Texture mip chunk '${mip.chunkId}' is not declared`);
      const expectedBytes = encodedTextureMipByteLength(format, logicalWidth, logicalHeight);
      if (chunk.compressedBytes !== expectedBytes || chunk.expectedResidentBytes !== expectedBytes) {
        throw new Error(`Texture mip chunk '${mip.chunkId}' byte size is invalid`);
      }
      return Object.freeze({ level, logicalWidth, logicalHeight, physicalWidth, physicalHeight, chunkId: mip.chunkId });
    });
    const expectedLevels = Math.floor(Math.log2(Math.max(raw.width, raw.height))) + 1;
    if (mips.length !== expectedLevels) throw new Error(`Texture variant '${String(variant.id)}' mip chain is incomplete`);
    const expectedChunkIds = [TEXTURE_METADATA_CHUNK_ID, ...mips.map(({ chunkId }) => chunkId)].sort();
    if (!sameStrings(manifestVariant.chunkIds, expectedChunkIds)) {
      throw new Error(`Texture variant '${String(variant.id)}' chunk table is invalid`);
    }
    return Object.freeze({
      id: String(variant.id),
      profile: variant.profile,
      format,
      ...layout,
      codecId: variant.codecId,
      codecRevision: variant.codecRevision,
      codecBinaryHash: variant.codecBinaryHash.toLowerCase(),
      mips: Object.freeze(mips)
    });
  });
  if (variants.length !== manifestVariants.size || new Set(variants.map(({ id }) => id)).size !== variants.length) {
    throw new Error("Texture metadata and manifest variant tables do not match");
  }
  const normalized = Object.freeze({
    width: raw.width,
    height: raw.height,
    sourceByteLength: raw.sourceByteLength,
    semantic: raw.semantic,
    alphaCutoff: raw.alphaCutoff,
    variants: Object.freeze(variants)
  });
  if (canonicalJson(raw) !== canonicalJson({ schemaVersion: TEXTURE_ASSET_SCHEMA_VERSION, ...normalized })) {
    throw new Error("Texture metadata contains unknown or non-canonical fields");
  }
  return normalized;
}

function padRows(source: Uint8Array, tight: number, padded: number, rows: number): Uint8Array { const output = new Uint8Array(padded * rows); for (let row = 0; row < rows; row++) output.set(source.subarray(row * tight, (row + 1) * tight), row * padded); return output; }
function alignUp(value: number, alignment: number): number { return Math.ceil(value / alignment) * alignment; }
function requiredFeaturesForFormat(format: GPUTextureFormat): string[] {
  const feature = requiredTextureCompressionFeature(format);
  return feature === null ? [] : [feature];
}
function assertDimension(value: unknown, name: string): asserts value is number { if (!Number.isInteger(value) || Number(value) <= 0 || Number(value) > 16384) throw new RangeError(`Texture ${name} is invalid`); }
function validatePackageSource(source: TexturePackageSourceV2): void {
  assertDimension(source.width, "width");
  assertDimension(source.height, "height");
  if (!isTextureSemantic(source.semantic)) throw new RangeError(`Unsupported texture semantic '${source.semantic}'`);
  if (!source.sourceUri) throw new RangeError("Texture source provenance URI is required");
  if ("rgba8" in source) {
    if (source.rgba8.byteLength !== source.width * source.height * 4) {
      throw new RangeError("Texture source byte length must equal width × height × 4");
    }
  } else {
    if (!Number.isSafeInteger(source.sourceByteLength) || source.sourceByteLength <= 0) {
      throw new RangeError("Encoded texture sourceByteLength must be positive");
    }
    if (!/^[0-9a-f]{64}$/i.test(source.sourceContentHash)) {
      throw new RangeError("Encoded texture sourceContentHash must be a SHA-256 digest");
    }
  }
  if (source.alphaCutoff !== undefined && (!Number.isFinite(source.alphaCutoff) || source.alphaCutoff < 0 || source.alphaCutoff > 1)) {
    throw new RangeError("Texture alphaCutoff must be finite and in [0, 1]");
  }
}
function isTextureSemantic(value: unknown): value is TextureSemanticV2 { return value === "base-color-srgb" || value === "normal-linear" || value === "orm-linear" || value === "alpha-mask" || value === "emissive-srgb"; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
async function sha256Hex(bytes: Uint8Array): Promise<string> { const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer)); return [...digest].map((value) => value.toString(16).padStart(2, "0")).join(""); }
function textureSourceByteLength(source: TexturePackageSourceV2): number {
  return "rgba8" in source ? source.rgba8.byteLength : source.sourceByteLength;
}
async function textureSourceHash(source: TexturePackageSourceV2): Promise<string> {
  if (!("rgba8" in source)) return source.sourceContentHash.toLowerCase();
  const bytes = new Uint8Array(8 + source.rgba8.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, source.width, true);
  view.setUint32(4, source.height, true);
  bytes.set(source.rgba8, 8);
  return sha256Hex(bytes);
}
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Texture package metadata cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError(`Texture package metadata cannot contain ${typeof value}`);
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

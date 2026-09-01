import {
  openRuntimeAssetPackage,
  writeRuntimeAssetPackage,
  type RuntimeAssetPackage
} from "./RuntimeAssetPackage.js";

export const MATERIAL_TEXTURE_PACKAGE_VERSION = 1;
export const MATERIAL_TEXTURE_DIRECTORY_STRIDE = 32;

export const MATERIAL_TEXTURE_SECTION_TYPES = Object.freeze({
  Directory: 0x54580001,
  Ktx2Payload: 0x54580002
});

const KTX2_IDENTIFIER = new Uint8Array([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb,
  0x0d, 0x0a, 0x1a, 0x0a
]);

export interface MaterialTexturePackageInput {
  readonly imageIndex: number;
  readonly bytes: Uint8Array;
}

export interface MaterialTexturePackageRecord {
  readonly imageIndex: number;
  readonly payloadOffset: number;
  readonly payloadLength: number;
  readonly width: number;
  readonly height: number;
  readonly mipLevelCount: number;
  readonly layerCount: number;
  readonly faceCount: number;
}

/**
 * Device-independent KTX2 payload view. The bytes remain owned by the
 * versioned Runtime Asset Package so GPU eviction can later re-transcode the
 * texture without retaining loader Blobs, ImageBitmaps or decoded RGBA data.
 */
export class Ktx2TextureSource {
  readonly kind = "ktx2";

  constructor(
    readonly owner: MaterialTextureAssetPackage,
    readonly record: MaterialTexturePackageRecord
  ) {}

  get width(): number { return this.record.width; }
  get height(): number { return this.record.height; }
  get depth(): number { return this.record.layerCount; }
  get mipLevelCount(): number { return this.record.mipLevelCount; }

  bytes(): Uint8Array {
    return this.owner.payload(this.record);
  }
}

export class MaterialTextureAssetPackage {
  readonly records: readonly MaterialTexturePackageRecord[];
  private readonly recordsByImage = new Map<number, MaterialTexturePackageRecord>();
  private readonly payloadBytes: Uint8Array;

  private constructor(readonly package: RuntimeAssetPackage) {
    const directory = requireSection(package, MATERIAL_TEXTURE_SECTION_TYPES.Directory);
    const payload = requireSection(package, MATERIAL_TEXTURE_SECTION_TYPES.Ktx2Payload);
    this.payloadBytes = payload.bytes;
    const view = new DataView(
      directory.bytes.buffer,
      directory.bytes.byteOffset,
      directory.bytes.byteLength
    );
    const records: MaterialTexturePackageRecord[] = [];
    for (let index = 0; index < directory.elementCount; index++) {
      const base = index * MATERIAL_TEXTURE_DIRECTORY_STRIDE;
      const record = Object.freeze({
        imageIndex: view.getUint32(base, true),
        payloadOffset: view.getUint32(base + 4, true),
        payloadLength: view.getUint32(base + 8, true),
        width: view.getUint32(base + 12, true),
        height: view.getUint32(base + 16, true),
        mipLevelCount: view.getUint32(base + 20, true),
        layerCount: view.getUint32(base + 24, true),
        faceCount: view.getUint32(base + 28, true)
      });
      validateRecord(record, payload.bytes.byteLength);
      if (this.recordsByImage.has(record.imageIndex)) {
        throw new Error(`Material texture package duplicates image ${record.imageIndex}`);
      }
      this.recordsByImage.set(record.imageIndex, record);
      records.push(record);
    }
    this.records = Object.freeze(records);
  }

  source(imageIndex: number): Ktx2TextureSource | undefined {
    const record = this.recordsByImage.get(imageIndex);
    return record === undefined ? undefined : new Ktx2TextureSource(this, record);
  }

  payload(record: MaterialTexturePackageRecord): Uint8Array {
    validateRecord(record, this.payloadBytes.byteLength);
    return this.payloadBytes.subarray(
      record.payloadOffset,
      record.payloadOffset + record.payloadLength
    );
  }

  evidence(): Readonly<{
    schemaVersion: 1;
    textureCount: number;
    packageBytes: number;
    ktx2PayloadBytes: number;
  }> {
    return Object.freeze({
      schemaVersion: 1,
      textureCount: this.records.length,
      packageBytes: this.package.manifest.totalByteLength,
      ktx2PayloadBytes: this.payloadBytes.byteLength
    });
  }

  static async open(bytes: ArrayBuffer): Promise<MaterialTextureAssetPackage> {
    const pkg = await openRuntimeAssetPackage(bytes, {
      supportedSectionTypes: new Set(Object.values(MATERIAL_TEXTURE_SECTION_TYPES))
    });
    return new MaterialTextureAssetPackage(pkg);
  }
}

/** Cooker seam for already-authored KTX2/Basis payloads such as gltfpack -tc/-tu. */
export async function cookMaterialTextureAssetPackage(
  input: readonly MaterialTexturePackageInput[]
): Promise<MaterialTextureAssetPackage> {
  const sorted = [...input].sort((left, right) => left.imageIndex - right.imageIndex);
  let payloadLength = 0;
  const parsed = sorted.map((item, index) => {
    if (!Number.isInteger(item.imageIndex) || item.imageIndex < 0) {
      throw new RangeError(`Texture package input ${index} has invalid imageIndex`);
    }
    if (index > 0 && sorted[index - 1]!.imageIndex === item.imageIndex) {
      throw new RangeError(`Texture package input duplicates image ${item.imageIndex}`);
    }
    const header = parseKtx2Header(item.bytes);
    payloadLength = align16(payloadLength);
    const payloadOffset = payloadLength;
    payloadLength += item.bytes.byteLength;
    return { item, header, payloadOffset };
  });
  const directory = new Uint8Array(parsed.length * MATERIAL_TEXTURE_DIRECTORY_STRIDE);
  const directoryView = new DataView(directory.buffer);
  const payload = new Uint8Array(payloadLength);
  for (let index = 0; index < parsed.length; index++) {
    const { item, header, payloadOffset } = parsed[index]!;
    payload.set(item.bytes, payloadOffset);
    const base = index * MATERIAL_TEXTURE_DIRECTORY_STRIDE;
    directoryView.setUint32(base, item.imageIndex, true);
    directoryView.setUint32(base + 4, payloadOffset, true);
    directoryView.setUint32(base + 8, item.bytes.byteLength, true);
    directoryView.setUint32(base + 12, header.width, true);
    directoryView.setUint32(base + 16, header.height, true);
    directoryView.setUint32(base + 20, header.mipLevelCount, true);
    directoryView.setUint32(base + 24, header.layerCount, true);
    directoryView.setUint32(base + 28, header.faceCount, true);
  }
  const bytes = await writeRuntimeAssetPackage({
    sections: [
      {
        type: MATERIAL_TEXTURE_SECTION_TYPES.Directory,
        data: directory,
        elementStride: MATERIAL_TEXTURE_DIRECTORY_STRIDE,
        elementCount: parsed.length,
        alignment: 16
      },
      {
        type: MATERIAL_TEXTURE_SECTION_TYPES.Ktx2Payload,
        data: payload,
        elementStride: 1,
        elementCount: payload.byteLength,
        alignment: 16
      }
    ]
  });
  return MaterialTextureAssetPackage.open(bytes);
}

export function isKtx2TextureSource(value: unknown): value is Ktx2TextureSource {
  return value instanceof Ktx2TextureSource;
}

function parseKtx2Header(bytes: Uint8Array): Readonly<{
  width: number;
  height: number;
  mipLevelCount: number;
  layerCount: number;
  faceCount: number;
}> {
  if (bytes.byteLength < 80) throw new Error("KTX2 payload is smaller than its header");
  for (let index = 0; index < KTX2_IDENTIFIER.length; index++) {
    if (bytes[index] !== KTX2_IDENTIFIER[index]) {
      throw new Error("KTX2 payload has an invalid identifier");
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(20, true);
  const height = view.getUint32(24, true);
  const depth = view.getUint32(28, true);
  const layerCount = Math.max(1, view.getUint32(32, true));
  const faceCount = view.getUint32(36, true);
  const mipLevelCount = Math.max(1, view.getUint32(40, true));
  if (width === 0 || height === 0 || depth > 1 || faceCount !== 1) {
    throw new Error(
      `Only non-empty 2D KTX2 textures are supported (got ${width}x${height}x${depth}, faces=${faceCount})`
    );
  }
  return Object.freeze({ width, height, mipLevelCount, layerCount, faceCount });
}

function requireSection(pkg: RuntimeAssetPackage, type: number) {
  const section = pkg.section(type);
  if (section === undefined) throw new Error(`Material texture package misses section ${type}`);
  return section;
}

function validateRecord(record: MaterialTexturePackageRecord, payloadBytes: number): void {
  if (
    record.width === 0 || record.height === 0 || record.mipLevelCount === 0 ||
    record.layerCount === 0 || record.faceCount !== 1 ||
    record.payloadLength === 0 ||
    record.payloadOffset > payloadBytes ||
    record.payloadLength > payloadBytes - record.payloadOffset
  ) {
    throw new Error(`Material texture package record ${record.imageIndex} is invalid`);
  }
}

function align16(value: number): number {
  return (value + 15) & ~15;
}

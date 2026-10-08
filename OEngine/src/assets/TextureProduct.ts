import { openRuntimeAssetPackageV2, writeRuntimeAssetPackageV2 } from "./RuntimeAssetManifestV2.js";
import { encodedTextureMipByteLength, physicalTextureExtent } from "./codec/TextureFormatLayout.js";
export type TextureSemanticV2 =
  | "base-color-srgb"
  | "normal-linear"
  | "orm-linear"
  | "occlusion-linear"
  | "alpha-mask"
  | "emissive-srgb";

export const PC_TEXTURE_INPUT_LIMIT = 128 * 1024 * 1024;
export const PC_TEXTURE_OUTPUT_LIMIT = 128 * 1024 * 1024;
export const PC_TEXTURE_WASM_LIMIT = 256 * 1024 * 1024;
export type PcTextureFormat = "bc7-rgba-unorm" | "bc7-rgba-unorm-srgb" | "bc4-r-unorm" | "r8unorm";
export interface TextureProductRecipe {
  readonly encoder: string;
  readonly revision: string;
  readonly binaryHash: string;
  readonly filter: "linear" | "linear-normal" | "provided";
  readonly quality: "bc7e-scalar-6-bc4-hq" | "external-final";
}
export interface TextureProductMip {
  readonly level: number;
  readonly width: number;
  readonly height: number;
  readonly physicalWidth: number;
  readonly physicalHeight: number;
  readonly byteLength: number;
  readonly chunkId: string;
  readonly hash: string;
}
export interface TextureProductPlane {
  readonly role: "color" | "scalar" | "coverage";
  readonly format: PcTextureFormat;
  readonly mips: readonly TextureProductMip[];
}
export interface TextureProductMetadata {
  readonly schemaVersion: 3;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly storageWidth: number;
  readonly storageHeight: number;
  readonly sourceBytes: number;
  readonly sourceHash: string;
  readonly sourceUri: string;
  readonly semantic: TextureSemanticV2;
  readonly channel: 0 | 1 | 2 | 3;
  readonly exactAlpha: boolean;
  readonly uvScaleBias: readonly [1, 1, 0, 0];
  readonly recipe: TextureProductRecipe;
  readonly planes: readonly TextureProductPlane[];
}
/** Immutable, exclusively handed-off chunks or archive views. Do not modify them
 * after validation. No GPU owner; retain this product for replay on a new device. */
export interface TextureProduct {
  readonly metadata: TextureProductMetadata;
  readonly identity: string;
  readonly recipeHash: string;
  readonly chunks: ReadonlyMap<string, Uint8Array>;
  readonly evidence: Readonly<{
    sourceBytes: number;
    ownedPayloadBytes: number;
    rgbaEquivalentBytes: number;
    coverageBytes: number;
    packageBytes: number;
    actualDecodedPeakBytes: null;
    runtimeMipPasses: 0;
  }>;
}
const validatedProducts = new WeakSet<TextureProduct>();
export function assertValidatedTextureProduct(product: TextureProduct): void {
  if (!validatedProducts.has(product))
    throw new Error("Texture Product must be created by the schema3 validator");
}

export function pcTextureStorageExtent(width: number, height: number): readonly [number, number] {
  dimension(width);
  dimension(height);
  return [Math.ceil(width / 4) * 4, Math.ceil(height / 4) * 4];
}
export function pcTextureFormat(semantic: TextureSemanticV2): PcTextureFormat {
  if (semantic === "alpha-mask") {
    return "r8unorm";
  }
  if (semantic === "occlusion-linear") {
    return "bc4-r-unorm";
  }
  return semantic === "base-color-srgb" || semantic === "emissive-srgb"
    ? "bc7-rgba-unorm-srgb"
    : "bc7-rgba-unorm";
}
export function textureProductMipCount(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}
export function textureProductPayloadBytes(
  width: number,
  height: number,
  semantic: TextureSemanticV2,
  exactAlpha: boolean,
): number {
  const [w, h] = pcTextureStorageExtent(width, height);
  let bytes = 0;
  for (let l = 0; l < textureProductMipCount(w, h); l++) {
    const mw = Math.max(1, Math.floor(w / 2 ** l)),
      mh = Math.max(1, Math.floor(h / 2 ** l));
    bytes += encodedTextureMipByteLength(pcTextureFormat(semantic), mw, mh);
    if (exactAlpha && semantic !== "alpha-mask") {
      bytes += mw * mh;
    }
  }
  if (bytes > PC_TEXTURE_OUTPUT_LIMIT) {
    throw new RangeError("PC texture output budget exceeded");
  }
  return bytes;
}

/** Shared in-memory / disk contract. Checks hashes, dimensions, semantic planes
 * and exact byte domain before allocation/upload. Sampler and UV are not payload keys. */
export async function validateTextureProduct(
  metadata: TextureProductMetadata,
  chunks: ReadonlyMap<string, Uint8Array>,
  packageBytes = 0,
): Promise<TextureProduct> {
  if (metadata.schemaVersion !== 3) {
    throw new Error("Texture metadata requires schema3; recook schema2 asset");
  }
  const [w, h] = pcTextureStorageExtent(metadata.sourceWidth, metadata.sourceHeight);
  if (
    metadata.storageWidth !== w ||
    metadata.storageHeight !== h ||
    canonical(metadata.uvScaleBias) !== "[1,1,0,0]"
  ) {
    throw new Error("Texture storage/UV domain is invalid");
  }
  if (
    !Number.isSafeInteger(metadata.sourceBytes) ||
    metadata.sourceBytes <= 0 ||
    metadata.sourceBytes > PC_TEXTURE_INPUT_LIMIT
  ) {
    throw new Error("Texture input budget is invalid");
  }
  if (
    !Number.isInteger(metadata.channel) ||
    metadata.channel < 0 ||
    metadata.channel > 3 ||
    typeof metadata.exactAlpha !== "boolean"
  ) {
    throw new Error("Texture channel/coverage contract is invalid");
  }
  if (
    ![
      "base-color-srgb",
      "emissive-srgb",
      "normal-linear",
      "orm-linear",
      "occlusion-linear",
      "alpha-mask",
    ].includes(metadata.semantic)
  ) {
    throw new Error("Texture semantic invalid");
  }
  if (metadata.semantic === "alpha-mask" && !metadata.exactAlpha) {
    throw new Error("Alpha mask requires exact coverage");
  }
  hash(metadata.sourceHash);
  hash(metadata.recipe.binaryHash);
  if (
    !metadata.sourceUri ||
    !metadata.recipe.encoder ||
    !metadata.recipe.revision ||
    !["linear", "linear-normal", "provided"].includes(metadata.recipe.filter) ||
    !["bc7e-scalar-6-bc4-hq", "external-final"].includes(metadata.recipe.quality)
  ) {
    throw new Error("Texture recipe invalid");
  }
  exactKeys(metadata, [
    "schemaVersion",
    "sourceWidth",
    "sourceHeight",
    "storageWidth",
    "storageHeight",
    "sourceBytes",
    "sourceHash",
    "sourceUri",
    "semantic",
    "channel",
    "exactAlpha",
    "uvScaleBias",
    "recipe",
    "planes",
  ]);
  exactKeys(metadata.recipe, ["encoder", "revision", "binaryHash", "filter", "quality"]);
  const expectedRoles =
    metadata.semantic === "alpha-mask"
      ? ["coverage"]
      : metadata.exactAlpha
        ? ["color", "coverage"]
        : [metadata.semantic === "occlusion-linear" ? "scalar" : "color"];
  // Scalar + exact coverage is intentionally not a third format family.
  if (metadata.exactAlpha && metadata.semantic === "occlusion-linear") {
    throw new Error("Scalar/coverage product needs a separate authored semantic");
  }
  textureProductPayloadBytes(
    metadata.sourceWidth,
    metadata.sourceHeight,
    metadata.semantic,
    metadata.exactAlpha,
  );
  if (metadata.planes.length !== expectedRoles.length) {
    throw new Error("Texture plane count invalid");
  }
  const seen = new Set<string>();
  let bytes = 0,
    coverageBytes = 0,
    rgbaEquivalentBytes = 0;
  for (let p = 0; p < metadata.planes.length; p++) {
    const plane = metadata.planes[p]!;
    exactKeys(plane, ["role", "format", "mips"]);
    const expectedFormat = plane.role === "coverage" ? "r8unorm" : pcTextureFormat(metadata.semantic);
    if (plane.role !== expectedRoles[p] || plane.format !== expectedFormat) {
      throw new Error("Texture plane semantic/format mismatch");
    }
    if (plane.mips.length !== textureProductMipCount(w, h)) {
      throw new Error("Texture full mip chain missing");
    }
    for (let l = 0; l < plane.mips.length; l++) {
      const mip = plane.mips[l]!;
      exactKeys(mip, [
        "level",
        "width",
        "height",
        "physicalWidth",
        "physicalHeight",
        "byteLength",
        "chunkId",
        "hash",
      ]);
      const mw = Math.max(1, Math.floor(w / 2 ** l)),
        mh = Math.max(1, Math.floor(h / 2 ** l));
      const [pw, ph] = physicalTextureExtent(plane.format, mw, mh);
      const expectedBytes = encodedTextureMipByteLength(plane.format, mw, mh);
      if (
        mip.level !== l ||
        mip.width !== mw ||
        mip.height !== mh ||
        mip.physicalWidth !== pw ||
        mip.physicalHeight !== ph ||
        mip.byteLength !== expectedBytes ||
        mip.chunkId !== `${plane.role}-mip-${l}` ||
        seen.has(mip.chunkId)
      ) {
        throw new Error("Texture mip extent/identity/bytes invalid");
      }
      seen.add(mip.chunkId);
      hash(mip.hash);
      const payload = chunks.get(mip.chunkId);
      if (
        !payload ||
        payload.byteLength !== expectedBytes ||
        (await textureProductHash(payload)) !== mip.hash
      ) {
        throw new Error("Texture chunk checksum/length invalid");
      }
      bytes += expectedBytes;
      if (plane.role === "coverage") {
        coverageBytes += expectedBytes;
      } else {
        rgbaEquivalentBytes += mw * mh * 4;
      }
    }
  }
  if (seen.size !== chunks.size || bytes > PC_TEXTURE_OUTPUT_LIMIT) {
    throw new Error("Texture chunk domain/output budget invalid");
  }
  const recipeHash = await textureProductHash(
    new TextEncoder().encode(
      canonical({
        ...metadata,
        sourceUri: undefined,
        sourceHash: undefined,
        sourceBytes: undefined,
        planes: metadata.planes.map((p) => ({ role: p.role, format: p.format })),
      }),
    ),
  );
  const identity = await textureProductHash(
    new TextEncoder().encode(
      canonical({
        sourceHash: metadata.sourceHash,
        recipeHash,
        payloads: metadata.planes.map((p) => p.mips.map((m) => m.hash)),
      }),
    ),
  );
  // Normalize through a private metadata copy; payloads are ownership hand-offs.
  const ownedMetadata = JSON.parse(JSON.stringify(metadata)) as TextureProductMetadata;
  deepFreeze(ownedMetadata);
  const product: TextureProduct = Object.freeze({
    metadata: ownedMetadata,
    identity,
    recipeHash,
    chunks: new Map(chunks),
    evidence: Object.freeze({
      sourceBytes: metadata.sourceBytes,
      ownedPayloadBytes: bytes,
      rgbaEquivalentBytes,
      coverageBytes,
      packageBytes,
      actualDecodedPeakBytes: null,
      runtimeMipPasses: 0 as const,
    }),
  });
  validatedProducts.add(product);
  return product;
}

export async function saveTextureProduct(product: TextureProduct): Promise<ArrayBuffer> {
  await validateTextureProduct(product.metadata, product.chunks);
  const data = new TextEncoder().encode(canonical(product.metadata));
  let section = 0x1000;
  return writeRuntimeAssetPackageV2({
    manifest: {
      assetSchemaVersion: 3,
      assetId: product.identity,
      assetType: "texture-2d",
      cookerVersion: "pc-bc-product-3",
      recipeHash: product.recipeHash,
      sourceProvenance: { uri: product.metadata.sourceUri, contentHash: product.metadata.sourceHash },
      dependencies: [],
      variants: [
        {
          id: "desktop-bc",
          profile: "desktop-bc",
          requiredFeatures: ["texture-compression-bc"],
          requiredLimits: [
            { name: "maxTextureArrayLayers", min: 1 },
            {
              name: "maxTextureDimension2D",
              min: Math.max(product.metadata.storageWidth, product.metadata.storageHeight),
            },
          ],
          chunkIds: ["texture-metadata", ...product.chunks.keys()],
        },
      ],
    },
    chunks: [
      {
        id: "texture-metadata",
        sectionType: 0x200,
        semantic: "texture-metadata",
        compression: "none",
        decodedBytes: data.byteLength,
        expectedResidentBytes: 0,
        data,
      },
      ...product.metadata.planes.flatMap((plane) =>
        plane.mips.map((mip) => ({
          id: mip.chunkId,
          sectionType: section++,
          semantic: plane.role,
          compression: plane.format,
          decodedBytes: mip.width * mip.height * (plane.role === "coverage" ? 1 : 4),
          expectedResidentBytes: mip.byteLength,
          data: product.chunks.get(mip.chunkId)!,
        })),
      ),
    ],
  });
}

export async function openTextureProduct(bytes: ArrayBuffer): Promise<TextureProduct> {
  const runtime = await openRuntimeAssetPackageV2(bytes);
  const manifest = runtime.manifest;
  if (manifest.assetSchemaVersion !== 3 || manifest.assetType !== "texture-2d") {
    throw new Error("Texture metadata requires schema3; recook schema2 asset");
  }
  const metadataBytes = runtime.chunks.get("texture-metadata");
  if (!metadataBytes) {
    throw new Error("Missing texture metadata");
  }
  const metadata = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(metadataBytes),
  ) as TextureProductMetadata;
  const chunks = new Map(runtime.chunks);
  chunks.delete("texture-metadata");
  const product = await validateTextureProduct(metadata, chunks, bytes.byteLength);
  const v = manifest.variants;
  if (
    manifest.assetId !== product.identity ||
    manifest.recipeHash !== product.recipeHash ||
    manifest.sourceProvenance.contentHash !== metadata.sourceHash ||
    manifest.sourceProvenance.uri !== metadata.sourceUri ||
    v.length !== 1 ||
    v[0]!.id !== "desktop-bc" ||
    v[0]!.profile !== "desktop-bc" ||
    canonical(v[0]!.requiredFeatures) !== '["texture-compression-bc"]' ||
    canonical(v[0]!.requiredLimits) !==
      canonical([
        { name: "maxTextureArrayLayers", min: 1 },
        { name: "maxTextureDimension2D", min: Math.max(metadata.storageWidth, metadata.storageHeight) },
      ]) ||
    canonical([...v[0]!.chunkIds].sort()) !== canonical([...runtime.chunks.keys()].sort())
  ) {
    throw new Error("Texture manifest identity/capability invalid");
  }
  for (const plane of metadata.planes) {
    for (const mip of plane.mips) {
      const c = manifest.chunks.find((c) => c.id === mip.chunkId)!;
      if (
        c.compression !== plane.format ||
        c.semantic !== plane.role ||
        c.compressedBytes !== mip.byteLength ||
        c.expectedResidentBytes !== mip.byteLength ||
        c.decodedBytes !== mip.width * mip.height * (plane.role === "coverage" ? 1 : 4)
      ) {
        throw new Error("Texture manifest chunk contract invalid");
      }
    }
  }
  return product;
}

/** Upload glue for the non-production oracle and T4.2 owner. Caller owns allocation,
 * reservation, submit/fence and publication. This function never creates/submits. */
export function writeTextureProductPlane(
  device: GPUDevice,
  product: TextureProduct,
  planeIndex: number,
  target: GPUTexture,
  layer: number,
  minMip = 0,
  onUploaded?: (bytes: number) => void,
): number {
  if (!device.features.has("texture-compression-bc")) {
    throw new Error("PC texture profile requires BC");
  }
  const plane = product.metadata.planes[planeIndex];
  if (
    !plane ||
    !Number.isInteger(layer) ||
    layer < 0 ||
    layer >= target.depthOrArrayLayers ||
    target.format !== plane.format ||
    target.width !== product.metadata.storageWidth ||
    target.height !== product.metadata.storageHeight ||
    target.mipLevelCount !== plane.mips.length ||
    target.dimension !== "2d" ||
    target.sampleCount !== 1 ||
    !(target.usage & GPUTextureUsage.COPY_DST) ||
    !Number.isInteger(minMip) ||
    minMip < 0 ||
    minMip >= plane.mips.length
  ) {
    throw new Error("Texture destination contract invalid");
  }
  for (const mip of plane.mips) {
    if (!product.chunks.get(mip.chunkId) || product.chunks.get(mip.chunkId)!.byteLength !== mip.byteLength) {
      throw new Error("Texture upload chunk missing/detached");
    }
  }
  let bytes = 0;
  for (const mip of plane.mips) {
    if (mip.level < minMip) {
      continue;
    }
    const block = plane.format === "r8unorm" ? 1 : 4;
    device.queue.writeTexture(
      { texture: target, mipLevel: mip.level, origin: [0, 0, layer] },
      product.chunks.get(mip.chunkId)! as Uint8Array<ArrayBuffer>,
      {
        bytesPerRow: mip.byteLength / (mip.physicalHeight / block),
        rowsPerImage: mip.physicalHeight / block,
      },
      { width: mip.physicalWidth, height: mip.physicalHeight, depthOrArrayLayers: 1 },
    );
    bytes += mip.byteLength;
    onUploaded?.(mip.byteLength);
  }
  return bytes;
}

export async function textureProductHash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return [...digest].map((v) => v.toString(16).padStart(2, "0")).join("");
}
function dimension(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 16384) {
    throw new RangeError("PC texture dimension invalid");
  }
}
function hash(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("Texture hash invalid");
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
function deepFreeze(value: object): void {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      deepFreeze(child);
    }
  }
  Object.freeze(value);
}
function exactKeys(value: object, keys: readonly string[]): void {
  if (canonical(Object.keys(value).sort()) !== canonical([...keys].sort())) {
    throw new Error("Texture metadata unknown/missing fields");
  }
}

import createBasisBcModule, { type BasisBcModule } from "./vendor/pc-texture/basis_bc.js";
import createKtxPcModule, { type KtxPcModule } from "./vendor/pc-texture/ktx_pc.js";
import {
  PC_TEXTURE_INPUT_LIMIT,
  PC_TEXTURE_WASM_LIMIT,
  pcTextureFormat,
  pcTextureStorageExtent,
  textureProductMipCount,
  textureProductPayloadBytes,
  textureProductHash,
  validateTextureProduct,
  type TextureProduct,
  type TextureProductMetadata,
  type TextureProductPlane,
  type TextureProductRecipe,
} from "../TextureProduct.js";
import type { TextureSemanticV2 } from "../TextureProduct.js";
import { encodedTextureMipByteLength, physicalTextureExtent } from "./TextureFormatLayout.js";

export const BASIS_BC_REVISION = "99f52d63aa6799cbdaecfe977111dc5ec3b31d47";
export const KTX_PC_REVISION = "4d6fc70eaf62ad0558e63e8d97eb9766118327a6";
// Normal mip scratch is larger than the read/transcode working set. Keep the
// combined hard cap, including both retained instances, at 256 MiB.
export const PC_TEXTURE_CODEC_HEAP_LIMIT = 96 * 1024 * 1024;
export interface PcTextureCookOptions {
  readonly semantic: TextureSemanticV2;
  readonly channel?: 0 | 1 | 2 | 3;
  readonly exactAlpha?: boolean;
  readonly sourceUri: string;
  readonly sourceHash?: string;
  readonly sourceBytes?: number;
}
export interface PcTextureCookEvidence {
  readonly prepareMs: number;
  readonly encodeMs: number;
  readonly transcodeMs: number;
  readonly ownedCopyBytes: number;
  readonly wasmLinearHighWaterBytes: number;
  readonly workerTaskMs: number | null;
  readonly decodeMs: number;
  readonly queueAndInitMs: number | null;
}
export interface PcTextureCookResult {
  readonly product: TextureProduct;
  readonly evidence: PcTextureCookEvidence;
}
export interface PcTextureCodecs {
  readonly basis: BasisBcModule;
  readonly ktx: KtxPcModule;
  readonly basisHash: string;
  readonly ktxHash: string;
}

/** Cold-only initialization. Failure is not cached by the caller's Worker factory. */
export async function initializePcTextureCodecs(): Promise<PcTextureCodecs> {
  const source = await fetch(new URL("./vendor/pc-texture/source.json", import.meta.url));
  if (!source.ok) {
    throw new Error("PC codec identity fetch failed");
  }
  const identity = (await source.json()) as {
    pins: { basis: string; ktx: string };
    hashes: Record<string, string>;
  };
  if (identity.pins.basis !== BASIS_BC_REVISION || identity.pins.ktx !== KTX_PC_REVISION) {
    throw new Error("PC codec revision mismatch");
  }
  const binaries: ArrayBuffer[] = [];
  for (const name of ["basis_bc.wasm", "ktx_pc.wasm"]) {
    const r = await fetch(new URL(`./vendor/pc-texture/${name}`, import.meta.url));
    if (!r.ok) {
      throw new Error(`PC codec binary ${name} fetch failed`);
    }
    const bytes = await r.arrayBuffer();
    if ((await textureProductHash(new Uint8Array(bytes))) !== identity.hashes[name]) {
      throw new Error("PC codec binary hash mismatch");
    }
    binaries.push(bytes);
  }
  return {
    basis: await createBasisBcModule({ wasmBinary: binaries[0]! }),
    ktx: await createKtxPcModule({ wasmBinary: binaries[1]! }),
    basisHash: identity.hashes["basis_bc.wasm"]!,
    ktxHash: identity.hashes["ktx_pc.wasm"]!,
  };
}

export function estimatePcTextureCookBytes(
  width: number,
  height: number,
  semantic: TextureSemanticV2,
  exactAlpha: boolean,
  providedBytes = 0,
): number {
  const [w, h] = pcTextureStorageExtent(width, height);
  const output = textureProductPayloadBytes(width, height, semantic, exactAlpha);
  // Source JS + WASM, largest float resampling surface/byte output, retained chunks,
  // allocator/table/scanline slack. Admission happens before native decode/encode.
  const resamplePixels =
    providedBytes > 0 && w === width && h === height
      ? 0
      : w === width && h === height
        ? Math.max(1, w >> 1) * Math.max(1, h >> 1)
        : w * h;
  const resampleBytesPerPixel = semantic === "normal-linear" && providedBytes === 0 ? 20 : 8;
  const bytes =
    width * height * 8 +
    providedBytes * 2 +
    resamplePixels * resampleBytesPerPixel +
    output +
    16 * 1024 * 1024;
  if (width * height * 4 + providedBytes > PC_TEXTURE_INPUT_LIMIT || bytes > PC_TEXTURE_WASM_LIMIT) {
    throw new RangeError("PC texture cold cook memory admission failed");
  }
  return bytes;
}

/** No GPU resources. Input mips, when provided, retain signed/non-unit XYZ exactly;
 * raw generation uses the current normalize-after-linear-filter producer recipe. */
export async function cookPcTextureRgba(
  codecs: PcTextureCodecs,
  rgba: Uint8Array,
  width: number,
  height: number,
  options: PcTextureCookOptions,
  providedMips?: readonly Uint8Array[],
): Promise<PcTextureCookResult> {
  const started = performance.now();
  const exactAlpha = options.exactAlpha === true || options.semantic === "alpha-mask";
  if (exactAlpha && options.semantic === "occlusion-linear") {
    throw new Error("Scalar/exact coverage semantic invalid");
  }
  const providedBytes = providedMips?.reduce((sum, mip) => sum + mip.byteLength, 0) ?? 0;
  estimatePcTextureCookBytes(width, height, options.semantic, exactAlpha, providedBytes);
  if (rgba.byteLength !== width * height * 4) {
    throw new Error("RGBA source byte length invalid");
  }
  const [w, h] = pcTextureStorageExtent(width, height);
  const count = textureProductMipCount(w, h);
  const sourceMipCount = textureProductMipCount(width, height);
  if (providedMips && providedMips.length !== sourceMipCount - 1) {
    throw new Error("Provided mip chain must match full source domain");
  }
  const srgb = options.semantic === "base-color-srgb" || options.semantic === "emissive-srgb";
  const normal = options.semantic === "normal-linear";
  const channel = options.channel ?? (options.semantic === "alpha-mask" ? 3 : 0);
  const recipe: TextureProductRecipe = {
    encoder: "basis-universal-direct-bc",
    revision: BASIS_BC_REVISION,
    binaryHash: codecs.basisHash,
    quality: "bc7e-scalar-6-bc4-hq",
    filter: providedMips ? "provided" : normal ? "linear-normal" : "linear",
  };
  let source = rgba,
    sw = width,
    sh = height,
    encodeMs = 0,
    prepareMs = 0;
  const chunks = new Map<string, Uint8Array>();
  const planes: Array<{
    role: TextureProductPlane["role"];
    format: TextureProductPlane["format"];
    mips: TextureProductPlane["mips"][number][];
  }> = [];
  if (options.semantic !== "alpha-mask") {
    planes.push({
      role: options.semantic === "occlusion-linear" ? "scalar" : "color",
      format: pcTextureFormat(options.semantic),
      mips: [],
    });
  }
  if (exactAlpha) {
    planes.push({ role: "coverage", format: "r8unorm", mips: [] });
  }
  let ownedCopyBytes = 0;
  for (let level = 0; level < count; level++) {
    const mw = Math.max(1, Math.floor(w / 2 ** level)),
      mh = Math.max(1, Math.floor(h / 2 ** level));
    const prepareStart = performance.now();
    if (providedMips) {
      const sourceLevel = Math.min(level, sourceMipCount - 1);
      source = sourceLevel === 0 ? rgba : providedMips[sourceLevel - 1]!;
      sw = Math.max(1, Math.floor(width / 2 ** sourceLevel));
      sh = Math.max(1, Math.floor(height / 2 ** sourceLevel));
      if (source.byteLength !== sw * sh * 4) {
        throw new Error("Provided mip bytes invalid");
      }
    }
    if (sw !== mw || sh !== mh) {
      source = resamplePcTexture(codecs.basis, source, sw, sh, mw, mh, srgb, normal && !providedMips);
      ownedCopyBytes += source.byteLength;
    }
    sw = mw;
    sh = mh;
    prepareMs += performance.now() - prepareStart;
    for (const plane of planes) {
      const encodeStart = performance.now();
      let payload: Uint8Array;
      if (plane.role === "coverage") {
        payload = new Uint8Array(mw * mh);
        const coverageChannel = options.semantic === "alpha-mask" ? channel : 3;
        for (let i = 0; i < payload.length; i++) {
          payload[i] = source[i * 4 + coverageChannel]!;
        }
      } else {
        payload = encodePcTextureMip(
          codecs.basis,
          source,
          mw,
          mh,
          plane.format === "bc4-r-unorm" ? 4 : 7,
          srgb,
          channel,
        );
      }
      ownedCopyBytes += payload.byteLength;
      encodeMs += performance.now() - encodeStart;
      await appendMip(chunks, plane, level, mw, mh, payload);
    }
  }
  const product = await validateTextureProduct(
    {
      schemaVersion: 3,
      sourceWidth: width,
      sourceHeight: height,
      storageWidth: w,
      storageHeight: h,
      sourceUri: options.sourceUri,
      sourceHash: options.sourceHash ?? (await textureProductHash(rgba)),
      sourceBytes: options.sourceBytes ?? rgba.byteLength + providedBytes,
      semantic: options.semantic,
      channel,
      exactAlpha,
      uvScaleBias: [1, 1, 0, 0],
      recipe,
      planes,
    },
    chunks,
  );
  return {
    product,
    evidence: {
      prepareMs,
      encodeMs,
      transcodeMs: 0,
      ownedCopyBytes,
      wasmLinearHighWaterBytes: codecs.basis.HEAPU8.byteLength + codecs.ktx.HEAPU8.byteLength,
      workerTaskMs: null,
      decodeMs: 0,
      queueAndInitMs: null,
    },
  };
}

/** Metadata-only libktx parse bounds shape, DFD, levels and inflated bytes before
 * load/transcode. A current-frame GPU control loop is never involved. */
export async function importPcTextureKtx(
  codecs: PcTextureCodecs,
  input: Uint8Array,
  options: PcTextureCookOptions,
): Promise<PcTextureCookResult> {
  const start = performance.now();
  let transcodeMs = 0;
  if (
    input.byteLength < 12 ||
    input.byteLength > PC_TEXTURE_INPUT_LIMIT ||
    ![0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => input[i] === v)
  ) {
    throw new Error("KTX magic/input budget invalid");
  }
  const texture = new codecs.ktx.Texture(input, true);
  try {
    if (texture.status() !== 0) {
      throw new Error(`KTX parse: ${texture.message()}`);
    }
    const w = texture.get(0),
      h = texture.get(1),
      levels = texture.get(4),
      model = texture.get(8),
      transfer = texture.get(9),
      vk = texture.get(11);
    if (
      texture.get(3) !== 2 ||
      texture.get(6) !== 1 ||
      texture.get(7) !== 0 ||
      texture.get(5) > 1 ||
      texture.get(2) > 1
    ) {
      throw new Error("KTX accepts only non-array 2D texture");
    }
    const exact = options.exactAlpha === true || options.semantic === "alpha-mask";
    const needsTranscoding = texture.get(12) !== 0;
    const credit = estimatePcTextureCookBytes(w, h, options.semantic, exact);
    if (
      input.byteLength + texture.get(13) + 16 * 1024 * 1024 > PC_TEXTURE_CODEC_HEAP_LIMIT ||
      credit > PC_TEXTURE_WASM_LIMIT
    ) {
      throw new Error("KTX parsed decoded/output budget exceeded");
    }
    if (!levels || levels > textureProductMipCount(w, h)) {
      throw new Error("KTX mip domain invalid");
    }
    const srgb = pcTextureFormat(options.semantic) === "bc7-rgba-unorm-srgb";
    if (transfer !== 1 && transfer !== 2) {
      throw new Error("KTX transfer function unsupported");
    }
    if (needsTranscoding && model !== 163 && model !== 166) {
      throw new Error("KTX Basis color model unsupported");
    }
    const sourceHash = options.sourceHash ?? (await textureProductHash(input));
    const sourceOptions = { ...options, sourceHash, sourceBytes: options.sourceBytes ?? input.byteLength };
    const [storageW, storageH] = pcTextureStorageExtent(w, h);
    const scalar = options.semantic === "occlusion-linear";
    const direct =
      !exact &&
      w === storageW &&
      h === storageH &&
      levels === textureProductMipCount(w, h) &&
      (transfer === 2) === srgb &&
      (!scalar || (options.channel ?? 0) === 0);
    const expectedVk = scalar ? 139 : srgb ? 146 : 145; // Vulkan BC4 / BC7 UNORM/SRGB ABI
    let decodedChainBytes = 0;
    for (let level = 0; level < levels; level++) {
      decodedChainBytes += Math.max(1, w >> level) * Math.max(1, h >> level) * 4;
    }
    const transcodeOutputBytes = needsTranscoding
      ? direct
        ? textureProductPayloadBytes(w, h, options.semantic, false)
        : decodedChainBytes
      : 0;
    // Transcode may keep source and old payload alive while allocating output.
    if (
      input.byteLength + texture.get(13) + transcodeOutputBytes + 16 * 1024 * 1024 >
      PC_TEXTURE_CODEC_HEAP_LIMIT
    ) {
      throw new Error("KTX transcode live heap budget exceeded");
    }
    if (texture.load() !== 0) {
      throw new Error(`KTX load: ${texture.message()}`);
    }
    if (direct && (needsTranscoding || vk === expectedVk)) {
      if (needsTranscoding) {
        const transcodeStarted = performance.now();
        const status = texture.transcode(scalar ? 4 : 6);
        transcodeMs += performance.now() - transcodeStarted;
        if (status !== 0) {
          throw new Error(`KTX BC transcode: ${texture.message()}`);
        }
      }
      const chunks = new Map<string, Uint8Array>();
      const plane: {
        role: "color" | "scalar";
        format: TextureProductPlane["format"];
        mips: TextureProductPlane["mips"][number][];
      } = { role: scalar ? "scalar" : "color", format: pcTextureFormat(options.semantic), mips: [] };
      for (let l = 0; l < levels; l++) {
        await appendMip(chunks, plane, l, Math.max(1, w >> l), Math.max(1, h >> l), texture.image(l).slice());
      }
      const metadata: TextureProductMetadata = {
        schemaVersion: 3,
        sourceWidth: w,
        sourceHeight: h,
        storageWidth: w,
        storageHeight: h,
        sourceBytes: sourceOptions.sourceBytes,
        sourceHash,
        sourceUri: options.sourceUri,
        semantic: options.semantic,
        channel: options.channel ?? 0,
        exactAlpha: false,
        uvScaleBias: [1, 1, 0, 0],
        recipe: {
          encoder: "ktx-software-read",
          revision: KTX_PC_REVISION,
          binaryHash: codecs.ktxHash,
          filter: "provided",
          quality: "external-final",
        },
        planes: [plane],
      };
      const product = await validateTextureProduct(metadata, chunks);
      return {
        product,
        evidence: {
          prepareMs: performance.now() - start - transcodeMs,
          encodeMs: 0,
          transcodeMs,
          ownedCopyBytes: product.evidence.ownedPayloadBytes,
          wasmLinearHighWaterBytes: codecs.basis.HEAPU8.byteLength + codecs.ktx.HEAPU8.byteLength,
          workerTaskMs: null,
          decodeMs: 0,
          queueAndInitMs: null,
        },
      };
    }
    // Missing mips/unaligned base/semantic conversion: upstream RGBA decode then
    // canonical cook. Exact coverage is the decoded uncompressed source's alpha.
    const supplied: Uint8Array[] = [];
    if (needsTranscoding) {
      const transcodeStarted = performance.now();
      const status = texture.transcode(13);
      transcodeMs += performance.now() - transcodeStarted;
      if (status !== 0) {
        throw new Error(`KTX RGBA decode: ${texture.message()}`);
      }
    } else if (![37, 43, 145, 146, 139].includes(vk)) {
      throw new Error(`KTX final format ${vk} requires an upstream-supported cold import profile`);
    }
    const preserveMips = levels === textureProductMipCount(w, h);
    for (let level = 0; level < (preserveMips ? levels : 1); level++) {
      const mw = Math.max(1, w >> level);
      const mh = Math.max(1, h >> level);
      const rgba =
        needsTranscoding || vk === 37 || vk === 43
          ? texture.image(level).slice()
          : decodePcTextureMip(codecs.basis, texture.image(level), mw, mh, vk === 139 ? 4 : 7);
      if ((transfer === 2) !== srgb) {
        convertTransfer(rgba, transfer === 2);
      }
      supplied.push(rgba);
    }
    const importPrepareMs = performance.now() - start - transcodeMs;
    const result = await cookPcTextureRgba(
      codecs,
      supplied[0]!,
      w,
      h,
      sourceOptions,
      preserveMips ? supplied.slice(1) : undefined,
    );
    return {
      product: result.product,
      evidence: {
        ...result.evidence,
        prepareMs: result.evidence.prepareMs + importPrepareMs,
        transcodeMs,
        ownedCopyBytes:
          result.evidence.ownedCopyBytes + supplied.reduce((sum, mip) => sum + mip.byteLength, 0),
      },
    };
  } finally {
    texture.delete();
  }
}

export function encodePcTextureMip(
  module: BasisBcModule,
  rgba: Uint8Array,
  w: number,
  h: number,
  format: 4 | 7,
  srgb: boolean,
  channel: number,
): Uint8Array {
  validateRgbaBytes(rgba, w, h);
  if ((format !== 4 && format !== 7) || !Number.isInteger(channel) || channel < 0 || channel > 3) {
    throw new Error("BC encode format/channel invalid");
  }
  const size = Math.ceil(w / 4) * Math.ceil(h / 4) * (format === 7 ? 16 : 8);
  return nativeBytes(module, rgba, size, (src, dst) =>
    module._bc_encode(src, w, h, format, Number(srgb), channel, dst),
  );
}
export function decodePcTextureMip(
  module: BasisBcModule,
  blocks: Uint8Array,
  w: number,
  h: number,
  format: 4 | 7,
): Uint8Array {
  pcTextureStorageExtent(w, h);
  if (
    (format !== 4 && format !== 7) ||
    blocks.byteLength !== Math.ceil(w / 4) * Math.ceil(h / 4) * (format === 7 ? 16 : 8)
  ) {
    throw new Error("BC decode bytes/format invalid");
  }
  if (w * h * 4 > PC_TEXTURE_INPUT_LIMIT) {
    throw new RangeError("BC decode output budget exceeded");
  }
  return nativeBytes(module, blocks, w * h * 4, (src, dst) => module._bc_decode(src, w, h, format, dst));
}
export function resamplePcTexture(
  module: BasisBcModule,
  source: Uint8Array,
  sw: number,
  sh: number,
  w: number,
  h: number,
  srgb: boolean,
  normal: boolean,
): Uint8Array {
  validateRgbaBytes(source, sw, sh);
  pcTextureStorageExtent(w, h);
  if (w * h * 4 > PC_TEXTURE_INPUT_LIMIT) {
    throw new RangeError("Resample output budget exceeded");
  }
  return nativeBytes(module, source, w * h * 4, (src, dst) =>
    module._bc_resample(src, sw, sh, dst, w, h, Number(srgb), Number(normal)),
  );
}
function validateRgbaBytes(rgba: Uint8Array, w: number, h: number): void {
  pcTextureStorageExtent(w, h);
  if (rgba.byteLength !== w * h * 4 || rgba.byteLength > PC_TEXTURE_INPUT_LIMIT) {
    throw new Error("RGBA native input byte domain invalid");
  }
}
function convertTransfer(rgba: Uint8Array, fromSrgb: boolean): void {
  for (let i = 0; i < rgba.length; i++) {
    if (i % 4 === 3) {
      continue;
    }
    const value = rgba[i]! / 255;
    const converted = fromSrgb
      ? value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4
      : value <= 0.0031308
        ? value * 12.92
        : 1.055 * value ** (1 / 2.4) - 0.055;
    rgba[i] = Math.round(converted * 255);
  }
}
function nativeBytes(
  module: BasisBcModule,
  input: Uint8Array,
  size: number,
  call: (src: number, dst: number) => number,
): Uint8Array {
  let src = 0,
    dst = 0;
  try {
    src = module._malloc(input.byteLength);
    dst = module._malloc(size);
    if (!src || !dst) {
      throw new Error("BC codec WASM allocation failed");
    }
    module.HEAPU8.set(input, src);
    if (call(src, dst) !== 1) {
      throw new Error("BC codec operation failed");
    }
    return module.HEAPU8.slice(dst, dst + size);
  } finally {
    if (src) {
      module._free(src);
    }
    if (dst) {
      module._free(dst);
    }
  }
}
async function appendMip(
  chunks: Map<string, Uint8Array>,
  plane: {
    role: TextureProductPlane["role"];
    format: TextureProductPlane["format"];
    mips: TextureProductPlane["mips"][number][];
  },
  level: number,
  w: number,
  h: number,
  payload: Uint8Array,
): Promise<void> {
  const expected = encodedTextureMipByteLength(plane.format, w, h);
  if (payload.byteLength !== expected) {
    throw new Error("Codec output exact mip bytes mismatch");
  }
  const [pw, ph] = physicalTextureExtent(plane.format, w, h),
    chunkId = `${plane.role}-mip-${level}`;
  plane.mips.push({
    level,
    width: w,
    height: h,
    physicalWidth: pw,
    physicalHeight: ph,
    byteLength: expected,
    chunkId,
    hash: await textureProductHash(payload),
  });
  chunks.set(chunkId, payload);
}

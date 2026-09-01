import { KTX2Decoder } from "@babylonjs/ktx2decoder";
import {
  LiteTranscoder_UASTC_ASTC,
  LiteTranscoder_UASTC_BC7,
  LiteTranscoder_UASTC_R8_UNORM,
  LiteTranscoder_UASTC_RG8_UNORM,
  LiteTranscoder_UASTC_RGBA_SRGB,
  LiteTranscoder_UASTC_RGBA_UNORM,
  MSCTranscoder
} from "@babylonjs/ktx2decoder/Transcoders/index.js";
import { ZSTDDecoder } from "@babylonjs/ktx2decoder/zstddec.js";
import { EngineFormat } from "@babylonjs/core/Materials/Textures/ktx2decoderTypes.js";
import astcWasmUrl from "@babylonjs/ktx2decoder/wasm/uastc_astc.wasm?url";
import bc7WasmUrl from "@babylonjs/ktx2decoder/wasm/uastc_bc7.wasm?url";
import r8WasmUrl from "@babylonjs/ktx2decoder/wasm/uastc_r8_unorm.wasm?url";
import rg8WasmUrl from "@babylonjs/ktx2decoder/wasm/uastc_rg8_unorm.wasm?url";
import rgbaSrgbWasmUrl from "@babylonjs/ktx2decoder/wasm/uastc_rgba8_srgb_v2.wasm?url";
import rgbaUnormWasmUrl from "@babylonjs/ktx2decoder/wasm/uastc_rgba8_unorm_v2.wasm?url";
import mscJsUrl from "@babylonjs/ktx2decoder/wasm/msc_basis_transcoder.js?url";
import mscWasmUrl from "@babylonjs/ktx2decoder/wasm/msc_basis_transcoder.wasm?url";
import zstdWasmUrl from "@babylonjs/ktx2decoder/wasm/zstddec.wasm?url";
import type { Ktx2TextureSource } from "../assets/MaterialTextureAssetPackage.js";

export interface Ktx2MipLevel {
  readonly level: number;
  readonly layer: number;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface TranscodedKtx2Texture {
  readonly source: Ktx2TextureSource;
  readonly width: number;
  readonly height: number;
  readonly layerCount: number;
  readonly mipLevelCount: number;
  readonly format: GPUTextureFormat;
  readonly compressed: boolean;
  readonly blockWidth: number;
  readonly blockHeight: number;
  readonly bytesPerBlock: number;
  readonly transcoderName: string;
  readonly sourceBytes: number;
  readonly decodedBytes: number;
  readonly mipLevels: readonly Ktx2MipLevel[];
}

export interface Ktx2TranscoderEvidence {
  readonly schemaVersion: 1;
  readonly decodedTextureCount: number;
  readonly cacheHitCount: number;
  readonly sourceBytes: number;
  readonly decodedTransientBytes: number;
  readonly bcTextureCount: number;
  readonly astcTextureCount: number;
  readonly etc2TextureCount: number;
  readonly rgbaFallbackTextureCount: number;
  readonly transcodeFailureCount: number;
}

/**
 * Capability-aware KTX2/Basis seam backed by Babylon.js' complete decoder.
 * The bundled WASM URLs are overridden explicitly so production never relies
 * on Babylon's CDN defaults.
 */
export class Ktx2Transcoder {
  private readonly decoder = new KTX2Decoder();
  private readonly cache = new WeakMap<
    Ktx2TextureSource,
    Map<"linear" | "srgb", Promise<TranscodedKtx2Texture>>
  >();
  private decodedTextureCount = 0;
  private cacheHitCount = 0;
  private sourceBytes = 0;
  private decodedTransientBytes = 0;
  private bcTextureCount = 0;
  private astcTextureCount = 0;
  private etc2TextureCount = 0;
  private rgbaFallbackTextureCount = 0;
  private transcodeFailureCount = 0;

  constructor(private readonly device: GPUDevice) {
    configureBundledTranscoders();
  }

  prepare(
    source: Ktx2TextureSource,
    colorSpace: "linear" | "srgb"
  ): Promise<TranscodedKtx2Texture> {
    let variants = this.cache.get(source);
    const cached = variants?.get(colorSpace);
    if (cached !== undefined) {
      this.cacheHitCount++;
      return cached;
    }
    const pending = this.decode(source, colorSpace).catch((error) => {
      variants?.delete(colorSpace);
      this.transcodeFailureCount++;
      throw error;
    });
    if (variants === undefined) {
      variants = new Map();
      this.cache.set(source, variants);
    }
    variants.set(colorSpace, pending);
    return pending;
  }

  releaseDecoded(texture: TranscodedKtx2Texture): void {
    this.cache.get(texture.source)?.delete(
      texture.format.endsWith("-srgb") ? "srgb" : "linear"
    );
    this.decodedTransientBytes = Math.max(0, this.decodedTransientBytes - texture.decodedBytes);
  }

  evidence(): Ktx2TranscoderEvidence {
    return Object.freeze({
      schemaVersion: 1,
      decodedTextureCount: this.decodedTextureCount,
      cacheHitCount: this.cacheHitCount,
      sourceBytes: this.sourceBytes,
      decodedTransientBytes: this.decodedTransientBytes,
      bcTextureCount: this.bcTextureCount,
      astcTextureCount: this.astcTextureCount,
      etc2TextureCount: this.etc2TextureCount,
      rgbaFallbackTextureCount: this.rgbaFallbackTextureCount,
      transcodeFailureCount: this.transcodeFailureCount
    });
  }

  private async decode(
    source: Ktx2TextureSource,
    colorSpace: "linear" | "srgb"
  ): Promise<TranscodedKtx2Texture> {
    const bytes = source.bytes();
    const bc = this.device.features.has("texture-compression-bc");
    const astc = this.device.features.has("texture-compression-astc");
    const etc2 = this.device.features.has("texture-compression-etc2");
    const decoded = await this.decoder.decode(bytes, {
      astc,
      bptc: bc,
      s3tc: bc,
      etc2,
      etc1: false,
      pvrtc: false
    }, {
      useRGBAIfASTCBC7NotAvailableWhenUASTC: true
    });
    if (decoded.errors) throw new Error(decoded.errors.trim());
    const format = webGpuFormat(decoded.transcodedFormat, colorSpace === "srgb");
    const block = textureBlock(format);
    const mipLevels = decoded.mipmaps.map((mip, index) => {
      if (mip.data === null) throw new Error(`KTX2 mip ${index} did not transcode`);
      return Object.freeze({
        level: Math.floor(index / decoded.layerCount),
        layer: mip.layerIndex,
        width: mip.width,
        height: mip.height,
        data: mip.data
      });
    });
    const decodedBytes = mipLevels.reduce((sum, mip) => sum + mip.data.byteLength, 0);
    this.decodedTextureCount++;
    this.sourceBytes += bytes.byteLength;
    this.decodedTransientBytes += decodedBytes;
    if (format.startsWith("bc")) this.bcTextureCount++;
    else if (format.startsWith("astc")) this.astcTextureCount++;
    else if (format.startsWith("etc2")) this.etc2TextureCount++;
    else this.rgbaFallbackTextureCount++;
    return Object.freeze({
      source,
      width: decoded.width,
      height: decoded.height,
      layerCount: decoded.layerCount,
      mipLevelCount: Math.max(1, decoded.mipmaps.length / decoded.layerCount),
      format,
      compressed: block.compressed,
      blockWidth: block.width,
      blockHeight: block.height,
      bytesPerBlock: block.bytes,
      transcoderName: decoded.transcoderName,
      sourceBytes: bytes.byteLength,
      decodedBytes,
      mipLevels: Object.freeze(mipLevels)
    });
  }
}

let configured = false;

function configureBundledTranscoders(): void {
  if (configured) return;
  configured = true;
  LiteTranscoder_UASTC_ASTC.WasmModuleURL = astcWasmUrl;
  LiteTranscoder_UASTC_BC7.WasmModuleURL = bc7WasmUrl;
  LiteTranscoder_UASTC_R8_UNORM.WasmModuleURL = r8WasmUrl;
  LiteTranscoder_UASTC_RG8_UNORM.WasmModuleURL = rg8WasmUrl;
  LiteTranscoder_UASTC_RGBA_SRGB.WasmModuleURL = rgbaSrgbWasmUrl;
  LiteTranscoder_UASTC_RGBA_UNORM.WasmModuleURL = rgbaUnormWasmUrl;
  MSCTranscoder.JSModuleURL = mscJsUrl;
  MSCTranscoder.WasmModuleURL = mscWasmUrl;
  MSCTranscoder.UseFromWorkerThread = false;
  ZSTDDecoder.WasmModuleURL = zstdWasmUrl;
}

function webGpuFormat(engineFormat: number, gamma: boolean): GPUTextureFormat {
  const suffix = gamma ? "-srgb" : "";
  switch (engineFormat) {
    case EngineFormat.COMPRESSED_RGBA_BPTC_UNORM_EXT:
      return `bc7-rgba-unorm${suffix}` as GPUTextureFormat;
    case EngineFormat.COMPRESSED_RGBA_ASTC_4X4_KHR:
      return `astc-4x4-unorm${suffix}` as GPUTextureFormat;
    case EngineFormat.COMPRESSED_RGB_S3TC_DXT1_EXT:
      return `bc1-rgba-unorm${suffix}` as GPUTextureFormat;
    case EngineFormat.COMPRESSED_RGBA_S3TC_DXT5_EXT:
      return `bc3-rgba-unorm${suffix}` as GPUTextureFormat;
    case EngineFormat.COMPRESSED_RGB8_ETC2:
    case EngineFormat.COMPRESSED_RGB_ETC1_WEBGL:
      return `etc2-rgb8unorm${suffix}` as GPUTextureFormat;
    case EngineFormat.COMPRESSED_RGBA8_ETC2_EAC:
      return `etc2-rgba8unorm${suffix}` as GPUTextureFormat;
    case EngineFormat.R8Format:
      return "r8unorm";
    case EngineFormat.RG8Format:
      return "rg8unorm";
    case EngineFormat.RGBA8Format:
      return gamma ? "rgba8unorm-srgb" : "rgba8unorm";
    default:
      throw new Error(`Unsupported KTX2 transcoder engine format ${engineFormat}`);
  }
}

function textureBlock(format: GPUTextureFormat): Readonly<{
  compressed: boolean;
  width: number;
  height: number;
  bytes: number;
}> {
  if (format.startsWith("bc1-") || format.startsWith("etc2-rgb8")) {
    return Object.freeze({ compressed: true, width: 4, height: 4, bytes: 8 });
  }
  if (format.startsWith("bc") || format.startsWith("etc2-") || format.startsWith("astc-4x4")) {
    return Object.freeze({ compressed: true, width: 4, height: 4, bytes: 16 });
  }
  if (format.startsWith("rgba8")) {
    return Object.freeze({ compressed: false, width: 1, height: 1, bytes: 4 });
  }
  if (format.startsWith("rg8")) {
    return Object.freeze({ compressed: false, width: 1, height: 1, bytes: 2 });
  }
  return Object.freeze({ compressed: false, width: 1, height: 1, bytes: 1 });
}

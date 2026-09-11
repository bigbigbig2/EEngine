import type { TextureSemanticV2 } from "../TextureAssetPackage.js";
import type { Ktx2SourceEncoding, Ktx2TranscodeTargetFormat } from "./AssetCodecTypes.js";
import {
  isTextureFormatEnabled,
  selectTextureTranscodeTarget,
  type TextureCodecCapabilities
} from "./TextureCodecPolicy.js";

export interface TexturePlanVariant {
  readonly variantId: string;
  readonly encoding: "gpu-native" | Ktx2SourceEncoding | "rgba8";
  readonly format?: GPUTextureFormat;
}

export type TextureDecodePlan =
  | { readonly mode: "direct"; readonly variantId: string; readonly targetFormat: GPUTextureFormat }
  | {
      readonly mode: "worker-transcode";
      readonly variantId: string;
      readonly sourceEncoding: Ktx2SourceEncoding;
      readonly targetFormat: Ktx2TranscodeTargetFormat;
    }
  | {
      readonly mode: "uncompressed";
      readonly variantId: string;
      readonly targetFormat: "rgba8unorm" | "rgba8unorm-srgb";
    };

export interface TextureDecodePlanRequest {
  readonly semantic: TextureSemanticV2;
  readonly variants: readonly TexturePlanVariant[];
  readonly capabilities: TextureCodecCapabilities;
  readonly allowUncompressedFallback: boolean;
}

export function planTextureDecode(request: TextureDecodePlanRequest): TextureDecodePlan {
  for (const variant of request.variants) {
    if (variant.encoding !== "gpu-native" || variant.format === undefined) continue;
    if (isTextureFormatEnabled(variant.format, request.capabilities.enabledFeatures)) {
      return Object.freeze({ mode: "direct", variantId: variant.variantId, targetFormat: variant.format });
    }
  }
  for (const variant of request.variants) {
    if (variant.encoding !== "ktx2-uastc" && variant.encoding !== "ktx2-etc1s") continue;
    const targetFormat = selectTextureTranscodeTarget({
      semantic: request.semantic,
      sourceEncoding: variant.encoding,
      capabilities: request.capabilities
    });
    if (targetFormat !== null) {
      return Object.freeze({
        mode: "worker-transcode",
        variantId: variant.variantId,
        sourceEncoding: variant.encoding,
        targetFormat
      });
    }
  }
  if (request.allowUncompressedFallback) {
    const fallback = request.variants.find((variant) => variant.encoding === "rgba8");
    if (fallback !== undefined) {
      return Object.freeze({
        mode: "uncompressed",
        variantId: fallback.variantId,
        targetFormat: request.semantic === "base-color-srgb" || request.semantic === "emissive-srgb"
          ? "rgba8unorm-srgb"
          : "rgba8unorm"
      });
    }
  }
  throw new Error("Texture asset has no declared variant compatible with the frozen codec/device policy");
}

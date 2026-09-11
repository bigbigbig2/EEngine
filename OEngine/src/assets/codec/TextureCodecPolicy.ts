import type { TextureSemanticV2 } from "../TextureAssetPackage.js";
import type {
  Ktx2SourceEncoding,
  Ktx2TranscodeTargetFormat
} from "./AssetCodecTypes.js";

export interface TextureCodecCapabilities {
  readonly enabledFeatures: ReadonlySet<string>;
  readonly transcoderTargets: ReadonlySet<Ktx2TranscodeTargetFormat>;
  readonly astcLdrTarget?: "astc-4x4-unorm" | "astc-4x4-unorm-srgb";
}

export interface TextureCodecTargetRequest {
  readonly semantic: TextureSemanticV2 | "hdr-linear";
  readonly sourceEncoding: Ktx2SourceEncoding;
  readonly capabilities: TextureCodecCapabilities;
}

export function selectTextureTranscodeTarget(
  request: TextureCodecTargetRequest
): Ktx2TranscodeTargetFormat | null {
  const { enabledFeatures, transcoderTargets } = request.capabilities;
  const srgb = request.semantic === "base-color-srgb" || request.semantic === "emissive-srgb";
  const candidates: Ktx2TranscodeTargetFormat[] = [];
  if (enabledFeatures.has("texture-compression-bc")) {
    if (request.semantic === "normal-linear") candidates.push("bc5-rg-unorm", "bc7-rgba-unorm");
    else if (request.semantic === "alpha-mask") candidates.push("bc4-r-unorm", "bc7-rgba-unorm");
    else if (request.semantic === "orm-linear") candidates.push("bc7-rgba-unorm", "bc3-rgba-unorm");
    else if (request.semantic !== "hdr-linear") {
      candidates.push(srgb ? "bc7-rgba-unorm-srgb" : "bc7-rgba-unorm");
      candidates.push(srgb ? "bc3-rgba-unorm-srgb" : "bc3-rgba-unorm");
    }
  }
  if (enabledFeatures.has("texture-compression-astc") && request.semantic !== "hdr-linear") {
    candidates.push(srgb ? "astc-4x4-unorm-srgb" : "astc-4x4-unorm");
  }
  if (enabledFeatures.has("texture-compression-etc2") && request.semantic !== "hdr-linear") {
    if (request.semantic === "normal-linear") candidates.push("eac-rg11unorm", "etc2-rgba8unorm");
    else if (request.semantic === "alpha-mask") candidates.push("eac-r11unorm", "etc2-rgba8unorm");
    else candidates.push(srgb ? "etc2-rgba8unorm-srgb" : "etc2-rgba8unorm");
  }
  return candidates.find((format) => transcoderTargets.has(format)) ?? null;
}

export function requiredTextureCompressionFeature(format: GPUTextureFormat): string | null {
  if (format.startsWith("bc")) return "texture-compression-bc";
  if (format.startsWith("astc")) return "texture-compression-astc";
  if (format.startsWith("etc2") || format.startsWith("eac")) return "texture-compression-etc2";
  return null;
}

export function isTextureFormatEnabled(
  format: GPUTextureFormat,
  enabledFeatures: ReadonlySet<string>
): boolean {
  const feature = requiredTextureCompressionFeature(format);
  return feature === null || enabledFeatures.has(feature);
}

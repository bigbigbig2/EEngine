import type { AssetCodecTaskResult, Ktx2TranscodeTask } from "./AssetCodecTypes.js";
import { physicalTextureExtent } from "./TextureFormatLayout.js";

export interface KtxEnumValue {}
export interface KtxTextureModuleTexture {
  readonly baseWidth: number;
  readonly baseHeight: number;
  readonly needsTranscoding: boolean;
  transcodeBasis(target: KtxEnumValue, flags: number): KtxEnumValue;
  getImage(level: number, layer: number, faceSlice: number): Uint8Array | null;
  delete(): void;
}
export interface KtxTextureModule {
  readonly texture: new (bytes: Uint8Array) => KtxTextureModuleTexture;
  readonly error_code: { readonly SUCCESS: KtxEnumValue };
  readonly transcode_fmt: Readonly<Record<string, KtxEnumValue>>;
}

export function transcodeKtx2Basis(
  module: KtxTextureModule,
  task: Ktx2TranscodeTask,
  identity: Readonly<{ codecId: string; codecRevision: string; codecBinaryHash: string }>,
  now: () => number = () => performance.now()
): AssetCodecTaskResult {
  const startedAt = now();
  const header = readKtx2Header(task.input);
  if (header.sourceEncoding !== task.sourceEncoding) {
    throw new Ktx2CodecError("source-encoding", `KTX2 payload is ${header.sourceEncoding}, request declared ${task.sourceEncoding}`);
  }
  if (header.layerCount > 1 || header.faceCount !== 1 || header.pixelDepth > 1) {
    throw new Ktx2CodecError("texture-shape", "KTX2 codec path currently accepts only one 2D, non-array face");
  }
  const texture = new module.texture(new Uint8Array(task.input));
  try {
    if (!texture.needsTranscoding) {
      throw new Ktx2CodecError("not-transcodable", "KTX2 payload does not contain Basis/UASTC transcodable data");
    }
    const target = module.transcode_fmt[transcodeEnumName(task.targetFormat)];
    if (target === undefined) throw new Ktx2CodecError("target-unavailable", `Pinned KTX binary does not expose ${task.targetFormat}`);
    if (texture.transcodeBasis(target, 0) !== module.error_code.SUCCESS) {
      throw new Ktx2CodecError("transcode-failed", `KTX2 transcode to ${task.targetFormat} failed`);
    }
    const mips = [];
    let outputBytes = 0;
    for (let level = 0; level < header.levelCount; level++) {
      const logicalWidth = Math.max(1, Math.floor(header.pixelWidth / 2 ** level));
      const logicalHeight = Math.max(1, Math.floor(header.pixelHeight / 2 ** level));
      const image = texture.getImage(level, 0, 0);
      if (image === null) throw new Ktx2CodecError("mip-missing", `KTX2 mip ${level} is missing`);
      const payload = image.slice().buffer;
      const [physicalWidth, physicalHeight] = physicalTextureExtent(task.targetFormat, logicalWidth, logicalHeight);
      outputBytes += payload.byteLength;
      mips.push(Object.freeze({ level, logicalWidth, logicalHeight, physicalWidth, physicalHeight, payload }));
    }
    const workerMs = now() - startedAt;
    return Object.freeze({
      taskId: task.taskId,
      ok: true,
      sourceEncoding: task.sourceEncoding,
      targetFormat: task.targetFormat,
      mips: Object.freeze(mips),
      evidence: Object.freeze({
        queueWaitMs: 0,
        workerMs,
        wallMs: workerMs,
        inputBytes: task.input.byteLength,
        outputBytes,
        estimatedPeakBytes: task.estimatedPeakBytes,
        ...identity
      })
    });
  } finally {
    texture.delete();
  }
}

export class Ktx2CodecError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "Ktx2CodecError";
  }
}

function readKtx2Header(input: ArrayBuffer): Readonly<{
  pixelWidth: number;
  pixelHeight: number;
  pixelDepth: number;
  layerCount: number;
  faceCount: number;
  levelCount: number;
  sourceEncoding: "ktx2-uastc" | "ktx2-etc1s";
}> {
  if (input.byteLength < 80) throw new Ktx2CodecError("ktx2-header", "KTX2 payload is shorter than its header");
  const bytes = new Uint8Array(input, 0, 12);
  const identifier = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!identifier.every((value, index) => bytes[index] === value)) {
    throw new Ktx2CodecError("ktx2-header", "KTX2 identifier is invalid");
  }
  const view = new DataView(input);
  const vkFormat = view.getUint32(12, true);
  const pixelWidth = view.getUint32(20, true);
  const pixelHeight = view.getUint32(24, true);
  const pixelDepth = view.getUint32(28, true);
  const layerCount = view.getUint32(32, true);
  const faceCount = view.getUint32(36, true);
  const levelCount = view.getUint32(40, true);
  const supercompression = view.getUint32(44, true);
  if (vkFormat !== 0 || pixelWidth === 0 || pixelHeight === 0 || levelCount === 0) {
    throw new Ktx2CodecError("ktx2-header", "KTX2 is not a complete Basis/UASTC 2D texture");
  }
  if (supercompression !== 0 && supercompression !== 1) {
    throw new Ktx2CodecError("supercompression", `KTX2 supercompression scheme ${supercompression} is unsupported`);
  }
  return Object.freeze({
    pixelWidth,
    pixelHeight,
    pixelDepth,
    layerCount,
    faceCount,
    levelCount,
    sourceEncoding: supercompression === 1 ? "ktx2-etc1s" : "ktx2-uastc"
  });
}

function transcodeEnumName(format: string): string {
  if (format === "bc1-rgba-unorm" || format === "bc1-rgba-unorm-srgb") return "BC1_RGB";
  if (format === "bc3-rgba-unorm" || format === "bc3-rgba-unorm-srgb") return "BC3_RGBA";
  if (format === "bc4-r-unorm") return "BC4_R";
  if (format === "bc5-rg-unorm") return "BC5_RG";
  if (format === "bc7-rgba-unorm" || format === "bc7-rgba-unorm-srgb") return "BC7_RGBA";
  if (format === "etc2-rgb8unorm" || format === "etc2-rgb8unorm-srgb") return "ETC1_RGB";
  if (format === "etc2-rgba8unorm" || format === "etc2-rgba8unorm-srgb") return "ETC2_RGBA";
  if (format === "eac-r11unorm") return "EAC_R11";
  if (format === "eac-rg11unorm") return "EAC_RG11";
  if (format === "astc-4x4-unorm" || format === "astc-4x4-unorm-srgb") return "ASTC_4x4_RGBA";
  if (format === "rgba8unorm" || format === "rgba8unorm-srgb") return "RGBA32";
  throw new Ktx2CodecError("target-unavailable", `KTX target '${format}' is unsupported`);
}

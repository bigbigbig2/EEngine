import type { TextureSemanticV2 } from "../TextureAssetPackage.js";
import {
  encodedTextureMipByteLength,
  physicalTextureExtent
} from "./TextureFormatLayout.js";

export type AssetCodecTaskKind =
  | "ktx2-transcode"
  | "draco-decode"
  | "meshopt-decode"
  | "zstd-decode";

export type AssetCodecPriority = 0 | 1 | 2;

export type Ktx2SourceEncoding = "ktx2-uastc" | "ktx2-etc1s";

export const KTX2_TRANSCODE_TARGET_FORMATS = Object.freeze([
  "bc1-rgba-unorm",
  "bc1-rgba-unorm-srgb",
  "bc3-rgba-unorm",
  "bc3-rgba-unorm-srgb",
  "bc4-r-unorm",
  "bc5-rg-unorm",
  "bc7-rgba-unorm",
  "bc7-rgba-unorm-srgb",
  "etc2-rgb8unorm",
  "etc2-rgb8unorm-srgb",
  "etc2-rgba8unorm",
  "etc2-rgba8unorm-srgb",
  "eac-r11unorm",
  "eac-rg11unorm",
  "astc-4x4-unorm",
  "astc-4x4-unorm-srgb",
  "rgba8unorm",
  "rgba8unorm-srgb"
] as const satisfies readonly GPUTextureFormat[]);

export type Ktx2TranscodeTargetFormat = typeof KTX2_TRANSCODE_TARGET_FORMATS[number];

export interface AssetCodecTaskBase {
  readonly taskId: number;
  readonly kind: AssetCodecTaskKind;
  readonly priority: AssetCodecPriority;
  readonly estimatedPeakBytes: number;
}

/** Worker-safe request. WebGPU objects must never cross this boundary. */
export interface Ktx2TranscodeTask extends AssetCodecTaskBase {
  readonly kind: "ktx2-transcode";
  readonly input: ArrayBuffer;
  readonly sourceEncoding: Ktx2SourceEncoding;
  readonly semantic: TextureSemanticV2;
  readonly targetFormat: Ktx2TranscodeTargetFormat;
}

export type AssetCodecTask = Ktx2TranscodeTask;

export interface AssetCodecMipResult {
  readonly level: number;
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  readonly physicalWidth: number;
  readonly physicalHeight: number;
  readonly payload: ArrayBuffer;
}

export interface AssetCodecEvidence {
  readonly queueWaitMs: number;
  readonly workerMs: number;
  readonly wallMs: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly estimatedPeakBytes: number;
  readonly codecId: string;
  readonly codecRevision: string;
  readonly codecBinaryHash: string;
}

export interface AssetCodecTaskResult {
  readonly taskId: number;
  readonly ok: true;
  readonly sourceEncoding: Ktx2SourceEncoding;
  readonly targetFormat: Ktx2TranscodeTargetFormat;
  readonly mips: readonly AssetCodecMipResult[];
  readonly evidence: AssetCodecEvidence;
}

export interface AssetCodecErrorResult {
  readonly taskId: number;
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

export type AssetCodecWorkerResult = AssetCodecTaskResult | AssetCodecErrorResult;

export interface AssetCodecInitRequest {
  readonly type: "init";
  readonly codecId: string;
  readonly codecRevision: string;
  readonly codecBinaryHash: string;
  readonly wasmBinary: ArrayBuffer;
}

export interface AssetCodecTaskRequest {
  readonly type: "task";
  readonly task: AssetCodecTask;
}

export interface AssetCodecCancelRequest {
  readonly type: "cancel";
  readonly taskId: number;
}

export interface AssetCodecDisposeRequest {
  readonly type: "dispose";
}

export type AssetCodecWorkerRequest =
  | AssetCodecInitRequest
  | AssetCodecTaskRequest
  | AssetCodecCancelRequest
  | AssetCodecDisposeRequest;

export interface AssetCodecWorkerReady {
  readonly type: "ready";
  readonly codecId: string;
  readonly codecRevision: string;
  readonly codecBinaryHash: string;
}

export interface AssetCodecWorkerTaskMessage {
  readonly type: "result";
  readonly result: AssetCodecWorkerResult;
}

export interface AssetCodecWorkerInitError {
  readonly type: "init-error";
  readonly code: string;
  readonly message: string;
}

export type AssetCodecWorkerMessage =
  | AssetCodecWorkerReady
  | AssetCodecWorkerTaskMessage
  | AssetCodecWorkerInitError;

const TARGET_FORMATS = new Set<string>(KTX2_TRANSCODE_TARGET_FORMATS);

export function validateAssetCodecTask(value: unknown): asserts value is AssetCodecTask {
  if (!isRecord(value)) throw new TypeError("Asset codec task must be an object");
  if (!Number.isSafeInteger(value.taskId) || Number(value.taskId) < 0) {
    throw new RangeError("Asset codec taskId must be a non-negative safe integer");
  }
  if (value.priority !== 0 && value.priority !== 1 && value.priority !== 2) {
    throw new RangeError("Asset codec priority must be 0, 1, or 2");
  }
  if (!Number.isSafeInteger(value.estimatedPeakBytes) || Number(value.estimatedPeakBytes) <= 0) {
    throw new RangeError("Asset codec estimatedPeakBytes must be a positive safe integer");
  }
  if (value.kind !== "ktx2-transcode") {
    throw new RangeError(`Asset codec task kind '${String(value.kind)}' is not enabled`);
  }
  if (!(value.input instanceof ArrayBuffer) || value.input.byteLength === 0) {
    throw new RangeError("KTX2 transcode input must be a non-empty ArrayBuffer");
  }
  if (value.sourceEncoding !== "ktx2-uastc" && value.sourceEncoding !== "ktx2-etc1s") {
    throw new RangeError(`Unsupported KTX2 source encoding '${String(value.sourceEncoding)}'`);
  }
  if (!isTextureSemantic(value.semantic)) {
    throw new RangeError(`Unsupported texture semantic '${String(value.semantic)}'`);
  }
  if (typeof value.targetFormat !== "string" || !TARGET_FORMATS.has(value.targetFormat)) {
    throw new RangeError(`Unsupported KTX2 transcode target '${String(value.targetFormat)}'`);
  }
}

export function validateAssetCodecWorkerResult(value: unknown): asserts value is AssetCodecWorkerResult {
  if (!isRecord(value)) throw new TypeError("Asset codec result must be an object");
  if (!Number.isSafeInteger(value.taskId) || Number(value.taskId) < 0) {
    throw new RangeError("Asset codec result taskId must be a non-negative safe integer");
  }
  if (value.ok === false) {
    if (typeof value.code !== "string" || value.code.length === 0 ||
        typeof value.message !== "string" || value.message.length === 0) {
      throw new TypeError("Asset codec error result must include code and message");
    }
    return;
  }
  if (value.ok !== true) throw new TypeError("Asset codec result ok flag is invalid");
  if (value.sourceEncoding !== "ktx2-uastc" && value.sourceEncoding !== "ktx2-etc1s") {
    throw new RangeError(`Asset codec result source encoding '${String(value.sourceEncoding)}' is invalid`);
  }
  if (typeof value.targetFormat !== "string" || !TARGET_FORMATS.has(value.targetFormat)) {
    throw new RangeError(`Asset codec result target '${String(value.targetFormat)}' is invalid`);
  }
  if (!Array.isArray(value.mips) || value.mips.length === 0) {
    throw new RangeError("Asset codec result must include a non-empty mip chain");
  }
  let outputBytes = 0;
  for (let index = 0; index < value.mips.length; index++) {
    const mip = value.mips[index];
    if (!isRecord(mip) || mip.level !== index ||
        !isPositiveInteger(mip.logicalWidth) || !isPositiveInteger(mip.logicalHeight) ||
        !isPositiveInteger(mip.physicalWidth) || !isPositiveInteger(mip.physicalHeight) ||
        !(mip.payload instanceof ArrayBuffer)) {
      throw new TypeError(`Asset codec result mip ${index} is malformed`);
    }
    const physical = physicalTextureExtent(value.targetFormat as Ktx2TranscodeTargetFormat, mip.logicalWidth, mip.logicalHeight);
    if (mip.physicalWidth !== physical[0] || mip.physicalHeight !== physical[1]) {
      throw new RangeError(`Asset codec result mip ${index} physical extent is invalid`);
    }
    const expectedBytes = encodedTextureMipByteLength(
      value.targetFormat as Ktx2TranscodeTargetFormat,
      mip.logicalWidth,
      mip.logicalHeight
    );
    if (mip.payload.byteLength !== expectedBytes) {
      throw new RangeError(`Asset codec result mip ${index} payload length is ${mip.payload.byteLength}, expected ${expectedBytes}`);
    }
    outputBytes += mip.payload.byteLength;
  }
  if (!isRecord(value.evidence)) throw new TypeError("Asset codec result evidence is malformed");
  for (const key of ["queueWaitMs", "workerMs", "wallMs", "inputBytes", "outputBytes", "estimatedPeakBytes"] as const) {
    if (!Number.isFinite(value.evidence[key]) || Number(value.evidence[key]) < 0) {
      throw new RangeError(`Asset codec result evidence ${key} is invalid`);
    }
  }
  if (value.evidence.outputBytes !== outputBytes) {
    throw new RangeError(`Asset codec result evidence outputBytes is ${String(value.evidence.outputBytes)}, expected ${outputBytes}`);
  }
  if (typeof value.evidence.codecId !== "string" || value.evidence.codecId.length === 0 ||
      typeof value.evidence.codecRevision !== "string" || value.evidence.codecRevision.length === 0 ||
      typeof value.evidence.codecBinaryHash !== "string" || !/^[0-9a-f]{64}$/i.test(value.evidence.codecBinaryHash)) {
    throw new TypeError("Asset codec result codec identity is invalid");
  }
}

export function assetCodecResultTransferList(result: AssetCodecTaskResult): Transferable[] {
  return result.mips.map((mip) => mip.payload);
}

function isTextureSemantic(value: unknown): value is TextureSemanticV2 {
  return value === "base-color-srgb" || value === "normal-linear" ||
    value === "orm-linear" || value === "alpha-mask" || value === "emissive-srgb";
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

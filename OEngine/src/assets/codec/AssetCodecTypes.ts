import type { TextureSemanticV2 } from "../TextureAssetPackage.js";

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

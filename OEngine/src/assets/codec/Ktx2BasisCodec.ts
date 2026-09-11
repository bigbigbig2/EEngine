import { AssetCodecService, type AssetCodecServiceOptions } from "./AssetCodecService.js";
import type {
  AssetCodecTaskResult,
  AssetCodecWorkerMessage,
  Ktx2TranscodeTask
} from "./AssetCodecTypes.js";
import {
  openTextureAssetPackageV2,
  writeEncodedTextureAssetPackageV2,
  type EncodedTextureVariantV2,
  type TextureAssetPackageV2,
  type TextureSemanticV2
} from "../TextureAssetPackage.js";
import { textureFormatBlockLayout } from "./TextureFormatLayout.js";

export const KTX_SOFTWARE_CODEC_ID = "khronos-ktx-software-libktx-read";
export const KTX_SOFTWARE_CODEC_REVISION = "v4.4.2+4d6fc70eaf62ad0558e63e8d97eb9766118327a6";
export const KTX_SOFTWARE_WASM_SHA256 = "8336a23659f306c93f45816022dcdfae122f66eaf566488a2b7cf40e0bf65f0e";

export const KTX_SOFTWARE_TRANSCODE_TARGETS = Object.freeze(new Set([
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
] as const));

export interface Ktx2BasisWorkerFactoryOptions {
  readonly workerUrl?: URL;
  readonly wasmUrl?: URL;
  readonly fetchBinary?: (url: URL) => Promise<ArrayBuffer>;
  readonly createWorker?: (url: URL) => Worker;
}

export function createKtx2BasisWorkerFactory(
  options: Ktx2BasisWorkerFactoryOptions = {}
): () => Promise<Worker> {
  const wasmUrl = options.wasmUrl ?? new URL(
    "./vendor/ktx-software-4.4.2/libktx_read.wasm",
    import.meta.url
  );
  const fetchBinary = options.fetchBinary ?? (async (url: URL) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`KTX codec WASM fetch failed: ${response.status} ${response.statusText}`);
    return response.arrayBuffer();
  });
  let wasmBinary: Promise<ArrayBuffer> | undefined;
  return async (): Promise<Worker> => {
    wasmBinary ??= fetchBinary(wasmUrl);
    const source = await wasmBinary;
    const worker = options.createWorker === undefined
      ? new Worker(new URL("./workers/asset-codec-worker.ts", import.meta.url), {
          type: "module",
          name: "oengine-asset-codec"
        })
      : options.createWorker(options.workerUrl ?? new URL("./workers/asset-codec-worker.ts", import.meta.url));
    const binary = source.slice(0);
    return new Promise<Worker>((resolve, reject) => {
      const cleanup = (): void => {
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
      };
      worker.onmessage = (event: MessageEvent<AssetCodecWorkerMessage>) => {
        if (event.data.type === "ready") {
          cleanup();
          resolve(worker);
        } else if (event.data.type === "init-error") {
          cleanup();
          worker.terminate();
          reject(new Error(`${event.data.code}: ${event.data.message}`));
        }
      };
      worker.onerror = (event: ErrorEvent) => {
        event.preventDefault?.();
        cleanup();
        worker.terminate();
        reject(new Error(event.message || "KTX codec Worker initialization failed"));
      };
      worker.onmessageerror = () => {
        cleanup();
        worker.terminate();
        reject(new Error("KTX codec Worker initialization response is malformed"));
      };
      worker.postMessage({
        type: "init",
        codecId: KTX_SOFTWARE_CODEC_ID,
        codecRevision: KTX_SOFTWARE_CODEC_REVISION,
        codecBinaryHash: KTX_SOFTWARE_WASM_SHA256,
        wasmBinary: binary
      }, [binary]);
    });
  };
}

export function createKtx2AssetCodecService(
  options: Omit<AssetCodecServiceOptions, "createWorker"> & Ktx2BasisWorkerFactoryOptions = {}
): AssetCodecService {
  const {
    workerUrl,
    wasmUrl,
    fetchBinary,
    createWorker,
    ...serviceOptions
  } = options;
  return new AssetCodecService({
    ...serviceOptions,
    createWorker: createKtx2BasisWorkerFactory({ workerUrl, wasmUrl, fetchBinary, createWorker })
  });
}

export function estimateKtx2TranscodePeakBytes(inputBytes: number): number {
  if (!Number.isSafeInteger(inputBytes) || inputBytes <= 0) {
    throw new RangeError("KTX2 input byte length must be a positive safe integer");
  }
  return Math.max(8 * 1024 * 1024, inputBytes * 8);
}

export function createKtx2TranscodeTask(
  input: Omit<Ktx2TranscodeTask, "estimatedPeakBytes">
): Ktx2TranscodeTask {
  return Object.freeze({
    ...input,
    estimatedPeakBytes: estimateKtx2TranscodePeakBytes(input.input.byteLength)
  });
}

export function encodedTextureVariantFromKtx2Result(
  result: AssetCodecTaskResult,
  semantic: TextureSemanticV2,
  profile = "worker-transcoded"
): EncodedTextureVariantV2 {
  const layout = textureFormatBlockLayout(result.targetFormat);
  return Object.freeze({
    profile,
    semantic,
    format: result.targetFormat,
    ...layout,
    codecId: result.evidence.codecId,
    codecRevision: result.evidence.codecRevision,
    codecBinaryHash: result.evidence.codecBinaryHash,
    mips: Object.freeze(result.mips.map((mip) => Object.freeze({
      level: mip.level,
      logicalWidth: mip.logicalWidth,
      logicalHeight: mip.logicalHeight,
      physicalWidth: mip.physicalWidth,
      physicalHeight: mip.physicalHeight,
      payload: new Uint8Array(mip.payload)
    })))
  });
}

export interface PrepareKtx2TextureOptions {
  readonly taskId: number;
  readonly priority: 0 | 1 | 2;
  readonly sourceEncoding: "ktx2-uastc" | "ktx2-etc1s";
  readonly semantic: TextureSemanticV2;
  readonly targetFormat: Ktx2TranscodeTask["targetFormat"];
  readonly sourceUri: string;
  readonly alphaCutoff?: number;
  readonly signal?: AbortSignal;
}

/**
 * Production preparation seam. The Worker output is serialized as the same
 * TextureAssetPackage V2 consumed by ordinary TextureResidency.
 */
export async function prepareKtx2TextureAssetPackageV2(
  service: AssetCodecService,
  input: ArrayBuffer,
  options: PrepareKtx2TextureOptions
): Promise<TextureAssetPackageV2> {
  if (input.byteLength === 0) throw new RangeError("KTX2 source is empty");
  if (options.sourceUri.length === 0) throw new RangeError("KTX2 source provenance URI is empty");
  const sourceByteLength = input.byteLength;
  const sourceContentHash = await sha256Hex(new Uint8Array(input));
  const result = await service.submit(createKtx2TranscodeTask({
    taskId: options.taskId,
    kind: "ktx2-transcode",
    priority: options.priority,
    sourceEncoding: options.sourceEncoding,
    semantic: options.semantic,
    targetFormat: options.targetFormat,
    input
  }), options.signal);
  const firstMip = result.mips[0];
  if (firstMip === undefined) throw new Error("KTX2 transcoder returned no mip data");
  const bytes = await writeEncodedTextureAssetPackageV2({
    width: firstMip.logicalWidth,
    height: firstMip.logicalHeight,
    semantic: options.semantic,
    sourceUri: options.sourceUri,
    sourceByteLength,
    sourceContentHash,
    alphaCutoff: options.alphaCutoff
  }, [encodedTextureVariantFromKtx2Result(result, options.semantic)]);
  return openTextureAssetPackageV2(bytes);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

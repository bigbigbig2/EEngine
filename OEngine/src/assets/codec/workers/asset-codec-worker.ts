import createKtxReadModule from "../vendor/ktx-software-4.4.2/libktx_read.js";
import {
  assetCodecResultTransferList,
  validateAssetCodecTask,
  type AssetCodecInitRequest,
  type AssetCodecWorkerMessage,
  type AssetCodecWorkerRequest,
  type Ktx2TranscodeTask
} from "../AssetCodecTypes.js";
import {
  Ktx2CodecError,
  transcodeKtx2Basis,
  type KtxTextureModule
} from "../Ktx2BasisTranscoder.js";

interface WorkerScope {
  onmessage: ((event: MessageEvent<AssetCodecWorkerRequest>) => void) | null;
  postMessage(message: AssetCodecWorkerMessage, transfer?: Transferable[]): void;
  close(): void;
}

const scope = self as unknown as WorkerScope;
let modulePromise: Promise<KtxTextureModule> | undefined;
let codecIdentity: Readonly<{
  codecId: string;
  codecRevision: string;
  codecBinaryHash: string;
}> | undefined;
const cancelled = new Set<number>();

scope.onmessage = (event): void => {
  const request = event.data;
  if (request.type === "init") void initialize(request);
  else if (request.type === "cancel") cancelled.add(request.taskId);
  else if (request.type === "dispose") {
    cancelled.clear();
    scope.close();
  } else if (request.type === "task") void runTask(request.task);
};

async function initialize(request: AssetCodecInitRequest): Promise<void> {
  if (modulePromise !== undefined) {
    postInitError("duplicate-init", "Asset codec Worker was initialized more than once");
    return;
  }
  codecIdentity = Object.freeze({
    codecId: request.codecId,
    codecRevision: request.codecRevision,
    codecBinaryHash: request.codecBinaryHash
  });
  modulePromise = createKtxReadModule({
    wasmBinary: request.wasmBinary,
    print: () => {},
    printErr: () => {}
  }) as Promise<KtxTextureModule>;
  try {
    await modulePromise;
    scope.postMessage({ type: "ready", ...codecIdentity });
  } catch (error) {
    modulePromise = undefined;
    postInitError("wasm-init", errorMessage(error));
  }
}

async function runTask(task: Ktx2TranscodeTask): Promise<void> {
  try {
    validateAssetCodecTask(task);
    const module = await requireModule();
    const result = transcodeKtx2Basis(module, task, requireCodecIdentity());
    if (cancelled.delete(task.taskId)) {
      throw new Ktx2CodecError("cancelled", "Codec task was cancelled");
    }
    scope.postMessage({ type: "result", result }, assetCodecResultTransferList(result));
  } catch (error) {
    scope.postMessage({
      type: "result",
      result: {
        taskId: task.taskId,
        ok: false,
        code: error instanceof Ktx2CodecError ? error.code : "worker-task",
        message: errorMessage(error)
      }
    });
  } finally {
    cancelled.delete(task.taskId);
  }
}

function requireModule(): Promise<KtxTextureModule> {
  if (modulePromise === undefined) throw new Ktx2CodecError("not-initialized", "Asset codec Worker is not initialized");
  return modulePromise;
}

function requireCodecIdentity(): NonNullable<typeof codecIdentity> {
  if (codecIdentity === undefined) throw new Ktx2CodecError("not-initialized", "Codec identity is unavailable");
  return codecIdentity;
}

function postInitError(code: string, message: string): void {
  scope.postMessage({ type: "init-error", code, message });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

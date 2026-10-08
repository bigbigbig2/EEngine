import { AssetWorkerPool } from "./AssetWorkerPool.js";
import {
  estimatePcTextureCookBytes,
  type PcTextureCookOptions,
  type PcTextureCookEvidence,
} from "./PcTextureCook.js";
import {
  PC_TEXTURE_INPUT_LIMIT,
  PC_TEXTURE_WASM_LIMIT,
  textureProductHash,
  validateTextureProduct,
  type TextureProduct,
  type TextureProductMetadata,
} from "../TextureProduct.js";

export interface PcTextureCookTask {
  readonly taskId: number;
  readonly kind: "rgba" | "ktx" | "image";
  readonly mimeType?: "image/png" | "image/jpeg" | "image/webp";
  readonly input: ArrayBuffer;
  readonly width: number;
  readonly height: number;
  readonly options: PcTextureCookOptions;
  readonly providedMips?: readonly ArrayBuffer[];
  readonly queuedAtMs?: number;
}
export interface PcTexturePreparedResult {
  readonly taskId: number;
  readonly ok: true;
  readonly metadata: TextureProductMetadata;
  readonly chunks: ReadonlyMap<string, Uint8Array>;
  readonly evidence: PcTextureCookEvidence;
}
/** Cold producer only. Transfers exclusively owned inputs, returns CPU chunks for
 * save/recovery or immediate upload; no GPU objects, submit or material publication. */
export class PcTexturePreparation {
  private readonly pool: AssetWorkerPool;
  private nextTaskId = 1;
  private epoch = 0;
  private disposed = false;
  constructor(
    options: {
      maxWorkers?: number;
      maxInFlightEstimatedBytes?: number;
      maxQueuedTasks?: number;
      createWorker?: () => Promise<Worker> | Worker;
    } = {},
  ) {
    this.pool = new AssetWorkerPool({
      maxWorkers: options.maxWorkers ?? 1,
      maxInFlightEstimatedBytes: options.maxInFlightEstimatedBytes ?? PC_TEXTURE_WASM_LIMIT,
      maxQueuedTasks: options.maxQueuedTasks ?? 256,
      createWorker: options.createWorker ?? createPcTextureWorker,
    });
  }
  async cookRgba(
    input: ArrayBuffer,
    width: number,
    height: number,
    options: PcTextureCookOptions,
    signal?: AbortSignal,
    providedMips?: readonly ArrayBuffer[],
  ): Promise<{ product: TextureProduct; evidence: PcTextureCookEvidence }> {
    const providedBytes = providedMips?.reduce((sum, mip) => sum + mip.byteLength, 0) ?? 0;
    if (input.byteLength + providedBytes > PC_TEXTURE_INPUT_LIMIT) {
      throw new RangeError("Provided mip input budget exceeded");
    }
    const estimatedPeakBytes = estimatePcTextureCookBytes(
      width,
      height,
      options.semantic,
      options.exactAlpha === true || options.semantic === "alpha-mask",
      providedBytes,
    );
    if (estimatedPeakBytes > PC_TEXTURE_WASM_LIMIT) {
      throw new RangeError("Provided mip memory admission failed");
    }
    return this.submit(
      {
        taskId: this.nextTaskId++,
        kind: "rgba",
        input,
        width,
        height,
        options,
        ...(providedMips ? { providedMips } : {}),
      },
      estimatedPeakBytes,
      signal,
    );
  }
  async importKtx(
    input: ArrayBuffer,
    options: PcTextureCookOptions,
    signal?: AbortSignal,
  ): Promise<{ product: TextureProduct; evidence: PcTextureCookEvidence }> {
    // Hold the bounded parse credit first; libktx then admits parsed decode/output
    // footprint before load/transcode. Never estimates compressed input * 8.
    return this.submit(
      { taskId: this.nextTaskId++, kind: "ktx", input, width: 0, height: 0, options },
      PC_TEXTURE_WASM_LIMIT,
      signal,
    );
  }
  async cookImage(
    input: ArrayBuffer,
    mimeType: "image/png" | "image/jpeg" | "image/webp",
    options: PcTextureCookOptions,
    signal?: AbortSignal,
  ): Promise<{ product: TextureProduct; evidence: PcTextureCookEvidence }> {
    if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType)) {
      throw new Error("Raw image MIME unsupported");
    }
    // Decode runs inside the existing bounded Worker task, not before queue
    // admission on the main thread. Browser-native decode peak is still unknown.
    return this.submit(
      { taskId: this.nextTaskId++, kind: "image", input, width: 0, height: 0, mimeType, options },
      PC_TEXTURE_WASM_LIMIT,
      signal,
    );
  }
  evidence(): ReturnType<AssetWorkerPool["evidence"]> {
    return this.pool.evidence();
  }
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.epoch++;
    this.pool.dispose();
  }
  private async submit(
    task: PcTextureCookTask,
    estimatedPeakBytes: number,
    signal?: AbortSignal,
  ): Promise<{ product: TextureProduct; evidence: PcTextureCookEvidence }> {
    this.assertLive(signal);
    if (
      !(task.input instanceof ArrayBuffer) ||
      task.input.byteLength === 0 ||
      task.input.byteLength > PC_TEXTURE_INPUT_LIMIT
    ) {
      throw new RangeError("PC texture input budget exceeded");
    }
    const sourceHash = task.options.sourceHash ?? (await textureProductHash(new Uint8Array(task.input)));
    this.assertLive(signal);
    const epoch = this.epoch;
    const result = await this.pool.submit<
      PcTextureCookTask,
      PcTexturePreparedResult | { ok: false; message: string }
    >({
      request: {
        ...task,
        queuedAtMs: performance.timeOrigin + performance.now(),
        options: { ...task.options, sourceHash },
      },
      transfer: [task.input, ...(task.providedMips ?? [])],
      estimatedPeakBytes,
      priority: 0,
      signal,
    });
    this.assertLive(signal);
    if (epoch !== this.epoch) {
      throw new Error("Stale texture cook epoch");
    }
    if (!result.ok) {
      throw new Error(result.message);
    }
    if (
      result.taskId !== task.taskId ||
      result.metadata.sourceHash !== sourceHash ||
      result.metadata.semantic !== task.options.semantic ||
      result.metadata.channel !==
        (task.options.channel ?? (task.options.semantic === "alpha-mask" ? 3 : 0)) ||
      result.metadata.exactAlpha !==
        (task.options.exactAlpha === true || task.options.semantic === "alpha-mask") ||
      (task.kind === "rgba" &&
        (result.metadata.sourceWidth !== task.width || result.metadata.sourceHeight !== task.height))
    ) {
      throw new Error("Texture worker identity mismatch");
    }
    const product = await validateTextureProduct(result.metadata, result.chunks);
    if (
      !Number.isSafeInteger(result.evidence.wasmLinearHighWaterBytes) ||
      result.evidence.wasmLinearHighWaterBytes > PC_TEXTURE_WASM_LIMIT
    ) {
      throw new Error("Texture Worker combined WASM budget invalid");
    }
    this.assertLive(signal);
    return { product, evidence: result.evidence };
  }
  private assertLive(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new DOMException("Texture cook cancelled", "AbortError");
    }
    if (this.disposed) {
      throw new Error("PcTexturePreparation disposed");
    }
  }
}

export async function createPcTextureWorker(url?: URL): Promise<Worker> {
  const worker = url
    ? new Worker(url, { type: "module", name: "oengine-pc-texture-cook" })
    : new Worker(new URL("./workers/pc-texture-worker.ts", import.meta.url), {
        type: "module",
        name: "oengine-pc-texture-cook",
      });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error("PC texture Worker initialization timeout")), 30000);
    function cleanup(): void {
      clearTimeout(timer);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
    }
    function fail(error: Error): void {
      cleanup();
      worker.terminate();
      reject(error);
    }
    worker.onmessage = (event: MessageEvent) => {
      if (event.data?.ready) {
        cleanup();
        resolve(worker);
      } else {
        fail(new Error(event.data?.message ?? "PC texture Worker initialization failed"));
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fail(new Error(event.message));
    };
    worker.onmessageerror = () => fail(new Error("PC texture Worker init message invalid"));
    worker.postMessage({ init: true });
  });
}

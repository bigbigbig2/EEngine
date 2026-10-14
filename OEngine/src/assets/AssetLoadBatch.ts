/** Loading-only concurrency and cancellation. Results remain caller-owned;
 * failed batches dispose every completed result after all workers settle. */
export async function loadAssetBatch<T, R>(
  items: readonly T[],
  concurrency: number,
  signal: AbortSignal,
  load: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  discard?: (value: R) => void,
): Promise<readonly R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Asset concurrency must be a positive integer");
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) {
    cancel();
  }
  const values = new Array<R>(items.length);
  const completed = new Uint8Array(items.length);
  let cursor = 0;
  let failure: unknown;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    try {
      while (!controller.signal.aborted) {
        const index = cursor++;
        if (index >= items.length) {
          return;
        }
        values[index] = await load(items[index]!, index, controller.signal);
        completed[index] = 1;
      }
    } catch (error) {
      if (failure === undefined) {
        failure = error;
      }
      controller.abort(error);
    }
  });
  try {
    await Promise.all(workers);
    if (controller.signal.aborted) {
      const cleanupFailures: unknown[] = [];
      for (let index = 0; index < values.length; index++) {
        if (completed[index]) {
          try {
            discard?.(values[index]!);
          } catch (error) {
            cleanupFailures.push(error);
          }
        }
      }
      if (cleanupFailures.length) {
        throw new AggregateError(
          [failure ?? controller.signal.reason, ...cleanupFailures],
          "Asset batch and cleanup failed",
        );
      }
      throw failure ?? controller.signal.reason;
    }
    return values;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/** Bounds live transport buffers, including the concatenation copy. Completed
 * immutable Products have separate caller ownership and are not counted here. */
export class AssetReadBudget {
  private used = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(readonly maxBytes = 256 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 2) {
      throw new RangeError("Asset read budget must be a positive byte capacity");
    }
  }

  async read<R>(
    response: Response,
    signal: AbortSignal,
    consume: (bytes: ArrayBuffer) => Promise<R>,
  ): Promise<R> {
    // Fetch exposes decompressed bytes, while Content-Length can describe the
    // compressed transport. Such responses use the unknown-length bound.
    const encoding = response.headers.get("content-encoding");
    const declared = encoding && encoding !== "identity" ? null : response.headers.get("content-length");
    const length = declared === null ? undefined : Number(declared);
    const limit = length ?? Math.floor(this.maxBytes / 2);
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > this.maxBytes / 2) {
      await response.body?.cancel();
      throw new RangeError("Asset response exceeds the transport byte budget");
    }
    const charge = Math.max(2, limit * 2);
    while (this.used + charge > this.maxBytes) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          const index = this.waiters.indexOf(wake);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          reject(signal.reason);
        };
        this.waiters.push(wake);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
        }
      });
    }
    signal.throwIfAborted();
    this.used += charge;
    let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
    try {
      reader = response.body?.getReader();
      if (!reader) {
        throw new Error("Asset response has no body");
      }
      const chunks: Uint8Array<ArrayBufferLike>[] = [];
      let size = 0;
      while (true) {
        signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) {
          break;
        }
        size += next.value.byteLength;
        if (size > limit) {
          throw new RangeError("Asset response exceeded its declared byte domain");
        }
        chunks.push(next.value);
      }
      if (length !== undefined && size !== length) {
        throw new Error("Asset response length mismatch");
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      chunks.length = 0;
      signal.throwIfAborted();
      return await consume(bytes.buffer);
    } finally {
      try {
        await reader?.cancel();
      } finally {
        try {
          reader?.releaseLock();
        } finally {
          this.used -= charge;
          for (const wake of this.waiters.splice(0)) {
            wake();
          }
        }
      }
    }
  }
}

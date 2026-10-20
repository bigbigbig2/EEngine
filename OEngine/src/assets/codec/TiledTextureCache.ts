/** Verified GPU-native BC/R8 backing stores only, never encoded transport frames.
 * take() transfers exclusive ownership out of the cache.
 * Ready leases are independently credited; they never pin cache entries. */
export class TiledTextureCache {
  readonly #entries = new Map<string, ArrayBuffer>();
  #bytes = 0;
  #peak = 0;

  constructor(readonly maxBytes = 128 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 128 * 1024 * 1024) {
      throw new RangeError("Tiled CPU cache budget must be in 0..128MiB");
    }
  }

  take(key: string): ArrayBuffer | undefined {
    const bytes = this.#entries.get(key);
    if (bytes) {
      this.#entries.delete(key);
      this.#bytes -= bytes.byteLength;
    }
    return bytes;
  }

  put(key: string, bytes: ArrayBuffer): void {
    if (bytes.byteLength === 0 || bytes.byteLength > this.maxBytes) {
      return;
    }
    const old = this.#entries.get(key);
    if (old) {
      this.#bytes -= old.byteLength;
      this.#entries.delete(key);
    }
    while (this.#bytes + bytes.byteLength > this.maxBytes) {
      const oldest = this.#entries.keys().next().value!;
      this.#bytes -= this.#entries.get(oldest)!.byteLength;
      this.#entries.delete(oldest);
    }
    this.#entries.set(key, bytes);
    this.#bytes += bytes.byteLength;
    this.#peak = Math.max(this.#peak, this.#bytes);
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  evidence() {
    return {
      bytes: this.#bytes,
      peakBytes: this.#peak,
      entries: this.#entries.size,
      maxBytes: this.maxBytes,
    };
  }
}

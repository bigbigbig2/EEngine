import type { GeometryProductProviderV1, GeometryProductRevisionSourceV1 } from "../geometry-product/GeometryProductV1.js";
import { WebCookClient, type WebCookClientEvidence, type WebCookClientOptions, type WebCookSceneCatalogSnapshot } from "./WebCookClient.js";
import { openGlbRangeSource, type GlbRangeReadableSource } from "../../loaders/gltf/streaming/GlbRangeSource.js";

/**
 * Runtime-side handle for a Web GLB CookSession.
 *
 * The handle owns only the Worker transport and CPU Product provider. GPU
 * admission, residency and Scene publication remain explicit renderer-owner
 * operations, so disposing this handle can never destroy a GPU resource.
 */
export class WebCookRuntimeAsset implements GeometryProductProviderV1 {
  readonly #client: WebCookClient;
  readonly #url: string;
  readonly #sourceOptions: WebCookClientOptions["source"];
  #ownedObjectUrl: string | undefined;
  #imageSource: GlbRangeReadableSource | undefined;
  #imageBlocksPending: Promise<ReadonlyMap<string, Uint8Array> | undefined> | undefined;

  private constructor(url: string, client: WebCookClient, sourceOptions: WebCookClientOptions["source"], ownedObjectUrl?: string) {
    this.#url = url;
    this.#client = client;
    this.#sourceOptions = sourceOptions;
    this.#ownedObjectUrl = ownedObjectUrl;
  }

  static open(source: string | Blob, options: WebCookClientOptions): WebCookRuntimeAsset {
    let url: string;
    let ownedObjectUrl: string | undefined;
    if (typeof source === "string") {
      if (source.length === 0) throw new TypeError("Web Cook asset URL must be a non-empty string");
      url = source;
    } else if (typeof Blob !== "undefined" && source instanceof Blob) {
      if (typeof URL.createObjectURL !== "function") throw new Error("Web Cook Blob source requires URL.createObjectURL");
      ownedObjectUrl = URL.createObjectURL(source);
      url = ownedObjectUrl;
    } else {
      throw new TypeError("Web Cook asset source must be a URL, Blob or File");
    }
    const client = new WebCookClient(options);
    try {
      client.open(url);
      return new WebCookRuntimeAsset(url, client, options.source, ownedObjectUrl);
    } catch (error) {
      client.dispose();
      if (ownedObjectUrl) URL.revokeObjectURL(ownedObjectUrl);
      throw error;
    }
  }

  get url(): string { return this.#url; }
  get state(): WebCookClientEvidence["state"] { return this.#client.state; }
  get catalog(): WebCookSceneCatalogSnapshot | undefined { return this.#client.catalog; }

  /**
   * Reads one catalog-declared authored image without retaining its bytes.
   *
   * Authored images are usually packed contiguously, so the first request plans
   * a single span covering every bufferView-backed image and later requests are
   * served from that block instead of issuing one HTTP range each.
   */
  async readImageSource(imageIndex: number, signal?: AbortSignal): Promise<{ readonly bytes: ArrayBuffer; readonly mimeType?: string }> {
    if (this.#client.state !== "open") throw new Error(`Web Cook image source is unavailable in '${this.#client.state}' state`);
    const image = this.#client.catalog?.images.find(value => value.imageIndex === imageIndex);
    if (!image) throw new RangeError(`Web Cook image ${imageIndex} is not declared by the catalog`);
    if (image.bufferView !== undefined) {
      const block = await this.#imageBlocks(signal);
      const view = image.bufferView;
      const key = `${view.bufferIndex}:${view.byteOffset}:${view.byteLength}`;
      const cached = block?.get(key);
      if (cached !== undefined) return Object.freeze({ bytes: toArrayBuffer(cached), ...(image.mimeType === undefined ? {} : { mimeType: image.mimeType }) });
      this.#imageSource ??= await openGlbRangeSource(this.#url, this.#sourceOptions);
      const bytes = await this.#imageSource.readBufferRange(view.bufferIndex, view.byteOffset, view.byteLength, signal);
      return Object.freeze({ bytes, ...(image.mimeType === undefined ? {} : { mimeType: image.mimeType }) });
    }
    if (!image.uri) throw new Error(`Web Cook image ${imageIndex} has no readable URI`);
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
    const fetchImpl = this.#sourceOptions?.fetch ?? globalThis.fetch.bind(globalThis);
    const response = await fetchImpl(image.uri, { ...(this.#sourceOptions?.init ?? {}), signal });
    if (!response.ok) throw new Error(`Web Cook image ${imageIndex} fetch failed with HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    const maxBytes = this.#sourceOptions?.wholeSourceFallbackBytes ?? 64 * 1024 * 1024;
    if (bytes.byteLength > maxBytes) throw new Error(`Web Cook image ${imageIndex} exceeds wholeSourceFallbackBytes=${maxBytes}`);
    return Object.freeze({ bytes, ...(image.mimeType === undefined ? {} : { mimeType: image.mimeType }) });
  }

  #imageBlocks(signal?: AbortSignal): Promise<ReadonlyMap<string, Uint8Array> | undefined> {
    this.#imageBlocksPending ??= this.#prefetchImageBlocks(signal);
    return this.#imageBlocksPending;
  }

  async #prefetchImageBlocks(signal?: AbortSignal): Promise<ReadonlyMap<string, Uint8Array> | undefined> {
    const images = this.#client.catalog?.images.filter(image => image.bufferView !== undefined) ?? [];
    if (images.length < 2) return undefined;
    const options = this.#sourceOptions;
    const maxBlockBytes = options?.imagePrefetchMaxBytes ?? 8 * 1024 * 1024;
    const maxGapBytes = options?.imagePrefetchMaxGapBytes ?? 256 * 1024;
    const first = images[0]!.bufferView!;
    const bufferIndex = first.bufferIndex;
    if (images.some(image => image.bufferView!.bufferIndex !== bufferIndex)) return undefined;
    const spans = images.map(image => image.bufferView!).sort((left, right) => left.byteOffset - right.byteOffset);
    const start = spans[0]!.byteOffset;
    const end = spans.at(-1)!.byteOffset + spans.at(-1)!.byteLength;
    if (end - start > maxBlockBytes) return undefined;
    // A large gap means the images are interleaved with geometry; a single span
    // would pull unrelated bytes, so fall back to per-image ranges.
    let previousEnd = start;
    for (const span of spans) {
      if (span.byteOffset - previousEnd > maxGapBytes) return undefined;
      previousEnd = Math.max(previousEnd, span.byteOffset + span.byteLength);
    }
    try {
      this.#imageSource ??= await openGlbRangeSource(this.#url, options);
      const bytes = new Uint8Array(await this.#imageSource.readBufferRange(bufferIndex, start, end - start, signal));
      const blocks = new Map<string, Uint8Array>();
      for (const span of spans) {
        const key = `${span.bufferIndex}:${span.byteOffset}:${span.byteLength}`;
        blocks.set(key, bytes.subarray(span.byteOffset - start, span.byteOffset - start + span.byteLength));
      }
      return blocks;
    } catch {
      // A failed prefetch must not fail the load; the per-image path still works.
      return undefined;
    }
  }

  revisions(signal?: AbortSignal): AsyncIterable<GeometryProductRevisionSourceV1> {
    return this.#client.revisions(signal);
  }

  requestPages(productId: Uint8Array, revision: number, pageIds: Uint32Array, priority = 0): void {
    this.#client.requestPages(productId, revision, pageIds, priority);
  }

  setSourcePriority(assetKey: string, score: number, cameraHintRevision: number): void {
    this.#client.setSourcePriority(assetKey, score, cameraHintRevision);
  }

  cancel(reason = "asset-cancelled"): void { try { this.#client.cancel(reason); } finally { this.#releaseImageSource(); this.#revokeObjectUrl(); } }
  dispose(): void { try { this.#client.dispose(); } finally { this.#releaseImageSource(); this.#revokeObjectUrl(); } }
  evidence(): WebCookClientEvidence { return this.#client.evidence(); }

  #revokeObjectUrl(): void { if (this.#ownedObjectUrl !== undefined) { URL.revokeObjectURL(this.#ownedObjectUrl); this.#ownedObjectUrl = undefined; } }
  #releaseImageSource(): void { this.#imageSource?.release(); this.#imageSource = undefined; this.#imageBlocksPending = undefined; }
}

/** Copies a view out of a prefetched block so callers own an independent buffer. */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

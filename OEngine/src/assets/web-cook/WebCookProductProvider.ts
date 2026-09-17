import { decodeGeometryProductDescriptorBinaryV1 } from "../geometry-product/GeometryProductBinaryV1.js";
import { decodeGeometryProductPageRecordV1, type GeometryPageProductV1, type GeometryProductProviderV1, type GeometryProductRevisionSourceV1 } from "../geometry-product/GeometryProductV1.js";
import type { WebCookEvent } from "./protocol/CookSessionProtocol.js";

export interface WebCookProductProviderOptions {
  readonly maxBufferedPages: number;
  readonly maxBufferedBytes: number;
  readonly returnOutputCredits: (blockCount: number, bytes: number) => void;
}

export interface WebCookProductProviderEvidence {
  readonly offeredRevisions: number;
  readonly bufferedPages: number;
  readonly bufferedBytes: number;
  readonly deliveredPages: number;
  readonly discardedPages: number;
  readonly staleEvents: number;
  readonly failures: number;
}

/** Maps Worker Product events to the producer-neutral revision-source contract. */
export class WebCookProductProvider implements GeometryProductProviderV1 {
  readonly #events: AsyncIterable<WebCookEvent>;
  readonly #options: WebCookProductProviderOptions;
  readonly #revisions = new AsyncValueQueue<GeometryProductRevisionSourceV1>();
  readonly #sources = new Map<string, LiveWebCookRevisionSource>();
  #started = false;
  #released = false;
  #offeredRevisions = 0;
  #bufferedPages = 0;
  #bufferedBytes = 0;
  #deliveredPages = 0;
  #discardedPages = 0;
  #staleEvents = 0;
  #failures = 0;

  constructor(events: AsyncIterable<WebCookEvent>, options: WebCookProductProviderOptions) {
    if (!Number.isInteger(options.maxBufferedPages) || options.maxBufferedPages <= 0 || !Number.isInteger(options.maxBufferedBytes) || options.maxBufferedBytes <= 0) throw new RangeError("Web Product provider buffers must be bounded");
    this.#events = events;
    this.#options = options;
  }

  revisions(signal?: AbortSignal): AsyncIterable<GeometryProductRevisionSourceV1> {
    if (this.#started) throw new Error("Web Product provider revisions can only be consumed once");
    this.#started = true;
    void this.#pump(signal);
    return this.#revisions.iterable(signal);
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    const error = new Error("Web Product provider released");
    for (const source of this.#sources.values()) source.fail(error);
    this.#sources.clear();
    this.#revisions.fail(error);
  }

  evidence(): WebCookProductProviderEvidence { return Object.freeze({ offeredRevisions: this.#offeredRevisions, bufferedPages: this.#bufferedPages, bufferedBytes: this.#bufferedBytes, deliveredPages: this.#deliveredPages, discardedPages: this.#discardedPages, staleEvents: this.#staleEvents, failures: this.#failures }); }

  async #pump(signal?: AbortSignal): Promise<void> {
    try {
      for await (const event of this.#events) {
        if (signal?.aborted) throw abortReason(signal);
        if (this.#released) break;
        this.#accept(event);
      }
      for (const source of this.#sources.values()) source.finish();
      this.#revisions.finish();
    } catch (error) {
      this.#failures++;
      for (const source of this.#sources.values()) source.fail(error);
      this.#revisions.fail(error);
    }
  }

  #accept(event: WebCookEvent): void {
    if (event.type === "RevisionOffered") {
      const descriptor = decodeGeometryProductDescriptorBinaryV1(event.descriptor);
      const key = productKey(descriptor.productId, descriptor.revision);
      if (this.#sources.has(key)) throw new Error("Web Cook offered a duplicate Product revision");
      const source = new LiveWebCookRevisionSource(descriptor, this);
      this.#sources.set(key, source);
      this.#offeredRevisions++;
      this.#revisions.push(source);
      return;
    }
    if (event.type === "PageReady") {
      const source = this.#sources.get(productKey(event.productId, event.revision));
      if (!source) { this.#staleEvents++; this._discardPage(event.bytes.byteLength); return; }
      try { source.acceptPage(event); } catch (error) { this._discardPage(event.bytes.byteLength); throw error; }
      return;
    }
    if (event.type === "FatalSessionFailure") throw new Error(`Web Cook failed: ${event.code}`);
  }

  _reservePage(bytes: number): void {
    if (this.#bufferedPages + 1 > this.#options.maxBufferedPages || this.#bufferedBytes + bytes > this.#options.maxBufferedBytes) throw new Error("Web Product provider output buffer budget exhausted");
    this.#bufferedPages++;
    this.#bufferedBytes += bytes;
  }
  _deliverBufferedPage(bytes: number): void { this.#bufferedPages--; this.#bufferedBytes -= bytes; this.#deliveredPages++; this.#options.returnOutputCredits(1, bytes); }
  _deliverIncomingPage(bytes: number): void { this.#deliveredPages++; this.#options.returnOutputCredits(1, bytes); }
  _discardPage(bytes: number): void { this.#discardedPages++; this.#options.returnOutputCredits(1, bytes); }
  _discardBufferedPage(bytes: number): void { this.#bufferedPages--; this.#bufferedBytes -= bytes; this.#discardedPages++; this.#options.returnOutputCredits(1, bytes); }
  _releaseSource(source: LiveWebCookRevisionSource): void { this.#sources.delete(productKey(source.descriptor.productId, source.descriptor.revision)); }
}

class LiveWebCookRevisionSource implements GeometryProductRevisionSourceV1 {
  readonly #pages = new Map<number, GeometryPageProductV1>();
  readonly #waiters = new Map<number, Deferred<GeometryPageProductV1>>();
  #released = false;
  #finished = false;
  #failure: unknown;
  constructor(readonly descriptor: ReturnType<typeof decodeGeometryProductDescriptorBinaryV1>, readonly owner: WebCookProductProvider) {}

  async readPage(pageId: number, signal?: AbortSignal): Promise<GeometryPageProductV1> {
    decodeGeometryProductPageRecordV1(this.descriptor, pageId);
    if (this.#released) throw new Error("Web Product revision has been released");
    if (this.#failure) throw this.#failure;
    const ready = this.#pages.get(pageId);
    if (ready) { this.#pages.delete(pageId); this.owner._deliverBufferedPage(ready.bytes.byteLength); return ready; }
    if (this.#finished) throw new Error(`Web Product stream ended before page ${pageId} arrived`);
    if (this.#waiters.has(pageId)) throw new Error(`Web Product page ${pageId} already has a pending reader`);
    const deferred = new Deferred<GeometryPageProductV1>();
    this.#waiters.set(pageId, deferred);
    const abort = (): void => { if (this.#waiters.delete(pageId)) deferred.reject(signal ? abortReason(signal) : new Error("Web Product page read aborted")); };
    signal?.addEventListener("abort", abort, { once: true });
    try { return await deferred.promise; } finally { signal?.removeEventListener("abort", abort); }
  }

  acceptPage(event: Extract<WebCookEvent, { type: "PageReady" }>): void {
    if (this.#released) { this.owner._discardPage(event.bytes.byteLength); return; }
    const expected = decodeGeometryProductPageRecordV1(this.descriptor, event.pageId);
    if (!sameBytes(event.productId, this.descriptor.productId) || event.revision !== this.descriptor.revision || event.decodedHash128.byteLength !== 16 || !sameBytes(event.decodedHash128, expected.decodedHash128) || event.bytes.byteLength !== this.descriptor.decodedPageBytes) throw new Error("Web Cook page does not match its immutable Product descriptor");
    if (this.#pages.has(event.pageId)) throw new Error(`Web Cook emitted duplicate page ${event.pageId}`);
    const page = Object.freeze({ productId: event.productId.slice(), revision: event.revision, pageId: event.pageId, decodedHash128: event.decodedHash128.slice(), bytes: event.bytes });
    const waiter = this.#waiters.get(event.pageId);
    if (waiter) { this.#waiters.delete(event.pageId); this.owner._deliverIncomingPage(event.bytes.byteLength); waiter.resolve(page); return; }
    this.owner._reservePage(event.bytes.byteLength);
    this.#pages.set(event.pageId, page);
  }

  finish(): void { this.#finished = true; for (const [pageId, waiter] of this.#waiters) waiter.reject(new Error(`Web Product stream ended before page ${pageId} arrived`)); this.#waiters.clear(); }
  fail(error: unknown): void { this.#failure = error; for (const waiter of this.#waiters.values()) waiter.reject(error); this.#waiters.clear(); this.release(); }
  release(): void { if (this.#released) return; this.#released = true; for (const page of this.#pages.values()) this.owner._discardBufferedPage(page.bytes.byteLength); this.#pages.clear(); for (const waiter of this.#waiters.values()) waiter.reject(new Error("Web Product revision released")); this.#waiters.clear(); this.owner._releaseSource(this); }
}

class Deferred<T> { readonly promise: Promise<T>; resolve!: (value: T) => void; reject!: (reason: unknown) => void; constructor() { this.promise = new Promise<T>((resolve, reject) => { this.resolve = resolve; this.reject = reject; }); } }

class AsyncValueQueue<T> {
  readonly #values: T[] = [];
  readonly #waiters: Deferred<IteratorResult<T>>[] = [];
  #finished = false;
  #failure: unknown;
  push(value: T): void { if (this.#finished || this.#failure) throw new Error("async queue is closed"); const waiter = this.#waiters.shift(); if (waiter) waiter.resolve({ done: false, value }); else this.#values.push(value); }
  finish(): void { if (this.#finished || this.#failure) return; this.#finished = true; for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined }); }
  fail(error: unknown): void { if (this.#finished || this.#failure) return; this.#failure = error; for (const waiter of this.#waiters.splice(0)) waiter.reject(error); }
  iterable(signal?: AbortSignal): AsyncIterable<T> { const queue = this; return { [Symbol.asyncIterator](): AsyncIterator<T> { return { async next(): Promise<IteratorResult<T>> { if (signal?.aborted) throw abortReason(signal); const value = queue.#values.shift(); if (value !== undefined) return { done: false, value }; if (queue.#failure) throw queue.#failure; if (queue.#finished) return { done: true, value: undefined }; const waiter = new Deferred<IteratorResult<T>>(); queue.#waiters.push(waiter); const abort = (): void => { const index = queue.#waiters.indexOf(waiter); if (index >= 0) queue.#waiters.splice(index, 1); waiter.reject(signal ? abortReason(signal) : new Error("async iteration aborted")); }; signal?.addEventListener("abort", abort, { once: true }); try { return await waiter.promise; } finally { signal?.removeEventListener("abort", abort); } } }; } }; }
}

function productKey(productId: Uint8Array, revision: number): string { return `${hex(productId)}:${revision}`; }
function hex(bytes: Uint8Array): string { return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join(""); }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { if (left.byteLength !== right.byteLength) return false; for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false; return true; }
function abortReason(signal: AbortSignal): unknown { return signal.reason ?? new DOMException("The operation was aborted", "AbortError"); }

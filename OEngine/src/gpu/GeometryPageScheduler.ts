import {
  deduplicateGeometryPageDemandsV1,
  unpackGeometryPageDemandHeaderV1,
  unpackGeometryPageDemandV1,
  type GeometryPageDemandV1
} from "./GeometryPageDemandAbiV1.js";
import {
  GEOMETRY_PRODUCT_PAGE_RECORD_STRIDE,
  decodeGeometryProductPageRecordV1,
  type GeometryProductRevisionSourceV1,
  type GeometryPageProductV1
} from "../assets/geometry-product/GeometryProductV1.js";

export type GeometryPageOperationStateV1 = "absent" | "queued" | "producing-or-reading" | "verified" | "upload-queued" | "submitted" | "resident" | "retiring" | "failed";

export interface GeometryPageUploadSinkV1 {
  uploadPage(page: GeometryPageProductV1): void;
}

export interface GeometryPageSchedulerOptionsV1 {
  readonly maxConcurrentReads: number;
  readonly maxInFlightBytes: number;
  readonly maxUploadBytesPerFrame?: number;
  readonly maxRetries?: number;
  readonly retryBaseDelayMs?: number;
}

export interface GeometryPageSchedulerEvidenceV1 {
  readonly requested: number;
  readonly deduplicated: number;
  readonly stale: number;
  readonly failed: number;
  readonly resident: number;
  readonly uploadedBytes: number;
  readonly inFlightBytes: number;
  readonly peakInFlightBytes: number;
  readonly retries: number;
  readonly cancelled: number;
  readonly lateResults: number;
  readonly uploadBudgetExhausted: number;
  readonly demandOverflow: number;
  readonly malformedReadbacks: number;
}

export interface GeometryPageRegistrationOptionsV1 {
  /** Defaults to scheduler ownership. Use external when Residency owns the source. */
  readonly sourceOwnership?: "scheduler" | "external";
}

interface RegisteredProduct { readonly generation: number; readonly productTableSlot: number; readonly source: GeometryProductRevisionSourceV1; readonly pageCount: number; readonly ownsSource: boolean; }
interface Operation { readonly key: string; demand: GeometryPageDemandV1; readonly product: RegisteredProduct; state: GeometryPageOperationStateV1; page?: GeometryPageProductV1; attempts: number; nextRetryAt: number; age: number; controller?: AbortController; }

/** Delayed CPU demand consumer. It never builds final visible work and never waits for GPU completion. */
export class GeometryPageSchedulerV1 {
  readonly #options: Required<GeometryPageSchedulerOptionsV1>;
  readonly #products = new Map<number, RegisteredProduct>();
  readonly #operations = new Map<string, Operation>();
  readonly #inFlight = new Set<Promise<void>>();
  #requested = 0; #deduplicated = 0; #stale = 0; #failed = 0; #resident = 0; #uploadedBytes = 0; #inFlightBytes = 0; #peakInFlightBytes = 0; #retries = 0; #cancelled = 0; #lateResults = 0; #uploadBudgetExhausted = 0; #demandOverflow = 0; #malformedReadbacks = 0;
  constructor(options: GeometryPageSchedulerOptionsV1) { const maxUploadBytesPerFrame = options.maxUploadBytesPerFrame ?? 8 * 1024 * 1024, maxRetries = options.maxRetries ?? 3, retryBaseDelayMs = options.retryBaseDelayMs ?? 100; if (!Number.isInteger(options.maxConcurrentReads) || options.maxConcurrentReads <= 0 || !Number.isInteger(options.maxInFlightBytes) || options.maxInFlightBytes <= 0 || !Number.isInteger(maxUploadBytesPerFrame) || maxUploadBytesPerFrame <= 0 || !Number.isInteger(maxRetries) || maxRetries < 0 || !Number.isFinite(retryBaseDelayMs) || retryBaseDelayMs < 0) throw new RangeError("Geometry page scheduler budgets/retry options are invalid"); this.#options = Object.freeze({ maxConcurrentReads: options.maxConcurrentReads, maxInFlightBytes: options.maxInFlightBytes, maxUploadBytesPerFrame, maxRetries, retryBaseDelayMs }); }
  registerProduct(productTableSlot: number, generation: number, source: GeometryProductRevisionSourceV1, options: GeometryPageRegistrationOptionsV1 = {}): void { const pageCount = source.descriptor.pageRecords.byteLength / GEOMETRY_PRODUCT_PAGE_RECORD_STRIDE; if (!Number.isInteger(productTableSlot) || productTableSlot < 0 || !Number.isInteger(generation) || generation <= 0 || generation === 0xffffffff || !Number.isInteger(pageCount) || pageCount <= 0) throw new RangeError("invalid Geometry Product scheduler registration"); if (this.#products.has(generation)) throw new Error(`product generation ${generation} is already registered`); if (options.sourceOwnership !== undefined && options.sourceOwnership !== "scheduler" && options.sourceOwnership !== "external") throw new RangeError("invalid Geometry Product source ownership"); this.#products.set(generation, { productTableSlot, generation, source, pageCount, ownsSource: options.sourceOwnership !== "external" }); }
  unregisterProduct(generation: number): void { const product = this.#products.get(generation); if (!product) return; for (const [key, operation] of this.#operations) if (operation.product.generation === generation) { operation.controller?.abort(); operation.state = "failed"; this.#operations.delete(key); this.#cancelled++; } this.#products.delete(generation); if (product.ownsSource) product.source.release(); }
  /** Consumes a delayed GPU demand readback; it never rebuilds visible work. */
  ingestDemandReadback(bytes: ArrayBuffer | Uint8Array, nowMs = 0): void {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    try {
      const header = unpackGeometryPageDemandHeaderV1(view);
      if (header.overflow !== 0) this.#demandOverflow++;
      const count = Math.min(header.attempted, header.capacity);
      const required = 16 + count * 16;
      if (required > view.byteLength) throw new RangeError("GeometryPageDemand readback is truncated");
      const records: GeometryPageDemandV1[] = [];
      for (let index = 0; index < count; index++) records.push(unpackGeometryPageDemandV1(view, 16 + index * 16));
      this.ingestDemands(records, nowMs);
    } catch (error) {
      this.#malformedReadbacks++;
      throw error;
    }
  }
  ingestDemands(demands: readonly GeometryPageDemandV1[], nowMs = 0): void { const unique = deduplicateGeometryPageDemandsV1(demands); this.#requested += demands.length; this.#deduplicated += demands.length - unique.length; for (const demand of unique) { const product = this.#products.get(demand.productGeneration); if (!product || product.productTableSlot !== demand.productTableSlot || demand.pageId >= product.pageCount) { this.#stale++; continue; } const key = operationKey(demand); const existing = this.#operations.get(key); if (existing) { existing.age++; if (priority(demand) > priority(existing.demand)) existing.demand = demand; continue; } this.#operations.set(key, { key, demand, product, state: "queued", attempts: 0, nextRetryAt: nowMs, age: 0 }); } this.pump(nowMs); }
  pump(nowMs = 0): void { while (this.#inFlight.size < this.#options.maxConcurrentReads) { const operation = [...this.#operations.values()].filter(candidate => candidate.state === "queued" && candidate.nextRetryAt <= nowMs).sort((a, b) => priority(b.demand) + b.age - priority(a.demand) - a.age)[0]; if (!operation) break; operation.state = "producing-or-reading"; operation.controller = new AbortController(); const bytes = this.#readReservationBytes(operation); if (this.#inFlightBytes + bytes > this.#options.maxInFlightBytes) { operation.state = "queued"; operation.controller = undefined; break; } this.#inFlightBytes += bytes; this.#peakInFlightBytes = Math.max(this.#peakInFlightBytes, this.#inFlightBytes); const task = this.produce(operation, nowMs); this.#inFlight.add(task); void task.then(() => { this.#inFlight.delete(task); this.#inFlightBytes -= bytes; this.pump(nowMs); }, () => { this.#inFlight.delete(task); this.#inFlightBytes -= bytes; this.pump(nowMs); }); } }
  async drainReads(): Promise<void> { await Promise.all([...this.#inFlight]); }
  drainUploadBudget(sink: GeometryPageUploadSinkV1): number { let remaining = this.#options.maxUploadBytesPerFrame, uploaded = 0; const ready = [...this.#operations.values()].filter(operation => operation.state === "upload-queued" && operation.page).sort((a, b) => priority(b.demand) + b.age - priority(a.demand) - a.age); for (const operation of ready) { const page = operation.page!; if (page.bytes.byteLength > remaining) { this.#uploadBudgetExhausted++; continue; } sink.uploadPage(page); operation.state = "resident"; this.#resident++; this.#uploadedBytes += page.bytes.byteLength; uploaded += page.bytes.byteLength; remaining -= page.bytes.byteLength; } return uploaded; }
  markRetiring(productGeneration: number, pageId: number): void { const operation = this.#operations.get(`${productGeneration}:${pageId}`); if (operation?.state === "resident") operation.state = "retiring"; }
  markRetired(productGeneration: number, pageId: number): void { const key = `${productGeneration}:${pageId}`, operation = this.#operations.get(key); if (operation?.state === "retiring") { operation.state = "absent"; this.#operations.delete(key); } }
  cancelGeneration(productGeneration: number): void { for (const [key, operation] of this.#operations) if (operation.product.generation === productGeneration && operation.state !== "resident") { operation.controller?.abort(); operation.state = "failed"; this.#operations.delete(key); this.#cancelled++; } }
  state(productGeneration: number, pageId: number): GeometryPageOperationStateV1 { return this.#operations.get(`${productGeneration}:${pageId}`)?.state ?? "absent"; }
  evidence(): GeometryPageSchedulerEvidenceV1 { return Object.freeze({ requested: this.#requested, deduplicated: this.#deduplicated, stale: this.#stale, failed: this.#failed, resident: this.#resident, uploadedBytes: this.#uploadedBytes, inFlightBytes: this.#inFlightBytes, peakInFlightBytes: this.#peakInFlightBytes, retries: this.#retries, cancelled: this.#cancelled, lateResults: this.#lateResults, uploadBudgetExhausted: this.#uploadBudgetExhausted, demandOverflow: this.#demandOverflow, malformedReadbacks: this.#malformedReadbacks }); }
  #readReservationBytes(operation: Operation): number { return operation.product.source.descriptor.decodedPageBytes; }
  private async produce(operation: Operation, nowMs: number): Promise<void> { try { const page = await operation.product.source.readPage(operation.demand.pageId, operation.controller?.signal); const descriptor = operation.product.source.descriptor; const expected = decodeGeometryProductPageRecordV1(descriptor, operation.demand.pageId); if (page.revision !== descriptor.revision || page.pageId !== operation.demand.pageId || !sameBytes(page.productId, descriptor.productId) || page.bytes.byteLength !== descriptor.decodedPageBytes || !sameBytes(page.decodedHash128, expected.decodedHash128)) throw new Error("page key/size/hash mismatch"); const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", page.bytes.slice(0))); if (!sameBytes(digest.subarray(0, 16), expected.decodedHash128)) throw new Error("page decoded hash mismatch"); if (this.#products.get(operation.product.generation) !== operation.product || operation.controller?.signal.aborted) { this.#lateResults++; operation.state = "failed"; this.#failed++; return; } operation.page = Object.freeze({ ...page, productId: page.productId.slice(), decodedHash128: page.decodedHash128.slice(), bytes: page.bytes.slice(0) }); operation.state = "verified"; operation.state = "upload-queued"; } catch (error) { if (this.#products.get(operation.product.generation) !== operation.product || operation.controller?.signal.aborted) { this.#lateResults++; operation.state = "failed"; return; } operation.attempts++; const deterministic = /hash|size|key|profile|corrupt|unsupported/i.test(error instanceof Error ? error.message : String(error)); if (!deterministic && operation.attempts <= this.#options.maxRetries) { operation.state = "queued"; operation.nextRetryAt = nowMs + this.#options.retryBaseDelayMs * (2 ** (operation.attempts - 1)); this.#retries++; } else { operation.state = "failed"; this.#failed++; } } }
}

function operationKey(demand: GeometryPageDemandV1): string { return `${demand.productGeneration}:${demand.pageId}`; }
function priority(demand: GeometryPageDemandV1): number { return demand.priority + (demand.currentViewMissing ? 0x1000000 : 0) + (demand.shadow ? 0x800000 : 0) + (demand.predictive ? 0x400000 : 0); }
function sameBytes(a: Uint8Array, b: Uint8Array): boolean { if (a.byteLength !== b.byteLength) return false; for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false; return true; }

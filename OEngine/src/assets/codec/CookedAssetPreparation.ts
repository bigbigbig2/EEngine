import { AssetWorkerPool, assertAssetWorkerResult } from "./AssetWorkerPool.js";
import {
  cookedGeometrySpans,
  type CookedAssetResult,
  type CookedAssetTask,
  type CookedGeometryRegistration,
  type CookedTaskHeader
} from "./CookedAssetProtocol.js";
import { importCookedTextureReceipt, PC_TEXTURE_INPUT_LIMIT } from "../TextureProduct.js";
import { loadAssetBatch } from "../AssetLoadBatch.js";
import {
  markPageIntegrityPreverifiedV1,
  type GeometryPageProductV1
} from "../geometry-product/GeometryProductV1.js";
import {
  importPreparedResidentPage,
  releasePreparedPage
} from "../geometry-product/GeometryProductResidentAttributes.js";
import { CookedAssetCredit } from "./CookedAssetCredit.js";

const MiB = 1024 * 1024;

/** Device-independent Cooked CPU owner. The pool never creates GPU objects.
 * Temporary work is admitted before fetch; immutable returned/replay bytes are
 * caller-owned. Session cancellation terminates active tasks via the pool. */
export class CookedAssetPreparation {
  readonly #pool: AssetWorkerPool;
  readonly #credit: CookedAssetCredit;
  // Separate IO admission from Worker and byte capacity. A smaller Worker
  // profile may run fewer simultaneous requests, but never bypasses this cap.
  readonly #io: CookedAssetCredit;
  #task = 0;
  #disposed = false;
  readonly #sessions = new Map<string, AbortController>();
  readonly #readyLeases = new Map<string, Set<ReturnType<typeof geometryReadyLease>>>();
  #encodedBytes = 0;
  #ioMs = 0;
  #busyMs = 0;
  #ranges = 0;
  #textureReads = 0;
  readonly #sessionMetrics = new Map<string, { encodedBytes: number; ranges: number }>();

  constructor(
    options: {
      maxWorkers?: number;
      maxConcurrentRanges?: number;
      maxTemporaryBytes?: number;
      createWorker?: () => Worker | Promise<Worker>;
    } = {}
  ) {
    const maxRanges = options.maxConcurrentRanges ?? 4;
    if (!Number.isSafeInteger(maxRanges) || maxRanges < 1 || maxRanges > 8) {
      throw new RangeError("Cooked range concurrency must be in 1..8");
    }
    this.#io = new CookedAssetCredit({ total: maxRanges, encoded: 0, ready: 0 });
    this.#credit = new CookedAssetCredit({
      total: options.maxTemporaryBytes ?? 256 * MiB,
      encoded: 32 * MiB,
      ready: 64 * MiB
    });
    this.#pool = new AssetWorkerPool({
      maxWorkers:
        options.maxWorkers ?? Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency ?? 3) - 2)),
      maxInFlightEstimatedBytes: options.maxTemporaryBytes ?? 256 * MiB,
      createWorker:
        options.createWorker ??
        (() => {
          if (typeof Worker === "undefined") {
            throw new Error("Cooked assets require Dedicated Worker support");
          }
          return new Worker(new URL("./workers/cooked-asset-worker.js", import.meta.url), { type: "module" });
        })
    });
  }

  openSession(): string {
    if (this.#disposed) {
      throw new Error("Cooked preparation is disposed");
    }
    const session = crypto.randomUUID();
    this.#sessions.set(session, new AbortController());
    this.#readyLeases.set(session, new Set());
    this.#sessionMetrics.set(session, { encodedBytes: 0, ranges: 0 });
    return session;
  }

  closeSession(session: string): void {
    this.#sessions.get(session)?.abort();
    for (const lease of this.#readyLeases.get(session) ?? []) {
      lease.cancel();
    }
    this.#readyLeases.delete(session);
    this.#sessions.delete(session);
    this.#sessionMetrics.delete(session);
    this.#pool.forgetRegistration(session);
  }

  async readGeometry(
    session: string,
    registration: CookedGeometryRegistration,
    pageIds: ArrayLike<number>,
    signal?: AbortSignal,
    priority: 0 | 1 | 2 = 1
  ): Promise<readonly GeometryPageProductV1[]> {
    const spans = cookedGeometrySpans(registration.pages, pageIds, 8 * MiB);
    if (pageIds.length > 64) {
      throw new RangeError("Cooked geometry batch exceeds 64 complete pages");
    }
    const pages = new Map<number, GeometryPageProductV1>();
    const combined = this.#signal(session, signal);
    const decodedBytes = spans.reduce((bytes, span) => bytes + span.pageIds.length * 262144, 0);
    const encodedBytes = spans.reduce((bytes, span) => bytes + span.bytes, 0);
    const readyBytes = decodedBytes * 2;
    // Admit the entire result domain atomically. Partial ready reservations can
    // otherwise deadlock two bootstrap batches waiting on each other's tails.
    const release = await this.#credit.acquire(
      {
        total: encodedBytes * 2 + decodedBytes * 3,
        encoded: encodedBytes,
        ready: readyBytes
      },
      priority,
      combined
    );
    const leases = this.#readyLeases.get(session);
    if (!leases || combined.aborted) {
      release();
      combined.throwIfAborted();
      throw new Error("Cooked asset session is closed");
    }
    const lease = geometryReadyLease(release, decodedBytes / 262144, () => leases.delete(lease));
    leases.add(lease);
    try {
      await loadAssetBatch(spans, 4, combined, async (span, _index, batchSignal) => {
        const header = this.#header(session);
        const decodedBytes = span.pageIds.length * 262144;
        const result = await this.#submit(
          { ...header, kind: "geometry", span },
          span.bytes * 2 + decodedBytes * 3,
          priority,
          batchSignal,
          { key: session, value: registration }
        );
        if (!result.ok || result.kind !== "geometry" || result.pages.length !== span.pageIds.length) {
          throw new Error("Cooked geometry receipt domain mismatch");
        }
        for (let index = 0; index < result.pages.length; index++) {
          const value = result.pages[index]!;
          const pageId = span.pageIds[index]!;
          const descriptor = registration.descriptor;
          if (
            value.pageId !== pageId ||
            value.bytes.byteLength !== descriptor.decodedPageBytes ||
            value.integrity !== (registration.verifyPageSha256 ? "decoded-sha256" : "encoded-crc32") ||
            (registration.verifyPageSha256 && !/^[0-9a-f]{64}$/u.test(value.decodedPageHash128 ?? ""))
          ) {
            throw new Error("Cooked geometry receipt identity/extent mismatch");
          }
          const page = markPageIntegrityPreverifiedV1(
            Object.freeze({
              productId: descriptor.productId.slice(),
              revision: descriptor.revision,
              pageId,
              decodedHash128: descriptor.pageRecords.slice(pageId * 32, pageId * 32 + 16),
              decodedPageHash128:
                value.decodedPageHash128 === undefined
                  ? undefined
                  : Uint8Array.from(value.decodedPageHash128.slice(0, 32).match(/../gu)!, (s) =>
                      parseInt(s, 16)
                    ),
              integrity: value.integrity,
              bytes: value.bytes
            })
          );
          const record = new DataView(
            descriptor.pageRecords.buffer,
            descriptor.pageRecords.byteOffset + pageId * 32,
            32
          );
          if (
            value.prepared.groupBegin !== record.getUint32(16, true) ||
            value.prepared.groupCount !== record.getUint32(20, true)
          ) {
            throw new Error("Cooked geometry prepared group domain mismatch");
          }
          importPreparedResidentPage(result, page, value.prepared, lease.releasePage);
          pages.set(pageId, page);
        }
      });
      this.#assertSession(session, combined);
      lease.imported();
      const ordered = Array.from(pageIds, (id) => pages.get(id)!);
      pages.clear();
      return ordered;
    } catch (error) {
      for (const page of pages.values()) {
        releasePreparedPage(page);
      }
      lease.cancel();
      throw error;
    }
  }

  async readTexture(
    session: string,
    url: string,
    expectedIdentity: string,
    signal?: AbortSignal,
    priority: 0 | 1 | 2 = 2
  ) {
    // HEAD does not allocate the response payload; admit the full declared
    // container plus digest scratch before a Worker starts its GET.
    const combined = this.#signal(session, signal);
    const releaseHead = await this.#io.acquire({ total: 1, encoded: 0, ready: 0 }, priority, combined);
    let response: Response;
    try {
      response = await fetch(url, { method: "HEAD", signal: combined });
    } finally {
      releaseHead();
    }
    if (!response.ok) {
      throw new Error(`Cooked texture HEAD HTTP ${response.status}`);
    }
    const size = Number(response.headers.get("content-length"));
    if (
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > PC_TEXTURE_INPUT_LIMIT ||
      (response.headers.get("content-encoding") ?? "identity") !== "identity"
    ) {
      throw new RangeError("Cooked texture requires a bounded identity-encoded container");
    }
    const release = await this.#credit.acquire({ total: size * 2, encoded: 0, ready: 0 }, priority, combined);
    try {
      const result = await this.#submit(
        { ...this.#header(session), kind: "texture", url, expectedIdentity, maxBytes: size },
        size * 2,
        priority,
        signal
      );
      const product = await importCookedTextureReceipt(result, expectedIdentity);
      this.#assertSession(session, signal);
      return product;
    } finally {
      release();
    }
  }

  evidence() {
    return {
      ...this.#pool.evidence(),
      encodedBytes: this.#encodedBytes,
      ioMs: this.#ioMs,
      busyMs: this.#busyMs,
      ranges: this.#ranges,
      textureReads: this.#textureReads,
      sessions: this.#sessions.size,
      credit: this.#credit.evidence(),
      io: this.#io.evidence()
    };
  }

  sessionEvidence(session: string) {
    return { ...this.#sessionMetrics.get(session) };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const session of this.#sessions.keys()) this.closeSession(session);
    this.#pool.dispose();
  }

  #assertSession(session: string, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.#disposed || !this.#sessions.has(session)) {
      throw new Error("Cooked asset session is closed");
    }
  }
  #signal(session: string, signal?: AbortSignal): AbortSignal {
    this.#assertSession(session, signal);
    return signal
      ? AbortSignal.any([signal, this.#sessions.get(session)!.signal])
      : this.#sessions.get(session)!.signal;
  }
  #header(session: string): CookedTaskHeader {
    this.#assertSession(session);
    return { version: 1, session, epoch: 1, task: ++this.#task };
  }
  async #submit(
    task: CookedAssetTask,
    estimatedPeakBytes: number,
    priority: 0 | 1 | 2,
    signal?: AbortSignal,
    registration?: { key: string; value: unknown }
  ): Promise<CookedAssetResult> {
    const combined = this.#signal(task.session, signal);
    const releaseIo = await this.#io.acquire({ total: 1, encoded: 0, ready: 0 }, priority, combined);
    try {
      const result = await this.#pool.submit<CookedAssetTask, CookedAssetResult>({
        request: task,
        transfer: [],
        estimatedPeakBytes,
        priority,
        signal: combined,
        registration
      });
      this.#assertSession(task.session, signal);
      assertAssetWorkerResult(result);
      if (
        result.version !== task.version ||
        result.session !== task.session ||
        result.epoch !== task.epoch ||
        result.task !== task.task
      ) {
        throw new Error("Cooked receipt protocol/session/task epoch mismatch");
      }
      if (!result.ok) {
        throw new Error(result.message);
      }
      this.#encodedBytes += result.encodedBytes;
      this.#ioMs += result.ioMs;
      this.#busyMs += result.busyMs;
      const metrics = this.#sessionMetrics.get(task.session)!;
      metrics.encodedBytes += result.encodedBytes;
      if (result.kind === "geometry") {
        this.#ranges++;
        metrics.ranges++;
      } else {
        this.#textureReads++;
      }
      return result;
    } finally {
      releaseIo();
    }
  }
}

/** Separate closure holds only counters/credit, never a batch's payload map. */
function geometryReadyLease(
  release: (remaining?: { total: number; encoded: number; ready: number }) => void,
  pageCount: number,
  finished: () => void
) {
  let remaining = pageCount;
  let imported = false;
  let active = true;
  const shrink = () => {
    const bytes = remaining * 2 * 262144;
    release({ total: bytes, encoded: 0, ready: bytes });
    if (remaining === 0) {
      active = false;
      finished();
    }
  };
  return {
    releasePage() {
      if (!active) {
        return;
      }
      remaining--;
      if (imported) {
        shrink();
      }
    },
    imported() {
      if (active) {
        imported = true;
        shrink();
      }
    },
    cancel() {
      if (active) {
        active = false;
        release();
        finished();
      }
    }
  };
}

let shared: CookedAssetPreparation | undefined;
/** Shared CPU pool, independent of any GPU device epoch. Sources own sessions. */
export function cookedAssetPreparation(): CookedAssetPreparation {
  return (shared ??= new CookedAssetPreparation());
}

import { AssetWorkerPool, assertAssetWorkerResult } from "./AssetWorkerPool.js";
import {
  cookedGeometrySpans,
  type CookedAssetResult,
  type CookedAssetTask,
  type CookedGeometryRegistration,
  type CookedTaskHeader,
} from "./CookedAssetProtocol.js";
import { importCookedTextureReceipt, PC_TEXTURE_INPUT_LIMIT } from "../TextureProduct.js";
import { loadAssetBatch } from "../AssetLoadBatch.js";
import {
  markPageIntegrityPreverifiedV1,
  type GeometryPageProductV1,
} from "../geometry-product/GeometryProductV1.js";
import {
  importPreparedResidentPage,
  releasePreparedPage,
} from "../geometry-product/GeometryProductResidentAttributes.js";
import { CookedAssetCredit } from "./CookedAssetCredit.js";
import {
  TILED_TEXTURE_DIRECTORY_LIMIT,
  assertTiledTextureDirectory,
  validateTiledTextureMetadata,
  type TiledTextureDirectory,
} from "../TiledTextureProduct.js";
import {
  tiledTextureSpans,
  type TiledTextureRegistration,
  type TiledTexturePreparedPayload,
} from "./TiledTextureTransport.js";
import { TiledTextureCache } from "./TiledTextureCache.js";
import { TILED_ZSTD_MEMORY_BYTES } from "./TiledTextureCompression.js";
import { TILED_ZSTD_WASM_BYTES } from "./vendor/tiled-zstd/identity.js";
import { writeImageTextureDirectory, type ImageTextureDirectory } from "../ImageTextureProduct.js";
import {
  ImageTextureLease, closeImageTextureResult, imageTaskPeak, imageTextureTask,
  type ImageTextureResult, type ImageTextureTask
} from "./ImageTexturePreparation.js";

const MiB = 1024 * 1024;
export interface TiledTexturePayloadLease {
  /** Exclusive, exact-sized storage. release() invalidates/detaches these views. */
  readonly payloads: readonly TiledTexturePreparedPayload[];
  /** Call after copying/staging/discarding. Credit remains held until release or session cancellation. */
  release(): void;
}
interface TiledDirectoryRegistration {
  readonly session: string;
  readonly key: string;
  readonly registration: TiledTextureRegistration;
  readonly charge: number;
  readonly controller: AbortController;
}
interface ImageDirectoryRegistration {
  readonly directory: ImageTextureDirectory;
  readonly controller: AbortController;
  readonly leases: Set<ImageTextureLease>;
  readonly charge: number;
}

/** Device-independent Cooked CPU owner. The pool never creates GPU objects.
 * Temporary work is admitted before fetch; immutable returned/replay bytes are
 * caller-owned. Session cancellation terminates active tasks via the pool. */
export class CookedAssetPreparation {
  readonly #pool: AssetWorkerPool;
  readonly #credit: CookedAssetCredit;
  // Separate IO admission from Worker and byte capacity. A smaller Worker
  // profile may run fewer simultaneous requests, but never bypasses this cap.
  readonly #io: CookedAssetCredit;
  readonly #tileCache: TiledTextureCache;
  readonly #tiledDirectories = new Map<TiledTextureDirectory, TiledDirectoryRegistration>();
  readonly #tileLeases = new Map<string, Set<() => void>>();
  readonly #imageLeases = new Map<string, Set<ImageTextureLease>>();
  readonly #imageDirectories = new Map<string, Map<ImageTextureDirectory, ImageDirectoryRegistration>>();
  #imageDirectoryBytes = 0;
  #directoryBytes = 0;
  #directoryReservedBytes = 0;
  #task = 0;
  #disposed = false;
  readonly #sessions = new Map<string, AbortController>();
  readonly #readyLeases = new Map<string, Set<ReturnType<typeof geometryReadyLease>>>();
  #encodedBytes = 0;
  #ioMs = 0;
  #busyMs = 0;
  #ranges = 0;
  #textureReads = 0;
  #tiledDirectoryReads = 0;
  #tiledPayloadRanges = 0;
  #tiledPayloadBytes = 0;
  #tiledFetchedBytes = 0;
  #tiledTaskFailures = 0;
  #tiledNativeBytes = 0;
  #tiledCacheHitBytes = 0;
  #tiledDecodeMs = 0;
  #tiledDecoderInitMs = 0;
  readonly #decoderReservedBytes: number;
  readonly #sessionMetrics = new Map<string, { encodedBytes: number; ranges: number }>();

  constructor(
    options: {
      maxWorkers?: number;
      maxConcurrentRanges?: number;
      maxTemporaryBytes?: number;
      createWorker?: () => Worker | Promise<Worker>;
      maxTileCacheBytes?: number;
      /** E1 isolated composition selects 16 MiB; production defaults stay unchanged until E2. */
      maxEncodedBytes?: number;
    } = {},
  ) {
    const maxRanges = options.maxConcurrentRanges ?? 4;
    const maxWorkers =
      options.maxWorkers ?? Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency ?? 3) - 2));
    if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 4) {
      throw new RangeError("Cooked Worker count must be in 1..4");
    }
    this.#tileCache = new TiledTextureCache(options.maxTileCacheBytes);
    if (!Number.isSafeInteger(maxRanges) || maxRanges < 1 || maxRanges > 8) {
      throw new RangeError("Cooked range concurrency must be in 1..8");
    }
    this.#io = new CookedAssetCredit({ total: maxRanges, encoded: 0, ready: 0 });
    const temporaryBytes = options.maxTemporaryBytes ?? 256 * MiB;
    this.#decoderReservedBytes = maxWorkers * (TILED_ZSTD_MEMORY_BYTES + 2 * TILED_ZSTD_WASM_BYTES);
    const taskBytes = temporaryBytes - this.#decoderReservedBytes;
    if (!Number.isSafeInteger(options.maxEncodedBytes ?? 32 * MiB) ||
        (options.maxEncodedBytes ?? 32 * MiB) < 1 || (options.maxEncodedBytes ?? 32 * MiB) > 32 * MiB) {
      throw new RangeError("Cooked encoded input credit must be in 1..32 MiB");
    }
    if (!Number.isSafeInteger(temporaryBytes) || taskBytes < 4 * MiB) {
      throw new RangeError(
        "Cooked budget cannot hold decoder reservations and one maximum resident fragment",
      );
    }
    this.#credit = new CookedAssetCredit({
      total: taskBytes,
      encoded: options.maxEncodedBytes ?? 32 * MiB,
      ready: 64 * MiB,
    });
    this.#pool = new AssetWorkerPool({
      maxWorkers,
      maxInFlightEstimatedBytes: taskBytes,
      discardResult: (result) => {
        if ((result as { version?: number } | null)?.version === 4) {
          closeImageTextureResult(result as ImageTextureResult);
        }
      },
      retainedBytes: (result) => {
        const bytes = (result as { decoderMemoryBytes?: unknown } | null)?.decoderMemoryBytes;
        if (bytes !== 0 && bytes !== TILED_ZSTD_MEMORY_BYTES) {
          throw new Error("Cooked Worker decoder memory receipt mismatch");
        }
        return bytes;
      },
      createWorker:
        options.createWorker ??
        (() => {
          if (typeof Worker === "undefined") {
            throw new Error("Cooked assets require Dedicated Worker support");
          }
          return new Worker(new URL("./workers/cooked-asset-worker.js", import.meta.url), { type: "module" });
        }),
    });
  }

  openSession(): string {
    if (this.#disposed) {
      throw new Error("Cooked preparation is disposed");
    }
    const session = crypto.randomUUID();
    this.#sessions.set(session, new AbortController());
    this.#readyLeases.set(session, new Set());
    this.#tileLeases.set(session, new Set());
    this.#imageLeases.set(session, new Set());
    this.#imageDirectories.set(session, new Map());
    this.#sessionMetrics.set(session, { encodedBytes: 0, ranges: 0 });
    return session;
  }

  closeSession(session: string): void {
    this.#sessions.get(session)?.abort();
    for (const lease of this.#imageLeases.get(session) ?? []) {
      lease.close();
    }
    this.#imageLeases.delete(session);
    for (const directory of this.#imageDirectories.get(session)?.keys() ?? []) {
      this.releaseImageDirectory(session, directory);
    }
    this.#imageDirectories.delete(session);
    for (const lease of this.#readyLeases.get(session) ?? []) {
      lease.cancel();
    }
    this.#readyLeases.delete(session);
    for (const cancel of this.#tileLeases.get(session) ?? []) {
      cancel();
    }
    this.#tileLeases.delete(session);
    for (const [directory, value] of this.#tiledDirectories) {
      if (value.session === session) {
        this.releaseTiledDirectory(session, directory);
      }
    }
    this.#sessions.delete(session);
    this.#sessionMetrics.delete(session);
    this.#pool.forgetRegistration(session);
  }

  /** E1 isolated entry. Shares the existing pool, IO admission, sessions and credits. */
  async readImageItem(
    session: string,
    directory: ImageTextureDirectory,
    itemId: number,
    baseUrl: string,
    signal?: AbortSignal,
    priority: 0 | 1 | 2 = 1
  ): Promise<ImageTextureLease> {
    this.#assertSession(session, signal);
    const directories = this.#imageDirectories.get(session)!;
    let registration = directories.get(directory);
    if (!registration) {
      const bytes = writeImageTextureDirectory(directory);
      const charge = bytes.byteLength * 4 + directory.items.length * 128;
      if (this.#imageDirectoryBytes + charge > 8 * MiB) {
        throw new RangeError("Image directory global metadata credit exceeded");
      }
      const snapshot = structuredClone(directory);
      for (const plane of snapshot.planes) {
        Object.freeze(plane.constants);
        Object.freeze(plane.alphaScales);
        Object.freeze(plane);
      }
      for (const item of snapshot.items) {
        Object.freeze(item);
      }
      Object.freeze(snapshot.items);
      Object.freeze(snapshot.planes);
      Object.freeze(snapshot);
      registration = { directory: snapshot, controller: new AbortController(), leases: new Set(), charge };
      directories.set(directory, registration);
      this.#imageDirectoryBytes += charge;
    }
    const registered = registration;
    const combined = AbortSignal.any([
      this.#signal(session, signal), registered.controller.signal, AbortSignal.timeout(30000)
    ]);
    const admittedDirectory = registered.directory;
    const task = imageTextureTask(admittedDirectory, itemId, baseUrl, session, ++this.#task);
    const peak = imageTaskPeak(task.item);
    const ready = task.item.decodedBytes * 2;
    const release = await this.#credit.acquire({ total: peak, encoded: task.item.bytes, ready }, priority, combined);
    let result: ImageTextureResult | undefined;
    let releaseIo: (() => void) | undefined;
    try {
      releaseIo = await this.#io.acquire({ total: 1, encoded: 0, ready: 0 }, priority, combined);
      result = await this.#pool.submit<ImageTextureTask, ImageTextureResult>({
        request: task, transfer: [], estimatedPeakBytes: peak, priority, signal: combined
      });
      this.#assertSession(session, combined);
      assertAssetWorkerResult(result);
      if (result.version !== 4 || result.session !== session || result.epoch !== task.epoch ||
          result.task !== task.task || result.sourceRevision !== task.sourceRevision ||
          result.recipe !== task.recipe || result.itemId !== itemId ||
          (result.decoderMemoryBytes !== 0 && result.decoderMemoryBytes !== TILED_ZSTD_MEMORY_BYTES)) {
        throw new Error("Image texture receipt provenance/domain mismatch");
      }
      if (!result.ok) {
        throw new Error(result.message);
      }
      if (result.encodedBytes !== task.item.bytes ||
          (task.item.kind === "image" ? result.representation !== "decoded-image" ||
            result.image.width !== task.item.width || result.image.height !== task.item.height :
            result.representation !== "exact-bytes" || result.bytes.byteLength !== task.item.decodedBytes)) {
        throw new Error("Image texture receipt backing mismatch");
      }
      release({ total: ready, encoded: 0, ready });
      const leases = this.#imageLeases.get(session)!;
      const lease = ImageTextureLease.import(admittedDirectory, task.item, result, () => {
        leases.delete(lease);
        registered.leases.delete(lease);
        release();
      });
      leases.add(lease);
      registered.leases.add(lease);
      return lease;
    } catch (error) {
      if (result) {
        closeImageTextureResult(result);
      }
      release();
      throw error;
    } finally {
      releaseIo?.();
    }
  }

  /** End this immutable source generation, including in-flight IO/ready objects, without
   * cancelling unrelated products. A later registration gets new task/lease identities. */
  releaseImageDirectory(session: string, directory: ImageTextureDirectory): void {
    const directories = this.#imageDirectories.get(session);
    const registered = directories?.get(directory);
    if (!registered) {
      return;
    }
    registered.controller.abort(new DOMException("Image source retired", "AbortError"));
    for (const lease of registered.leases) {
      lease.close();
    }
    directories!.delete(directory);
    this.#imageDirectoryBytes -= registered.charge;
  }

  async readGeometry(
    session: string,
    registration: CookedGeometryRegistration,
    pageIds: ArrayLike<number>,
    signal?: AbortSignal,
    priority: 0 | 1 | 2 = 1,
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
        ready: readyBytes,
      },
      priority,
      combined,
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
          { key: session, value: registration },
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
                      parseInt(s, 16),
                    ),
              integrity: value.integrity,
              bytes: value.bytes,
            }),
          );
          const record = new DataView(
            descriptor.pageRecords.buffer,
            descriptor.pageRecords.byteOffset + pageId * 32,
            32,
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
    priority: 0 | 1 | 2 = 2,
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
        signal,
      );
      const product = await importCookedTextureReceipt(result, expectedIdentity);
      this.#assertSession(session, signal);
      return product;
    } finally {
      release();
    }
  }

  /** Manifest hash/length admit only metadata; no fine payload is fetched here.
   * Bound to this session and URL until releaseTiledDirectory() or closeSession(). */
  async readTiledDirectory(
    session: string,
    url: string,
    expectedHash: string,
    byteLength: number,
    signal?: AbortSignal,
    priority: 0 | 1 | 2 = 0,
  ): Promise<TiledTextureDirectory> {
    const combined = this.#signal(session, signal);
    if (
      !Number.isSafeInteger(byteLength) ||
      byteLength < 1 ||
      byteLength > TILED_TEXTURE_DIRECTORY_LIMIT ||
      !/^[a-f0-9]{64}$/u.test(expectedHash)
    ) {
      throw new RangeError("Tiled directory manifest length invalid");
    }
    for (const [directory, value] of this.#tiledDirectories) {
      if (
        value.session === session &&
        directory.identity === expectedHash &&
        value.registration.directoryUrl === url &&
        directory.directoryBytes === byteLength
      ) {
        return directory;
      }
    }
    // Only the main owner retains the full directory. Worker registrations hold
    // identity/pack routing; each task clones <=64 selected records, never all pages.
    const reserved = byteLength * 4;
    if (this.#directoryBytes + this.#directoryReservedBytes + reserved > 128 * MiB) {
      throw new RangeError("Tiled directory metadata budget exceeded");
    }
    this.#directoryReservedBytes += reserved;
    let release: (() => void) | undefined;
    try {
      release = await this.#credit.acquire(
        { total: byteLength * 16, encoded: 0, ready: 0 },
        priority,
        combined,
      );
      const result = await this.#submit(
        {
          ...this.#header(session),
          kind: "tiled-directory",
          url,
          expectedHash,
          byteLength,
        },
        byteLength * 16,
        priority,
        combined,
      );
      if (
        !result.ok ||
        result.kind !== "tiled-directory" ||
        result.directory.identity !== expectedHash ||
        result.directory.directoryBytes !== byteLength
      ) {
        throw new Error("Tiled directory receipt identity mismatch");
      }
      const directory = validateTiledTextureMetadata(result.directory.metadata, expectedHash, byteLength);
      this.#assertSession(session, combined);
      const objects =
        directory.metadata.payloads.length +
        directory.metadata.planes.reduce((n, plane) => n + plane.mips.length * 2 + 1, 0) +
        directory.metadata.source.planes.reduce((n, plane) => n + plane.mips.length + 1, 0);
      const charge = reserved + objects * 128;
      if (this.#directoryBytes + this.#directoryReservedBytes - reserved + charge > 128 * MiB) {
        throw new RangeError("Tiled parsed directory metadata budget exceeded");
      }
      this.#tiledDirectories.set(directory, {
        session,
        key: `${session}:vt:${crypto.randomUUID()}`,
        charge,
        controller: new AbortController(),
        registration: { identity: directory.identity, pack: directory.metadata.pack, directoryUrl: url },
      });
      this.#directoryBytes += charge;
      return directory;
    } finally {
      this.#directoryReservedBytes -= reserved;
      release?.();
    }
  }

  /** Ends one asset registration without closing unrelated assets in the session.
   * Cancels its in-flight/ready leases; late results cannot acquire the retired registration. */
  releaseTiledDirectory(session: string, directory: TiledTextureDirectory): void {
    const registered = this.#tiledDirectories.get(directory);
    if (!registered) {
      return;
    }
    if (registered.session !== session) {
      throw new Error("Tiled directory belongs to another session");
    }
    registered.controller.abort(new DOMException("Tiled directory is released", "AbortError"));
    this.#pool.forgetRegistration(registered.key);
    this.#directoryBytes -= registered.charge;
    this.#tiledDirectories.delete(directory);
  }

  /** Fetch at most 64 complete tiles/resident fragments. The caller owns a ready
   * lease, never the replay cache; no GPU object or frame submit occurs here. */
  async readTiledPayloads(
    session: string,
    directory: TiledTextureDirectory,
    payloadIds: readonly number[],
    signal?: AbortSignal,
    priority: 0 | 1 | 2 = 1,
  ): Promise<TiledTexturePayloadLease> {
    const sessionSignal = this.#signal(session, signal);
    assertTiledTextureDirectory(directory);
    const registered = this.#tiledDirectories.get(directory);
    if (registered?.session !== session) {
      throw new Error("Tiled directory is not registered in this live session");
    }
    const combined = AbortSignal.any([sessionSignal, registered.controller.signal]);
    // Validate the complete requested domain before taking any cache ownership.
    tiledTextureSpans(directory, payloadIds);
    const ids = [...new Set(payloadIds)];
    const readyBytes = ids.reduce((n, id) => n + directory.metadata.payloads[id]!.nativeByteLength, 0);
    const spans = tiledTextureSpans(directory, ids);
    const encodedBytes = spans.reduce((n, span) => n + span.byteLength, 0);
    const releaseCredit = await this.#credit.acquire(
      {
        total: encodedBytes * 2 + readyBytes * 2,
        encoded: encodedBytes,
        ready: readyBytes,
      },
      priority,
      combined,
    );
    const leases = this.#tileLeases.get(session);
    // Admission resolves asynchronously. The session or directory can retire
    // before this continuation gets a chance to register its lease.
    if (!leases || combined.aborted) {
      releaseCredit();
      combined.throwIfAborted();
      throw new Error("Cooked asset session is closed");
    }
    const values = new Map<number, TiledTexturePreparedPayload>();
    let active = true;
    const finish = (cache: boolean) => {
      if (!active) {
        return;
      }
      active = false;
      for (const value of values.values()) {
        // A consumer may have already transferred its exclusive storage.
        if (value.bytes.byteLength === 0) {
          continue;
        }
        // Move storage out of caller views; a retained released lease cannot
        // keep an unaccounted backing allocation alive.
        const owned = structuredClone(value.bytes, { transfer: [value.bytes] });
        if (cache && !this.#disposed) {
          this.#tileCache.put(`${directory.identity}/${value.id}`, owned);
        }
      }
      values.clear();
      leases.delete(cancel);
      combined.removeEventListener("abort", cancel);
      releaseCredit();
    };
    const cancel = () => finish(false);
    leases.add(cancel);
    combined.addEventListener("abort", cancel, { once: true });
    try {
      combined.throwIfAborted();
      for (const id of ids) {
        const bytes = this.#tileCache.take(`${directory.identity}/${id}`);
        if (bytes) {
          values.set(id, {
            id,
            hash: directory.metadata.payloads[id]!.hash,
            representation: "gpu-native",
            bytes,
          });
          if (bytes.byteLength !== directory.metadata.payloads[id]!.nativeByteLength) {
            throw new Error("Tiled native cache extent mismatch");
          }
          this.#tiledCacheHitBytes += bytes.byteLength;
        }
      }
      const missing = ids.filter((id) => !values.has(id));
      await loadAssetBatch(
        tiledTextureSpans(directory, missing),
        4,
        combined,
        async (span, _index, batchSignal) => {
          const result = await this.#submit(
            {
              ...this.#header(session),
              kind: "tiled-payload",
              registrationKey: registered.key,
              span,
            },
            span.byteLength * 2 + span.payloads.reduce((sum, p) => sum + p.nativeByteLength, 0) * 2,
            priority,
            batchSignal,
            {
              key: registered.key,
              value: registered.registration,
            },
          );
          if (
            !result.ok ||
            result.kind !== "tiled-payload" ||
            result.registrationKey !== registered.key ||
            result.payloads.length !== span.payloadIds.length
          ) {
            throw new Error("Tiled payload receipt domain mismatch");
          }
          if (!active) {
            throw new Error("Tiled payload lease was cancelled");
          }
          for (let i = 0; i < result.payloads.length; i++) {
            const value = result.payloads[i]!;
            const id = span.payloadIds[i]!;
            const expected = directory.metadata.payloads[id]!;
            if (
              value.id !== id ||
              value.hash !== expected.hash ||
              value.representation !== "gpu-native" ||
              !(value.bytes instanceof ArrayBuffer) ||
              value.bytes.byteLength !== expected.nativeByteLength
            ) {
              throw new Error("Tiled payload receipt identity/extent mismatch");
            }
            values.set(id, value);
          }
        },
      );
      this.#assertSession(session, combined);
      releaseCredit({ total: readyBytes, encoded: 0, ready: readyBytes });
      return Object.freeze({
        payloads: Object.freeze(ids.map((id) => values.get(id)!)),
        release: () => finish(true),
      });
    } catch (error) {
      cancel();
      throw error;
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
      tiledDirectoryReads: this.#tiledDirectoryReads,
      tiledPayloadRanges: this.#tiledPayloadRanges,
      sessions: this.#sessions.size,
      credit: this.#credit.evidence(),
      imageDirectoryBytes: this.#imageDirectoryBytes,
      io: this.#io.evidence(),
      tiled: {
        fetchedBytes: this.#tiledFetchedBytes,
        hashedPayloadBytes: this.#tiledPayloadBytes,
        nativeOutputBytes: this.#tiledNativeBytes,
        cacheHitBytes: this.#tiledCacheHitBytes,
        decodeMs: this.#tiledDecodeMs,
        decoderInitMs: this.#tiledDecoderInitMs,
        decoderReservedBytes: this.#disposed ? 0 : this.#decoderReservedBytes,
        overfetchBytes: this.#tiledFetchedBytes - this.#tiledPayloadBytes,
        failedTasks: this.#tiledTaskFailures,
        metadataBytes: this.#directoryBytes,
        reservedMetadataBytes: this.#directoryReservedBytes,
        directories: this.#tiledDirectories.size,
        cache: this.#tileCache.evidence(),
      },
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
    this.#tileCache.clear();
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
    return { version: 3, session, epoch: 1, task: ++this.#task };
  }
  async #submit(
    task: CookedAssetTask,
    estimatedPeakBytes: number,
    priority: 0 | 1 | 2,
    signal?: AbortSignal,
    registration?: { key: string; value: unknown },
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
        registration,
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
      } else if (result.kind === "texture") {
        this.#textureReads++;
      } else if (result.kind === "tiled-directory") {
        this.#tiledDirectoryReads++;
      } else {
        this.#tiledPayloadRanges++;
        this.#tiledFetchedBytes += result.encodedBytes;
        const useful =
          task.kind === "tiled-payload" ? task.span.payloads.reduce((n, p) => n + p.byteLength, 0) : -1;
        const native = result.payloads.reduce((n, p) => n + p.bytes.byteLength, 0);
        if (
          result.usefulEncodedBytes !== useful ||
          result.nativeBytes !== native ||
          !Number.isFinite(result.decodeMs) ||
          result.decodeMs < 0 ||
          !Number.isFinite(result.decoderInitMs) ||
          result.decoderInitMs < 0
        ) {
          throw new Error("Tiled Worker cost receipt domain mismatch");
        }
        this.#tiledPayloadBytes += useful;
        this.#tiledNativeBytes += native;
        this.#tiledDecodeMs += result.decodeMs;
        this.#tiledDecoderInitMs += result.decoderInitMs;
        metrics.ranges++;
      }
      return result;
    } catch (error) {
      if (task.kind === "tiled-directory" || task.kind === "tiled-payload") {
        this.#tiledTaskFailures++;
      }
      throw error;
    } finally {
      releaseIo();
    }
  }
}

/** Separate closure holds only counters/credit, never a batch's payload map. */
function geometryReadyLease(
  release: (remaining?: { total: number; encoded: number; ready: number }) => void,
  pageCount: number,
  finished: () => void,
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
    },
  };
}

let shared: CookedAssetPreparation | undefined;
/** Shared CPU pool, independent of any GPU device epoch. Sources own sessions. */
export function cookedAssetPreparation(): CookedAssetPreparation {
  return (shared ??= new CookedAssetPreparation());
}

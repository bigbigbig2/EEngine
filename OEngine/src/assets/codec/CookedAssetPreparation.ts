import { AssetWorkerPool, assertAssetWorkerResult } from "./AssetWorkerPool.js";
import {
  cookedGeometrySpans,
  type CookedAssetResult,
  type CookedAssetTask,
  type CookedGeometryRegistration,
  type CookedTaskHeader
} from "./CookedAssetProtocol.js";
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
import {
  IMAGE_TEXTURE_LIMITS,
  checkedImageHash,
  checkedImageInteger,
  imageTextureHash,
  readImageTextureDirectory,
  writeImageTextureDirectory,
  type ImageTextureDirectory
} from "../ImageTextureProduct.js";
import {
  ImageTextureLease,
  closeImageTextureResult,
  imageTaskPeak,
  imageTextureTask,
  registerImageDirectorySnapshot,
  type ImageTextureResult,
  type ImageTextureTask
} from "./ImageTexturePreparation.js";
import type { ImageTextureImportTask, ImageTextureImportResult } from "./ImageTextureImport.js";

import { imageRanges, fetchImageRange } from "./ImageTextureDelivery.js";

const MiB = 1024 * 1024;
interface ImageDirectoryRegistration {
  readonly cacheIdentity: number;
  readonly directory: ImageTextureDirectory;
  readonly controller: AbortController;
  readonly leases: Set<ImageTextureLease>;
  readonly charge: number;
  indexBytes: number;
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
  readonly #imageLeases = new Map<string, Set<ImageTextureLease>>();
  readonly #imageDirectories = new Map<string, Map<ImageTextureDirectory, ImageDirectoryRegistration>>();
  readonly #localImagePayloads = new Map<ImageTextureDirectory, ReadonlyMap<string, ArrayBuffer>>();
  #imageDirectoryBytes = 0;
  #localReplayBytes = 0;
  readonly #decodedImages = new Map<
    string,
    { lease: ImageTextureLease; bytes: number; session: string; expires: number }
  >();
  #decodedImageTimer: ReturnType<typeof setTimeout> | undefined;
  #decodedImageBytes = 0;
  #decodedImageHits = 0;
  #task = 0;
  #disposed = false;
  readonly #sessions = new Map<string, AbortController>();
  readonly #readyLeases = new Map<string, Set<ReturnType<typeof geometryReadyLease>>>();
  #encodedBytes = 0;
  #ioMs = 0;
  #busyMs = 0;
  #ranges = 0;
  readonly #sessionMetrics = new Map<string, { encodedBytes: number; ranges: number }>();

  constructor(
    options: {
      maxWorkers?: number;
      maxConcurrentRanges?: number;
      maxTemporaryBytes?: number;
      createWorker?: () => Worker | Promise<Worker>;
      maxEncodedBytes?: number;
    } = {}
  ) {
    const maxRanges = options.maxConcurrentRanges ?? 4;
    const maxWorkers =
      options.maxWorkers ?? Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency ?? 3) - 2));
    if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 4) {
      throw new RangeError("Cooked Worker count must be in 1..4");
    }
    if (!Number.isSafeInteger(maxRanges) || maxRanges < 1 || maxRanges > 8) {
      throw new RangeError("Cooked range concurrency must be in 1..8");
    }
    this.#io = new CookedAssetCredit({ total: maxRanges, encoded: 0, ready: 0 });
    // Cold KTX can retain libktx (96 MiB), decoder (64 MiB), resampler
    // (64 MiB), canonical chains and PNG framing until its Worker retires.
    const temporaryBytes = options.maxTemporaryBytes ?? 384 * MiB;
    const taskBytes = temporaryBytes;
    if (
      !Number.isSafeInteger(options.maxEncodedBytes ?? 16 * MiB) ||
      (options.maxEncodedBytes ?? 16 * MiB) < 1 ||
      (options.maxEncodedBytes ?? 16 * MiB) > 16 * MiB
    ) {
      throw new RangeError("Cooked encoded input credit must be in 1..16 MiB");
    }
    if (!Number.isSafeInteger(temporaryBytes) || taskBytes < 4 * MiB) {
      throw new RangeError(
        "Cooked budget cannot hold decoder reservations and one maximum resident fragment"
      );
    }
    this.#credit = new CookedAssetCredit({
      total: taskBytes,
      encoded: options.maxEncodedBytes ?? 16 * MiB,
      ready: 64 * MiB
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
        if (bytes !== 0) {
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
    this.#sessions.delete(session);
    this.#sessionMetrics.delete(session);
    this.#pool.forgetRegistration(session);
  }

  /** Bounded metadata fetch shares the same global IO and byte admission as payload work. */
  async readImageDirectory(
    url: string,
    identity: string,
    byteLength: number,
    signal?: AbortSignal
  ): Promise<ImageTextureDirectory> {
    checkedImageHash(identity);
    checkedImageInteger(byteLength, 1, IMAGE_TEXTURE_LIMITS.directoryBytes);
    const combined = AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]);
    const session = this.openSession();
    const bounded = AbortSignal.any([combined, this.#sessions.get(session)!.signal]);
    let release;
    let releaseIo;
    try {
      release = await this.#credit.acquire(
        { total: byteLength * 5, encoded: byteLength, ready: 0 },
        0,
        bounded
      );
      releaseIo = await this.#io.acquire({ total: 1, encoded: 0, ready: 0 }, 0, bounded);
      return await this.#fetchImageDirectory(url, identity, byteLength, bounded);
    } finally {
      releaseIo?.();
      release?.();
      this.closeSession(session);
    }
  }

  async #fetchImageDirectory(
    url: string,
    identity: string,
    byteLength: number,
    signal: AbortSignal
  ): Promise<ImageTextureDirectory> {
    checkedImageHash(identity);
    checkedImageInteger(byteLength, 1, IMAGE_TEXTURE_LIMITS.directoryBytes);
    const target = new URL(url);
    if (!["http:", "https:"].includes(target.protocol)) {
      throw new Error("Image texture directory requires immutable HTTP transport");
    }
    const combined = signal;
    const response = await fetch(target, { signal: combined });
    if (
      response.status !== 200 ||
      (response.headers.get("content-encoding") ?? "identity") !== "identity" ||
      (response.headers.has("content-length") &&
        response.headers.get("content-length") !== String(byteLength))
    ) {
      await response.body?.cancel();
      throw new Error("Image directory transport status/length/encoding mismatch");
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Image directory body is missing");
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) {
          break;
        }
        if (part.value.byteLength > bytes.length - offset) {
          throw new RangeError("Image directory exceeds its declared byte domain");
        }
        bytes.set(part.value, offset);
        offset += part.value.byteLength;
      }
    } finally {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
    if (offset !== byteLength || (await imageTextureHash(bytes)) !== identity) {
      throw new Error("Image directory byte count/SHA256 mismatch");
    }
    combined.throwIfAborted();

    return readImageTextureDirectory(bytes);
  }

  /** One-item convenience entry; all image preparation shares the same byte owner. */
  async readImageItem(
    session: string,
    directory: ImageTextureDirectory,
    itemId: number,
    baseUrl: string,
    signal?: AbortSignal,
    priority: 0 | 1 | 2 = 1
  ): Promise<ImageTextureLease> {
    const leases = await this.readImageItems(session, directory, [itemId], baseUrl, signal, priority);
    return leases[0]!;
  }

  /** Sources register immutable metadata/index storage at open, not first payload
   * demand, so dormant sources cannot bypass the shared directory capacity. */
  registerImageSource(session: string, directory: ImageTextureDirectory, spatialIndexBytes: number): void {
    checkedImageInteger(spatialIndexBytes, 0, 8 * MiB);
    const registration = this.#registerImageDirectory(session, directory);
    if (registration.indexBytes !== 0) {
      throw new Error("Image source spatial index was already registered");
    }
    const extra = spatialIndexBytes;
    if (this.#imageDirectoryBytes + extra > 8 * MiB) {
      this.releaseImageDirectory(session, directory);
      throw new RangeError("Image source/index global metadata credit exceeded");
    }
    this.#imageDirectoryBytes += extra;
    registration.indexBytes += extra;
  }

  /** Reserve the entire deduplicated VT neighborhood before decoding its first owner.
   * Child tasks only acquire IO slots. They cannot hold partial ready images while
   * waiting for their own remaining byte credit. Failed siblings settle before release. */
  async readImageItems(
    session: string,
    directory: ImageTextureDirectory,
    itemIds: readonly number[],
    baseUrl: string,
    signal?: AbortSignal,
    priority: 0 | 1 | 2 = 1
  ): Promise<readonly ImageTextureLease[]> {
    this.#assertSession(session, signal);
    if (itemIds.length < 1 || itemIds.length > 16) {
      throw new RangeError("Image dependency batch must contain 1..16 item IDs");
    }
    const ids = [...new Set(itemIds)];
    // Freeze the caller's complete generation before an asynchronous admission wait.
    const admitted = this.#registerImageDirectory(session, directory);
    const snapshot = admitted.directory;
    for (const id of ids) {
      if (!Number.isSafeInteger(id) || id < 0 || !snapshot.items[id]) {
        throw new RangeError("Image dependency ID is outside its directory");
      }
    }
    // Cache identities belong to source registrations, not just identical recipes.
    const keys = new Set(ids.map((id) => `${session}/${admitted.cacheIdentity}/${id}`));
    const hits = new Map<number, ImageTextureLease>();
    for (const id of ids) {
      const cached = this.#decodedImages.get(`${session}/${admitted.cacheIdentity}/${id}`);
      if (cached) {
        cached.expires = performance.now() + 5000;
        this.#decodedImages.delete(`${session}/${admitted.cacheIdentity}/${id}`);
        this.#decodedImages.set(`${session}/${admitted.cacheIdentity}/${id}`, cached);
        hits.set(id, cached.lease.retain());
        this.#decodedImageHits++;
      }
    }
    const controller = new AbortController();
    const registration = this.#imageDirectories.get(session)!.get(directory)!;
    const combined = AbortSignal.any([
      this.#signal(session, signal),
      controller.signal,
      registration.controller.signal,
      AbortSignal.timeout(30000)
    ]);
    let peak = 0;
    let encoded = 0;
    let ready = 0;
    for (const id of ids) {
      if (!Number.isSafeInteger(id) || id < 0 || !snapshot.items[id]) {
        throw new RangeError("Image dependency ID is outside its directory");
      }
      const item = snapshot.items[id]!;
      if (hits.has(id)) continue;
      peak += imageTaskPeak(item);
      encoded += item.bytes;
      ready += item.decodedBytes * 2;
    }
    const ranges = imageRanges(
      ids
        .filter((id) => !hits.has(id) && !this.#localImagePayloads.has(directory))
        .map((id) => ({ ...snapshot.items[id]!, priority }))
    ).filter((range) => range.items.length > 1);
    const rangeCharge = ranges.reduce((sum, range) => sum + range.fetchedBytes * 2, 0);
    peak += rangeCharge;
    encoded += rangeCharge;
    const hitBytes = [...hits.values()].reduce((sum, lease) => sum + lease.item.decodedBytes * 2, 0);
    if (peak + hitBytes > this.#credit.limits.total || ready + hitBytes > this.#credit.limits.ready) {
      for (const lease of hits.values()) {
        lease.close();
      }
      throw new RangeError("Cooked cached neighborhood exceeds its credit capacity");
    }
    // Keep LRU neighborhoods while credit permits. On pressure release cold
    // cache references before waiting, so cached ready bytes cannot deadlock IO.
    for (const [key, cached] of this.#decodedImages) {
      const used = this.#credit.evidence().used;
      if (
        used.total + peak <= this.#credit.limits.total &&
        used.encoded + encoded <= this.#credit.limits.encoded &&
        used.ready + ready <= this.#credit.limits.ready
      )
        break;
      if (!keys.has(key)) {
        this.#decodedImages.delete(key);
        this.#decodedImageBytes -= cached.bytes;
        cached.lease.close();
      }
    }
    let release;
    try {
      release = await this.#credit.acquire({ total: peak, encoded, ready }, priority, combined);
    } catch (error) {
      for (const lease of hits.values()) lease.close();
      throw error;
    }
    const charges = new Map<number, { total: number; encoded: number; ready: number }>();
    for (const id of ids) {
      const item = snapshot.items[id]!;
      if (hits.has(id)) continue;
      charges.set(id, { total: imageTaskPeak(item), encoded: item.bytes, ready: item.decodedBytes * 2 });
    }
    const shrink = (id: number, remaining = { total: 0, encoded: 0, ready: 0 }) => {
      const held = charges.get(id)!;
      peak -= held.total - remaining.total;
      encoded -= held.encoded - remaining.encoded;
      ready -= held.ready - remaining.ready;
      charges.set(id, remaining);
      release({ total: peak, encoded, ready });
    };
    const rangeInputs = new Map<number, () => Promise<ArrayBuffer>>();
    for (const range of ranges) {
      let pending: Promise<Uint8Array<ArrayBuffer>> | undefined;
      const fetchRange = () =>
        (pending ??= (async () => {
          const releaseIo = await this.#io.acquire({ total: 1, encoded: 0, ready: 0 }, priority, combined);
          try {
            const bytes = await fetchImageRange(range, baseUrl, combined);
            this.#ranges++;
            this.#encodedBytes += bytes.length;
            const metrics = this.#sessionMetrics.get(session);
            if (metrics) {
              metrics.ranges++;
              metrics.encodedBytes += bytes.length;
            }
            return bytes;
          } finally {
            releaseIo();
          }
        })());
      for (const id of range.items) {
        rangeInputs.set(id, async () => {
          const bytes = await fetchRange();
          const item = snapshot.items[id]!;
          const offset = Number(BigInt(item.offset!) - BigInt(range.start));
          return bytes.slice(offset, offset + item.bytes).buffer;
        });
      }
    }
    const results = await Promise.allSettled(
      ids.map(async (id) => {
        try {
          const hit = hits.get(id);
          if (hit) return hit;
          return await this.#readImageItem(
            session,
            directory,
            id,
            baseUrl,
            combined,
            priority,
            (remaining) => shrink(id, remaining),
            rangeInputs.get(id)
          );
        } catch (error) {
          if (!hits.has(id)) shrink(id);
          controller.abort(error);
          throw error;
        }
      })
    );
    // All child tasks settled; shared range buffers can now retire.
    rangeInputs.clear();
    peak -= rangeCharge;
    encoded -= rangeCharge;
    release({ total: peak, encoded, ready });
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected" || combined.aborted) {
      for (const result of results) {
        if (result.status === "fulfilled") {
          result.value.close();
        }
      }
      for (const id of ids) {
        const key = `${session}/${admitted.cacheIdentity}/${id}`;
        const cached = this.#decodedImages.get(key);
        if (cached) {
          this.#decodedImages.delete(key);
          this.#decodedImageBytes -= cached.bytes;
          cached.lease.close();
        }
      }
      // Other batches may retain a decoded owner: only its last reference
      // returns the original per-item ready charge.
      throw failure?.status === "rejected" ? failure.reason : combined.reason;
    }
    return Object.freeze(
      results.map((result) => {
        if (result.status !== "fulfilled") {
          throw new Error("Image batch lost an admitted result");
        }
        return result.value;
      })
    );
  }

  #registerImageDirectory(session: string, directory: ImageTextureDirectory): ImageDirectoryRegistration {
    this.#assertSession(session);
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
      registerImageDirectorySnapshot(snapshot, directory);
      registration = {
        cacheIdentity: ++this.#task,
        directory: snapshot,
        controller: new AbortController(),
        leases: new Set(),
        charge,
        indexBytes: 0
      };
      directories.set(directory, registration);
      this.#imageDirectoryBytes += charge;
    }
    return registration;
  }

  async #readImageItem(
    session: string,
    directory: ImageTextureDirectory,
    itemId: number,
    baseUrl: string,
    signal: AbortSignal,
    priority: 0 | 1 | 2,
    release: (remaining?: { total: number; encoded: number; ready: number }) => void,
    sharedInput?: () => Promise<ArrayBuffer>
  ): Promise<ImageTextureLease> {
    this.#assertSession(session, signal);
    const registration = this.#registerImageDirectory(session, directory);
    const registered = registration;
    const combined = AbortSignal.any([
      this.#signal(session, signal),
      registered.controller.signal,
      AbortSignal.timeout(30000)
    ]);
    const admittedDirectory = registered.directory;
    const cacheKey = `${session}/${registered.cacheIdentity}/${itemId}`;
    let task = imageTextureTask(admittedDirectory, itemId, baseUrl, session, ++this.#task);
    const local = this.#localImagePayloads.get(directory)?.get(task.item.sha256);
    if (local) task = { ...task, input: local.slice(0) };
    const peak = imageTaskPeak(task.item);
    const ready = task.item.decodedBytes * 2;
    let result: ImageTextureResult | undefined;
    let releaseIo: (() => void) | undefined;
    try {
      if (sharedInput) task = { ...task, input: await sharedInput() };
      releaseIo = await this.#io.acquire({ total: 1, encoded: 0, ready: 0 }, priority, combined);
      result = await this.#pool.submit<ImageTextureTask, ImageTextureResult>({
        request: task,
        transfer: task.input ? [task.input] : [],
        estimatedPeakBytes: peak,
        priority,
        signal: combined
      });
      this.#assertSession(session, combined);
      assertAssetWorkerResult(result);
      if (
        result.version !== 4 ||
        result.session !== session ||
        result.epoch !== task.epoch ||
        result.task !== task.task ||
        result.sourceRevision !== task.sourceRevision ||
        result.recipe !== task.recipe ||
        result.itemId !== itemId ||
        result.decoderMemoryBytes !== 0
      ) {
        throw new Error("Image texture receipt provenance/domain mismatch");
      }
      if (!result.ok) {
        throw new Error(result.message);
      }
      if (
        result.encodedBytes !== task.item.bytes ||
        (task.item.kind === "image"
          ? result.representation !== "decoded-image" ||
            result.image.width !== task.item.width ||
            result.image.height !== task.item.height
          : result.representation !== "exact-bytes" || result.bytes.byteLength !== task.item.decodedBytes)
      ) {
        throw new Error("Image texture receipt backing mismatch");
      }
      this.#ioMs += result.ioMs;
      this.#busyMs += result.busyMs;
      if (!task.input) {
        this.#ranges++;
        this.#encodedBytes += task.item.bytes;
        const metrics = this.#sessionMetrics.get(session)!;
        metrics.ranges++;
        metrics.encodedBytes += task.item.bytes;
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
      if (
        task.plane.mode === "virtual" &&
        task.item.kind === "image" &&
        task.item.decodedBytes * 2 <= 8 * MiB &&
        this.#credit.evidence().waiting === 0
      ) {
        const bytes = task.item.decodedBytes * 2;
        for (const [key, prior] of this.#decodedImages) {
          if (this.#decodedImageBytes + bytes <= 8 * MiB) break;
          this.#decodedImages.delete(key);
          this.#decodedImageBytes -= prior.bytes;
          prior.lease.close();
        }
        const prior = this.#decodedImages.get(cacheKey);
        if (prior) {
          this.#decodedImages.delete(cacheKey);
          this.#decodedImageBytes -= prior.bytes;
          prior.lease.close();
        }
        this.#decodedImages.set(cacheKey, {
          lease: lease.retain(),
          bytes,
          session,
          expires: performance.now() + 5000
        });
        this.#decodedImageBytes += bytes;
        this.#expireDecodedImages();
      }
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

  #expireDecodedImages(): void {
    if (this.#decodedImageTimer !== undefined) {
      return;
    }
    this.#decodedImageTimer = setTimeout(() => {
      this.#decodedImageTimer = undefined;
      const now = performance.now();
      for (const [key, cached] of this.#decodedImages) {
        if (cached.expires <= now) {
          this.#decodedImages.delete(key);
          this.#decodedImageBytes -= cached.bytes;
          cached.lease.close();
        }
      }
      if (this.#decodedImages.size > 0) {
        this.#expireDecodedImages();
      }
    }, 1000);
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
    for (const [key, cached] of this.#decodedImages) {
      if (cached.session === session && key.startsWith(`${session}/${registered.cacheIdentity}/`)) {
        this.#decodedImages.delete(key);
        this.#decodedImageBytes -= cached.bytes;
        cached.lease.close();
      }
    }
    for (const lease of registered.leases) {
      lease.retire();
    }
    directories!.delete(directory);
    this.#imageDirectoryBytes -= registered.charge + registered.indexBytes;
    const local = this.#localImagePayloads.get(directory);
    if (local) {
      this.#localReplayBytes -= [...local.values()].reduce((sum, value) => sum + value.byteLength, 0);
      this.#localImagePayloads.delete(directory);
    }
  }

  /** Cold Web import shares the existing Worker/credit owner. The temporary
   * registration lifetime includes immutable PNG/exact replay needed after loss. */
  async importImage(
    session: string,
    input: Omit<ImageTextureImportTask, "version" | "session" | "task">,
    signal?: AbortSignal
  ): Promise<Extract<ImageTextureImportResult, { ok: true }> & { release(): void }> {
    const combined = this.#signal(session, signal);
    const peakBytes = input.mime === "image/ktx2" ? 384 * MiB : 256 * MiB;
    const release = await this.#credit.acquire(
      { total: peakBytes, encoded: input.input.byteLength, ready: 48 * MiB },
      0,
      combined
    );
    let handedOff = false;
    try {
      const task: ImageTextureImportTask = { ...input, version: 5, session, task: ++this.#task };
      const result = await this.#pool.submit<ImageTextureImportTask, ImageTextureImportResult>({
        request: task,
        transfer: [input.input],
        estimatedPeakBytes: peakBytes,
        priority: 0,
        signal: combined,
        retireWorker: true
      });
      this.#assertSession(session, combined);
      assertAssetWorkerResult(result);
      if (result.version !== 5 || result.session !== session || result.task !== task.task) {
        throw new Error("Web image import receipt provenance mismatch");
      }
      if (!result.ok) throw new Error(result.message);
      const bytes = [...result.payloads.values()].reduce((sum, payload) => sum + payload.byteLength, 0);
      if (bytes > 48 * MiB) throw new RangeError("Web image output exceeds its admitted receipt capacity");
      release({ total: bytes, ready: bytes, encoded: 0 });
      handedOff = true;
      return { ...result, release };
    } finally {
      if (!handedOff) release();
    }
  }

  registerLocalImagePayloads(
    session: string,
    directory: ImageTextureDirectory,
    payloads: ReadonlyMap<string, ArrayBuffer>
  ): void {
    this.#registerImageDirectory(session, directory);
    for (const item of directory.items) {
      if (payloads.get(item.sha256)?.byteLength !== item.bytes)
        throw new Error("Local replay payload domain mismatch");
    }
    const bytes = [...payloads.values()].reduce((sum, value) => sum + value.byteLength, 0);
    if (this.#localImagePayloads.has(directory)) throw new Error("Local replay already registered");
    if (this.#localReplayBytes + bytes > 64 * MiB)
      throw new RangeError("Local image replay capacity exceeded");
    this.#localReplayBytes += bytes;
    this.#localImagePayloads.set(directory, payloads);
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

  evidence() {
    return {
      ...this.#pool.evidence(),
      encodedBytes: this.#encodedBytes,
      ioMs: this.#ioMs,
      busyMs: this.#busyMs,
      ranges: this.#ranges,
      sessions: this.#sessions.size,
      credit: this.#credit.evidence(),
      imageDirectoryBytes: this.#imageDirectoryBytes,
      localImageReplayBytes: this.#localReplayBytes,
      decodedImageCacheBytes: this.#decodedImageBytes,
      decodedImageCacheHits: this.#decodedImageHits,
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
    clearTimeout(this.#decodedImageTimer);
    this.#decodedImageTimer = undefined;
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
    return { version: 3, session, epoch: 1, task: ++this.#task };
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

import { buildGlbSceneCatalog, type GlbByteRange, type GlbCookPrimitive, type GlbSceneCatalog } from "../../loaders/gltf/streaming/GlbSceneCatalog.js";
import { openGlbRangeSource, type GlbRangeReadableSource, type GlbRangeSourceOptions } from "../../loaders/gltf/streaming/GlbRangeSource.js";
import { decodeGeometryProductDescriptorBinaryV1 } from "../geometry-product/GeometryProductBinaryV1.js";
import { OEGPACK_V3_ASSET_STRIDE } from "../GeometryAbiV3.js";
import { WebCookSessionProtocol, WEB_COOK_PAGE_BYTES, WEB_COOK_PROTOCOL_VERSION, type WebCookBootstrapOptions, type WebCookBudgets, type WebCookEvent, type WebCookRuntimeProfile } from "./protocol/CookSessionProtocol.js";

export interface WebCookUnitContext {
  readonly source: GlbRangeReadableSource;
  readonly catalog: GlbSceneCatalog;
  readonly signal: AbortSignal;
  /** Priority-selected units allowed to form the first complete Product cut. */
  readonly bootstrapUnits?: readonly GlbCookPrimitive[];
  /** Stable catalog indices matching bootstrapUnits. */
  readonly bootstrapAssetIndices?: readonly number[];
  readRange(range: { readonly bufferIndex: number; readonly byteOffset: number; readonly byteLength: number }): Promise<ArrayBuffer>;
}

export interface WebCookProductPage {
  readonly pageId: number;
  readonly decodedHash128: Uint8Array;
  readonly decodedPageHash128: Uint8Array;
  readonly bytes: ArrayBuffer;
}

export interface WebCookProductRevision {
  readonly descriptor: ArrayBuffer;
  readonly productId: Uint8Array;
  readonly revision: number;
  readonly pageCount: number;
  /** Catalog primitive indices represented by this revision's asset table. */
  readonly sceneAssetIndices?: readonly number[];
  readPage(pageId: number): Promise<WebCookProductPage>;
  release(): void;
}

/**
 * The cooker is deliberately a pure producer. It may be backed by WASM in a
 * dedicated Worker, but it never receives a GPU object or performs publication.
 */
export interface WebRuntimeCooker {
  cookBootstrap(unit: GlbCookPrimitive, context: WebCookUnitContext): Promise<WebCookProductRevision>;
  /** Optional whole-source entry. Producers use this to publish one immutable Product cut. */
  cookBootstrapBatch?(units: readonly GlbCookPrimitive[], context: WebCookUnitContext): Promise<WebCookProductRevision>;
  /**
   * Optional progressive entry. The producer offers each immutable revision
   * through `onRevision` in activation order (coarse bootstrap first, richer
   * replacement later) and reports non-fatal refinement failures through
   * `onFailure` so the resident bootstrap keeps rendering.
   */
  cookProgressive?(
    units: readonly GlbCookPrimitive[],
    context: WebCookUnitContext,
    onRevision: (revision: WebCookProductRevision) => Promise<void>,
    onFailure?: (error: Error) => void
  ): Promise<void>;
}

export interface WebCookCoordinatorOptions {
  readonly budgets: WebCookBudgets;
  readonly runtimeProfile?: WebCookRuntimeProfile;
  readonly recipe?: Readonly<Record<string, unknown>>;
  readonly source?: GlbRangeSourceOptions;
  readonly cooker: WebRuntimeCooker;
  /** Invoked after each queued session event so the Worker can flush before awaiting output credit. */
  readonly onEvent?: () => void;
  /** Explicit unit count for the first Product cut; overrides the automatic selection. */
  readonly bootstrapUnitCount?: number;
  /** Explicit source-byte cap for the first cut; the full refinement is separately bounded by the cooker. */
  readonly bootstrapMaxSourceBytes?: number;
  /** Optional automatic selector. When present it chooses the first cut; the byte cap still applies. */
  readonly selectBootstrap?: (catalog: GlbSceneCatalog) => readonly GlbCookPrimitive[];
}

export interface WebCookCoordinatorEvidence {
  readonly state: "idle" | "opening" | "cooking" | "complete" | "cancelled" | "failed" | "disposed";
  readonly sessionGeneration: number;
  readonly catalogPrimitives: number;
  readonly completedUnits: number;
  readonly emittedPages: number;
  readonly sourceBytes: number;
  readonly peakUnitBytes: number;
  readonly bootstrapUnits: number;
  readonly bootstrapSourceBytes: number;
  readonly refinementSourceBytes: number;
  readonly firstRevisionMs?: number;
  readonly failure?: string;
}

/** Coordinates bounded GLB metadata/cook work and exposes protocol events. */
export class WebCookCoordinator {
  readonly #options: WebCookCoordinatorOptions;
  readonly #session: WebCookSessionProtocol;
  readonly #abort = new AbortController();
  #state: WebCookCoordinatorEvidence["state"] = "idle";
  #source: GlbRangeReadableSource | undefined;
  #catalog: GlbSceneCatalog | undefined;
  #completedUnits = 0;
  #emittedPages = 0;
  #peakUnitBytes = 0;
  #failure: string | undefined;
  #bootstrapUnits = 0;
  #bootstrapSourceBytes = 0;
  #refinementSourceBytes = 0;
  #firstRevisionAt: number | undefined;
  #cookStartedAt = 0;
  readonly #sourcePriorities = new Map<string, { readonly score: number; readonly cameraHintRevision: number }>();
  readonly #liveRevisions: WebCookProductRevision[] = [];
  /** Revisions whose activation cut finished streaming; those pages re-emit. */
  readonly #activationStreamed = new Map<string, boolean>();
  readonly #creditWaiters = new Set<() => void>();
  #emitTail: Promise<void> = Promise.resolve();

  constructor(readonly sessionId: string, sessionGeneration: number, options: WebCookCoordinatorOptions) {
    this.#options = options;
    this.#session = new WebCookSessionProtocol(sessionId, sessionGeneration);
    this.#session.accept({ protocolVersion: WEB_COOK_PROTOCOL_VERSION, sessionId, sessionGeneration, type: "CreateSession", runtimeProfile: options.runtimeProfile ?? "portable-single", recipe: options.recipe ?? {}, budgets: options.budgets });
  }

  get catalog(): GlbSceneCatalog | undefined { return this.#catalog; }
  get source(): GlbRangeReadableSource | undefined { return this.#source; }

  async open(url: string): Promise<GlbSceneCatalog> {
    this.requireState("idle");
    this.#state = "opening";
    try {
      const source = await openGlbRangeSource(url, this.#options.source);
      this.#source = source;
      if (source.byteLength > this.#options.budgets.maxSourceBytes) throw new Error(`GLB source exceeds maxSourceBytes=${this.#options.budgets.maxSourceBytes}`);
      this.#catalog = buildGlbSceneCatalog(source);
      this.#session.accept(this.header({ type: "OpenSource", source: { url: source.sourceIdentity.finalUrl, byteLength: source.byteLength, identityHash: source.sourceIdentity.hash.slice() } }));
      this.#session.emit(this.header({ type: "SceneCatalogReady", catalog: {
        schemaVersion: this.#catalog.schemaVersion,
        primitiveCount: this.#catalog.primitives.length,
        sourceBytes: this.#catalog.sourceBytes,
        sourceTransferMode: source.transferMode,
        sourceIdentityHash: this.#catalog.sourceIdentityHash.slice(),
        // Scene metadata is JSON-only and therefore safe to transfer before
        // any geometry page is copied out of the Worker.
        scenes: this.#catalog.scenes.slice(),
        instances: this.#catalog.instances.map(instance => ({ nodeIndex: instance.nodeIndex, meshIndex: instance.meshIndex, worldMatrix: Array.from(instance.worldMatrix) })),
        primitives: this.#catalog.primitives.map((primitive, index) => ({ assetKey: primitiveKey(primitive), catalogIndex: index, nodeIndex: primitive.nodeIndex, instanceNodeIndices: primitive.instanceNodeIndices.slice(), meshIndex: primitive.meshIndex, primitiveIndex: primitive.primitiveIndex, materialIndex: primitive.materialIndex, material: primitive.material, attributeSemantics: Object.keys(primitive.attributes), vertexCount: primitive.vertexCount, triangleCount: primitive.triangleCount, boundsMin: primitive.boundsMin.slice(), boundsMax: primitive.boundsMax.slice(), boundsSphere: primitive.boundsSphere.slice() })),
        textures: this.#catalog.textures.map(texture => ({ textureIndex: texture.textureIndex, sourceIndex: texture.sourceIndex, sampler: { ...texture.sampler } })),
        images: this.#catalog.images.map(image => ({ imageIndex: image.imageIndex, ...(image.mimeType === undefined ? {} : { mimeType: image.mimeType }), ...(image.uri === undefined ? {} : { uri: image.uri }), ...(image.bufferView === undefined ? {} : { bufferView: { ...image.bufferView } }) }))
      } }));
      this.#state = "cooking";
      return this.#catalog;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async cookBootstrap(): Promise<void> {
    if (this.#state !== "cooking") throw new Error(`WebCookCoordinator cannot cook from '${this.#state}'`);
    this.#cookStartedAt = Date.now();
    try {
      const source = this.#source!, catalog = this.#catalog!;
      const units = [...catalog.primitives].sort((left, right) => this.priorityFor(right) - this.priorityFor(left) || comparePrimitiveOrder(left, right));
      const bootstrapUnits = this.selectBootstrapUnits(units);
      const catalogIndex = new Map(catalog.primitives.map((unit, index) => [primitiveKey(unit), index]));
      const bootstrapAssetIndices = bootstrapUnits.map(unit => catalogIndex.get(primitiveKey(unit))!);
      this.#bootstrapUnits = bootstrapUnits.length;
      this.#bootstrapSourceBytes = estimateSourceBytes(bootstrapUnits);
      this.#refinementSourceBytes = estimateSourceBytes(units);
      // The automatic selection is bounded by its own byte cap even when the
      // caller did not configure one; an explicit count stays caller-governed.
      if (this.#options.bootstrapUnitCount === undefined && this.#bootstrapSourceBytes > DEFAULT_BOOTSTRAP_SOURCE_BYTES) {
        throw new Error(`automatic visible-first bootstrap exceeds ${DEFAULT_BOOTSTRAP_SOURCE_BYTES} bytes`);
      }
      if (this.#options.bootstrapMaxSourceBytes !== undefined && this.#bootstrapSourceBytes > this.#options.bootstrapMaxSourceBytes) {
        throw new Error(`visible-first bootstrap source exceeds bootstrapMaxSourceBytes=${this.#options.bootstrapMaxSourceBytes}`);
      }
      const progressive = this.#options.cooker.cookProgressive;
      if (progressive) {
        const context: WebCookUnitContext = Object.freeze({ source, catalog, signal: this.#abort.signal, bootstrapUnits, bootstrapAssetIndices, readRange: (range: GlbByteRange) => source.readBufferRange(range.bufferIndex, range.byteOffset, range.byteLength, this.#abort.signal) });
        this.#peakUnitBytes = Math.max(this.#peakUnitBytes, this.#bootstrapSourceBytes);
        if (this.#bootstrapSourceBytes > this.#options.budgets.maxWasmBytes) throw new Error(`bootstrap cook source exceeds maxWasmBytes=${this.#options.budgets.maxWasmBytes}`);
        // The refinement is one opaque cooker call that can run for seconds, so a
        // revision is not a fine-grained progress signal. Heartbeat real elapsed
        // time while it runs: the UI can then show the cook is still alive
        // instead of freezing at "0.4" until the replacement lands.
        const heartbeat = this.#startProgressHeartbeat(units.length);
        try {
          await progressive.call(this.#options.cooker, units, context, async (revision) => {
            this.validateRevision(revision);
            this.#liveRevisions.push(revision);
            const descriptor = decodeGeometryProductDescriptorBinaryV1(revision.descriptor);
            this.#completedUnits = revision.revision === 0 ? bootstrapUnits.length : units.length;
            if (this.#firstRevisionAt === undefined) this.#firstRevisionAt = Date.now() - this.#cookStartedAt;
            this.publish(this.header({ type: "RevisionOffered", descriptor: revision.descriptor, ...(revision.sceneAssetIndices === undefined ? {} : { sceneAssetIndices: Uint32Array.from(revision.sceneAssetIndices) }) }));
            for (const pageId of descriptor.activationPageIds) await this.emitPage(revision, pageId);
            this.markActivationStreamed(revision);
            this.publish(this.header({ type: "Progress", stage: revision.revision === 0 ? "bootstrap" : "refinement", units: this.#completedUnits, bytes: revision.revision === 0 ? this.#bootstrapSourceBytes : this.#refinementSourceBytes, timings: {} }));
          }, (error) => {
            this.publish(this.header({ type: "RecoverableFailure", scope: "richer-product-revision", code: error.message, retryAfterMs: 0 }));
          });
        } finally {
          heartbeat();
        }
        this.#state = "complete";
        return;
      }
      const batchCooker = this.#options.cooker.cookBootstrapBatch;
      if (batchCooker) {
        const context: WebCookUnitContext = Object.freeze({ source, catalog, signal: this.#abort.signal, bootstrapUnits, bootstrapAssetIndices, readRange: (range: GlbByteRange) => source.readBufferRange(range.bufferIndex, range.byteOffset, range.byteLength, this.#abort.signal) });
        const estimated = this.#bootstrapSourceBytes;
        this.#peakUnitBytes = Math.max(this.#peakUnitBytes, estimated);
        if (estimated > this.#options.budgets.maxWasmBytes) throw new Error(`cook source exceeds maxWasmBytes=${this.#options.budgets.maxWasmBytes}`);
        const revision = await batchCooker.call(this.#options.cooker, bootstrapUnits, context);
        this.validateRevision(revision);
        this.#liveRevisions.push(revision);
        const descriptor = decodeGeometryProductDescriptorBinaryV1(revision.descriptor);
        this.#completedUnits = bootstrapUnits.length;
        this.#firstRevisionAt = Date.now() - this.#cookStartedAt;
        this.publish(this.header({ type: "RevisionOffered", descriptor: revision.descriptor, ...(revision.sceneAssetIndices === undefined ? {} : { sceneAssetIndices: Uint32Array.from(revision.sceneAssetIndices) }) }));
        for (const pageId of descriptor.activationPageIds) await this.emitPage(revision, pageId);
        this.markActivationStreamed(revision);
        this.publish(this.header({ type: "Progress", stage: "bootstrap", units: this.#completedUnits, bytes: estimated, timings: {} }));
        this.#state = "complete";
        return;
      }
      // A non-progressive producer is an explicit bootstrap-only fallback. It
      // cannot safely publish one Product per unit because those revisions have
      // no replacement/scene identity contract for a partial catalog.
      if (units.length > bootstrapUnits.length) throw new Error("Web Cook producer must implement cookProgressive for multi-unit visible-first loading");
      const concurrency = Math.min(this.#options.budgets.maxConcurrentWorkers, bootstrapUnits.length);
      for (let begin = 0; begin < bootstrapUnits.length; begin += concurrency) {
        if (this.#abort.signal.aborted) throw this.#abort.signal.reason ?? new Error("Web Cook was cancelled");
        const batch = bootstrapUnits.slice(begin, begin + concurrency);
        const cooked = await Promise.all(batch.map(async unit => {
          const context: WebCookUnitContext = Object.freeze({ source, catalog, signal: this.#abort.signal, bootstrapUnits, bootstrapAssetIndices, readRange: (range: GlbByteRange) => source.readBufferRange(range.bufferIndex, range.byteOffset, range.byteLength, this.#abort.signal) });
          const estimated = unit.ranges.reduce((sum, range) => sum + range.byteLength, 0);
          this.#peakUnitBytes = Math.max(this.#peakUnitBytes, estimated);
          if (estimated > this.#options.budgets.maxWasmBytes) throw new Error(`cook unit exceeds maxWasmBytes=${this.#options.budgets.maxWasmBytes}`);
          const revision = await this.#options.cooker.cookBootstrap(unit, context);
          this.validateRevision(revision);
          return { revision, estimated };
        }));
        for (const { revision, estimated } of cooked) {
          const descriptor = decodeGeometryProductDescriptorBinaryV1(revision.descriptor);
          this.#liveRevisions.push(revision);
          this.publish(this.header({ type: "RevisionOffered", descriptor: revision.descriptor, ...(revision.sceneAssetIndices === undefined ? {} : { sceneAssetIndices: Uint32Array.from(revision.sceneAssetIndices) }) }));
          for (const pageId of descriptor.activationPageIds) await this.emitPage(revision, pageId);
          this.markActivationStreamed(revision);
          this.#completedUnits++;
          this.#session.emit(this.header({ type: "Progress", stage: "bootstrap", units: this.#completedUnits, bytes: estimated, timings: {} }));
        }
      }
      this.#state = "complete";
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  /**
   * Emits periodic `Progress` heartbeats until the returned stop function runs.
   *
   * The cook's two revisions are the only producer-side milestones, and the
   * refinement between them is opaque: `onRevision` fires only after the whole
   * call returns. The heartbeat therefore reports `#completedUnits` verbatim -
   * the count stays at the bootstrap cut while the refinement runs - and only
   * adds an elapsed timer. Claiming the full unit count here would report work
   * that has not been produced yet.
   */
  #startProgressHeartbeat(totalUnits: number): () => void {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      // Progress is informational, and this runs outside the cook's own error
      // path. A saturated event queue must drop the tick rather than throw from
      // a timer callback, which would fail the whole session.
      try {
        this.publish(this.header({
          type: "Progress",
          stage: "refinement",
          units: this.#completedUnits,
          bytes: this.#refinementSourceBytes,
          timings: Object.freeze({ elapsedMs: Date.now() - startedAt, totalUnits })
        }));
      } catch {
        // The consumer is not draining events; skip this heartbeat.
      }
    }, PROGRESS_HEARTBEAT_MS);
    return () => { clearInterval(timer); };
  }

  /** Records source priority before or during a bounded cook session. */
  setSourcePriority(assetKey: string, score: number, cameraHintRevision: number): void {
    if (this.#state !== "opening" && this.#state !== "cooking") throw new Error(`WebCookCoordinator cannot prioritize from '${this.#state}'`);
    if (!assetKey || !Number.isFinite(score) || !Number.isInteger(cameraHintRevision) || cameraHintRevision < 0) throw new RangeError("Web Cook source priority is invalid");
    this.#sourcePriorities.set(assetKey, Object.freeze({ score, cameraHintRevision }));
  }

  /**
   * Re-reads requested Product pages without mutating the immutable revision.
   *
   * A page the activation loop has not streamed yet stays with that loop, so it
   * is never emitted twice. Once the cut has finished streaming, a request for
   * an activation page means the consumer lost its copy - for example after
   * `abandonForDeviceLoss` released the GPU banks - and it must be re-served.
   */
  async requestPages(productId: Uint8Array, revision: number, pageIds: Uint32Array, _priority: number): Promise<void> {
    if (this.#state !== "cooking" && this.#state !== "complete") throw new Error(`WebCookCoordinator cannot request pages from '${this.#state}'`);
    if (productId.byteLength !== 32 || !Number.isInteger(revision) || revision < 0 || revision === 0xffffffff) throw new RangeError("Web Cook page request identity is invalid");
    const source = this.#liveRevisions.find(candidate => candidate.revision === revision && sameBytes(candidate.productId, productId));
    if (!source) throw new Error("Web Cook page request targets an unknown Product revision");
    const unique = [...new Set(pageIds)].sort((left, right) => left - right);
    const activation = new Set<number>(decodeGeometryProductDescriptorBinaryV1(source.descriptor).activationPageIds);
    const activationStreamed = this.#activationStreamed.get(revisionKey(source.productId, revision)) === true;
    for (const pageId of unique) {
      if (!Number.isInteger(pageId) || pageId < 0 || pageId === 0xffffffff || pageId >= source.pageCount) throw new RangeError("Web Cook page request targets an invalid page");
      if (activation.has(pageId) && !activationStreamed) continue;
      await this.emitPage(source, pageId);
    }
  }

  grantOutputCredits(blockCount: number, bytes: number): void { this.#session.accept(this.header({ type: "GrantOutputCredits", blockCount, bytes })); for (const wake of this.#creditWaiters) wake(); this.#creditWaiters.clear(); }
  returnOutputCredits(blockCount: number, bytes: number): void { this.#session.returnOutputCredits(blockCount, bytes); for (const wake of this.#creditWaiters) wake(); this.#creditWaiters.clear(); }
  drainEvents(maxEvents = Number.MAX_SAFE_INTEGER): WebCookEvent[] { return this.#session.drain(maxEvents); }
  cancel(reason = new Error("Web Cook was cancelled")): void { if (this.#state === "disposed" || this.#state === "complete") return; this.#abort.abort(reason); this.#state = "cancelled"; for (const wake of this.#creditWaiters) wake(); this.#creditWaiters.clear(); this.#session.accept(this.header({ type: "CancelScope", scope: "session" })); }
  dispose(): void { if (this.#state === "disposed") return; this.#abort.abort(new Error("Web Cook session disposed")); for (const revision of this.#liveRevisions.splice(0)) revision.release(); for (const wake of this.#creditWaiters) wake(); this.#creditWaiters.clear(); this.#source?.release(); this.#source = undefined; this.#catalog = undefined; this.#state = "disposed"; this.#session.accept(this.header({ type: "DisposeSession" })); }
  evidence(): WebCookCoordinatorEvidence { return Object.freeze({ state: this.#state, sessionGeneration: this.#session.sessionGeneration, catalogPrimitives: this.#catalog?.primitives.length ?? 0, completedUnits: this.#completedUnits, emittedPages: this.#emittedPages, sourceBytes: this.#source?.byteLength ?? 0, peakUnitBytes: this.#peakUnitBytes, bootstrapUnits: this.#bootstrapUnits, bootstrapSourceBytes: this.#bootstrapSourceBytes, refinementSourceBytes: this.#refinementSourceBytes, ...(this.#firstRevisionAt === undefined ? {} : { firstRevisionMs: this.#firstRevisionAt }), ...(this.#failure === undefined ? {} : { failure: this.#failure }) }); }

  private fail(error: unknown): void { this.#failure = error instanceof Error ? error.message : String(error); this.#state = this.#abort.signal.aborted ? "cancelled" : "failed"; for (const revision of this.#liveRevisions.splice(0)) revision.release(); for (const wake of this.#creditWaiters) wake(); this.#creditWaiters.clear(); this.#session.fail(this.#failure); this.#source?.release(); this.#source = undefined; }
  private validateRevision(revision: WebCookProductRevision): void {
    if (revision.productId.byteLength !== 32 || !Number.isInteger(revision.revision) || revision.revision < 0 || revision.revision === 0xffffffff || !Number.isInteger(revision.pageCount) || revision.pageCount <= 0) throw new Error("Web Cook revision identity/count is invalid");
    const descriptor = decodeGeometryProductDescriptorBinaryV1(revision.descriptor);
    if (descriptor.revision !== revision.revision || !sameBytes(descriptor.productId, revision.productId) || descriptor.pageRecords.byteLength / 32 !== revision.pageCount) throw new Error("Web Cook descriptor and revision identity/count disagree");
    if (revision.sceneAssetIndices !== undefined) {
      const assetCount = descriptor.assetRecords.byteLength / OEGPACK_V3_ASSET_STRIDE;
      if (revision.sceneAssetIndices.length !== assetCount || new Set(revision.sceneAssetIndices).size !== assetCount || revision.sceneAssetIndices.some(index => !Number.isSafeInteger(index) || index < 0)) throw new Error("Web Cook revision sceneAssetIndices are invalid");
    }
  }
  private priorityFor(unit: GlbCookPrimitive): number {
    const keys = [`${unit.nodeIndex}:${unit.meshIndex}:${unit.primitiveIndex}`, `${unit.meshIndex}:${unit.primitiveIndex}`, `${unit.nodeIndex}`];
    let score = 0;
    for (const key of keys) score = Math.max(score, this.#sourcePriorities.get(key)?.score ?? 0);
    return score;
  }
  private selectBootstrapUnits(units: readonly GlbCookPrimitive[]): readonly GlbCookPrimitive[] {
    const custom = this.#options.selectBootstrap;
    const configured = custom ? undefined : this.#options.bootstrapUnitCount;
    if (configured !== undefined && (!Number.isSafeInteger(configured) || configured <= 0)) throw new RangeError("bootstrapUnitCount must be a positive safe integer");
    const maxBytes = this.#options.bootstrapMaxSourceBytes;
    // An explicit unit count keeps the original "first N priority units"
    // contract so a caller can still pin an exact cut.
    const candidates = configured !== undefined
      ? units.slice(0, configured)
      : custom
        ? [...custom(this.#catalog!)].sort(comparePrimitiveOrder)
        : defaultBootstrapSelection(units);
    const selected: GlbCookPrimitive[] = [];
    for (const unit of candidates) {
      const nextBytes = estimateSourceBytes([...selected, unit]);
      if (maxBytes !== undefined && nextBytes > maxBytes) {
        if (selected.length === 0) throw new Error(`visible-first bootstrap source exceeds bootstrapMaxSourceBytes=${maxBytes}`);
        break;
      }
      selected.push(unit);
    }
    if (selected.length === 0) throw new Error("Web Cook catalog contains no bootstrap unit");
    return Object.freeze(selected);
  }
  private emitPage(revision: WebCookProductRevision, pageId: number): Promise<void> {
    // Activation streaming and RequestPages can both emit; serialize so credit
    // accounting and PageReady publication stay atomic.
    const run = this.#emitTail.then(() => this.emitPageNow(revision, pageId));
    this.#emitTail = run.catch(() => undefined);
    return run;
  }
  private async emitPageNow(revision: WebCookProductRevision, pageId: number): Promise<void> {
    await this.waitForOutputCredit(WEB_COOK_PAGE_BYTES);
    if (this.#abort.signal.aborted) throw this.#abort.signal.reason ?? new Error("Web Cook was cancelled");
    const page = await revision.readPage(pageId);
    if (page.pageId !== pageId || page.bytes.byteLength !== WEB_COOK_PAGE_BYTES) throw new Error("Web Cook producer returned the wrong page");
    if (!this.publish(this.header({ type: "PageReady", productId: revision.productId.slice(), revision: revision.revision, pageId, decodedHash128: page.decodedHash128, decodedPageHash128: page.decodedPageHash128, bytes: page.bytes }))) throw new Error("Web Cook output credit changed before PageReady emission");
    this.#emittedPages++;
  }
  /** Marks the activation cut of one revision fully streamed and re-readable. */
  private markActivationStreamed(revision: WebCookProductRevision): void {
    this.#activationStreamed.set(revisionKey(revision.productId, revision.revision), true);
  }
  private async waitForOutputCredit(bytes: number): Promise<void> {
    while (!this.#session.canEmitPage(bytes)) {
      if (this.#abort.signal.aborted || this.#state === "disposed" || this.#state === "failed") throw this.#abort.signal.reason ?? new Error("Web Cook stopped while awaiting output credit");
      await new Promise<void>(resolve => this.#creditWaiters.add(resolve));
    }
  }
  private requireState(state: WebCookCoordinatorEvidence["state"]): void { if (this.#state !== state) throw new Error(`WebCookCoordinator expected state '${state}', got '${this.#state}'`); }
  private publish(event: WebCookEvent): boolean {
    const accepted = this.#session.emit(event);
    this.#options.onEvent?.();
    return accepted;
  }
  private header<const T extends Record<string, unknown>>(message: T): T & { protocolVersion: 1; sessionId: string; sessionGeneration: number } { return Object.assign({ protocolVersion: WEB_COOK_PROTOCOL_VERSION as 1, sessionId: this.sessionId, sessionGeneration: this.#session.sessionGeneration }, message); }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean { if (left.byteLength !== right.byteLength) return false; for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false; return true; }
function revisionKey(productId: Uint8Array, revision: number): string { return `${Array.from(productId, (value) => value.toString(16).padStart(2, "0")).join("")}:${revision}`; }
function estimateSourceBytes(units: readonly GlbCookPrimitive[]): number {
  const ranges = new Map<string, GlbByteRange>();
  for (const unit of units) for (const range of unit.ranges) ranges.set(`${range.bufferIndex}:${range.byteOffset}:${range.byteLength}`, range);
  return [...ranges.values()].reduce((sum, range) => sum + range.byteLength, 0);
}

function primitiveKey(unit: GlbCookPrimitive): string { return `${unit.nodeIndex}:${unit.meshIndex}:${unit.primitiveIndex}`; }
function comparePrimitiveOrder(left: GlbCookPrimitive, right: GlbCookPrimitive): number { return left.nodeIndex - right.nodeIndex || left.meshIndex - right.meshIndex || left.primitiveIndex - right.primitiveIndex; }

/**
 * Bounded budget for the automatic first cut. The bootstrap revision only needs
 * to make the scene legible while refinement converges, so it is capped by both
 * a primitive count and the canonical source it may pull.
 */
const DEFAULT_BOOTSTRAP_UNIT_LIMIT = 24;
const DEFAULT_BOOTSTRAP_SOURCE_BYTES = 16 * 1024 * 1024;
/** Cadence for elapsed-time progress heartbeats during an opaque cook stage. */
const PROGRESS_HEARTBEAT_MS = 250;

/**
 * Chooses the automatic first cut.
 *
 * The catalog is ordered by node/mesh/primitive, which has no relation to
 * visibility: node 0 can be a single pillar while the surrounding level lives in
 * later nodes. Ordering by spatial coverage instead makes the first frame carry
 * the scene's extent rather than one arbitrary primitive. Units whose glTF
 * POSITION bounds are unavailable are treated as worst-case coverage and sorted
 * last by catalog order, which keeps legacy assets deterministic.
 */
function defaultBootstrapSelection(units: readonly GlbCookPrimitive[]): readonly GlbCookPrimitive[] {
  if (units.length <= DEFAULT_BOOTSTRAP_UNIT_LIMIT) return units;
  const ranked = units.map((unit, index) => ({ unit, index, coverage: bootstrapCoverage(unit) }));
  ranked.sort((left, right) => right.coverage - left.coverage || left.index - right.index);
  const selected = ranked.slice(0, DEFAULT_BOOTSTRAP_UNIT_LIMIT).map(entry => entry.unit);
  selected.sort(comparePrimitiveOrder);
  return selected;
}

function bootstrapCoverage(unit: GlbCookPrimitive): number {
  const min = unit.boundsMin, max = unit.boundsMax;
  // POSITION min/max are optional in glTF. Missing bounds mean unknown extent,
  // not zero extent, so they must never outrank a measured primitive.
  for (let axis = 0; axis < 3; axis++) {
    const low = min[axis]!, high = max[axis]!;
    if (!Number.isFinite(low) || !Number.isFinite(high) || high < low) return -1;
  }
  const extent = Math.max(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!);
  if (!(extent > 0)) return 0;
  return extent * unit.instanceNodeIndices.length;
}

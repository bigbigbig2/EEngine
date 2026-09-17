import { buildGlbSceneCatalog, type GlbByteRange, type GlbCookPrimitive, type GlbSceneCatalog } from "../../loaders/gltf/streaming/GlbSceneCatalog.js";
import { openGlbRangeSource, type GlbRangeReadableSource, type GlbRangeSourceOptions } from "../../loaders/gltf/streaming/GlbRangeSource.js";
import { decodeGeometryProductDescriptorBinaryV1 } from "../geometry-product/GeometryProductBinaryV1.js";
import { WebCookSessionProtocol, WEB_COOK_PAGE_BYTES, WEB_COOK_PROTOCOL_VERSION, type WebCookBudgets, type WebCookEvent, type WebCookRuntimeProfile } from "./protocol/CookSessionProtocol.js";

export interface WebCookUnitContext {
  readonly source: GlbRangeReadableSource;
  readonly catalog: GlbSceneCatalog;
  readonly signal: AbortSignal;
  readRange(range: { readonly bufferIndex: number; readonly byteOffset: number; readonly byteLength: number }): Promise<ArrayBuffer>;
}

export interface WebCookProductPage {
  readonly pageId: number;
  readonly decodedHash128: Uint8Array;
  readonly bytes: ArrayBuffer;
}

export interface WebCookProductRevision {
  readonly descriptor: ArrayBuffer;
  readonly productId: Uint8Array;
  readonly revision: number;
  readonly pageCount: number;
  readPage(pageId: number): Promise<WebCookProductPage>;
  release(): void;
}

/**
 * The cooker is deliberately a pure producer. It may be backed by WASM in a
 * dedicated Worker, but it never receives a GPU object or performs publication.
 */
export interface WebRuntimeCooker {
  cookBootstrap(unit: GlbCookPrimitive, context: WebCookUnitContext): Promise<WebCookProductRevision>;
}

export interface WebCookCoordinatorOptions {
  readonly budgets: WebCookBudgets;
  readonly runtimeProfile?: WebCookRuntimeProfile;
  readonly recipe?: Readonly<Record<string, unknown>>;
  readonly source?: GlbRangeSourceOptions;
  readonly cooker: WebRuntimeCooker;
}

export interface WebCookCoordinatorEvidence {
  readonly state: "idle" | "opening" | "cooking" | "complete" | "cancelled" | "failed" | "disposed";
  readonly sessionGeneration: number;
  readonly catalogPrimitives: number;
  readonly completedUnits: number;
  readonly emittedPages: number;
  readonly sourceBytes: number;
  readonly peakUnitBytes: number;
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
  readonly #liveRevisions: WebCookProductRevision[] = [];
  readonly #creditWaiters = new Set<() => void>();

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
      this.#session.emit(this.header({ type: "SceneCatalogReady", catalog: { schemaVersion: this.#catalog.schemaVersion, primitiveCount: this.#catalog.primitives.length, sourceBytes: this.#catalog.sourceBytes, sourceIdentityHash: this.#catalog.sourceIdentityHash.slice() } }));
      this.#state = "cooking";
      return this.#catalog;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async cookBootstrap(): Promise<void> {
    if (this.#state !== "cooking") throw new Error(`WebCookCoordinator cannot cook from '${this.#state}'`);
    try {
      const source = this.#source!, catalog = this.#catalog!;
      for (const unit of catalog.primitives) {
        if (this.#abort.signal.aborted) throw this.#abort.signal.reason ?? new Error("Web Cook was cancelled");
        const context: WebCookUnitContext = Object.freeze({ source, catalog, signal: this.#abort.signal, readRange: (range: GlbByteRange) => source.readBufferRange(range.bufferIndex, range.byteOffset, range.byteLength, this.#abort.signal) });
        const estimated = unit.ranges.reduce((sum, range) => sum + range.byteLength, 0);
        this.#peakUnitBytes = Math.max(this.#peakUnitBytes, estimated);
        if (estimated > this.#options.budgets.maxWasmBytes) throw new Error(`cook unit exceeds maxWasmBytes=${this.#options.budgets.maxWasmBytes}`);
        const revision = await this.#options.cooker.cookBootstrap(unit, context);
        this.validateRevision(revision);
        const descriptor = decodeGeometryProductDescriptorBinaryV1(revision.descriptor);
        this.#liveRevisions.push(revision);
        this.#session.emit(this.header({ type: "RevisionOffered", descriptor: revision.descriptor }));
        for (const pageId of descriptor.activationPageIds) await this.emitPage(revision, pageId);
        this.#completedUnits++;
        this.#session.emit(this.header({ type: "Progress", stage: "bootstrap", units: this.#completedUnits, bytes: estimated, timings: {} }));
      }
      this.#state = "complete";
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  grantOutputCredits(blockCount: number, bytes: number): void { this.#session.accept(this.header({ type: "GrantOutputCredits", blockCount, bytes })); for (const wake of this.#creditWaiters) wake(); this.#creditWaiters.clear(); }
  returnOutputCredits(blockCount: number, bytes: number): void { this.#session.returnOutputCredits(blockCount, bytes); for (const wake of this.#creditWaiters) wake(); this.#creditWaiters.clear(); }
  drainEvents(maxEvents = Number.MAX_SAFE_INTEGER): WebCookEvent[] { return this.#session.drain(maxEvents); }
  cancel(reason = new Error("Web Cook was cancelled")): void { if (this.#state === "disposed" || this.#state === "complete") return; this.#abort.abort(reason); this.#state = "cancelled"; for (const wake of this.#creditWaiters) wake(); this.#creditWaiters.clear(); this.#session.accept(this.header({ type: "CancelScope", scope: "session" })); }
  dispose(): void { if (this.#state === "disposed") return; this.#abort.abort(new Error("Web Cook session disposed")); for (const revision of this.#liveRevisions.splice(0)) revision.release(); for (const wake of this.#creditWaiters) wake(); this.#creditWaiters.clear(); this.#source?.release(); this.#source = undefined; this.#catalog = undefined; this.#state = "disposed"; this.#session.accept(this.header({ type: "DisposeSession" })); }
  evidence(): WebCookCoordinatorEvidence { return Object.freeze({ state: this.#state, sessionGeneration: this.#session.sessionGeneration, catalogPrimitives: this.#catalog?.primitives.length ?? 0, completedUnits: this.#completedUnits, emittedPages: this.#emittedPages, sourceBytes: this.#source?.byteLength ?? 0, peakUnitBytes: this.#peakUnitBytes, ...(this.#failure === undefined ? {} : { failure: this.#failure }) }); }

  private fail(error: unknown): void { this.#failure = error instanceof Error ? error.message : String(error); this.#state = this.#abort.signal.aborted ? "cancelled" : "failed"; for (const revision of this.#liveRevisions.splice(0)) revision.release(); for (const wake of this.#creditWaiters) wake(); this.#creditWaiters.clear(); this.#session.fail(this.#failure); this.#source?.release(); this.#source = undefined; }
  private validateRevision(revision: WebCookProductRevision): void {
    if (revision.productId.byteLength !== 32 || !Number.isInteger(revision.revision) || revision.revision < 0 || revision.revision === 0xffffffff || !Number.isInteger(revision.pageCount) || revision.pageCount <= 0) throw new Error("Web Cook revision identity/count is invalid");
    const descriptor = decodeGeometryProductDescriptorBinaryV1(revision.descriptor);
    if (descriptor.revision !== revision.revision || !sameBytes(descriptor.productId, revision.productId) || descriptor.pageRecords.byteLength / 32 !== revision.pageCount) throw new Error("Web Cook descriptor and revision identity/count disagree");
  }
  private async emitPage(revision: WebCookProductRevision, pageId: number): Promise<void> {
    await this.waitForOutputCredit(WEB_COOK_PAGE_BYTES);
    if (this.#abort.signal.aborted) throw this.#abort.signal.reason ?? new Error("Web Cook was cancelled");
    const page = await revision.readPage(pageId);
    if (page.pageId !== pageId || page.bytes.byteLength !== WEB_COOK_PAGE_BYTES) throw new Error("Web Cook producer returned the wrong page");
    if (!this.#session.emit(this.header({ type: "PageReady", productId: revision.productId.slice(), revision: revision.revision, pageId, decodedHash128: page.decodedHash128, bytes: page.bytes }))) throw new Error("Web Cook output credit changed before PageReady emission");
    this.#emittedPages++;
  }
  private async waitForOutputCredit(bytes: number): Promise<void> {
    while (!this.#session.canEmitPage(bytes)) {
      if (this.#abort.signal.aborted || this.#state === "disposed" || this.#state === "failed") throw this.#abort.signal.reason ?? new Error("Web Cook stopped while awaiting output credit");
      await new Promise<void>(resolve => this.#creditWaiters.add(resolve));
    }
  }
  private requireState(state: WebCookCoordinatorEvidence["state"]): void { if (this.#state !== state) throw new Error(`WebCookCoordinator expected state '${state}', got '${this.#state}'`); }
  private header<const T extends Record<string, unknown>>(message: T): T & { protocolVersion: 1; sessionId: string; sessionGeneration: number } { return Object.assign({ protocolVersion: WEB_COOK_PROTOCOL_VERSION as 1, sessionId: this.sessionId, sessionGeneration: this.#session.sessionGeneration }, message); }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean { if (left.byteLength !== right.byteLength) return false; for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false; return true; }

import type { GeometryProductProviderV1, GeometryProductRevisionSourceV1 } from "../geometry-product/GeometryProductV1.js";
import type { WebCookBudgetEvidence, WebCookBudgetLease, WebCookBudgetLedger } from "./WebCookBudget.js";
import {
  WEB_COOK_PAGE_BYTES,
  WEB_COOK_PROTOCOL_VERSION,
  type WebCookBootstrapOptions,
  type WebCookBudgets,
  type WebCookCommand,
  type WebCookRuntimeProfile
} from "./protocol/CookSessionProtocol.js";
import { WebCookProductProvider, type WebCookProductProviderEvidence } from "./WebCookProductProvider.js";
import { WebCookWorkerTransport, type WebCookWorkerPort, type WebCookWorkerTransportEvidence } from "./WebCookWorkerTransport.js";
import type { GlbRangeSourceOptions } from "../../loaders/gltf/streaming/GlbRangeSource.js";

export interface WebCookSceneCatalogSnapshot {
  readonly schemaVersion: 1;
  readonly primitiveCount: number;
  readonly sourceBytes: number;
  readonly sourceTransferMode: "range" | "whole-source-fallback";
  readonly sourceIdentityHash: Uint8Array;
  readonly scenes: readonly number[];
  readonly instances: readonly {
    readonly nodeIndex: number;
    readonly meshIndex: number;
    readonly worldMatrix: readonly number[];
  }[];
  readonly primitives: readonly {
    readonly assetKey: string;
    readonly catalogIndex: number;
    readonly nodeIndex: number;
    readonly instanceNodeIndices: readonly number[];
    readonly meshIndex: number;
    readonly primitiveIndex: number;
    readonly materialIndex: number;
    readonly material: Readonly<Record<string, unknown>>;
    readonly attributeSemantics: readonly string[];
    readonly vertexCount: number;
    readonly triangleCount: number;
    readonly boundsMin: readonly number[];
    readonly boundsMax: readonly number[];
    readonly boundsSphere: readonly number[];
  }[];
  readonly textures: readonly {
    readonly textureIndex: number;
    readonly sourceIndex: number;
    readonly sampler: Readonly<{ magFilter?: number; minFilter?: number; wrapS?: number; wrapT?: number }>;
  }[];
  readonly images: readonly {
    readonly imageIndex: number;
    readonly mimeType?: string;
    readonly uri?: string;
    readonly bufferView?: Readonly<{ bufferIndex: number; byteOffset: number; byteLength: number }>;
  }[];
}

export interface WebCookClientOptions {
  readonly worker: WebCookWorkerPort;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly budgets: WebCookBudgets;
  readonly runtimeProfile?: WebCookRuntimeProfile;
  readonly recipe?: Readonly<Record<string, unknown>>;
  /** Initial whole-page output ownership granted to the Worker. */
  readonly initialOutputPageCredits: number;
  readonly maxBufferedPages?: number;
  readonly maxBufferedBytes?: number;
  readonly onSceneCatalogReady?: (catalog: WebCookSceneCatalogSnapshot) => void;
  /** Optional page-global ledger that caps sessions and live bytes across clients. */
  readonly ledger?: WebCookBudgetLedger;
  /** Admission priority used when the ledger is saturated. */
  readonly priority?: number;
  /** Applied immediately after catalog metadata arrives, before BIN cooking. */
  readonly initialSourcePriorities?: readonly { readonly assetKey: string; readonly score: number; readonly cameraHintRevision: number }[];
  /** Bounds the first Product cut. Omit both fields to use the automatic selection. */
  readonly bootstrap?: WebCookBootstrapOptions;
  /** Main-thread source options used only for bounded authored-image preflight. */
  readonly source?: GlbRangeSourceOptions;
}

export interface WebCookClientEvidence {
  readonly state: "created" | "open" | "cancelled" | "failed" | "disposed";
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly transport: WebCookWorkerTransportEvidence;
  readonly provider: WebCookProductProviderEvidence;
  readonly catalogReady: boolean;
  readonly progressEvents: number;
  readonly recoverableFailures: number;
  readonly recoverableFailureCodes: readonly string[];
  readonly budget?: WebCookBudgetEvidence;
}

/**
 * Main-thread owner for the browser-first Web Cook session.
 *
 * This class only coordinates a Dedicated Worker and exposes the
 * producer-neutral Product provider. It never parses source data, owns WASM
 * memory, or creates a WebGPU object.
 */
export class WebCookClient implements GeometryProductProviderV1 {
  readonly #transport: WebCookWorkerTransport;
  readonly #provider: WebCookProductProvider;
  readonly #options: WebCookClientOptions;
  #state: WebCookClientEvidence["state"] = "created";
  #providerConsumed = false;
  #catalog: WebCookSceneCatalogSnapshot | undefined;
  #progressEvents = 0;
  #recoverableFailures = 0;
  readonly #recoverableFailureCodes: string[] = [];
  readonly #admission = new AbortController();
  #lease: WebCookBudgetLease | undefined;
  #reservedOutputBytes = 0;
  #reservedSourceBytes = 0;
  #reservedWasmBytes = 0;

  constructor(options: WebCookClientOptions) {
    validateOptions(options);
    this.#options = Object.freeze({ ...options, recipe: Object.freeze({ ...(options.recipe ?? {}) }) });
    this.#transport = new WebCookWorkerTransport(options.worker, options.sessionId, options.sessionGeneration, options.budgets.maxQueuedEvents);
    const maxBufferedPages = options.maxBufferedPages ?? options.initialOutputPageCredits;
    const maxBufferedBytes = options.maxBufferedBytes ?? maxBufferedPages * WEB_COOK_PAGE_BYTES;
    if (maxBufferedPages <= 0 || maxBufferedPages > options.budgets.maxQueuedEvents || maxBufferedBytes < maxBufferedPages * WEB_COOK_PAGE_BYTES || maxBufferedBytes > options.budgets.maxOutputBytes) {
      throw new RangeError("Web Cook client output buffer exceeds the session budget");
    }
    this.#provider = new WebCookProductProvider(this.#transport, {
      maxBufferedPages,
      maxBufferedBytes,
      returnOutputCredits: (blockCount, bytes) => this.#returnOutputCredits(blockCount, bytes),
      onSceneCatalogReady: catalog => {
        this.#catalog = catalog as unknown as WebCookSceneCatalogSnapshot;
        this.#reserveSource(this.#catalog.sourceBytes);
        for (const priority of this.#options.initialSourcePriorities ?? []) this.setSourcePriority(priority.assetKey, priority.score, priority.cameraHintRevision);
        this.#options.onSceneCatalogReady?.(this.#catalog);
      },
      onProgress: () => { this.#progressEvents++; },
      onRecoverableFailure: failure => { this.#recoverableFailures++; this.#recoverableFailureCodes.push(`${failure.scope}:${failure.code}`); },
      onFatal: error => {
        if (this.#state !== "open") return;
        this.#state = "failed";
        this.#releaseBudget();
        this.#transport.close(true);
      },
      requestPage: (productId, revision, pageId) => this.requestPages(productId, revision, new Uint32Array([pageId]), 0)
    });
  }

  get state(): WebCookClientEvidence["state"] { return this.#state; }
  get catalog(): WebCookSceneCatalogSnapshot | undefined { return this.#catalog; }

  /** Starts one bounded GLB source session and grants only whole-page credit. */
  open(url: string): void {
    if (this.#state !== "created") throw new Error(`Web Cook client cannot open from '${this.#state}'`);
    if (!url || typeof url !== "string") throw new TypeError("Web Cook source URL must be a non-empty string");
    this.#state = "open";
    void this.#begin(url);
  }

  /** Waits for the page-global budget when present, then opens the session. */
  async #begin(url: string): Promise<void> {
    try {
      const ledger = this.#options.ledger;
      if (ledger !== undefined) {
        this.#lease = await ledger.acquireSession(this.#options.sessionId, this.#options.priority ?? 0, this.#admission.signal);
        if (this.#state !== "open") {
          // A waiter can be granted concurrently with cancel/dispose. Do not
          // strand the lease when the state transition wins that race.
          this.#lease.release();
          this.#lease = undefined;
          return;
        }
        // Reserve the configured WASM/canonical-input ceiling before source
        // work starts so concurrent sessions cannot overcommit the page cap.
        this.#reserveWasm(this.#options.budgets.maxWasmBytes);
      }
      this.#reserveOutput(this.#options.initialOutputPageCredits * WEB_COOK_PAGE_BYTES);
      this.#send({
        type: "CreateSession",
        runtimeProfile: this.#options.runtimeProfile ?? "portable-single",
        recipe: this.#options.recipe ?? {},
        budgets: this.#options.budgets,
        ...(this.#options.bootstrap === undefined ? {} : { bootstrap: this.#options.bootstrap })
      });
      this.#send({ type: "GrantOutputCredits", blockCount: this.#options.initialOutputPageCredits, bytes: this.#options.initialOutputPageCredits * WEB_COOK_PAGE_BYTES });
      this.#send({ type: "OpenSource", source: { url } });
    } catch (error) {
      if (this.#state !== "open") return;
      this.#state = "failed";
      this.#releaseBudget();
      this.#provider.release();
      this.#transport.close(true);
    }
  }

  revisions(signal?: AbortSignal): AsyncIterable<GeometryProductRevisionSourceV1> {
    if (this.#state !== "open") throw new Error(`Web Cook client cannot consume revisions from '${this.#state}'`);
    if (this.#providerConsumed) throw new Error("Web Cook client revisions can only be consumed once");
    this.#providerConsumed = true;
    const revisions = this.#provider.revisions(signal);
    const client = this;
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<GeometryProductRevisionSourceV1> {
        try {
          for await (const revision of revisions) yield revision;
        } catch (error) {
          if (client.#state === "open") client.#state = "failed";
          throw error;
        }
      }
    };
  }

  requestPages(productId: Uint8Array, revision: number, pageIds: Uint32Array, priority: number): void {
    if (this.#state !== "open") throw new Error(`Web Cook client cannot request pages from '${this.#state}'`);
    if (productId.byteLength !== 32 || !Number.isInteger(revision) || revision < 0 || revision === 0xffffffff || pageIds.some(pageId => pageId === 0xffffffff) || !Number.isInteger(priority) || priority < 0) throw new RangeError("Web Cook page request identity/priority is invalid");
    this.#send({ type: "RequestPages", productId: productId.slice(), revision, pageIds: pageIds.slice(), priority });
  }

  setSourcePriority(assetKey: string, score: number, cameraHintRevision: number): void {
    if (this.#state !== "open") throw new Error(`Web Cook client cannot prioritize from '${this.#state}'`);
    if (!assetKey || !Number.isFinite(score) || !Number.isInteger(cameraHintRevision) || cameraHintRevision < 0) throw new RangeError("Web Cook source priority is invalid");
    this.#send({ type: "SetSourcePriority", assetKey, score, cameraHintRevision });
  }

  cancel(reason = "session"): void {
    if (this.#state !== "open") return;
    this.#admission.abort(new Error("Web Cook session cancelled"));
    try { this.#send({ type: "CancelScope", scope: reason }); } finally {
      this.#state = "cancelled";
      this.#releaseBudget();
      this.#provider.release();
      this.#transport.close(true);
    }
  }

  dispose(): void {
    if (this.#state === "disposed") return;
    this.#admission.abort(new Error("Web Cook session disposed"));
    try {
      if (this.#state === "open") this.#send({ type: "DisposeSession" });
    } finally {
      this.#state = "disposed";
      this.#releaseBudget();
      this.#provider.release();
      this.#transport.close(true);
    }
  }

  evidence(): WebCookClientEvidence {
    return Object.freeze({
      state: this.#state,
      sessionId: this.#options.sessionId,
      sessionGeneration: this.#options.sessionGeneration,
      transport: this.#transport.evidence(),
      provider: this.#provider.evidence(),
      catalogReady: this.#catalog !== undefined,
      progressEvents: this.#progressEvents,
      recoverableFailures: this.#recoverableFailures,
      recoverableFailureCodes: Object.freeze(this.#recoverableFailureCodes.slice()),
      ...(this.#options.ledger === undefined ? {} : { budget: this.#options.ledger.evidence() })
    });
  }

  #send(command: WebCookClientCommand): void {
    this.#transport.send({
      protocolVersion: WEB_COOK_PROTOCOL_VERSION,
      sessionId: this.#options.sessionId,
      sessionGeneration: this.#options.sessionGeneration,
      ...command
    } as WebCookCommand);
  }

  #returnOutputCredits(blockCount: number, bytes: number): void {
    if (this.#state !== "open") return;
    this.#releaseOutput(bytes);
    this.#send({ type: "ReturnOutputCredits", blockCount, bytes });
  }

  #reserveOutput(bytes: number): void {
    const ledger = this.#options.ledger;
    if (ledger === undefined || this.#lease === undefined) return;
    if (!ledger.reserve(this.#lease, "output", bytes)) throw new Error("Web Cook global output budget is exhausted");
    this.#reservedOutputBytes += bytes;
  }

  #reserveSource(bytes: number): void {
    const ledger = this.#options.ledger;
    if (ledger === undefined || this.#lease === undefined || this.#reservedSourceBytes !== 0) return;
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError("Web Cook source byte count is invalid");
    if (!ledger.reserve(this.#lease, "source", bytes)) throw new Error("Web Cook global source budget is exhausted");
    this.#reservedSourceBytes = bytes;
  }

  #reserveWasm(bytes: number): void {
    const ledger = this.#options.ledger;
    if (ledger === undefined || this.#lease === undefined || this.#reservedWasmBytes !== 0) return;
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError("Web Cook WASM byte count is invalid");
    if (!ledger.reserve(this.#lease, "wasm", bytes)) throw new Error("Web Cook global WASM budget is exhausted");
    this.#reservedWasmBytes = bytes;
  }

  #releaseOutput(bytes: number): void {
    const ledger = this.#options.ledger;
    if (ledger === undefined || this.#lease === undefined) return;
    const applied = Math.min(bytes, this.#reservedOutputBytes);
    this.#reservedOutputBytes -= applied;
    ledger.release(this.#lease, "output", applied);
  }

  #releaseBudget(): void {
    const ledger = this.#options.ledger;
    if (ledger !== undefined && this.#lease !== undefined) {
      if (this.#reservedOutputBytes > 0) ledger.release(this.#lease, "output", this.#reservedOutputBytes);
      if (this.#reservedSourceBytes > 0) ledger.release(this.#lease, "source", this.#reservedSourceBytes);
      if (this.#reservedWasmBytes > 0) ledger.release(this.#lease, "wasm", this.#reservedWasmBytes);
      this.#lease.release();
    }
    this.#reservedOutputBytes = 0;
    this.#reservedSourceBytes = 0;
    this.#reservedWasmBytes = 0;
    this.#lease = undefined;
  }
}

type WebCookClientCommand = WebCookCommand extends infer Command
  ? Command extends WebCookCommand
    ? Omit<Command, "protocolVersion" | "sessionId" | "sessionGeneration">
    : never
  : never;

function validateOptions(options: WebCookClientOptions): void {
  if (!options || !options.worker || !options.sessionId || !Number.isInteger(options.sessionGeneration) || options.sessionGeneration <= 0 || options.sessionGeneration === 0xffffffff) throw new RangeError("Web Cook client identity is invalid");
  for (const [name, value] of Object.entries(options.budgets ?? {})) if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  if (!Number.isInteger(options.initialOutputPageCredits) || options.initialOutputPageCredits <= 0) throw new RangeError("initialOutputPageCredits must be positive");
  if (options.initialOutputPageCredits > options.budgets.maxQueuedEvents || options.initialOutputPageCredits * WEB_COOK_PAGE_BYTES > options.budgets.maxOutputBytes) throw new RangeError("initial output credits exceed the session budget");
  for (const priority of options.initialSourcePriorities ?? []) {
    if (!priority.assetKey || !Number.isFinite(priority.score) || !Number.isInteger(priority.cameraHintRevision) || priority.cameraHintRevision < 0) throw new RangeError("initial source priority is invalid");
  }
  const bootstrap = options.bootstrap;
  if (bootstrap?.unitCount !== undefined && (!Number.isSafeInteger(bootstrap.unitCount) || bootstrap.unitCount <= 0)) throw new RangeError("bootstrap unitCount must be a positive safe integer");
  if (bootstrap?.maxSourceBytes !== undefined && (!Number.isSafeInteger(bootstrap.maxSourceBytes) || bootstrap.maxSourceBytes <= 0)) throw new RangeError("bootstrap maxSourceBytes must be a positive safe integer");
  if (bootstrap?.maxSourceBytes !== undefined && bootstrap.maxSourceBytes > options.budgets.maxWasmBytes) throw new RangeError("bootstrap maxSourceBytes exceeds the session WASM budget");
}

import type { GeometryProductProviderV1, GeometryProductRevisionSourceV1 } from "../geometry-product/GeometryProductV1.js";
import {
  WEB_COOK_PAGE_BYTES,
  WEB_COOK_PROTOCOL_VERSION,
  type WebCookBudgets,
  type WebCookCommand,
  type WebCookRuntimeProfile
} from "./protocol/CookSessionProtocol.js";
import { WebCookProductProvider, type WebCookProductProviderEvidence } from "./WebCookProductProvider.js";
import { WebCookWorkerTransport, type WebCookWorkerPort, type WebCookWorkerTransportEvidence } from "./WebCookWorkerTransport.js";

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
    readonly nodeIndex: number;
    readonly instanceNodeIndices: readonly number[];
    readonly meshIndex: number;
    readonly primitiveIndex: number;
    readonly materialIndex: number;
    readonly material: Readonly<Record<string, unknown>>;
    readonly attributeSemantics: readonly string[];
    readonly vertexCount: number;
    readonly triangleCount: number;
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
        this.#options.onSceneCatalogReady?.(this.#catalog);
      },
      onProgress: () => { this.#progressEvents++; },
      onRecoverableFailure: () => { this.#recoverableFailures++; },
      requestPage: (productId, revision, pageId) => this.requestPages(productId, revision, new Uint32Array([pageId]), 0)
    });
  }

  get state(): WebCookClientEvidence["state"] { return this.#state; }
  get catalog(): WebCookSceneCatalogSnapshot | undefined { return this.#catalog; }

  /** Starts one bounded GLB source session and grants only whole-page credit. */
  open(url: string): void {
    if (this.#state !== "created") throw new Error(`Web Cook client cannot open from '${this.#state}'`);
    if (!url || typeof url !== "string") throw new TypeError("Web Cook source URL must be a non-empty string");
    try {
      this.#send({
        type: "CreateSession",
        runtimeProfile: this.#options.runtimeProfile ?? "portable-single",
        recipe: this.#options.recipe ?? {},
        budgets: this.#options.budgets
      });
      this.#send({ type: "GrantOutputCredits", blockCount: this.#options.initialOutputPageCredits, bytes: this.#options.initialOutputPageCredits * WEB_COOK_PAGE_BYTES });
      this.#send({ type: "OpenSource", source: { url } });
      this.#state = "open";
    } catch (error) {
      this.#state = "failed";
      this.#provider.release();
      this.#transport.close(true);
      throw error;
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
    try { this.#send({ type: "CancelScope", scope: reason }); } finally {
      this.#state = "cancelled";
      this.#provider.release();
      this.#transport.close(true);
    }
  }

  dispose(): void {
    if (this.#state === "disposed") return;
    try {
      if (this.#state === "open") this.#send({ type: "DisposeSession" });
    } finally {
      this.#state = "disposed";
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
      recoverableFailures: this.#recoverableFailures
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
    this.#send({ type: "ReturnOutputCredits", blockCount, bytes });
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
}

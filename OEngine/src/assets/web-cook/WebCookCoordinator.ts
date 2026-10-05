import {
  buildGlbSceneCatalog,
  type GlbByteRange,
  type GlbCookPrimitive,
  type GlbSceneCatalog,
} from "../../loaders/gltf/streaming/GlbSceneCatalog.js";
import {
  openGlbRangeSource,
  type GlbRangeReadableSource,
  type GlbRangeSourceOptions,
} from "../../loaders/gltf/streaming/GlbRangeSource.js";
import { decodeGeometryProductDescriptorBinaryV1 } from "../geometry-product/GeometryProductBinaryV1.js";
import { OEGPACK_V3_ASSET_STRIDE } from "../GeometryAbiV3.js";
import {
  WebCookSessionProtocol,
  WEB_COOK_PAGE_BYTES,
  WEB_COOK_PROTOCOL_VERSION,
  type WebCookBootstrapOptions,
  type WebCookBudgets,
  type WebCookEvent,
  type WebCookRuntimeProfile,
} from "./protocol/CookSessionProtocol.js";
import type { WebCookProductTaskTraceEventV1, WebCookProductTaskTraceListener } from "./ProductTaskTrace.js";

export interface WebCookUnitContext {
  readonly source: GlbRangeReadableSource;
  readonly catalog: GlbSceneCatalog;
  readonly signal: AbortSignal;
  /** Session generation that owns every page artifact produced for this cook. */
  readonly sessionGeneration?: number;
  /** Priority-selected units allowed to form the first complete Product cut. */
  readonly bootstrapUnits?: readonly GlbCookPrimitive[];
  /** Stable catalog indices matching bootstrapUnits. */
  readonly bootstrapAssetIndices?: readonly number[];
  readRange(range: {
    readonly bufferIndex: number;
    readonly byteOffset: number;
    readonly byteLength: number;
  }): Promise<ArrayBuffer>;
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
  /**
   * True while the revision still has declared page payloads that have not been
   * produced. A plan-backed revision publishes its descriptor before it is fully
   * materialised, and the coordinator keeps the activation cut usable by
   * advancing exactly the pages it is asked for.
   */
  readonly hasPendingPages?: boolean;
  readPage(pageId: number): Promise<WebCookProductPage>;
  release(): void;
}

/**
 * The cooker is deliberately a pure producer. It may be backed by WASM in a
 * dedicated Worker, but it never receives a GPU object or performs publication.
 */
export interface WebRuntimeCooker {
  /** Every offered partition is required, unlike optional richer replacements. */
  readonly requiredIndependentProducts?: boolean;
  /**
   * Returns the producer's upper bound for live source bytes while cooking the
   * supplied units. This is deliberately not the total accessor range size:
   * bounded-window producers may spatially shard one giant primitive and scan
   * its ranges one window at a time. Producers that omit this capability are
   * admitted against their complete unit ranges and therefore fail closed for
   * oversized primitives.
   */
  estimateLiveSourceBytes?(units: readonly GlbCookPrimitive[]): number;
  cookBootstrap(unit: GlbCookPrimitive, context: WebCookUnitContext): Promise<WebCookProductRevision>;
  /** Optional whole-source entry. Producers use this to publish one immutable Product cut. */
  cookBootstrapBatch?(
    units: readonly GlbCookPrimitive[],
    context: WebCookUnitContext,
  ): Promise<WebCookProductRevision>;
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
    onFailure?: (error: Error) => void,
  ): Promise<void>;
  /** Optional producer-owned memory evidence. It must describe live windows, not total asset size. */
  evidence?(): Readonly<Record<string, number>>;
  /** Installs the session trace sink before cook starts. */
  setTaskTraceListener?(listener: WebCookProductTaskTraceListener | undefined): void;
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
  /** Explicit live source-window cap for the first cut; the full refinement is separately bounded by the cooker. */
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
  /** Live source-window estimate used for the bootstrap admission/progress cut. */
  readonly bootstrapSourceBytes: number;
  /** Live source-window estimate for the complete refinement unit set. */
  readonly refinementSourceBytes: number;
  /** Time from cook start until the first activation cut is fully streamed. */
  readonly firstMeaningfulFrameMs?: number;
  /** Time from cook start until the progressive producer has settled. */
  readonly totalCookMs?: number;
  /** Time from cook start until the first descriptor is offered. */
  readonly firstRevisionMs?: number;
  /**
   * Priorities that arrived after the first cut was already chosen.
   *
   * A non-zero value means the caller's ranking could not influence the
   * bootstrap revision, so the first frame was ranked by coverage instead.
   */
  readonly lateSourcePriorities: number;
  readonly recoverableFailures: readonly string[];
  readonly productTaskEvents: number;
  readonly productTasksStarted: number;
  readonly productTasksCompleted: number;
  readonly productTasksFailed: number;
  readonly productTasksCancelled: number;
  readonly currentProductTask?: WebCookProductTaskTraceEventV1;
  readonly lastFailedProductTask?: WebCookProductTaskTraceEventV1;
  readonly cooker?: Readonly<Record<string, number>>;
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
  #firstMeaningfulFrameAt: number | undefined;
  #totalCookAt: number | undefined;
  #cookStartedAt = 0;
  #cookStarted = false;
  /**
   * True once the automatic bootstrap selection has been computed. A priority
   * that arrives after this point can no longer change the first cut, so it is
   * counted instead of silently ignored.
   */
  #bootstrapSelected = false;
  #lateSourcePriorities = 0;
  readonly #recoverableFailures: string[] = [];
  readonly #sourcePriorities = new Map<
    string,
    { readonly score: number; readonly cameraHintRevision: number }
  >();
  readonly #liveRevisions: WebCookProductRevision[] = [];
  readonly #releasedRevisions = new WeakSet<WebCookProductRevision>();
  /** Revisions whose activation cut finished streaming; those pages re-emit. */
  readonly #activationStreamed = new Map<string, boolean>();
  readonly #deliveredPageKeys = new Set<string>();
  readonly #completedSceneAssets = new Set<number>();
  #productTaskEvents = 0;
  #productTasksStarted = 0;
  #productTasksCompleted = 0;
  #productTasksFailed = 0;
  #productTasksCancelled = 0;
  #currentProductTask: WebCookProductTaskTraceEventV1 | undefined;
  #lastFailedProductTask: WebCookProductTaskTraceEventV1 | undefined;
  #acceptedProducts = 0;
  readonly #creditWaiters = new Set<() => void>();
  #emitTail: Promise<void> = Promise.resolve();
  /** Phase durations, reported through `Progress.timings` so the load is not a black box. */
  #openStartedAt = 0;
  #catalogReadyMs = 0;
  #refinementMs = 0;
  #activationCreditWaitMs = 0;
  #activationReadMs = 0;
  readonly #cookCompletion = deferred<void>();
  #firstRevisionReject: ((reason?: unknown) => void) | undefined;

  constructor(
    readonly sessionId: string,
    sessionGeneration: number,
    options: WebCookCoordinatorOptions,
  ) {
    this.#options = options;
    this.#session = new WebCookSessionProtocol(sessionId, sessionGeneration);
    this.#session.accept({
      protocolVersion: WEB_COOK_PROTOCOL_VERSION,
      sessionId,
      sessionGeneration,
      type: "CreateSession",
      runtimeProfile: options.runtimeProfile ?? "portable-single",
      recipe: options.recipe ?? {},
      budgets: options.budgets,
    });
    options.cooker.setTaskTraceListener?.((trace) => this.#acceptProductTaskTrace(trace));
  }

  get catalog(): GlbSceneCatalog | undefined {
    return this.#catalog;
  }
  get source(): GlbRangeReadableSource | undefined {
    return this.#source;
  }
  /** Resolves after the progressive producer settles, independently of TTFMF. */
  waitForCookCompletion(): Promise<void> {
    return this.#cookCompletion.promise;
  }

  async open(url: string): Promise<GlbSceneCatalog> {
    this.requireState("idle");
    this.#state = "opening";
    this.#openStartedAt = Date.now();
    try {
      const source = await openGlbRangeSource(url, this.#options.source);
      this.#source = source;
      this.#catalog = buildGlbSceneCatalog(source);
      this.#session.accept(
        this.header({
          type: "OpenSource",
          source: {
            url: source.sourceIdentity.finalUrl,
            byteLength: source.byteLength,
            identityHash: source.sourceIdentity.hash.slice(),
          },
        }),
      );
      this.#session.emit(
        this.header({
          type: "SceneCatalogReady",
          catalog: {
            schemaVersion: this.#catalog.schemaVersion,
            primitiveCount: this.#catalog.primitives.length,
            sourceBytes: this.#catalog.sourceBytes,
            sourceTransferMode: source.transferMode,
            sourceIdentityHash: this.#catalog.sourceIdentityHash.slice(),
            // Scene metadata is JSON-only and therefore safe to transfer before
            // any geometry page is copied out of the Worker.
            scenes: this.#catalog.scenes.slice(),
            instances: this.#catalog.instances.map((instance) => ({
              nodeIndex: instance.nodeIndex,
              meshIndex: instance.meshIndex,
              worldMatrix: Array.from(instance.worldMatrix),
            })),
            primitives: this.#catalog.primitives.map((primitive, index) => ({
              assetKey: primitiveKey(primitive),
              catalogIndex: index,
              nodeIndex: primitive.nodeIndex,
              instanceNodeIndices: primitive.instanceNodeIndices.slice(),
              meshIndex: primitive.meshIndex,
              primitiveIndex: primitive.primitiveIndex,
              materialIndex: primitive.materialIndex,
              material: primitive.material,
              attributeSemantics: Object.keys(primitive.attributes),
              vertexCount: primitive.vertexCount,
              triangleCount: primitive.triangleCount,
              boundsMin: primitive.boundsMin.slice(),
              boundsMax: primitive.boundsMax.slice(),
              boundsSphere: primitive.boundsSphere.slice(),
            })),
            textures: this.#catalog.textures.map((texture) => ({
              textureIndex: texture.textureIndex,
              sourceIndex: texture.sourceIndex,
              sampler: { ...texture.sampler },
            })),
            images: this.#catalog.images.map((image) => ({
              imageIndex: image.imageIndex,
              ...(image.mimeType === undefined ? {} : { mimeType: image.mimeType }),
              ...(image.uri === undefined ? {} : { uri: image.uri }),
              ...(image.bufferView === undefined ? {} : { bufferView: { ...image.bufferView } }),
            })),
          },
        }),
      );
      this.#catalogReadyMs = Date.now() - this.#openStartedAt;
      this.#state = "cooking";
      return this.#catalog;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async cookBootstrap(): Promise<void> {
    if (this.#state !== "cooking") throw new Error(`WebCookCoordinator cannot cook from '${this.#state}'`);
    if (this.#cookStarted) throw new Error("WebCookCoordinator cook has already started");
    this.#cookStarted = true;
    this.#cookStartedAt = Date.now();
    try {
      const source = this.#source!,
        catalog = this.#catalog!;
      const units = [...catalog.primitives].sort(
        (left, right) =>
          this.priorityFor(right) - this.priorityFor(left) || comparePrimitiveOrder(left, right),
      );
      const bootstrapUnits = this.selectBootstrapUnits(units);
      this.#bootstrapSelected = true;
      const catalogIndex = new Map(catalog.primitives.map((unit, index) => [primitiveKey(unit), index]));
      const bootstrapAssetIndices = bootstrapUnits.map((unit) => catalogIndex.get(primitiveKey(unit))!);
      this.#bootstrapUnits = bootstrapUnits.length;
      this.#bootstrapSourceBytes = estimateLiveSourceBytes(this.#options.cooker, bootstrapUnits);
      this.#refinementSourceBytes = estimateLiveSourceBytes(this.#options.cooker, units);
      const hasBoundedLiveSource = this.#options.cooker.estimateLiveSourceBytes !== undefined;
      // The automatic selection is bounded by its own byte cap even when the
      // caller did not configure one; an explicit count stays caller-governed.
      // A bounded-window producer owns a more accurate live-source budget, so
      // the legacy whole-primitive default must not reject a spatial giant.
      if (
        this.#options.bootstrapUnitCount === undefined &&
        this.#options.cooker.estimateLiveSourceBytes === undefined &&
        this.#bootstrapSourceBytes > DEFAULT_BOOTSTRAP_SOURCE_BYTES
      ) {
        throw new Error(`automatic visible-first bootstrap exceeds ${DEFAULT_BOOTSTRAP_SOURCE_BYTES} bytes`);
      }
      if (
        this.#options.bootstrapMaxSourceBytes !== undefined &&
        this.#bootstrapSourceBytes > this.#options.bootstrapMaxSourceBytes
      ) {
        throw new Error(
          `visible-first bootstrap source exceeds bootstrapMaxSourceBytes=${this.#options.bootstrapMaxSourceBytes}`,
        );
      }
      const progressive = this.#options.cooker.cookProgressive;
      if (progressive) {
        const context: WebCookUnitContext = Object.freeze({
          source,
          catalog,
          signal: this.#abort.signal,
          sessionGeneration: this.#session.sessionGeneration,
          bootstrapUnits,
          bootstrapAssetIndices,
          readRange: (range: GlbByteRange) =>
            source.readBufferRange(range.bufferIndex, range.byteOffset, range.byteLength, this.#abort.signal),
        });
        this.#peakUnitBytes = Math.max(this.#peakUnitBytes, this.#bootstrapSourceBytes);
        assertLiveSourceBudget(
          this.#bootstrapSourceBytes,
          this.#options.budgets,
          "bootstrap cook source",
          hasBoundedLiveSource,
        );
        // A revision is not a fine-grained progress signal: the cook between two
        // revisions can run for seconds. Heartbeat real elapsed time while it
        // runs: the UI can then show the cook is still alive instead of freezing
        // at "0.4" until the replacement lands.
        const heartbeat = this.#startProgressHeartbeat(units.length);
        // The producer may hand over a revision that is still streaming. The
        // promise therefore resolves on the *first* revision's completion, so
        // `cookBootstrap()` keeps its contract of returning only once the first
        // activation cut is fully streamed, while a later revision keeps
        // working in the background.
        const firstRevision = deferred<void>();
        let seenRevision = false;
        let firstActivationFailed = false;
        let reportedFailure: Error | undefined;
        // The producer deliberately remains alive after the first activation
        // cut. `cookBootstrap()` is the TTFMF barrier; total cook completion is
        // reported by the background task once richer refinement settles.
        const producerTask = Promise.resolve().then(() =>
          progressive.call(
            this.#options.cooker,
            units,
            context,
            (revision) => {
              const isFirst = !seenRevision;
              seenRevision = true;
              const streamed = this.#acceptRevisionRevisions(revision, bootstrapUnits.length, units.length);
              if (!isFirst) {
                return streamed.catch((error: unknown) => {
                  if (this.#options.cooker.requiredIndependentProducts) throw error;
                  if (!this.#abort.signal.aborted) this.recordRecoverableFailure(error);
                });
              }
              // A failure while streaming the first cut is the caller's failure.
              return streamed.then(
                () => {
                  firstRevision.resolve();
                },
                (error: unknown) => {
                  firstActivationFailed = true;
                  firstRevision.reject(error);
                  throw error;
                },
              );
            },
            (error) => {
              if (!this.#options.cooker.requiredIndependentProducts && this.hasCompleteCatalogCoverage())
                this.recordRecoverableFailure(error);
              else reportedFailure = error;
            },
          ),
        );
        void producerTask.then(
          () => {
            heartbeat();
            if (!seenRevision) {
              const error = new Error("Web Cook producer completed without offering a revision");
              firstRevision.reject(error);
              this.fail(error);
              return;
            }
            if (
              reportedFailure !== undefined &&
              (this.#options.cooker.requiredIndependentProducts || !this.hasCompleteCatalogCoverage())
            ) {
              this.fail(reportedFailure, true);
              return;
            }
            this.completeCook();
          },
          (error: unknown) => {
            heartbeat();
            if (!seenRevision || firstActivationFailed) {
              firstRevision.reject(error);
              this.fail(error);
              return;
            }
            if (!this.#options.cooker.requiredIndependentProducts && this.hasCompleteCatalogCoverage()) {
              if (!this.#abort.signal.aborted) this.recordRecoverableFailure(error);
              this.completeCook();
              return;
            }
            this.fail(error, true);
          },
        );
        this.#firstRevisionReject = firstRevision.reject;
        try {
          await firstRevision.promise;
        } finally {
          if (this.#firstRevisionReject === firstRevision.reject) this.#firstRevisionReject = undefined;
        }
        return;
      }
      const batchCooker = this.#options.cooker.cookBootstrapBatch;
      if (batchCooker) {
        const context: WebCookUnitContext = Object.freeze({
          source,
          catalog,
          signal: this.#abort.signal,
          sessionGeneration: this.#session.sessionGeneration,
          bootstrapUnits,
          bootstrapAssetIndices,
          readRange: (range: GlbByteRange) =>
            source.readBufferRange(range.bufferIndex, range.byteOffset, range.byteLength, this.#abort.signal),
        });
        const estimated = this.#bootstrapSourceBytes;
        this.#peakUnitBytes = Math.max(this.#peakUnitBytes, estimated);
        assertLiveSourceBudget(estimated, this.#options.budgets, "cook source", hasBoundedLiveSource);
        const revision = await batchCooker.call(this.#options.cooker, bootstrapUnits, context);
        this.validateRevision(revision);
        this.#liveRevisions.push(revision);
        const descriptor = decodeGeometryProductDescriptorBinaryV1(revision.descriptor);
        this.#completedUnits = bootstrapUnits.length;
        this.#firstRevisionAt = Date.now() - this.#cookStartedAt;
        this.publish(
          this.header({
            type: "RevisionOffered",
            descriptor: revision.descriptor,
            ...(revision.sceneAssetIndices === undefined
              ? {}
              : { sceneAssetIndices: Uint32Array.from(revision.sceneAssetIndices) }),
          }),
        );
        for (const pageId of descriptor.activationPageIds) await this.emitPage(revision, pageId);
        this.markActivationStreamed(revision);
        this.#firstMeaningfulFrameAt = Date.now() - this.#cookStartedAt;
        this.publish(
          this.header({
            type: "Progress",
            stage: "bootstrap-cook",
            units: this.#completedUnits,
            bytes: estimated,
            timings: this.phaseTimings(),
          }),
        );
        this.#totalCookAt = Date.now() - this.#cookStartedAt;
        this.#state = "complete";
        this.#cookCompletion.resolve();
        return;
      }
      // A non-progressive producer is an explicit bootstrap-only fallback. It
      // cannot safely publish one Product per unit because those revisions have
      // no replacement/scene identity contract for a partial catalog.
      if (units.length > bootstrapUnits.length)
        throw new Error(
          "Web Cook producer must implement cookProgressive for multi-unit visible-first loading",
        );
      const concurrency = Math.min(this.#options.budgets.maxConcurrentWorkers, bootstrapUnits.length);
      for (let begin = 0; begin < bootstrapUnits.length; begin += concurrency) {
        if (this.#abort.signal.aborted)
          throw this.#abort.signal.reason ?? new Error("Web Cook was cancelled");
        const batch = bootstrapUnits.slice(begin, begin + concurrency);
        const cooked = await Promise.all(
          batch.map(async (unit) => {
            const context: WebCookUnitContext = Object.freeze({
              source,
              catalog,
              signal: this.#abort.signal,
              sessionGeneration: this.#session.sessionGeneration,
              bootstrapUnits,
              bootstrapAssetIndices,
              readRange: (range: GlbByteRange) =>
                source.readBufferRange(
                  range.bufferIndex,
                  range.byteOffset,
                  range.byteLength,
                  this.#abort.signal,
                ),
            });
            const estimated = estimateLiveSourceBytes(this.#options.cooker, [unit]);
            this.#peakUnitBytes = Math.max(this.#peakUnitBytes, estimated);
            assertLiveSourceBudget(estimated, this.#options.budgets, "cook unit", hasBoundedLiveSource);
            const revision = await this.#options.cooker.cookBootstrap(unit, context);
            this.validateRevision(revision);
            return { revision, estimated };
          }),
        );
        for (const { revision, estimated } of cooked) {
          const descriptor = decodeGeometryProductDescriptorBinaryV1(revision.descriptor);
          this.#liveRevisions.push(revision);
          this.publish(
            this.header({
              type: "RevisionOffered",
              descriptor: revision.descriptor,
              ...(revision.sceneAssetIndices === undefined
                ? {}
                : { sceneAssetIndices: Uint32Array.from(revision.sceneAssetIndices) }),
            }),
          );
          for (const pageId of descriptor.activationPageIds) await this.emitPage(revision, pageId);
          this.markActivationStreamed(revision);
          if (this.#firstMeaningfulFrameAt === undefined)
            this.#firstMeaningfulFrameAt = Date.now() - this.#cookStartedAt;
          this.#completedUnits++;
          this.#session.emit(
            this.header({
              type: "Progress",
              stage: "bootstrap-cook",
              units: this.#completedUnits,
              bytes: estimated,
              timings: this.phaseTimings(),
            }),
          );
        }
      }
      this.#totalCookAt = Date.now() - this.#cookStartedAt;
      this.#state = "complete";
      this.#cookCompletion.resolve();
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  /**
   * Records one offered revision and streams its activation cut.
   *
   * The descriptor is published first, because the activation cut and every
   * later GPU demand address pages through it. Only then are the cut's payloads
   * produced: a plan-backed revision has not materialised them yet, so this loop
   * is what actually advances the payload stage for the cut. `markActivationStreamed`
   * runs after the loop, which is what lets `requestPages` take over re-reads.
   */
  #acceptRevisionRevisions(
    revision: WebCookProductRevision,
    bootstrapUnitCount: number,
    totalUnitCount: number,
  ): Promise<void> {
    if (this.#state !== "cooking" || this.#abort.signal.aborted) {
      this.releaseRevision(revision);
      throw this.#abort.signal.reason ?? new Error("Web Cook stopped before revision publication");
    }
    try {
      this.validateRevision(revision);
    } catch (error) {
      this.releaseRevision(revision);
      throw error;
    }
    this.#liveRevisions.push(revision);
    let descriptor: ReturnType<typeof decodeGeometryProductDescriptorBinaryV1>;
    try {
      descriptor = decodeGeometryProductDescriptorBinaryV1(revision.descriptor);
      if (this.#firstRevisionAt === undefined) this.#firstRevisionAt = Date.now() - this.#cookStartedAt;
      else this.#refinementMs = Date.now() - this.#cookStartedAt - this.#firstRevisionAt;
      this.publish(
        this.header({
          type: "RevisionOffered",
          descriptor: revision.descriptor,
          ...(revision.sceneAssetIndices === undefined
            ? {}
            : { sceneAssetIndices: Uint32Array.from(revision.sceneAssetIndices) }),
        }),
      );
    } catch (error) {
      this.removeLiveRevision(revision);
      this.releaseRevision(revision);
      throw error;
    }
    return (async () => {
      try {
        for (const pageId of descriptor.activationPageIds) await this.emitPage(revision, pageId);
        this.markActivationStreamed(revision);
        // A descriptor offer is not a completed unit milestone: keep progress
        // at the last fully streamed activation cut while a richer cut waits
        // for credit or page reads.
        this.#acceptedProducts++;
        for (const index of revision.sceneAssetIndices ?? []) this.#completedSceneAssets.add(index);
        const mappedProgress =
          revision.sceneAssetIndices === undefined
            ? this.#acceptedProducts === 1
              ? bootstrapUnitCount
              : totalUnitCount
            : this.#completedSceneAssets.size;
        this.#completedUnits = Math.min(
          totalUnitCount,
          Math.max(mappedProgress, this.#acceptedProducts === 1 ? bootstrapUnitCount : 0),
        );
        const firstProduct = this.#acceptedProducts === 1;
        if (firstProduct && this.#firstMeaningfulFrameAt === undefined)
          this.#firstMeaningfulFrameAt = Date.now() - this.#cookStartedAt;
        try {
          this.publish(
            this.header({
              type: "Progress",
              stage: firstProduct ? "bootstrap-cook" : "refinement",
              units: this.#completedUnits,
              bytes: firstProduct ? this.#bootstrapSourceBytes : this.#refinementSourceBytes,
              timings: this.phaseTimings(),
            }),
          );
        } catch {
          // Progress is diagnostic; a saturated queue must not revoke a fully
          // streamed activation revision that the consumer can already render.
        }
      } catch (error) {
        this.removeLiveRevision(revision);
        this.releaseRevision(revision);
        throw error;
      }
    })();
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
        this.publish(
          this.header({
            type: "Progress",
            stage: "refinement",
            units: this.#completedUnits,
            bytes: this.#refinementSourceBytes,
            timings: Object.freeze({
              ...this.phaseTimings(),
              ...this.#options.cooker.evidence?.(),
              elapsedMs: Date.now() - startedAt,
              totalUnits,
            }),
          }),
        );
      } catch {
        // The consumer is not draining events; skip this heartbeat.
      }
    }, PROGRESS_HEARTBEAT_MS);
    return () => {
      clearInterval(timer);
    };
  }

  /** Records source priority before or during a bounded cook session. */
  setSourcePriority(assetKey: string, score: number, cameraHintRevision: number): void {
    if (this.#state !== "opening" && this.#state !== "cooking")
      throw new Error(`WebCookCoordinator cannot prioritize from '${this.#state}'`);
    if (
      !assetKey ||
      !Number.isFinite(score) ||
      !Number.isInteger(cameraHintRevision) ||
      cameraHintRevision < 0
    )
      throw new RangeError("Web Cook source priority is invalid");
    // The first cut is already chosen, so this priority cannot be honoured. It
    // is still stored (a later revision may use it) but must be visible in
    // evidence rather than looking like a successful ranking.
    if (this.#bootstrapSelected) this.#lateSourcePriorities++;
    this.#sourcePriorities.set(assetKey, Object.freeze({ score, cameraHintRevision }));
  }

  /**
   * Produces and emits requested Product pages without mutating the immutable
   * revision.
   *
   * This is the demand side of the two-phase ABI. A plan-backed revision has
   * only produced its activation cut, so a request for a non-activation page is
   * the first thing that advances that page's payload stage; a later request for
   * the same PageID is served from the revision's own produced-page cache
   * instead of re-cooking it.
   *
   * A page the activation loop has not streamed yet stays with that loop, so it
   * is never emitted twice. Once the cut has finished streaming, a request for
   * an activation page means the consumer lost its copy - for example after
   * `abandonForDeviceLoss` released the GPU banks - and it must be re-served.
   */
  /**
   * The per-phase durations this session has measured so far, in milliseconds.
   *
   * Filled into `Progress.timings` so the load is not a black box: the caller
   * can see how long the catalog, the first cut, the activation stream (split
   * into output-credit wait and page read) and the richer refinement each took.
   * A phase that has not run yet reports 0.
   */
  private phaseTimings(): Readonly<Record<string, number>> {
    return Object.freeze({
      catalogMs: this.#catalogReadyMs,
      bootstrapCookMs: this.#firstRevisionAt ?? 0,
      firstMeaningfulFrameMs: this.#firstMeaningfulFrameAt ?? 0,
      activationStreamMs: this.#activationCreditWaitMs + this.#activationReadMs,
      activationCreditWaitMs: this.#activationCreditWaitMs,
      activationReadMs: this.#activationReadMs,
      refinementMs: this.#refinementMs,
      totalCookMs: this.#totalCookAt ?? 0,
    });
  }

  async requestPages(
    productId: Uint8Array,
    revision: number,
    pageIds: Uint32Array,
    _priority: number,
  ): Promise<void> {
    if (this.#state !== "cooking" && this.#state !== "complete")
      throw new Error(`WebCookCoordinator cannot request pages from '${this.#state}'`);
    if (productId.byteLength !== 32 || !Number.isInteger(revision) || revision < 0 || revision === 0xffffffff)
      throw new RangeError("Web Cook page request identity is invalid");
    const source = this.#liveRevisions.find(
      (candidate) => candidate.revision === revision && sameBytes(candidate.productId, productId),
    );
    if (!source) throw new Error("Web Cook page request targets an unknown Product revision");
    const unique = [...new Set(pageIds)].sort((left, right) => left - right);
    const activation = new Set<number>(
      decodeGeometryProductDescriptorBinaryV1(source.descriptor).activationPageIds,
    );
    const activationStreamed = this.#activationStreamed.get(revisionKey(source.productId, revision)) === true;
    for (const pageId of unique) {
      if (!Number.isInteger(pageId) || pageId < 0 || pageId === 0xffffffff || pageId >= source.pageCount)
        throw new RangeError("Web Cook page request targets an invalid page");
      if (
        activation.has(pageId) &&
        !activationStreamed &&
        !this.#deliveredPageKeys.has(`${revisionKey(source.productId, revision)}:${pageId}`)
      )
        continue;
      await this.emitPage(source, pageId);
    }
  }

  grantOutputCredits(blockCount: number, bytes: number): void {
    this.#session.accept(this.header({ type: "GrantOutputCredits", blockCount, bytes }));
    for (const wake of this.#creditWaiters) wake();
    this.#creditWaiters.clear();
  }
  returnOutputCredits(blockCount: number, bytes: number): void {
    this.#session.returnOutputCredits(blockCount, bytes);
    for (const wake of this.#creditWaiters) wake();
    this.#creditWaiters.clear();
  }
  drainEvents(maxEvents = Number.MAX_SAFE_INTEGER): WebCookEvent[] {
    return this.#session.drain(maxEvents);
  }
  cancel(reason = new Error("Web Cook was cancelled")): void {
    if (this.#state === "disposed" || this.#state === "complete") return;
    this.#abort.abort(reason);
    this.#state = "cancelled";
    this.#firstRevisionReject?.(reason);
    this.#cookCompletion.reject(reason);
    for (const wake of this.#creditWaiters) wake();
    this.#creditWaiters.clear();
    this.#session.accept(this.header({ type: "CancelScope", scope: "session" }));
  }
  dispose(): void {
    if (this.#state === "disposed") return;
    const reason = new Error("Web Cook session disposed");
    this.#abort.abort(reason);
    this.#firstRevisionReject?.(reason);
    this.#cookCompletion.reject(reason);
    for (const revision of this.#liveRevisions.splice(0)) this.releaseRevision(revision);
    for (const wake of this.#creditWaiters) wake();
    this.#creditWaiters.clear();
    this.#source?.release();
    this.#source = undefined;
    this.#catalog = undefined;
    this.#state = "disposed";
    this.#session.accept(this.header({ type: "DisposeSession" }));
  }
  evidence(): WebCookCoordinatorEvidence {
    return Object.freeze({
      state: this.#state,
      sessionGeneration: this.#session.sessionGeneration,
      catalogPrimitives: this.#catalog?.primitives.length ?? 0,
      completedUnits: this.#completedUnits,
      emittedPages: this.#emittedPages,
      sourceBytes: this.#source?.byteLength ?? 0,
      peakUnitBytes: this.#peakUnitBytes,
      bootstrapUnits: this.#bootstrapUnits,
      bootstrapSourceBytes: this.#bootstrapSourceBytes,
      refinementSourceBytes: this.#refinementSourceBytes,
      lateSourcePriorities: this.#lateSourcePriorities,
      recoverableFailures: Object.freeze(this.#recoverableFailures.slice()),
      productTaskEvents: this.#productTaskEvents,
      productTasksStarted: this.#productTasksStarted,
      productTasksCompleted: this.#productTasksCompleted,
      productTasksFailed: this.#productTasksFailed,
      productTasksCancelled: this.#productTasksCancelled,
      ...(this.#currentProductTask === undefined ? {} : { currentProductTask: this.#currentProductTask }),
      ...(this.#lastFailedProductTask === undefined
        ? {}
        : { lastFailedProductTask: this.#lastFailedProductTask }),
      ...(this.#options.cooker.evidence === undefined ? {} : { cooker: this.#options.cooker.evidence() }),
      ...(this.#firstRevisionAt === undefined ? {} : { firstRevisionMs: this.#firstRevisionAt }),
      ...(this.#firstMeaningfulFrameAt === undefined
        ? {}
        : { firstMeaningfulFrameMs: this.#firstMeaningfulFrameAt }),
      ...(this.#totalCookAt === undefined ? {} : { totalCookMs: this.#totalCookAt }),
      ...(this.#failure === undefined ? {} : { failure: this.#failure }),
    });
  }

  #acceptProductTaskTrace(trace: WebCookProductTaskTraceEventV1): void {
    this.#productTaskEvents++;
    if (trace.kind === "task-started") this.#productTasksStarted++;
    else if (trace.kind === "completed") this.#productTasksCompleted++;
    else if (trace.kind === "failed") {
      this.#productTasksFailed++;
      this.#lastFailedProductTask = trace;
    } else if (trace.kind === "cancelled") this.#productTasksCancelled++;
    this.#currentProductTask =
      trace.kind === "completed" || trace.kind === "failed" || trace.kind === "cancelled" ? undefined : trace;
    this.publish(this.header({ type: "ProductTaskTrace", trace }));
  }

  private fail(error: unknown, preservePublishedProducts = false): void {
    if (this.#state === "disposed" || this.#state === "cancelled") return;
    this.#failure = error instanceof Error ? error.message : String(error);
    this.#state = this.#abort.signal.aborted ? "cancelled" : "failed";
    this.#firstRevisionReject?.(error);
    this.#cookCompletion.reject(error);
    if (!preservePublishedProducts)
      for (const revision of this.#liveRevisions.splice(0)) this.releaseRevision(revision);
    for (const wake of this.#creditWaiters) wake();
    this.#creditWaiters.clear();
    try {
      this.publish(
        this.header({
          type: "Progress",
          stage: "failed",
          units: this.#completedUnits,
          bytes: this.#refinementSourceBytes,
          timings: { ...this.phaseTimings(), ...this.#options.cooker.evidence?.() },
        }),
      );
    } catch {
      /* preserve the terminal failure if diagnostics are saturated */
    }
    // The first activation promise may already have resolved. Notify the live
    // provider before closing the session queue so later failures cannot hang it.
    try {
      this.publish(this.header({ type: "FatalSessionFailure", code: this.#failure }));
    } catch {
      /* transport already failed */
    }
    this.#session.fail(this.#failure);
    this.#source?.release();
    this.#source = undefined;
  }
  private recordRecoverableFailure(error: unknown): void {
    const code = error instanceof Error ? error.message : String(error);
    this.#recoverableFailures.push(code);
    if (this.#state !== "cooking" || this.#abort.signal.aborted) return;
    try {
      this.publish(
        this.header({ type: "RecoverableFailure", scope: "richer-product-revision", code, retryAfterMs: 0 }),
      );
    } catch {
      /* a saturated diagnostic queue must not revoke bootstrap */
    }
  }
  private completeCook(): void {
    if (this.#totalCookAt === undefined) this.#totalCookAt = Date.now() - this.#cookStartedAt;
    if (this.#state !== "cooking") return;
    if (
      !this.hasCompleteCatalogCoverage() ||
      (this.#options.cooker.requiredIndependentProducts &&
        (this.#productTasksFailed > 0 ||
          this.#productTasksCancelled > 0 ||
          this.#productTasksStarted !== this.#productTasksCompleted))
    ) {
      const catalogPrimitives = this.#catalog?.primitives.length ?? 0;
      const failedTask = this.#lastFailedProductTask?.task.taskId;
      const failedPhase = this.#lastFailedProductTask?.phase;
      this.fail(
        new Error(
          `Web Cook producer settled with incomplete catalog coverage (${this.#completedUnits}/${catalogPrimitives})${failedTask === undefined ? "" : `; failedTask=${failedTask}${failedPhase === undefined ? "" : `; failedPhase=${failedPhase}`}`}`,
        ),
        true,
      );
      return;
    }
    this.#state = "complete";
    this.#cookCompletion.resolve();
    try {
      this.publish(
        this.header({
          type: "Progress",
          stage: "cook-complete",
          units: this.#completedUnits,
          bytes: this.#refinementSourceBytes,
          timings: { ...this.phaseTimings(), ...this.#options.cooker.evidence?.() },
        }),
      );
    } catch {
      /* completion evidence remains available even if the queue is full */
    }
  }
  private hasCompleteCatalogCoverage(): boolean {
    const catalogPrimitives = this.#catalog?.primitives.length ?? 0;
    if (catalogPrimitives === 0) return false;
    if (this.#completedSceneAssets.size > 0) return this.#completedSceneAssets.size === catalogPrimitives;
    return this.#completedUnits === catalogPrimitives;
  }
  private removeLiveRevision(revision: WebCookProductRevision): void {
    const index = this.#liveRevisions.indexOf(revision);
    if (index >= 0) this.#liveRevisions.splice(index, 1);
  }
  private releaseRevision(revision: WebCookProductRevision): void {
    if (this.#releasedRevisions.has(revision)) return;
    this.#releasedRevisions.add(revision);
    revision.release();
  }
  private validateRevision(revision: WebCookProductRevision): void {
    if (
      revision.productId.byteLength !== 32 ||
      !Number.isInteger(revision.revision) ||
      revision.revision < 0 ||
      revision.revision === 0xffffffff ||
      !Number.isInteger(revision.pageCount) ||
      revision.pageCount <= 0
    )
      throw new Error("Web Cook revision identity/count is invalid");
    const descriptor = decodeGeometryProductDescriptorBinaryV1(revision.descriptor);
    if (
      descriptor.revision !== revision.revision ||
      !sameBytes(descriptor.productId, revision.productId) ||
      descriptor.pageRecords.byteLength / 32 !== revision.pageCount
    )
      throw new Error("Web Cook descriptor and revision identity/count disagree");
    if (revision.sceneAssetIndices !== undefined) {
      const assetCount = descriptor.assetRecords.byteLength / OEGPACK_V3_ASSET_STRIDE;
      if (
        revision.sceneAssetIndices.length !== assetCount ||
        revision.sceneAssetIndices.some((index) => !Number.isSafeInteger(index) || index < 0)
      )
        throw new Error("Web Cook revision sceneAssetIndices are invalid");
    }
  }
  private priorityFor(unit: GlbCookPrimitive): number {
    const keys = [
      `${unit.nodeIndex}:${unit.meshIndex}:${unit.primitiveIndex}`,
      `${unit.meshIndex}:${unit.primitiveIndex}`,
      `${unit.nodeIndex}`,
    ];
    let score = 0;
    for (const key of keys) score = Math.max(score, this.#sourcePriorities.get(key)?.score ?? 0);
    return score;
  }
  private selectBootstrapUnits(units: readonly GlbCookPrimitive[]): readonly GlbCookPrimitive[] {
    const custom = this.#options.selectBootstrap;
    const configured = custom ? undefined : this.#options.bootstrapUnitCount;
    if (configured !== undefined && (!Number.isSafeInteger(configured) || configured <= 0))
      throw new RangeError("bootstrapUnitCount must be a positive safe integer");
    const maxBytes = this.#options.bootstrapMaxSourceBytes;
    // An explicit unit count limits the cut size, but still uses the same
    // current-view priority plus spatial relevance ranking as the automatic
    // selector. A caller can pin an exact set through `selectBootstrap`.
    const candidates =
      configured !== undefined
        ? defaultBootstrapSelection(units, (unit) => this.priorityFor(unit)).slice(0, configured)
        : custom
          ? // A custom selector's own order is the caller's expressed intent, so it
            // is kept for the byte-cap walk below and only the chosen set is put
            // back into catalog order for a deterministic result.
            [...custom(this.#catalog!)]
          : defaultBootstrapSelection(units, (unit) => this.priorityFor(unit));
    const selected: GlbCookPrimitive[] = [];
    for (const unit of candidates) {
      const nextBytes = estimateLiveSourceBytes(this.#options.cooker, [...selected, unit]);
      if (maxBytes !== undefined && nextBytes > maxBytes) {
        if (selected.length === 0)
          throw new Error(`visible-first bootstrap source exceeds bootstrapMaxSourceBytes=${maxBytes}`);
        break;
      }
      selected.push(unit);
    }
    if (selected.length === 0) throw new Error("Web Cook catalog contains no bootstrap unit");
    selected.sort(comparePrimitiveOrder);
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
    const creditWaitStartedAt = Date.now();
    await this.waitForOutputCredit(WEB_COOK_PAGE_BYTES);
    this.#activationCreditWaitMs += Date.now() - creditWaitStartedAt;
    if (this.#abort.signal.aborted) throw this.#abort.signal.reason ?? new Error("Web Cook was cancelled");
    const readStartedAt = Date.now();
    const page = await revision.readPage(pageId);
    this.#activationReadMs += Date.now() - readStartedAt;
    if (page.pageId !== pageId || page.bytes.byteLength !== WEB_COOK_PAGE_BYTES)
      throw new Error(
        `Web Cook producer returned the wrong page (revision ${revision.revision}, requested page ${pageId}, got page ${page.pageId} with ${page.bytes.byteLength} bytes, expected ${WEB_COOK_PAGE_BYTES})`,
      );
    this.#deliveredPageKeys.add(`${revisionKey(revision.productId, revision.revision)}:${pageId}`);
    if (
      !this.publish(
        this.header({
          type: "PageReady",
          productId: revision.productId.slice(),
          revision: revision.revision,
          pageId,
          decodedHash128: page.decodedHash128,
          decodedPageHash128: page.decodedPageHash128,
          bytes: page.bytes,
        }),
      )
    )
      throw new Error("Web Cook output credit changed before PageReady emission");
    this.#emittedPages++;
  }
  /** Marks the activation cut of one revision fully streamed and re-readable. */
  private markActivationStreamed(revision: WebCookProductRevision): void {
    this.#activationStreamed.set(revisionKey(revision.productId, revision.revision), true);
  }
  private async waitForOutputCredit(bytes: number): Promise<void> {
    while (!this.#session.canEmitPage(bytes)) {
      if (this.#abort.signal.aborted || this.#state === "disposed" || this.#state === "failed")
        throw this.#abort.signal.reason ?? new Error("Web Cook stopped while awaiting output credit");
      await new Promise<void>((resolve) => this.#creditWaiters.add(resolve));
    }
  }
  private requireState(state: WebCookCoordinatorEvidence["state"]): void {
    if (this.#state !== state)
      throw new Error(`WebCookCoordinator expected state '${state}', got '${this.#state}'`);
  }
  private publish(event: WebCookEvent): boolean {
    const accepted = this.#session.emit(event);
    this.#options.onEvent?.();
    return accepted;
  }
  private header<const T extends Record<string, unknown>>(
    message: T,
  ): T & { protocolVersion: 1; sessionId: string; sessionGeneration: number } {
    return Object.assign(
      {
        protocolVersion: WEB_COOK_PROTOCOL_VERSION as 1,
        sessionId: this.sessionId,
        sessionGeneration: this.#session.sessionGeneration,
      },
      message,
    );
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false;
  return true;
}
function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // The completion barrier is awaited in `cookBootstrap`, but a rejection is
  // also rethrown from the producer callback, and the two paths can race. This
  // no-op handler keeps an unobserved rejection from surfacing as unhandled.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
function revisionKey(productId: Uint8Array, revision: number): string {
  return `${Array.from(productId, (value) => value.toString(16).padStart(2, "0")).join("")}:${revision}`;
}
function estimateSourceBytes(units: readonly GlbCookPrimitive[]): number {
  const ranges = new Map<string, GlbByteRange>();
  for (const unit of units)
    for (const range of unit.ranges)
      ranges.set(`${range.bufferIndex}:${range.byteOffset}:${range.byteLength}`, range);
  return [...ranges.values()].reduce((sum, range) => sum + range.byteLength, 0);
}

function estimateLiveSourceBytes(cooker: WebRuntimeCooker, units: readonly GlbCookPrimitive[]): number {
  const estimated = cooker.estimateLiveSourceBytes?.(units) ?? estimateSourceBytes(units);
  if (!Number.isSafeInteger(estimated) || estimated < 0)
    throw new RangeError("Web Cook live source estimate must be a non-negative safe integer");
  return estimated;
}

function assertLiveSourceBudget(
  bytes: number,
  budgets: WebCookBudgets,
  label: string,
  bounded: boolean,
): void {
  // maxSourceBytes is reserved by the session/global ledger as live-window
  // capacity. It must not be reapplied to an unbounded producer's catalog
  // total range estimate. A producer that declares a live bound must fit that
  // bound in both the source ledger and the WASM admission budget.
  if (bounded && bytes > budgets.maxSourceBytes)
    throw new Error(`${label} exceeds maxSourceBytes=${budgets.maxSourceBytes}`);
  if (bytes > budgets.maxWasmBytes) throw new Error(`${label} exceeds maxWasmBytes=${budgets.maxWasmBytes}`);
}

function primitiveKey(unit: GlbCookPrimitive): string {
  return `${unit.nodeIndex}:${unit.meshIndex}:${unit.primitiveIndex}`;
}
function comparePrimitiveOrder(left: GlbCookPrimitive, right: GlbCookPrimitive): number {
  return (
    left.nodeIndex - right.nodeIndex ||
    left.meshIndex - right.meshIndex ||
    left.primitiveIndex - right.primitiveIndex
  );
}

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
 * The caller's `sourcePriorities` are a camera-aware ranking of the catalog and
 * therefore dominate: the first frame should carry what the default view
 * actually sees. Spatial coverage is the fallback for the common case where no
 * priority was set, because the catalog's own order is node/mesh/primitive and
 * has no relation to visibility: node 0 can be a single pillar while the
 * surrounding level lives in later nodes. Catalog order settles the remaining
 * ties, and units whose glTF POSITION bounds are unavailable score as
 * worst-case coverage so a legacy asset stays deterministic.
 *
 * Ordering by priority here is not sufficient on its own: the caller's
 * priorities only reach this function if the catalog handshake completed, which
 * is why `CommitCatalogPriorities` exists on the Worker boundary.
 */
function defaultBootstrapSelection(
  units: readonly GlbCookPrimitive[],
  priorityOf: (unit: GlbCookPrimitive) => number,
): readonly GlbCookPrimitive[] {
  const ranked = units.map((unit, index) => ({
    unit,
    index,
    coverage: bootstrapCoverage(unit),
    priority: priorityOf(unit),
  }));
  ranked.sort(
    (left, right) =>
      right.priority - left.priority || right.coverage - left.coverage || left.index - right.index,
  );
  const selected = ranked
    .slice(0, Math.min(DEFAULT_BOOTSTRAP_UNIT_LIMIT, ranked.length))
    .map((entry) => entry.unit);
  selected.sort(comparePrimitiveOrder);
  return selected;
}

function bootstrapCoverage(unit: GlbCookPrimitive): number {
  const min = unit.boundsMin,
    max = unit.boundsMax;
  // POSITION min/max are optional in glTF. Missing bounds mean unknown extent,
  // not zero extent, so they must never outrank a measured primitive.
  for (let axis = 0; axis < 3; axis++) {
    const low = min[axis]!,
      high = max[axis]!;
    if (!Number.isFinite(low) || !Number.isFinite(high) || high < low) return -1;
  }
  const extent = Math.max(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!);
  if (!(extent > 0)) return 0;
  return extent * unit.instanceNodeIndices.length;
}

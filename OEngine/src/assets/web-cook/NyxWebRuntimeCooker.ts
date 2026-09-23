import { createGeometryCookRecipeV3, type GeometryCookRecipeV3 } from "../GeometryCookRecipe.js";
import { cookWasmGeometryProductRevisionV1, planWasmGeometryProductRevisionV1, planWasmGeometryProductRevisionWindowsV1, type WasmGeometryProductRevisionV1 } from "../geometry-product/WasmGeometryProductV1.js";
import type { WebCookProductRevision, WebCookUnitContext, WebRuntimeCooker } from "./WebCookCoordinator.js";
import { canonicalizeGlbPrimitiveV1 } from "./gltf/GlbPrimitiveCanonicalizer.js";
import {
  WEB_GEOMETRY_PAGE_BYTES,
  encodeWebCanonicalGeometryV1,
  encodeWebGeometryCookRecipeV1,
  type EmscriptenWebGeometryCookerModuleV1
} from "./wasm/WebGeometryCookerAbi.js";
import type { GlbCookPrimitive } from "../../loaders/gltf/streaming/GlbSceneCatalog.js";
import { prefetchCoalescedRangeGroups, type CoalescedRangeReaderOptions } from "./CoalescedRangeReader.js";
import {
  estimateCanonicalBytes,
  estimateProductWorkV1,
  estimateSourceBytes,
  exceedsProductWorkBudgetV1,
  planCanonicalWindows,
  validateProductWorkBudgetV1,
  type CanonicalWindowPlan,
  type ProductWorkBudgetV1
} from "./CanonicalWindowPlanner.js";
import {
  WEB_SPATIAL_SHARD_PARTITION_VERSION,
  canonicalizeGlbPrimitiveSpatialShardIndicesV1,
  materializeGlbPrimitiveSpatialShardsV1,
  planGlbPrimitiveSpatialShardsV1,
  type GlbSpatialShardSetV1
} from "./SpatialShardPlanner.js";
import type { WebGeometryPageSpillStoreV1 } from "../geometry-product/WebGeometryPageSpillStoreV1.js";
import type {
  WebCookProductTaskIdentityV1,
  WebCookProductTaskMetricsV1,
  WebCookProductTaskPhase,
  WebCookProductTaskTraceEventV1,
  WebCookProductTaskTraceListener
} from "./ProductTaskTrace.js";

export const NYX_WEB_RUNTIME_PRODUCER_ID = "oengine-nyx-web-runtime";
export const NYX_WEB_RUNTIME_PRODUCER_VERSION = "nyx-b749346382b0-web-cooker-abi1-product-v2-scope";
/**
 * Producer version for plan-backed revisions.
 *
 * A plan-backed revision cannot carry the manifest-backed ProductID: the content
 * manifest covers every page payload, so it does not exist while pages are still
 * PENDING. Folding the phase into the version keeps the two phases from ever
 * claiming the same identity for different evidence.
 */
export const NYX_WEB_RUNTIME_PLAN_PRODUCER_VERSION = "nyx-b749346382b0-web-cooker-abi2-plan-v2-scope";
export const WEB_COOK_DEFAULT_MAX_TRIANGLES_PER_PRODUCT = 128 * 1024;
export const WEB_COOK_DEFAULT_MAX_VERTICES_PER_PRODUCT = 512 * 1024;
export const WEB_COOK_DEFAULT_MAX_DOMAINS_PER_PRODUCT = 64;

/**
 * Coarse bootstrap profile. It stops simplification earlier than the full
 * recipe, so the first complete activation cut is resident sooner while the
 * richer revision converges in the background.
 */
const DEFAULT_BOOTSTRAP_RECIPE: Partial<GeometryCookRecipeV3> = Object.freeze({ minimumLodReduction: 0.35 });

export interface NyxWebRuntimeCookerOptions {
  readonly recipe?: Partial<GeometryCookRecipeV3>;
  readonly maxCanonicalInputBytes: number;
  readonly maxSourceWindowBytes?: number;
  readonly maxDecodedProductBytes: number;
  readonly maxTrianglesPerProduct?: number;
  readonly maxVerticesPerProduct?: number;
  readonly maxDomainsPerProduct?: number;
  /** Coarse bootstrap recipe; the richer revision uses `recipe`. */
  readonly bootstrapRecipe?: Partial<GeometryCookRecipeV3>;
  /** Coalesced GLB range block budget (defaults to 1 MiB). */
  readonly rangeBlockBytes?: number;
  /** Maximum unused gap merged into one range block (defaults to 64 KiB). */
  readonly rangeMaxGapBytes?: number;
  /** Maximum in-flight GLB range reads (defaults to 4). */
  readonly rangeConcurrency?: number;
  /** Optional page artifact sink. When present, plan pages are re-readable from spill. */
  readonly spillStore?: WebGeometryPageSpillStoreV1;
  /** Session generation included in every spill key to reject late writes. */
  readonly sessionGeneration?: number;
}

export interface NyxWebRuntimeCookerEvidence {
  readonly [key: string]: number;
  readonly maxSourceWindowBytes: number;
  readonly maxCanonicalWindowBytes: number;
  readonly currentSourceWindowBytes: number;
  readonly peakSourceWindowBytes: number;
  readonly currentCanonicalWindowBytes: number;
  readonly peakCanonicalWindowBytes: number;
  readonly canonicalWindows: number;
  readonly completedCanonicalWindows: number;
  readonly spatialPrimitives: number;
  readonly spatialShards: number;
  readonly spatialScratchCapacityBytes: number;
  readonly spatialScratchBytes: number;
  readonly spatialScratchPeakBytes: number;
  readonly spatialScanPasses: number;
  readonly spillCurrentBytes: number;
  readonly spillPeakBytes: number;
  readonly spillLimitBytes: number;
  readonly spillOwnerCount: number;
  readonly spillWrites: number;
  readonly spillReads: number;
  readonly spillReleases: number;
}

interface PreparedSpatialUnit {
  readonly unit: GlbCookPrimitive;
  readonly sceneAssetIndex: number;
  readonly spatial?: GlbSpatialShardSetV1;
}

interface ActiveProductTask {
  identity: WebCookProductTaskIdentityV1;
  readonly startedAt: number;
  readonly phaseStartedAt: Partial<Record<WebCookProductTaskPhase, number>>;
  readonly metrics: { canonicalizeMs: number; wasmPlanMs: number; spillMs: number; publishMs: number; pageCount: number; spillBytes: number; spillCurrentBytes: number; spillPeakBytes: number; spillLimitBytes: number };
  terminal: boolean;
}

/** Browser-first Nyx producer. It owns no GPU object and emits only Product bytes. */
export class NyxWebRuntimeCooker implements WebRuntimeCooker {
  readonly requiredIndependentProducts = true;
  readonly #module: EmscriptenWebGeometryCookerModuleV1;
  readonly #recipeInput: ArrayBuffer;
  readonly #bootstrapRecipeInput: ArrayBuffer;
  readonly #maxCanonicalInputBytes: number;
  readonly #maxSourceWindowBytes: number;
  readonly #maxDecodedProductBytes: number;
  readonly #workBudget: ProductWorkBudgetV1;
  readonly #rangeOptions: CoalescedRangeReaderOptions;
  #currentSourceWindowBytes = 0;
  #peakSourceWindowBytes = 0;
  #currentCanonicalWindowBytes = 0;
  #peakCanonicalWindowBytes = 0;
  #canonicalWindows = 0;
  #completedCanonicalWindows = 0;
  #spatialPrimitives = 0;
  #spatialShards = 0;
  #spatialScratchBytes = 0;
  #spatialScratchPeakBytes = 0;
  #spatialScanPasses = 0;
  readonly #spillStore: WebGeometryPageSpillStoreV1 | undefined;
  readonly #sessionGeneration: number | undefined;
  #taskTraceListener: WebCookProductTaskTraceListener | undefined;
  #nextProductOrdinal = 0;
  readonly #revisionTasks = new WeakMap<WebCookProductRevision, ActiveProductTask>();

  constructor(module: EmscriptenWebGeometryCookerModuleV1, options: NyxWebRuntimeCookerOptions) {
    if (!Number.isSafeInteger(options.maxCanonicalInputBytes) || options.maxCanonicalInputBytes <= 0) throw new RangeError("maxCanonicalInputBytes must be a positive safe integer");
    if (!Number.isSafeInteger(options.maxDecodedProductBytes) || options.maxDecodedProductBytes < WEB_GEOMETRY_PAGE_BYTES) throw new RangeError("maxDecodedProductBytes must admit at least one page");
    this.#module = module;
    this.#recipeInput = encodeWebGeometryCookRecipeV1(createGeometryCookRecipeV3(options.recipe));
    this.#bootstrapRecipeInput = encodeWebGeometryCookRecipeV1(createGeometryCookRecipeV3({ ...(options.recipe ?? {}), ...DEFAULT_BOOTSTRAP_RECIPE, ...(options.bootstrapRecipe ?? {}) }));
    this.#maxCanonicalInputBytes = options.maxCanonicalInputBytes;
    this.#maxSourceWindowBytes = options.maxSourceWindowBytes ?? options.maxCanonicalInputBytes;
    if (!Number.isSafeInteger(this.#maxSourceWindowBytes) || this.#maxSourceWindowBytes <= 0) throw new RangeError("maxSourceWindowBytes must be a positive safe integer");
    this.#maxDecodedProductBytes = options.maxDecodedProductBytes;
    this.#workBudget = Object.freeze({
      maxSourceBytes: this.#maxSourceWindowBytes,
      maxCanonicalBytes: this.#maxCanonicalInputBytes,
      maxTriangles: options.maxTrianglesPerProduct ?? WEB_COOK_DEFAULT_MAX_TRIANGLES_PER_PRODUCT,
      maxVertices: options.maxVerticesPerProduct ?? WEB_COOK_DEFAULT_MAX_VERTICES_PER_PRODUCT,
      maxDomains: options.maxDomainsPerProduct ?? WEB_COOK_DEFAULT_MAX_DOMAINS_PER_PRODUCT
    });
    validateProductWorkBudgetV1(this.#workBudget);
    this.#spillStore = options.spillStore;
    this.#sessionGeneration = options.sessionGeneration;
    this.#rangeOptions = Object.freeze({
      maxBlockBytes: options.rangeBlockBytes ?? 1024 * 1024,
      maxGapBytes: options.rangeMaxGapBytes ?? 64 * 1024,
      concurrency: options.rangeConcurrency ?? 4
    });
  }

  evidence(): NyxWebRuntimeCookerEvidence {
    return Object.freeze({
      maxSourceWindowBytes: this.#maxSourceWindowBytes,
      wasmMemoryBytes: this.#module.HEAPU8.byteLength,
      maxCanonicalWindowBytes: this.#maxCanonicalInputBytes,
      maxTrianglesPerProduct: this.#workBudget.maxTriangles,
      maxVerticesPerProduct: this.#workBudget.maxVertices,
      maxDomainsPerProduct: this.#workBudget.maxDomains,
      currentSourceWindowBytes: this.#currentSourceWindowBytes,
      peakSourceWindowBytes: this.#peakSourceWindowBytes,
      currentCanonicalWindowBytes: this.#currentCanonicalWindowBytes,
      peakCanonicalWindowBytes: this.#peakCanonicalWindowBytes,
      canonicalWindows: this.#canonicalWindows,
      completedCanonicalWindows: this.#completedCanonicalWindows,
      spatialPrimitives: this.#spatialPrimitives,
      spatialShards: this.#spatialShards,
      spatialScratchCapacityBytes: this.#maxSourceWindowBytes,
      spatialScratchBytes: this.#spatialScratchBytes,
      spatialScratchPeakBytes: this.#spatialScratchPeakBytes,
      spatialScanPasses: this.#spatialScanPasses,
      spillCurrentBytes: this.#spillStore?.evidence().currentBytes ?? 0,
      spillPeakBytes: this.#spillStore?.evidence().peakBytes ?? 0,
      spillLimitBytes: this.#spillStore?.evidence().limitBytes ?? 0,
      spillOwnerCount: this.#spillStore?.evidence().ownerCount ?? 0,
      spillWrites: this.#spillStore?.evidence().writes ?? 0,
      spillReads: this.#spillStore?.evidence().reads ?? 0,
      spillReleases: this.#spillStore?.evidence().releases ?? 0
    });
  }

  setTaskTraceListener(listener: WebCookProductTaskTraceListener | undefined): void { this.#taskTraceListener = listener; }

  /**
   * Coordinator admission must use the bounded live source window rather than
   * the total accessor ranges of a giant primitive. Every Nyx path either fits
   * in one window or expands the primitive into spatial shards before reading.
   */
  estimateLiveSourceBytes(units: readonly GlbCookPrimitive[]): number {
    return units.length === 0 ? 0 : Math.min(this.#maxSourceWindowBytes, estimateSourceBytes(units));
  }

  async cookBootstrap(unit: GlbCookPrimitive, context: WebCookUnitContext): Promise<WebCookProductRevision> {
    return this.cookDomains([unit], context, [catalogIndexFor(unit, context)]);
  }

  async cookBootstrapBatch(units: readonly GlbCookPrimitive[], context: WebCookUnitContext): Promise<WebCookProductRevision> {
    if (units.length === 0) throw new Error("Nyx Web Product requires at least one GLB primitive");
    // Product asset index == canonical domain index == catalog primitive index.
    // Re-sort on the catalog's stable key so a priority reorder cannot change
    // the published asset order the scene publication side maps against.
    const ordered = [...units].sort(compareCookPrimitiveOrder);
    return this.cookDomains(ordered, context, ordered.map((unit, index) => catalogIndexFor(unit, context, index)));
  }

  private async canonicalizeWindow(window: CanonicalWindowPlan, context: WebCookUnitContext): Promise<ArrayBuffer> {
    // Plan every unit's ranges in one pass. A GLB packs accessors contiguously,
    // so per-unit planning turned one contiguous span into one HTTP range per
    // unit; a global plan collapses it to the block count `maxBlockBytes` allows.
    const units = window.units;
    const groups = units.map(unit => unit.ranges);
    const readers = await prefetchCoalescedRangeGroups(groups, range => context.readRange(range), context.signal, this.#rangeOptions);
    const fetchedBytes = readers[0]?.evidence.fetchedBytes ?? 0;
    if (fetchedBytes > this.#maxSourceWindowBytes) throw new Error(`source window exceeds maxSourceWindowBytes=${this.#maxSourceWindowBytes}`);
    this.#currentSourceWindowBytes = fetchedBytes;
    this.#peakSourceWindowBytes = Math.max(this.#peakSourceWindowBytes, fetchedBytes);
    try {
      const domains: Array<Awaited<ReturnType<typeof canonicalizeGlbPrimitiveV1>> | undefined> = new Array(units.length);
      // Results are written back by stable unit index, so changing concurrency
      // cannot change Nyx canonical input order.
      let nextUnit = 0;
      const worker = async (): Promise<void> => {
        while (true) {
          const index = nextUnit++;
          if (index >= units.length) return;
          domains[index] = await canonicalizeGlbPrimitiveV1(units[index]!, readers[index]!);
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.#rangeOptions.concurrency, units.length) }, () => worker()));
      if (context.signal.aborted) throw context.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      const canonicalInput = encodeWebCanonicalGeometryV1(domains.map(domain => domain!));
      if (canonicalInput.byteLength > this.#maxCanonicalInputBytes) throw new Error(`canonical cook input exceeds maxCanonicalInputBytes=${this.#maxCanonicalInputBytes}`);
      if (canonicalInput.byteLength !== window.canonicalBytes) throw new Error(`canonical window estimate ${window.canonicalBytes} differs from encoded ${canonicalInput.byteLength}`);
      this.#canonicalWindows++;
      this.#currentCanonicalWindowBytes = canonicalInput.byteLength;
      this.#peakCanonicalWindowBytes = Math.max(this.#peakCanonicalWindowBytes, canonicalInput.byteLength);
      return canonicalInput;
    } finally {
      this.#currentSourceWindowBytes = 0;
    }
  }

  private releaseCanonicalWindow(): void {
    if (this.#currentCanonicalWindowBytes === 0) return;
    this.#currentCanonicalWindowBytes = 0;
    this.#completedCanonicalWindows++;
  }

  private async consumeCanonicalWindow<T>(window: CanonicalWindowPlan, context: WebCookUnitContext, consume: (canonical: ArrayBuffer) => Promise<T>): Promise<T> {
    const canonical = await this.canonicalizeWindow(window, context);
    try { return await consume(canonical); }
    finally { this.releaseCanonicalWindow(); }
  }

  private windows(units: readonly GlbCookPrimitive[]): readonly CanonicalWindowPlan[] { return planCanonicalWindows(units, this.#workBudget); }

  private requiresSpatialSharding(unit: GlbCookPrimitive): boolean {
    return exceedsProductWorkBudgetV1(estimateProductWorkV1([unit]), this.#workBudget);
  }

  private async prepareSpatialUnits(units: readonly GlbCookPrimitive[], context: WebCookUnitContext, sceneAssetIndices: readonly number[]): Promise<readonly PreparedSpatialUnit[]> {
    if (units.length !== sceneAssetIndices.length) throw new Error("Nyx Web spatial source mapping is invalid");
    const prepared: PreparedSpatialUnit[] = [];
    for (let index = 0; index < units.length; index++) {
      const unit = units[index]!, sceneAssetIndex = sceneAssetIndices[index]!;
      if (!this.requiresSpatialSharding(unit)) { prepared.push(Object.freeze({ unit, sceneAssetIndex })); continue; }
      const spatial = await planGlbPrimitiveSpatialShardsV1(unit, { signal: context.signal, readRange: range => context.readRange(range) }, {
        maxSourceWindowBytes: this.#maxSourceWindowBytes,
        maxCanonicalWindowBytes: this.#maxCanonicalInputBytes,
        maximumTrianglesPerShard: this.#workBudget.maxTriangles,
        maximumVerticesPerShard: this.#workBudget.maxVertices,
        sourceIdentityHash: context.source.sourceIdentity.hash
      });
      this.#spatialPrimitives++;
      this.#spatialShards += spatial.shards.length;
      this.#peakSourceWindowBytes = Math.max(this.#peakSourceWindowBytes, spatial.peakSourceWindowBytes);
      prepared.push(Object.freeze({ unit, sceneAssetIndex, spatial }));
    }
    return Object.freeze(prepared);
  }

  private async *preparedCanonicalWindows(prepared: readonly PreparedSpatialUnit[], context: WebCookUnitContext): AsyncGenerator<ArrayBuffer> {
    let whole: GlbCookPrimitive[] = [];
    const flushWhole = async function* (owner: NyxWebRuntimeCooker): AsyncGenerator<ArrayBuffer> {
      if (whole.length === 0) return;
      for (const window of owner.windows(whole)) {
        const canonical = await owner.canonicalizeWindow(window, context);
        try { yield canonical; }
        finally { owner.releaseCanonicalWindow(); }
      }
      whole = [];
    };
    for (const item of prepared) {
      if (!item.spatial) { whole.push(item.unit); continue; }
      yield* flushWhole(this);
      const materialized = await materializeGlbPrimitiveSpatialShardsV1(item.unit, item.spatial, { signal: context.signal, readRange: range => context.readRange(range) }, this.#maxSourceWindowBytes, this.#maxSourceWindowBytes);
      this.#spatialScratchBytes = materialized.scratchBytes;
      this.#spatialScratchPeakBytes = Math.max(this.#spatialScratchPeakBytes, materialized.scratchBytes);
      this.#spatialScanPasses += materialized.scanPasses;
      try {
        for (let shardIndex = 0; shardIndex < item.spatial.shards.length; shardIndex++) {
          const shard = item.spatial.shards[shardIndex]!;
          const domain = await canonicalizeGlbPrimitiveSpatialShardIndicesV1(item.unit, item.spatial, shard, materialized.readShard(shardIndex), { signal: context.signal, readRange: range => context.readRange(range) }, this.#maxSourceWindowBytes);
          const canonical = encodeWebCanonicalGeometryV1([domain]);
          if (canonical.byteLength > this.#maxCanonicalInputBytes) throw new Error(`spatial canonical shard ${shard.shardId} exceeds maxCanonicalInputBytes=${this.#maxCanonicalInputBytes}`);
          this.#canonicalWindows++;
          this.#currentCanonicalWindowBytes = canonical.byteLength;
          this.#peakCanonicalWindowBytes = Math.max(this.#peakCanonicalWindowBytes, canonical.byteLength);
          try { yield canonical; }
          finally { this.releaseCanonicalWindow(); }
        }
      } finally {
        this.#spatialScratchBytes = 0;
        await materialized.dispose();
      }
    }
    yield* flushWhole(this);
  }

  private async planWindowedCanonical(
    units: readonly GlbCookPrimitive[], context: WebCookUnitContext, recipeInput: ArrayBuffer, revision: number,
    replaces?: { readonly productId: Uint8Array; readonly revision: number }, sceneAssetIndices?: readonly number[]
  ): Promise<WasmGeometryProductRevisionV1> {
    if (units.some(unit => this.requiresSpatialSharding(unit))) {
      const sourceIndices = sceneAssetIndices ?? units.map((unit, index) => catalogIndexFor(unit, context, index));
      const prepared = await this.prepareSpatialUnits(units, context, sourceIndices);
      const expandedSceneAssetIndices = prepared.flatMap(item => item.spatial === undefined ? [item.sceneAssetIndex] : item.spatial.shards.map(() => item.sceneAssetIndex));
      return planWasmGeometryProductRevisionWindowsV1(this.#module, this.preparedCanonicalWindows(prepared, context), recipeInput, {
        producerId: NYX_WEB_RUNTIME_PRODUCER_ID,
        producerVersion: `${NYX_WEB_RUNTIME_PLAN_PRODUCER_VERSION};partition=${WEB_SPATIAL_SHARD_PARTITION_VERSION};source=${this.#maxSourceWindowBytes};canonical=${this.#maxCanonicalInputBytes}`,
        sourceIdentityKind: context.source.sourceIdentity.kind,
        sourceIdentityHash: context.source.sourceIdentity.hash,
        signal: context.signal,
        revision,
        ...(replaces === undefined ? {} : { replaces }),
        maxDecodedProductBytes: this.#maxDecodedProductBytes,
        sceneAssetIndices: expandedSceneAssetIndices,
        ...(this.#spillStore === undefined ? {} : { spillStore: this.#spillStore }),
        ...(this.spillGeneration(context) === undefined ? {} : { sessionGeneration: this.spillGeneration(context) })
      });
    }
    const windows = this.windows(units);
    if (windows.length === 1) return this.consumeCanonicalWindow(windows[0]!, context, canonical => this.planCanonical(canonical, context, recipeInput, revision, replaces, sceneAssetIndices));
    const canonicalWindows = async function* (owner: NyxWebRuntimeCooker): AsyncGenerator<ArrayBuffer> {
      for (const window of windows) {
        const canonical = await owner.canonicalizeWindow(window, context);
        try { yield canonical; }
        finally { owner.releaseCanonicalWindow(); }
      }
    };
    return planWasmGeometryProductRevisionWindowsV1(this.#module, canonicalWindows(this), recipeInput, {
      producerId: NYX_WEB_RUNTIME_PRODUCER_ID,
      producerVersion: NYX_WEB_RUNTIME_PLAN_PRODUCER_VERSION,
      sourceIdentityKind: context.source.sourceIdentity.kind,
      sourceIdentityHash: context.source.sourceIdentity.hash,
      signal: context.signal,
      revision,
      ...(replaces === undefined ? {} : { replaces }),
      maxDecodedProductBytes: this.#maxDecodedProductBytes,
      sceneAssetIndices,
      ...(this.#spillStore === undefined ? {} : { spillStore: this.#spillStore }),
      ...(this.spillGeneration(context) === undefined ? {} : { sessionGeneration: this.spillGeneration(context) })
    });
  }

  private async cookCanonical(
    canonicalInput: ArrayBuffer,
    context: WebCookUnitContext,
    recipeInput: ArrayBuffer,
    revision: number,
    replaces?: { readonly productId: Uint8Array; readonly revision: number },
    sceneAssetIndices?: readonly number[]
  ): Promise<WasmGeometryProductRevisionV1> {
    return cookWasmGeometryProductRevisionV1(this.#module, canonicalInput, recipeInput, {
      producerId: NYX_WEB_RUNTIME_PRODUCER_ID,
      producerVersion: NYX_WEB_RUNTIME_PRODUCER_VERSION,
      sourceIdentityKind: context.source.sourceIdentity.kind,
      sourceIdentityHash: context.source.sourceIdentity.hash,
      signal: context.signal,
      revision,
      ...(replaces === undefined ? {} : { replaces }),
      maxDecodedProductBytes: this.#maxDecodedProductBytes,
      sceneAssetIndices,
      ...(this.#spillStore === undefined ? {} : { spillStore: this.#spillStore }),
      ...(this.spillGeneration(context) === undefined ? {} : { sessionGeneration: this.spillGeneration(context) })
    });
  }

  private spillGeneration(context: WebCookUnitContext): number | undefined { return context.sessionGeneration ?? this.#sessionGeneration; }

  /**
   * Freezes the descriptor without producing any page payload.
   *
   * This is the two-phase entry: the returned revision already carries the
   * complete ID graph - page count, per-PageID identity, Group mapping and the
   * activation cut - while every payload is still PENDING. The downstream
   * coordinator publishes the descriptor and then produces only the activation
   * cut, so a rich revision no longer has to be cooked in full before anything
   * becomes visible.
   */
  private async planCanonical(
    canonicalInput: ArrayBuffer,
    context: WebCookUnitContext,
    recipeInput: ArrayBuffer,
    revision: number,
    replaces?: { readonly productId: Uint8Array; readonly revision: number },
    sceneAssetIndices?: readonly number[],
    producerVersion = NYX_WEB_RUNTIME_PLAN_PRODUCER_VERSION,
    partitionIdentity?: string
  ): Promise<WasmGeometryProductRevisionV1> {
    return planWasmGeometryProductRevisionV1(this.#module, canonicalInput, recipeInput, {
      producerId: NYX_WEB_RUNTIME_PRODUCER_ID,
      producerVersion,
      partitionIdentity,
      sourceIdentityKind: context.source.sourceIdentity.kind,
      sourceIdentityHash: context.source.sourceIdentity.hash,
      signal: context.signal,
      revision,
      ...(replaces === undefined ? {} : { replaces }),
      maxDecodedProductBytes: this.#maxDecodedProductBytes,
      sceneAssetIndices,
      ...(this.#spillStore === undefined ? {} : { spillStore: this.#spillStore }),
      ...(this.spillGeneration(context) === undefined ? {} : { sessionGeneration: this.spillGeneration(context) })
    });
  }

  private async cookDomains(units: readonly GlbCookPrimitive[], context: WebCookUnitContext, sceneAssetIndices: readonly number[]): Promise<WasmGeometryProductRevisionV1> {
    if (units.some(unit => this.requiresSpatialSharding(unit))) return this.planWindowedCanonical(units, context, this.#recipeInput, 0, undefined, sceneAssetIndices);
    const windows = this.windows(units);
    if (windows.length === 1) return this.consumeCanonicalWindow(windows[0]!, context, canonical => this.cookCanonical(canonical, context, this.#recipeInput, 0, undefined, sceneAssetIndices));
    return this.planWindowedCanonical(units, context, this.#recipeInput, 0, undefined, sceneAssetIndices);
  }

  private beginTask(input: Omit<WebCookProductTaskIdentityV1, "taskId" | "productOrdinal" | "limits">): ActiveProductTask {
    const productOrdinal = this.#nextProductOrdinal++;
    const task: ActiveProductTask = {
      identity: Object.freeze({ ...input, taskId: `product-${productOrdinal}`, productOrdinal, limits: this.#workBudget }),
      startedAt: taskNow(),
      phaseStartedAt: {},
      metrics: { canonicalizeMs: 0, wasmPlanMs: 0, spillMs: 0, publishMs: 0, pageCount: 0, spillBytes: 0, spillCurrentBytes: 0, spillPeakBytes: 0, spillLimitBytes: this.#spillStore?.evidence().limitBytes ?? 0 },
      terminal: false
    };
    this.emitTask(task, "task-started");
    return task;
  }

  private updateTaskGeometry(task: ActiveProductTask, canonicalBytes: number, vertices: number): void {
    task.identity = Object.freeze({ ...task.identity, canonicalBytes, vertices });
  }

  private startTaskPhase(task: ActiveProductTask, phase: WebCookProductTaskPhase): void {
    const startedAt = taskNow();
    task.phaseStartedAt[phase] = startedAt;
    this.emitTask(task, "phase-started", phase, startedAt);
  }

  private completeTaskPhase(task: ActiveProductTask, phase: WebCookProductTaskPhase): void {
    const startedAt = task.phaseStartedAt[phase];
    if (startedAt === undefined) throw new Error(`Product task ${task.identity.taskId} phase '${phase}' was not started`);
    const endedAt = taskNow(), elapsedMs = Math.max(0, endedAt - startedAt);
    if (phase === "canonicalize") task.metrics.canonicalizeMs += elapsedMs;
    else if (phase === "wasm-plan") task.metrics.wasmPlanMs += elapsedMs;
    else if (phase === "spill") task.metrics.spillMs += elapsedMs;
    else task.metrics.publishMs += elapsedMs;
    delete task.phaseStartedAt[phase];
    this.emitTask(task, "phase-completed", phase, startedAt, endedAt);
  }

  private finishTask(task: ActiveProductTask, kind: "completed" | "failed" | "cancelled", error?: unknown): void {
    if (task.terminal) return;
    task.terminal = true;
    this.emitTask(task, kind, undefined, task.startedAt, taskNow(), error);
  }

  private emitTask(
    task: ActiveProductTask,
    kind: WebCookProductTaskTraceEventV1["kind"],
    phase?: WebCookProductTaskPhase,
    startedAt = task.startedAt,
    endedAt?: number,
    error?: unknown
  ): void {
    const metrics: WebCookProductTaskMetricsV1 = Object.freeze({ ...task.metrics });
    const event: WebCookProductTaskTraceEventV1 = Object.freeze({
      schemaVersion: 1,
      kind,
      task: task.identity,
      ...(phase === undefined ? {} : { phase }),
      startedAt,
      ...(endedAt === undefined ? {} : { endedAt, elapsedMs: Math.max(0, endedAt - startedAt) }),
      metrics,
      ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) })
    });
    this.#taskTraceListener?.(event);
  }

  private failTask(task: ActiveProductTask, context: WebCookUnitContext, error: unknown): void {
    if (task.terminal) return;
    task.terminal = true;
    const phase = Object.keys(task.phaseStartedAt)[0] as WebCookProductTaskPhase | undefined;
    this.emitTask(task, context.signal.aborted ? "cancelled" : "failed", phase, task.startedAt, taskNow(), error);
  }

  /**
   * Produces one independently owned Product for every bounded canonical
   * window or spatial shard. The WASM plan never accumulates scene-scale
   * CookedAsset/SerializedGroup state. Publish the activation cut first, then
   * spill the remaining pages before planning the next Product.
   */
  private async *planIndependentProducts(
    units: readonly GlbCookPrimitive[],
    context: WebCookUnitContext,
    recipeInput: ArrayBuffer
  ): AsyncGenerator<WasmGeometryProductRevisionV1> {
    const catalogPrimitives = context.catalog?.primitives ?? units;
    const catalogIndices = new Map(catalogPrimitives.map((unit, index) => [primitiveKey(unit), index]));
    let ordinary: GlbCookPrimitive[] = [];
    const flushOrdinary = async function* (owner: NyxWebRuntimeCooker): AsyncGenerator<WasmGeometryProductRevisionV1> {
      if (ordinary.length === 0) return;
      for (const window of owner.windows(ordinary)) {
        const indices = window.units.map((unit, index) => catalogIndices.get(primitiveKey(unit)) ?? index);
        const task = owner.beginTask({
          primitive: window.units.map(primitiveKey).join("|"),
          sceneAssetIndices: Object.freeze(indices.slice()),
          spatial: false,
          triangles: window.triangleCount,
          vertices: window.vertexCount,
          domains: window.domainCount,
          canonicalBytes: window.canonicalBytes
        });
        let revision: WasmGeometryProductRevisionV1 | undefined;
        try {
          owner.startTaskPhase(task, "canonicalize");
          const canonical = await owner.canonicalizeWindow(window, context);
          owner.completeTaskPhase(task, "canonicalize");
          owner.startTaskPhase(task, "wasm-plan");
          revision = await owner.planCanonical(
            canonical, context, recipeInput, 0, undefined, indices,
            `${NYX_WEB_RUNTIME_PLAN_PRODUCER_VERSION};partition=canonical-window-v2`,
            `canonical-window-v2:${indices.join(",")}`
          );
          owner.completeTaskPhase(task, "wasm-plan");
        } catch (error) {
          revision?.release();
          owner.failTask(task, context, error);
          throw error;
        } finally {
          owner.releaseCanonicalWindow();
        }
        owner.#revisionTasks.set(revision, task);
        yield revision;
      }
      ordinary = [];
    };

    for (const unit of units) {
      if (!this.requiresSpatialSharding(unit)) {
        ordinary.push(unit);
        continue;
      }
      yield* flushOrdinary(this);
      const sceneAssetIndex = catalogIndices.get(primitiveKey(unit));
      if (sceneAssetIndex === undefined) throw new Error("Nyx Web Product shard is not present in the scene catalog");
      const spatial = await planGlbPrimitiveSpatialShardsV1(unit, {
        signal: context.signal,
        readRange: range => context.readRange(range)
      }, {
        maxSourceWindowBytes: this.#maxSourceWindowBytes,
        maxCanonicalWindowBytes: this.#maxCanonicalInputBytes,
        maximumTrianglesPerShard: this.#workBudget.maxTriangles,
        maximumVerticesPerShard: this.#workBudget.maxVertices,
        sourceIdentityHash: context.source.sourceIdentity.hash
      });
      this.#spatialPrimitives++;
      this.#spatialShards += spatial.shards.length;
      this.#peakSourceWindowBytes = Math.max(this.#peakSourceWindowBytes, spatial.peakSourceWindowBytes);
      const materialized = await materializeGlbPrimitiveSpatialShardsV1(unit, spatial, {
        signal: context.signal,
        readRange: range => context.readRange(range)
      }, this.#maxSourceWindowBytes, this.#maxSourceWindowBytes);
      this.#spatialScratchBytes = materialized.scratchBytes;
      this.#spatialScratchPeakBytes = Math.max(this.#spatialScratchPeakBytes, materialized.scratchBytes);
      this.#spatialScanPasses += materialized.scanPasses;
      try {
        for (let shardIndex = 0; shardIndex < spatial.shards.length; shardIndex++) {
          const shard = spatial.shards[shardIndex]!;
          const task = this.beginTask({
            primitive: primitiveKey(unit),
            sceneAssetIndices: Object.freeze([sceneAssetIndex]),
            spatial: true,
            shardOrdinal: shardIndex,
            shardCount: spatial.shards.length,
            triangles: shard.triangleCount,
            vertices: Math.min(unit.vertexCount, shard.triangleCount * 3),
            domains: 1,
            canonicalBytes: shard.estimatedCanonicalBytes
          });
          let revision: WasmGeometryProductRevisionV1 | undefined;
          try {
            this.startTaskPhase(task, "canonicalize");
            const domain = await canonicalizeGlbPrimitiveSpatialShardIndicesV1(unit, spatial, shard, materialized.readShard(shardIndex), {
              signal: context.signal,
              readRange: range => context.readRange(range)
            }, this.#maxSourceWindowBytes);
            const canonical = encodeWebCanonicalGeometryV1([domain]);
            const vertices = domain.vertices.length / 18;
            if (canonical.byteLength > this.#maxCanonicalInputBytes || vertices > this.#workBudget.maxVertices || shard.triangleCount > this.#workBudget.maxTriangles) {
              throw new Error(`spatial canonical shard ${shard.shardId} exceeds Product work budget`);
            }
            this.updateTaskGeometry(task, canonical.byteLength, vertices);
            this.#canonicalWindows++;
            this.#currentCanonicalWindowBytes = canonical.byteLength;
            this.#peakCanonicalWindowBytes = Math.max(this.#peakCanonicalWindowBytes, canonical.byteLength);
            this.completeTaskPhase(task, "canonicalize");
            this.startTaskPhase(task, "wasm-plan");
            revision = await this.planCanonical(
              canonical, context, recipeInput, 0, undefined, [sceneAssetIndex],
              `${NYX_WEB_RUNTIME_PLAN_PRODUCER_VERSION};partition=${WEB_SPATIAL_SHARD_PARTITION_VERSION}`,
              `${WEB_SPATIAL_SHARD_PARTITION_VERSION}:${shard.shardId}`
            );
            this.completeTaskPhase(task, "wasm-plan");
          } catch (error) {
            revision?.release();
            this.failTask(task, context, error);
            throw error;
          } finally {
            this.releaseCanonicalWindow();
          }
          this.#revisionTasks.set(revision, task);
          yield revision;
        }
      } finally {
        this.#spatialScratchBytes = 0;
        await materialized.dispose();
      }
    }
    yield* flushOrdinary(this);
  }

  async cookProgressive(
    units: readonly GlbCookPrimitive[],
    context: WebCookUnitContext,
    onRevision: (revision: WebCookProductRevision) => Promise<void>,
    _onFailure?: (error: Error) => void
  ): Promise<void> {
    if (units.length === 0) throw new Error("Nyx Web Product requires at least one GLB primitive");
    if (this.#spillStore === undefined) throw new Error("Nyx Web progressive Product requires a spill store");
    const bootstrapKeys = new Set((context.bootstrapUnits ?? [units[0]!]).map(primitiveKey));
    const prioritized = [
      ...units.filter(unit => bootstrapKeys.has(primitiveKey(unit))),
      ...units.filter(unit => !bootstrapKeys.has(primitiveKey(unit)))
    ];
    let offered = 0;
    try {
      for await (const revision of this.planIndependentProducts(prioritized, context, this.#recipeInput)) {
        const task = this.#revisionTasks.get(revision);
        try {
          const spillBefore = this.#spillStore.evidence().currentBytes;
          if (task) this.startTaskPhase(task, "publish");
          await onRevision(revision);
          if (task) {
            this.completeTaskPhase(task, "publish");
            this.startTaskPhase(task, "spill");
          }
          await revision.spillAllPages();
          if (task) {
            const spillEvidence = this.#spillStore.evidence();
            task.metrics.pageCount = revision.pageCount;
            task.metrics.spillBytes = Math.max(0, spillEvidence.currentBytes - spillBefore);
            task.metrics.spillCurrentBytes = spillEvidence.currentBytes;
            task.metrics.spillPeakBytes = spillEvidence.peakBytes;
            task.metrics.spillLimitBytes = spillEvidence.limitBytes;
            this.completeTaskPhase(task, "spill");
            this.finishTask(task, "completed");
          }
          offered++;
        } catch (error) {
          if (task) this.failTask(task, context, error);
          revision.release();
          throw error;
        }
      }
      if (offered === 0) throw new Error("Nyx Web Product sharding produced no Products");
    } catch (error) {
      // Independent Products collectively provide the catalog's required
      // coverage. Once any one of them fails, the already-published prefix may
      // remain visible, but this CookSession is incomplete and must fail. The
      // optional refinement callback is reserved for a failure after complete
      // usable coverage, which this loop cannot establish while a Product is
      // missing.
      throw error;
    }
  }
}

function taskNow(): number { return globalThis.performance?.now?.() ?? Date.now(); }

function compareCookPrimitiveOrder(left: GlbCookPrimitive, right: GlbCookPrimitive): number {
  return left.nodeIndex - right.nodeIndex || left.meshIndex - right.meshIndex || left.primitiveIndex - right.primitiveIndex;
}

function primitiveKey(unit: GlbCookPrimitive): string { return `${unit.nodeIndex}:${unit.meshIndex}:${unit.primitiveIndex}`; }
function catalogIndexFor(unit: GlbCookPrimitive, context: WebCookUnitContext, fallback = 0): number {
  const primitives = context.catalog.primitives;
  if (Array.isArray(primitives)) {
    const index = primitives.findIndex(candidate => primitiveKey(candidate) === primitiveKey(unit));
    if (index >= 0) return index;
  }
  return fallback;
}

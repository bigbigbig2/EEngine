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
import { estimateCanonicalBytes, estimateSourceBytes, planCanonicalWindows, type CanonicalWindowPlan } from "./CanonicalWindowPlanner.js";
import {
  WEB_SPATIAL_SHARD_PARTITION_VERSION,
  canonicalizeGlbPrimitiveSpatialShardV1,
  planGlbPrimitiveSpatialShardsV1,
  type GlbSpatialShardSetV1
} from "./SpatialShardPlanner.js";
import type { WebGeometryPageSpillStoreV1 } from "../geometry-product/WebGeometryPageSpillStoreV1.js";

export const NYX_WEB_RUNTIME_PRODUCER_ID = "oengine-nyx-web-runtime";
export const NYX_WEB_RUNTIME_PRODUCER_VERSION = "nyx-b749346382b0-web-cooker-abi1-product-v1";
/**
 * Producer version for plan-backed revisions.
 *
 * A plan-backed revision cannot carry the manifest-backed ProductID: the content
 * manifest covers every page payload, so it does not exist while pages are still
 * PENDING. Folding the phase into the version keeps the two phases from ever
 * claiming the same identity for different evidence.
 */
export const NYX_WEB_RUNTIME_PLAN_PRODUCER_VERSION = "nyx-b749346382b0-web-cooker-abi2-plan-v1";

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

/** Browser-first Nyx producer. It owns no GPU object and emits only Product bytes. */
export class NyxWebRuntimeCooker implements WebRuntimeCooker {
  readonly #module: EmscriptenWebGeometryCookerModuleV1;
  readonly #recipeInput: ArrayBuffer;
  readonly #bootstrapRecipeInput: ArrayBuffer;
  readonly #maxCanonicalInputBytes: number;
  readonly #maxSourceWindowBytes: number;
  readonly #maxDecodedProductBytes: number;
  readonly #rangeOptions: CoalescedRangeReaderOptions;
  #currentSourceWindowBytes = 0;
  #peakSourceWindowBytes = 0;
  #currentCanonicalWindowBytes = 0;
  #peakCanonicalWindowBytes = 0;
  #canonicalWindows = 0;
  #completedCanonicalWindows = 0;
  #spatialPrimitives = 0;
  #spatialShards = 0;
  readonly #spillStore: WebGeometryPageSpillStoreV1 | undefined;
  readonly #sessionGeneration: number | undefined;

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
      maxCanonicalWindowBytes: this.#maxCanonicalInputBytes,
      currentSourceWindowBytes: this.#currentSourceWindowBytes,
      peakSourceWindowBytes: this.#peakSourceWindowBytes,
      currentCanonicalWindowBytes: this.#currentCanonicalWindowBytes,
      peakCanonicalWindowBytes: this.#peakCanonicalWindowBytes,
      canonicalWindows: this.#canonicalWindows,
      completedCanonicalWindows: this.#completedCanonicalWindows,
      spatialPrimitives: this.#spatialPrimitives,
      spatialShards: this.#spatialShards,
      spillCurrentBytes: this.#spillStore?.evidence().currentBytes ?? 0,
      spillPeakBytes: this.#spillStore?.evidence().peakBytes ?? 0,
      spillLimitBytes: this.#spillStore?.evidence().limitBytes ?? 0,
      spillOwnerCount: this.#spillStore?.evidence().ownerCount ?? 0,
      spillWrites: this.#spillStore?.evidence().writes ?? 0,
      spillReads: this.#spillStore?.evidence().reads ?? 0,
      spillReleases: this.#spillStore?.evidence().releases ?? 0
    });
  }

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

  private windows(units: readonly GlbCookPrimitive[]): readonly CanonicalWindowPlan[] { return planCanonicalWindows(units, this.#maxSourceWindowBytes, this.#maxCanonicalInputBytes); }

  private requiresSpatialSharding(unit: GlbCookPrimitive): boolean {
    return estimateSourceBytes([unit]) > this.#maxSourceWindowBytes || estimateCanonicalBytes([unit]) > this.#maxCanonicalInputBytes;
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
      for (const shard of item.spatial.shards) {
        const domain = await canonicalizeGlbPrimitiveSpatialShardV1(item.unit, item.spatial, shard, { signal: context.signal, readRange: range => context.readRange(range) }, this.#maxSourceWindowBytes);
        const canonical = encodeWebCanonicalGeometryV1([domain]);
        if (canonical.byteLength > this.#maxCanonicalInputBytes) throw new Error(`spatial canonical shard ${shard.shardId} exceeds maxCanonicalInputBytes=${this.#maxCanonicalInputBytes}`);
        this.#canonicalWindows++;
        this.#currentCanonicalWindowBytes = canonical.byteLength;
        this.#peakCanonicalWindowBytes = Math.max(this.#peakCanonicalWindowBytes, canonical.byteLength);
        try { yield canonical; }
        finally { this.releaseCanonicalWindow(); }
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
    sceneAssetIndices?: readonly number[]
  ): Promise<WasmGeometryProductRevisionV1> {
    return planWasmGeometryProductRevisionV1(this.#module, canonicalInput, recipeInput, {
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

  private async cookDomains(units: readonly GlbCookPrimitive[], context: WebCookUnitContext, sceneAssetIndices: readonly number[]): Promise<WasmGeometryProductRevisionV1> {
    if (units.some(unit => this.requiresSpatialSharding(unit))) return this.planWindowedCanonical(units, context, this.#recipeInput, 0, undefined, sceneAssetIndices);
    const windows = this.windows(units);
    if (windows.length === 1) return this.consumeCanonicalWindow(windows[0]!, context, canonical => this.cookCanonical(canonical, context, this.#recipeInput, 0, undefined, sceneAssetIndices));
    return this.planWindowedCanonical(units, context, this.#recipeInput, 0, undefined, sceneAssetIndices);
  }

  async cookProgressive(
    units: readonly GlbCookPrimitive[],
    context: WebCookUnitContext,
    onRevision: (revision: WebCookProductRevision) => Promise<void>,
    onFailure?: (error: Error) => void
  ): Promise<void> {
    if (units.length === 0) throw new Error("Nyx Web Product requires at least one GLB primitive");
    const ordered = [...units].sort(compareCookPrimitiveOrder);
    const catalogIndex = new Map((context.catalog.primitives ?? []).map((unit, index) => [primitiveKey(unit), index]));
    const bootstrapPairs = (context.bootstrapUnits === undefined || context.bootstrapUnits.length === 0
      ? [{ unit: ordered[0]!, index: catalogIndex.get(primitiveKey(ordered[0]!)) ?? 0 }]
      : context.bootstrapUnits.map((unit, index) => ({ unit, index: context.bootstrapAssetIndices?.[index] ?? catalogIndex.get(primitiveKey(unit)) ?? index })))
      .sort((left, right) => compareCookPrimitiveOrder(left.unit, right.unit));
    const bootstrapUnits = bootstrapPairs.map(pair => pair.unit);
    const bootstrapIndices = bootstrapPairs.map(pair => pair.index);
    if (bootstrapUnits.length !== bootstrapIndices.length || bootstrapIndices.some(index => !Number.isSafeInteger(index) || index < 0)) throw new RangeError("Nyx Web bootstrap asset mapping is invalid");
    const bootstrapHasSpatial = bootstrapUnits.some(unit => this.requiresSpatialSharding(unit));
    const bootstrapWindows = bootstrapHasSpatial ? [] : this.windows(bootstrapUnits);
    // A one-window bootstrap remains manifest-backed. A larger bootstrap uses
    // the bounded plan builder and publishes its complete activation graph.
    const bootstrap = !bootstrapHasSpatial && bootstrapWindows.length === 1
      ? await this.consumeCanonicalWindow(bootstrapWindows[0]!, context, canonical => this.cookCanonical(canonical, context, this.#bootstrapRecipeInput, 0, undefined, bootstrapIndices))
      : await this.planWindowedCanonical(bootstrapUnits, context, this.#bootstrapRecipeInput, 0, undefined, bootstrapIndices);
    try {
      await onRevision(bootstrap);
    } catch (error) {
      bootstrap.release();
      throw error;
    }
    // A richer failure must not tear down the resident bootstrap revision.
    try {
      // The richer revision freezes its descriptor only. Its activation cut is
      // produced as the coordinator streams it, and every remaining page is
      // produced on demand inside the same revision instead of forcing a
      // second, fully-materialised replacement.
      const richer = await this.planWindowedCanonical(ordered, context, this.#recipeInput, 1,
        { productId: bootstrap.product.productId, revision: bootstrap.product.revision },
        ordered.map((unit, index) => catalogIndex.get(primitiveKey(unit)) ?? index));
      try {
        await onRevision(richer);
      } catch (error) {
        richer.release();
        throw error;
      }
    } catch (error) {
      onFailure?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

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

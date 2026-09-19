import { createGeometryCookRecipeV3, type GeometryCookRecipeV3 } from "../GeometryCookRecipe.js";
import { cookWasmGeometryProductRevisionV1, type WasmGeometryProductRevisionV1 } from "../geometry-product/WasmGeometryProductV1.js";
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

export const NYX_WEB_RUNTIME_PRODUCER_ID = "oengine-nyx-web-runtime";
export const NYX_WEB_RUNTIME_PRODUCER_VERSION = "nyx-b749346382b0-web-cooker-abi1-product-v1";

/**
 * Coarse bootstrap profile. It stops simplification earlier than the full
 * recipe, so the first complete activation cut is resident sooner while the
 * richer revision converges in the background.
 */
const DEFAULT_BOOTSTRAP_RECIPE: Partial<GeometryCookRecipeV3> = Object.freeze({ minimumLodReduction: 0.35 });

export interface NyxWebRuntimeCookerOptions {
  readonly recipe?: Partial<GeometryCookRecipeV3>;
  readonly maxCanonicalInputBytes: number;
  readonly maxDecodedProductBytes: number;
  /** Coarse bootstrap recipe; the richer revision uses `recipe`. */
  readonly bootstrapRecipe?: Partial<GeometryCookRecipeV3>;
  /** Coalesced GLB range block budget (defaults to 1 MiB). */
  readonly rangeBlockBytes?: number;
  /** Maximum unused gap merged into one range block (defaults to 64 KiB). */
  readonly rangeMaxGapBytes?: number;
  /** Maximum in-flight GLB range reads (defaults to 4). */
  readonly rangeConcurrency?: number;
}

/** Browser-first Nyx producer. It owns no GPU object and emits only Product bytes. */
export class NyxWebRuntimeCooker implements WebRuntimeCooker {
  readonly #module: EmscriptenWebGeometryCookerModuleV1;
  readonly #recipeInput: ArrayBuffer;
  readonly #bootstrapRecipeInput: ArrayBuffer;
  readonly #maxCanonicalInputBytes: number;
  readonly #maxDecodedProductBytes: number;
  readonly #rangeOptions: CoalescedRangeReaderOptions;

  constructor(module: EmscriptenWebGeometryCookerModuleV1, options: NyxWebRuntimeCookerOptions) {
    if (!Number.isSafeInteger(options.maxCanonicalInputBytes) || options.maxCanonicalInputBytes <= 0) throw new RangeError("maxCanonicalInputBytes must be a positive safe integer");
    if (!Number.isSafeInteger(options.maxDecodedProductBytes) || options.maxDecodedProductBytes < WEB_GEOMETRY_PAGE_BYTES) throw new RangeError("maxDecodedProductBytes must admit at least one page");
    this.#module = module;
    this.#recipeInput = encodeWebGeometryCookRecipeV1(createGeometryCookRecipeV3(options.recipe));
    this.#bootstrapRecipeInput = encodeWebGeometryCookRecipeV1(createGeometryCookRecipeV3({ ...(options.recipe ?? {}), ...DEFAULT_BOOTSTRAP_RECIPE, ...(options.bootstrapRecipe ?? {}) }));
    this.#maxCanonicalInputBytes = options.maxCanonicalInputBytes;
    this.#maxDecodedProductBytes = options.maxDecodedProductBytes;
    this.#rangeOptions = Object.freeze({
      maxBlockBytes: options.rangeBlockBytes ?? 1024 * 1024,
      maxGapBytes: options.rangeMaxGapBytes ?? 64 * 1024,
      concurrency: options.rangeConcurrency ?? 4
    });
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

  private async canonicalizeDomains(units: readonly GlbCookPrimitive[], context: WebCookUnitContext): Promise<ArrayBuffer> {
    // Plan every unit's ranges in one pass. A GLB packs accessors contiguously,
    // so per-unit planning turned one contiguous span into one HTTP range per
    // unit; a global plan collapses it to the block count `maxBlockBytes` allows.
    const groups = units.map(unit => unit.ranges);
    const readers = await prefetchCoalescedRangeGroups(groups, range => context.readRange(range), context.signal, this.#rangeOptions);
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
    return canonicalInput;
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
      revision,
      ...(replaces === undefined ? {} : { replaces }),
      maxDecodedProductBytes: this.#maxDecodedProductBytes,
      sceneAssetIndices
    });
  }

  private async cookDomains(units: readonly GlbCookPrimitive[], context: WebCookUnitContext, sceneAssetIndices: readonly number[]): Promise<WasmGeometryProductRevisionV1> {
    const canonicalInput = await this.canonicalizeDomains(units, context);
    return this.cookCanonical(canonicalInput, context, this.#recipeInput, 0, undefined, sceneAssetIndices);
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
    let bootstrapInput: ArrayBuffer | undefined = await this.canonicalizeDomains(bootstrapUnits, context);
    const bootstrap = await this.cookCanonical(bootstrapInput, context, this.#bootstrapRecipeInput, 0, undefined, bootstrapIndices);
    // The WASM ABI copies/owns its input before returning a revision. Drop the
    // bootstrap canonical buffer before constructing the richer input so the
    // two revisions do not overlap unnecessarily in the JS heap.
    bootstrapInput = undefined;
    try {
      await onRevision(bootstrap);
    } catch (error) {
      bootstrap.release();
      throw error;
    }
    // A richer failure must not tear down the resident bootstrap revision.
    try {
      const canonicalInput = await this.canonicalizeDomains(ordered, context);
      const richer = await this.cookCanonical(canonicalInput, context, this.#recipeInput, 1, { productId: bootstrap.product.productId, revision: bootstrap.product.revision }, ordered.map((unit, index) => catalogIndex.get(primitiveKey(unit)) ?? index));
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

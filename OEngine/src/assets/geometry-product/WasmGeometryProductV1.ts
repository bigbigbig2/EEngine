import { encodeGeometryProductDescriptorBinaryV1 } from "./GeometryProductBinaryV1.js";
import {
  GEOMETRY_PRODUCT_RUNTIME_PROFILE,
  assertGeometryProductDescriptorV1,
  decodeGeometryProductPageRecordV1,
  type GeometryProductDescriptorV1,
  type GeometryProductSourceIdentityKind,
  type GeometryPageProductV1
} from "./GeometryProductV1.js";
import {
  beginWebGeometryCookWasmBuilderV1,
  cookWebGeometryWasmV1,
  planWebGeometryWasmV1,
  WEB_GEOMETRY_COOK_PAGE_READY,
  WEB_GEOMETRY_PAGE_BYTES,
  type EmscriptenWebGeometryCookerModuleV1,
  type WebGeometryCookWasmHandleV1,
  type WebGeometryCookWasmPlanV1
} from "../web-cook/wasm/WebGeometryCookerAbi.js";
import type {
  WebGeometryPageArtifactInputV1,
  WebGeometryPageSpillKeyV1,
  WebGeometryPageSpillStoreV1
} from "./WebGeometryPageSpillStoreV1.js";
import { pageSpillKeyV1 } from "./WebGeometryPageSpillStoreV1.js";

/**
 * Producer-neutral assembly of one WASM cook result into a Geometry Product
 * revision.
 *
 * Every in-browser producer shares this step - the GLB CookSession route and the
 * runtime ordinary-Scene route - so Product identity, descriptor validation and
 * page re-readability cannot diverge between them. The module owns no GPU
 * object and never touches admission or residency.
 *
 * A revision may be built either from a monolithic cook, where every page
 * payload already exists, or from the two-phase plan, where the descriptor is
 * frozen while payloads are still PENDING. The interface is identical: callers
 * only observe that `readPage` may do more work for a plan-backed revision.
 */
export interface WasmGeometryProductRevisionV1 {
  readonly descriptor: ArrayBuffer;
  /** Frozen descriptor object, including ProductID and revision. */
  readonly product: GeometryProductDescriptorV1;
  readonly productId: Uint8Array;
  readonly revision: number;
  readonly pageCount: number;
  /** Catalog primitive indices represented by this revision's asset table. */
  readonly sceneAssetIndices?: readonly number[];
  /** True while at least one declared page payload has not been produced yet. */
  readonly hasPendingPages: boolean;
  readPage(pageId: number): Promise<GeometryPageProductV1>;
  release(): void;
}

export interface WasmGeometryProductIdentifyInputV1 {
  readonly producerId: string;
  readonly producerVersion: string;
  readonly sourceIdentityKind: GeometryProductSourceIdentityKind;
  readonly sourceIdentityHash: Uint8Array;
  readonly revision: number;
  readonly replaces?: Readonly<{ productId: Uint8Array; revision: number }>;
  readonly sceneAssetIndices?: readonly number[];
  /** Optional bounded page artifact owner used by cook-and-spill. */
  readonly spillStore?: WebGeometryPageSpillStoreV1;
  /** Runtime session generation used to reject late page writes. */
  readonly sessionGeneration?: number;
  /** Optional producer cancellation signal; late spill writes are rejected. */
  readonly signal?: AbortSignal;
}

/**
 * Stable Product identity for one produced revision: producer identity + source
 * identity + recipe hash + runtime profile + the cook content manifest. Callers
 * that share these inputs are guaranteed the same ProductID.
 */
export async function deriveGeometryProductIdV1(
  producerId: string,
  producerVersion: string,
  sourceIdentityKind: GeometryProductSourceIdentityKind,
  sourceIdentityHash: Uint8Array,
  recipeHash: Uint8Array,
  contentManifestHash: Uint8Array
): Promise<Uint8Array> {
  for (const [name, value] of [["sourceIdentityHash", sourceIdentityHash], ["recipeHash", recipeHash], ["contentManifestHash", contentManifestHash]] as const) {
    if (value.byteLength !== 32) throw new RangeError(`${name} must be exactly 32 bytes`);
  }
  const fields = [
    textBytes("OENGINE-GEOMETRY-PRODUCT-ID-V1"),
    textBytes(sourceIdentityKind),
    sourceIdentityHash.slice(),
    textBytes("web-runtime"),
    textBytes(producerId),
    textBytes(producerVersion),
    recipeHash.slice(),
    textBytes(GEOMETRY_PRODUCT_RUNTIME_PROFILE),
    contentManifestHash.slice()
  ];
  const encoded = encodeLengthPrefixed(fields);
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", encoded));
}

/** Cooks canonical domains and returns one frozen, re-readable Product revision. */
export async function cookWasmGeometryProductRevisionV1(
  module: EmscriptenWebGeometryCookerModuleV1,
  canonicalInput: ArrayBuffer,
  recipeInput: ArrayBuffer,
  options: Readonly<WasmGeometryProductIdentifyInputV1 & { readonly maxDecodedProductBytes: number }>
): Promise<WasmGeometryProductRevisionV1> {
  const result = cookWebGeometryWasmV1(module, canonicalInput, recipeInput, options.maxDecodedProductBytes);
  try {
    return await assembleWasmGeometryProductRevisionV1(result, options, () => new MonolithicPageSource(result));
  } catch (error) {
    result.release();
    throw error;
  }
}

/**
 * Freezes the descriptor stage and returns a revision whose pages are still
 * PENDING.
 *
 * Only the descriptor is materialised, so the caller can publish the complete ID
 * graph immediately and let GPU demand decide which payloads are worth
 * producing. `readPage` advances exactly the requested PageID and reuses it on
 * later reads, so repeating a demand never re-cooks the page.
 *
 * The ProductID is derived from the recipe hash plus a zero content manifest:
 * the real manifest covers every page payload, so it cannot exist at descriptor
 * time. Plan-backed revisions therefore carry a provisional identity that is
 * only valid under `oengine-nyx-web-runtime-plan-v1`. A producer that already
 * produced all payloads must use the monolithic entry instead, which keeps the
 * manifest-backed ProductID.
 */
export async function planWasmGeometryProductRevisionV1(
  module: EmscriptenWebGeometryCookerModuleV1,
  canonicalInput: ArrayBuffer,
  recipeInput: ArrayBuffer,
  options: Readonly<WasmGeometryProductIdentifyInputV1 & { readonly maxDecodedProductBytes: number }>
): Promise<WasmGeometryProductRevisionV1> {
  const result = planWebGeometryWasmV1(module, canonicalInput, recipeInput, options.maxDecodedProductBytes);
  try {
    return await assembleWasmGeometryProductRevisionV1(result, options, descriptor => new WasmPlanPageSource(result!, descriptor, options.spillStore, options.sessionGeneration, options.signal));
  } catch (error) {
    result.release();
    throw error;
  }
}

/** Builds one Product descriptor from bounded canonical windows without retaining prior inputs. */
export async function planWasmGeometryProductRevisionWindowsV1(
  module: EmscriptenWebGeometryCookerModuleV1,
  canonicalWindows: AsyncIterable<ArrayBuffer>,
  recipeInput: ArrayBuffer,
  options: Readonly<WasmGeometryProductIdentifyInputV1 & { readonly maxDecodedProductBytes: number }>
): Promise<WasmGeometryProductRevisionV1> {
  const builder = beginWebGeometryCookWasmBuilderV1(module, recipeInput, options.maxDecodedProductBytes);
  let result: WebGeometryCookWasmPlanV1 | undefined;
  try {
    let windows = 0;
    for await (const canonical of canonicalWindows) { builder.append(canonical); windows++; }
    if (windows === 0) throw new Error("canonical window stream produced no inputs");
    result = builder.finish();
    return await assembleWasmGeometryProductRevisionV1(result, options, descriptor => new WasmPlanPageSource(result!, descriptor, options.spillStore, options.sessionGeneration, options.signal));
  } catch (error) {
    result?.release();
    builder.release();
    throw error;
  }
}

/** How one revision turns a PageID into bytes. */
interface GeometryProductPageSourceV1 {
  readonly hasPendingPages: boolean;
  /** Produces (if needed) and returns one page payload, or null when undeclared. */
  copyPage(pageId: number): Promise<ArrayBuffer | null>;
  release(): void;
}

async function assembleWasmGeometryProductRevisionV1(
  result: WebGeometryCookWasmHandleV1,
  options: Readonly<WasmGeometryProductIdentifyInputV1 & { readonly maxDecodedProductBytes: number }>,
  createPageSource: (descriptor: GeometryProductDescriptorV1) => GeometryProductPageSourceV1
): Promise<WasmGeometryProductRevisionV1> {
  const sections = result.descriptorSections();
  const productId = await deriveGeometryProductIdV1(
    options.producerId,
    options.producerVersion,
    options.sourceIdentityKind,
    options.sourceIdentityHash,
    sections.recipeHash,
    sections.contentManifestHash
  );
  const descriptor: GeometryProductDescriptorV1 = Object.freeze({
    schemaVersion: 1,
    productId,
    revision: options.revision,
    ...(options.replaces === undefined ? {} : { replaces: Object.freeze({ productId: options.replaces.productId.slice(), revision: options.replaces.revision }) }),
    producerKind: "web-runtime",
    producerId: options.producerId,
    producerVersion: options.producerVersion,
    sourceIdentityKind: options.sourceIdentityKind,
    sourceIdentityHash: options.sourceIdentityHash,
    recipeHash: sections.recipeHash,
    runtimeProfile: GEOMETRY_PRODUCT_RUNTIME_PROFILE,
    decodedPageBytes: WEB_GEOMETRY_PAGE_BYTES,
    assetRecords: sections.assetRecords,
    rootNodeIds: sections.rootNodeIds,
    hierarchyNodes: sections.hierarchyNodes,
    groupDirectory: sections.groupDirectory,
    pageRecords: sections.pageRecords,
    bootstrapPageIds: sections.bootstrapPageIds,
    activationPageIds: sections.activationPageIds,
    vertexFormats: sections.vertexFormats
  });
  assertGeometryProductDescriptorV1(descriptor);
  return new WasmGeometryProductRevision(createPageSource(descriptor), descriptor, options.sceneAssetIndices);
}

/** Monolithic handle: every payload already exists, so `copyPage` is a plain copy. */
class MonolithicPageSource implements GeometryProductPageSourceV1 {
  readonly hasPendingPages = false;
  constructor(private readonly handle: WebGeometryCookWasmHandleV1) {}
  async copyPage(pageId: number): Promise<ArrayBuffer> { return this.handle.copyPage(pageId); }
  release(): void { this.handle.release(); }
}

/**
 * Two-phase plan: payloads are advanced on demand and cached per PageID.
 *
 * A produced page is immutable, so a second request for the same PageID is
 * served from the cache instead of re-running the payload stage. The cache is
 * bounded by `maxDecodedProductBytes`, which the cook already treats as the
 * ceiling for what one revision may hold resident.
 */
class WasmPlanPageSource implements GeometryProductPageSourceV1 {
  readonly #plan: WebGeometryCookWasmPlanV1;
  readonly #descriptor: GeometryProductDescriptorV1;
  readonly #spillStore: WebGeometryPageSpillStoreV1 | undefined;
  readonly #sessionGeneration: number | undefined;
  readonly #signal: AbortSignal | undefined;
  readonly #produced = new Map<number, ArrayBuffer>();
  readonly #ownedSpill = new Map<string, WebGeometryPageSpillKeyV1>();
  readonly #inflight = new Map<number, Promise<ArrayBuffer | null>>();
  #released = false;

  constructor(plan: WebGeometryCookWasmPlanV1, descriptor: GeometryProductDescriptorV1, spillStore?: WebGeometryPageSpillStoreV1, sessionGeneration?: number, signal?: AbortSignal) {
    this.#plan = plan;
    this.#descriptor = descriptor;
    this.#spillStore = spillStore;
    this.#sessionGeneration = sessionGeneration;
    this.#signal = signal;
  }

  get hasPendingPages(): boolean {
    if (this.#released) return false;
    return (this.#spillStore ? this.#ownedSpill.size : this.#produced.size) < this.#plan.pageCount;
  }

  async copyPage(pageId: number): Promise<ArrayBuffer | null> {
    if (this.#released) throw new Error("WASM Geometry Product plan has been released");
    this.throwIfAborted();
    if (!Number.isInteger(pageId) || pageId < 0 || pageId >= this.#plan.pageCount) return null;
    const cached = this.#produced.get(pageId);
    if (cached !== undefined) return cached.slice(0);
    const pending = this.#inflight.get(pageId);
    if (pending !== undefined) return pending.then(bytes => bytes?.slice(0) ?? null);
    const key = this.spillKey(pageId);
    const run = this.readOrMaterialize(pageId, key);
    this.#inflight.set(pageId, run);
    try {
      const bytes = await run;
      return bytes?.slice(0) ?? null;
    } finally {
      this.#inflight.delete(pageId);
    }
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    const store = this.#spillStore;
    if (store !== undefined) for (const key of this.#ownedSpill.values()) void store.release(key).catch(() => undefined);
    this.#ownedSpill.clear();
    this.#produced.clear();
    this.#inflight.clear();
    this.#plan.release();
  }

  private async readOrMaterialize(pageId: number, key: WebGeometryPageSpillKeyV1): Promise<ArrayBuffer | null> {
    if (this.#released) throw new Error("WASM Geometry Product plan has been released");
    if (this.#spillStore !== undefined) {
      const artifact = await this.#spillStore.read(key);
      this.throwIfAborted();
      if (this.#released) throw new Error("WASM Geometry Product plan has been released");
      if (artifact !== null) {
        const expected = decodeGeometryProductPageRecordV1(this.#descriptor, pageId);
        if (!sameBytes(artifact.productId, key.productId) || artifact.revision !== key.revision || artifact.pageId !== key.pageId || !sameBytes(artifact.decodedHash128, expected.decodedHash128)) throw new Error("spill page key or identity does not match the Product revision");
        this.#ownedSpill.set(pageSpillKeyV1(artifact), key);
        return artifact.bytes;
      }
    }
    return this.materialize(pageId, key);
  }

  private async materialize(pageId: number, key: WebGeometryPageSpillKeyV1): Promise<ArrayBuffer | null> {
    if (this.#released) throw new Error("WASM Geometry Product plan has been released");
    let produced: ReturnType<WebGeometryCookWasmPlanV1["producePage"]>;
    try { produced = this.#plan.producePage(pageId); } catch { return null; }
    if (produced.status !== WEB_GEOMETRY_COOK_PAGE_READY || produced.bytes === null) return null;
    if (this.#released) throw new Error("WASM Geometry Product plan was released while producing a page");
    this.throwIfAborted();
    if (this.#spillStore === undefined) {
      this.#produced.set(pageId, produced.bytes);
      return produced.bytes;
    }
    const expected = decodeGeometryProductPageRecordV1(this.#descriptor, pageId);
    const input: WebGeometryPageArtifactInputV1 = { ...key, decodedHash128: expected.decodedHash128, bytes: produced.bytes };
    const artifact = await this.#spillStore.put(input);
    if (this.#released || this.#signal?.aborted) {
      void this.#spillStore.release(key).catch(() => undefined);
      throw this.#signal?.reason ?? new Error("WASM Geometry Product plan was released while committing a page");
    }
    this.#plan.releasePage(pageId);
    this.#ownedSpill.set(pageSpillKeyV1(artifact), key);
    return artifact.bytes;
  }

  private spillKey(pageId: number): WebGeometryPageSpillKeyV1 { return { productId: this.#descriptor.productId.slice(), revision: this.#descriptor.revision, pageId, ...(this.#sessionGeneration === undefined ? {} : { sessionGeneration: this.#sessionGeneration }) }; }
  private throwIfAborted(): void { if (this.#signal?.aborted) throw this.#signal.reason ?? new DOMException("The operation was aborted", "AbortError"); }
}

class WasmGeometryProductRevision implements WasmGeometryProductRevisionV1 {
  readonly descriptor: ArrayBuffer;
  readonly productId: Uint8Array;
  readonly revision: number;
  readonly pageCount: number;
  readonly sceneAssetIndices?: readonly number[];
  #source: GeometryProductPageSourceV1 | undefined;

  constructor(source: GeometryProductPageSourceV1, readonly product: GeometryProductDescriptorV1, sceneAssetIndices?: readonly number[]) {
    this.#source = source;
    this.descriptor = encodeGeometryProductDescriptorBinaryV1(product);
    this.productId = product.productId.slice();
    this.revision = product.revision;
    this.pageCount = product.pageRecords.byteLength / 32;
    this.sceneAssetIndices = sceneAssetIndices === undefined ? undefined : Object.freeze([...sceneAssetIndices]);
  }

  get hasPendingPages(): boolean { return this.#source?.hasPendingPages ?? false; }

  async readPage(pageId: number): Promise<GeometryPageProductV1> {
    const source = this.#source;
    if (!source) throw new Error("WASM Geometry Product revision has been released");
    const expected = decodeGeometryProductPageRecordV1(this.product, pageId);
    const bytes = await source.copyPage(pageId);
    if (bytes === null) throw new Error(`WASM Geometry Product page ${pageId} is not declared by the descriptor`);
    // The page record carries rolled-up identity, not the whole-page digest, so a
    // whole-page hash comparison would always mismatch. Whole-page digest is
    // reported separately for transport integrity only.
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
    return Object.freeze({
      productId: this.product.productId.slice(),
      revision: this.product.revision,
      pageId,
      decodedHash128: expected.decodedHash128.slice(),
      decodedPageHash128: digest.subarray(0, 16).slice(),
      bytes
    });
  }

  release(): void { this.#source?.release(); this.#source = undefined; }
}

function encodeLengthPrefixed(fields: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const byteLength = fields.reduce((sum, field) => checkedAdd(sum, 8 + field.byteLength), 0);
  const output = new Uint8Array(byteLength), view = new DataView(output.buffer);
  let offset = 0;
  for (const field of fields) {
    const length = BigInt(field.byteLength);
    view.setUint32(offset, Number(length & 0xffffffffn), true);
    view.setUint32(offset + 4, Number(length >> 32n), true);
    output.set(field, offset + 8);
    offset += 8 + field.byteLength;
  }
  return output;
}

function textBytes(value: string): Uint8Array { return new TextEncoder().encode(value); }
function checkedAdd(a: number, b: number): number { const value = a + b; if (!Number.isSafeInteger(value)) throw new RangeError("Product identity input exceeds safe integer range"); return value; }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { if (left.byteLength !== right.byteLength) return false; for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false; return true; }

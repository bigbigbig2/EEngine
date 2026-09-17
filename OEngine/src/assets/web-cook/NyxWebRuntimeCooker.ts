import { createGeometryCookRecipeV3, type GeometryCookRecipeV3 } from "../GeometryCookRecipe.js";
import { encodeGeometryProductDescriptorBinaryV1 } from "../geometry-product/GeometryProductBinaryV1.js";
import {
  GEOMETRY_PRODUCT_RUNTIME_PROFILE,
  assertGeometryProductDescriptorV1,
  decodeGeometryProductPageRecordV1,
  type GeometryProductDescriptorV1,
  type GeometryProductSourceIdentityKind
} from "../geometry-product/GeometryProductV1.js";
import type { WebCookProductPage, WebCookProductRevision, WebCookUnitContext, WebRuntimeCooker } from "./WebCookCoordinator.js";
import { canonicalizeGlbPrimitiveV1 } from "./gltf/GlbPrimitiveCanonicalizer.js";
import {
  WEB_GEOMETRY_PAGE_BYTES,
  cookWebGeometryWasmV1,
  encodeWebCanonicalGeometryV1,
  encodeWebGeometryCookRecipeV1,
  type EmscriptenWebGeometryCookerModuleV1,
  type WebGeometryCookDescriptorSectionsV1,
  type WebGeometryCookWasmResultV1
} from "./wasm/WebGeometryCookerAbi.js";
import type { GlbCookPrimitive } from "../../loaders/gltf/streaming/GlbSceneCatalog.js";

export const NYX_WEB_RUNTIME_PRODUCER_ID = "oengine-nyx-web-runtime";
export const NYX_WEB_RUNTIME_PRODUCER_VERSION = "nyx-b749346382b0-web-cooker-abi1-product-v1";

export interface NyxWebRuntimeCookerOptions {
  readonly recipe?: Partial<GeometryCookRecipeV3>;
  readonly maxCanonicalInputBytes: number;
  readonly maxDecodedProductBytes: number;
}

/** Browser-first Nyx producer. It owns no GPU object and emits only Product bytes. */
export class NyxWebRuntimeCooker implements WebRuntimeCooker {
  readonly #module: EmscriptenWebGeometryCookerModuleV1;
  readonly #recipeInput: ArrayBuffer;
  readonly #maxCanonicalInputBytes: number;
  readonly #maxDecodedProductBytes: number;

  constructor(module: EmscriptenWebGeometryCookerModuleV1, options: NyxWebRuntimeCookerOptions) {
    if (!Number.isSafeInteger(options.maxCanonicalInputBytes) || options.maxCanonicalInputBytes <= 0) throw new RangeError("maxCanonicalInputBytes must be a positive safe integer");
    if (!Number.isSafeInteger(options.maxDecodedProductBytes) || options.maxDecodedProductBytes < WEB_GEOMETRY_PAGE_BYTES) throw new RangeError("maxDecodedProductBytes must admit at least one page");
    this.#module = module;
    this.#recipeInput = encodeWebGeometryCookRecipeV1(createGeometryCookRecipeV3(options.recipe));
    this.#maxCanonicalInputBytes = options.maxCanonicalInputBytes;
    this.#maxDecodedProductBytes = options.maxDecodedProductBytes;
  }

  async cookBootstrap(unit: GlbCookPrimitive, context: WebCookUnitContext): Promise<WebCookProductRevision> {
    return this.cookDomains([unit], context);
  }

  async cookBootstrapBatch(units: readonly GlbCookPrimitive[], context: WebCookUnitContext): Promise<WebCookProductRevision> {
    if (units.length === 0) throw new Error("Nyx Web Product requires at least one GLB primitive");
    const material = units[0]!.materialIndex;
    if (units.some(unit => unit.materialIndex !== material)) {
      throw new Error("Web GLB Product currently requires one material domain per immutable Product; split the source or use an offline Product");
    }
    const mesh = units[0]!.meshIndex;
    if (units.some(unit => unit.meshIndex !== mesh)) {
      throw new Error("Web GLB Product currently requires one mesh per immutable Product; split the source or use an offline Product");
    }
    return this.cookDomains(units, context);
  }

  private async cookDomains(units: readonly GlbCookPrimitive[], context: WebCookUnitContext): Promise<WebCookProductRevision> {
    const domains = [];
    for (const unit of units) domains.push(await canonicalizeGlbPrimitiveV1(unit, context));
    if (context.signal.aborted) throw context.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    const canonicalInput = encodeWebCanonicalGeometryV1(domains);
    if (canonicalInput.byteLength > this.#maxCanonicalInputBytes) throw new Error(`canonical cook input exceeds maxCanonicalInputBytes=${this.#maxCanonicalInputBytes}`);
    const result = cookWebGeometryWasmV1(this.#module, canonicalInput, this.#recipeInput, this.#maxDecodedProductBytes);
    try {
      const sections = result.descriptorSections();
      const sourceIdentityKind = context.source.sourceIdentity.kind;
      const sourceIdentityHash = context.source.sourceIdentity.hash;
      const productId = await deriveNyxWebProductIdV1(sourceIdentityKind, sourceIdentityHash, sections.recipeHash, sections.contentManifestHash);
      const descriptor: GeometryProductDescriptorV1 = Object.freeze({
        schemaVersion: 1,
        productId,
        revision: 0,
        producerKind: "web-runtime",
        producerId: NYX_WEB_RUNTIME_PRODUCER_ID,
        producerVersion: NYX_WEB_RUNTIME_PRODUCER_VERSION,
        sourceIdentityKind,
        sourceIdentityHash,
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
      return new NyxWebProductRevision(result, descriptor);
    } catch (error) {
      result.release();
      throw error;
    }
  }
}

export async function deriveNyxWebProductIdV1(
  sourceIdentityKind: GeometryProductSourceIdentityKind,
  sourceIdentityHash: Uint8Array,
  recipeHash: Uint8Array,
  contentManifestHash: Uint8Array
): Promise<Uint8Array> {
  for (const [name, value] of [["sourceIdentityHash", sourceIdentityHash], ["recipeHash", recipeHash], ["contentManifestHash", contentManifestHash]] as const) if (value.byteLength !== 32) throw new RangeError(`${name} must be exactly 32 bytes`);
  const fields = [
    textBytes("OENGINE-GEOMETRY-PRODUCT-ID-V1"),
    textBytes(sourceIdentityKind),
    sourceIdentityHash.slice(),
    textBytes("web-runtime"),
    textBytes(NYX_WEB_RUNTIME_PRODUCER_ID),
    textBytes(NYX_WEB_RUNTIME_PRODUCER_VERSION),
    recipeHash.slice(),
    textBytes(GEOMETRY_PRODUCT_RUNTIME_PROFILE),
    contentManifestHash.slice()
  ];
  const encoded = encodeLengthPrefixed(fields);
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", encoded));
}

class NyxWebProductRevision implements WebCookProductRevision {
  readonly descriptor: ArrayBuffer;
  readonly productId: Uint8Array;
  readonly revision: number;
  readonly pageCount: number;
  #result: WebGeometryCookWasmResultV1 | undefined;

  constructor(result: WebGeometryCookWasmResultV1, readonly product: GeometryProductDescriptorV1) {
    this.#result = result;
    this.descriptor = encodeGeometryProductDescriptorBinaryV1(product);
    this.productId = product.productId.slice();
    this.revision = product.revision;
    this.pageCount = result.pageCount;
  }

  async readPage(pageId: number): Promise<WebCookProductPage> {
    const result = this.#result;
    if (!result) throw new Error("Nyx Web Product revision has been released");
    const expected = decodeGeometryProductPageRecordV1(this.product, pageId);
    const bytes = result.copyPage(pageId);
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
    if (!sameBytes(digest.subarray(0, 16), expected.decodedHash128)) throw new Error(`Nyx Web Product page ${pageId} failed decoded hash validation`);
    return Object.freeze({ pageId, decodedHash128: expected.decodedHash128.slice(), bytes });
  }

  release(): void { this.#result?.release(); this.#result = undefined; }
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

function textBytes(value: string): Uint8Array<ArrayBuffer> { return new TextEncoder().encode(value); }
function checkedAdd(a: number, b: number): number { const value = a + b; if (!Number.isSafeInteger(value)) throw new RangeError("Product identity input exceeds safe integer range"); return value; }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { if (left.byteLength !== right.byteLength) return false; for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false; return true; }

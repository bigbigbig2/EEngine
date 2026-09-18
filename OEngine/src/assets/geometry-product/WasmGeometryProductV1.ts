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
  WEB_GEOMETRY_PAGE_BYTES,
  cookWebGeometryWasmV1,
  type EmscriptenWebGeometryCookerModuleV1,
  type WebGeometryCookWasmResultV1
} from "../web-cook/wasm/WebGeometryCookerAbi.js";

/**
 * Producer-neutral assembly of one WASM cook result into a Geometry Product
 * revision.
 *
 * Every in-browser producer shares this step - the GLB CookSession route and the
 * runtime ordinary-Scene route - so Product identity, descriptor validation and
 * page re-readability cannot diverge between them. The module owns no GPU
 * object and never touches admission or residency.
 */
export interface WasmGeometryProductRevisionV1 {
  readonly descriptor: ArrayBuffer;
  /** Frozen descriptor object, including ProductID and revision. */
  readonly product: GeometryProductDescriptorV1;
  readonly productId: Uint8Array;
  readonly revision: number;
  readonly pageCount: number;
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
    return new WasmGeometryProductRevision(result, descriptor);
  } catch (error) {
    result.release();
    throw error;
  }
}

class WasmGeometryProductRevision implements WasmGeometryProductRevisionV1 {
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

  async readPage(pageId: number): Promise<GeometryPageProductV1> {
    const result = this.#result;
    if (!result) throw new Error("WASM Geometry Product revision has been released");
    const expected = decodeGeometryProductPageRecordV1(this.product, pageId);
    const bytes = result.copyPage(pageId);
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
    if (!sameBytes(digest.subarray(0, 16), expected.decodedHash128)) throw new Error(`Geometry Product page ${pageId} failed decoded hash validation`);
    return Object.freeze({ productId: this.product.productId.slice(), revision: this.product.revision, pageId, decodedHash128: expected.decodedHash128.slice(), bytes });
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

function textBytes(value: string): Uint8Array { return new TextEncoder().encode(value); }
function checkedAdd(a: number, b: number): number { const value = a + b; if (!Number.isSafeInteger(value)) throw new RangeError("Product identity input exceeds safe integer range"); return value; }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { if (left.byteLength !== right.byteLength) return false; for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false; return true; }

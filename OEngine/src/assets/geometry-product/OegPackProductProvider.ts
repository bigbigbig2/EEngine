import { OEGPACK_V4_PAGE_BYTES } from "../GeometryAbiV4.js";
import { openOegPackV4, type OegPackDecodedPageV4, type OegPackV4 } from "../OegPackV4.js";
import {
  assertGeometryProductDescriptorV1,
  encodeAssetRecordsV4,
  encodeGeometryProductPageRecordsV1,
  encodeGroupDirectoryV4,
  encodeVertexFormatsV4,
  GEOMETRY_PRODUCT_RUNTIME_PROFILE,
  markPageIntegrityPreverifiedV1,
  type GeometryProductDescriptorV1,
  type GeometryProductProviderV1,
  type GeometryProductRevisionSourceV1,
  type GeometryPageProductV1,
} from "./GeometryProductV1.js";

export interface OegPackPreparedReader {
  readPages(
    pageIds: ArrayLike<number>,
    signal?: AbortSignal,
    priority?: 0 | 1 | 2
  ): Promise<readonly GeometryPageProductV1[]>;
  release(): void;
}

export interface OegPackPreparation {
  open(): OegPackPreparedReader;
  release(): void;
}

export class OegPackProductProvider implements GeometryProductProviderV1 {
  readonly #packPromise: Promise<OegPackV4>;
  #released = false;

  constructor(
    pack: OegPackV4 | Promise<OegPackV4>,
    readonly preparation?: OegPackPreparation
  ) {
    this.#packPromise = Promise.resolve(pack);
  }

  async *revisions(signal?: AbortSignal): AsyncIterable<GeometryProductRevisionSourceV1> {
    throwIfAborted(signal);
    if (this.#released) return;
    const pack = await this.#packPromise;
    throwIfAborted(signal);
    if (this.#released) return;
    const descriptor = descriptorFromOegPack(pack);
    assertGeometryProductDescriptorV1(descriptor);
    yield new OegPackProductRevisionSource(pack, descriptor, this.preparation?.open());
  }

  release(): void {
    this.#released = true;
    this.preparation?.release();
  }
}

export function descriptorFromOegPack(pack: OegPackV4): GeometryProductDescriptorV1 {
  const productId = fromHex(pack.header.packContentHash);
  const pageRecords = encodeGeometryProductPageRecordsV1(
    pack.pages.map((page) => ({
      decodedHash128: fromHexBytes(page.decodedContentHash128, 16),
      firstGroup: page.firstGroup,
      groupCount: page.groupCount,
      flags: 0,
      reserved: 0,
    })),
  );
  const descriptor: GeometryProductDescriptorV1 = Object.freeze({
    schemaVersion: 3,
    productId,
    revision: 0,
    producerKind: "offline-native",
    producerId: "oengine-oegpack-v4",
    producerVersion: "4.0-soa-query3",
    sourceIdentityKind: "content-sha256",
    sourceIdentityHash: productId.slice(),
    recipeHash: fromHex(pack.header.recipeHash),
    runtimeProfile: GEOMETRY_PRODUCT_RUNTIME_PROFILE,
    decodedPageBytes: OEGPACK_V4_PAGE_BYTES,
    assetRecords: encodeAssetRecordsV4(pack.assets),
    rootNodeIds: pack.rootNodeIndices.slice(),
    hierarchyNodes: pack.hierarchyBytes.slice(),
    groupDirectory: encodeGroupDirectoryV4(pack.groups),
    pageRecords,
    bootstrapPageIds: pack.bootstrapPageIds.slice(),
    vertexFormats: encodeVertexFormatsV4(pack.vertexFormats),
    activationPageIds: Uint32Array.from([...new Set(pack.bootstrapPageIds)].sort((a, b) => a - b)),
    querySection: pack.querySection.slice(),
  });
  return descriptor;
}

export class OegPackProductRevisionSource implements GeometryProductRevisionSourceV1 {
  #released = false;
  constructor(
    readonly pack: OegPackV4,
    readonly descriptor: GeometryProductDescriptorV1,
    readonly prepared?: OegPackPreparedReader,
  ) {}
  #toPageProduct(pageId: number, page: OegPackDecodedPageV4): GeometryPageProductV1 {
    const recordOffset = pageId * 32;
    const expectedHash = this.descriptor.pageRecords.slice(recordOffset, recordOffset + 16);
    const decoded = page.bytes;
    if (decoded.byteLength !== OEGPACK_V4_PAGE_BYTES)
      throw new Error("OEGPACK adapter returned a non-256 KiB page");
    // The pack's public decoded view must not alias a published Product page.
    const bytes = decoded.slice().buffer;
    return markPageIntegrityPreverifiedV1(
      Object.freeze({
        productId: this.descriptor.productId.slice(),
        revision: this.descriptor.revision,
        pageId,
        integrity: page.integrity,
        decodedHash128: expectedHash,
        decodedPageHash128:
          page.decodedPageHash128 === undefined
            ? undefined
            : fromHexBytes(page.decodedPageHash128.slice(0, 32), 16),
        bytes,
      }),
    );
  }
  async readPage(pageId: number, signal?: AbortSignal): Promise<GeometryPageProductV1> {
    throwIfAborted(signal);
    if (this.#released) throw new Error("OEGPACK Product revision has been released");
    const recordOffset = pageId * 32;
    if (!Number.isInteger(pageId) || pageId < 0 || recordOffset + 32 > this.descriptor.pageRecords.byteLength)
      throw new RangeError("Geometry Product pageId is out of range");
    if (this.prepared) return (await this.prepared.readPages([pageId], signal))[0]!;
    const page = await this.pack.readPage(pageId, signal);
    throwIfAborted(signal);
    return this.#toPageProduct(pageId, page);
  }
  async readPages(
    pageIds: ArrayLike<number>,
    signal?: AbortSignal,
    priority: 0 | 1 | 2 = 0,
  ): Promise<readonly GeometryPageProductV1[]> {
    throwIfAborted(signal);
    if (this.#released) throw new Error("OEGPACK Product revision has been released");
    for (let i = 0; i < pageIds.length; i++) {
      const pageId = pageIds[i]!;
      const recordOffset = pageId * 32;
      if (
        !Number.isInteger(pageId) ||
        pageId < 0 ||
        recordOffset + 32 > this.descriptor.pageRecords.byteLength
      )
        throw new RangeError("Geometry Product pageId is out of range");
    }
    if (this.prepared) return this.prepared.readPages(pageIds, signal, priority);
    if (this.pack.readPages) {
      const decodedPages = await this.pack.readPages(pageIds, signal);
      throwIfAborted(signal);
      return Object.freeze(decodedPages.map((page, index) => this.#toPageProduct(pageIds[index]!, page)));
    }
    const results: GeometryPageProductV1[] = [];
    for (let i = 0; i < pageIds.length; i++) {
      results.push(await this.readPage(pageIds[i]!, signal));
    }
    return Object.freeze(results);
  }
  release(): void {
    this.#released = true;
    this.prepared?.release();
  }
}

function fromHex(value: string): Uint8Array {
  return fromHexBytes(value, 32);
}
function fromHexBytes(value: string, byteLength: number): Uint8Array {
  if (!new RegExp(`^[0-9a-f]{${byteLength * 2}}$`, "u").test(value))
    throw new Error(`expected ${byteLength}-byte lowercase hex`);
  return Uint8Array.from({ length: byteLength }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );
}
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted", "AbortError");
}

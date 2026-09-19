import { OEGPACK_V3_PAGE_BYTES } from "../GeometryAbiV3.js";
import { openOegPackV3, type OegPackV3 } from "../OegPackV3.js";
import {
  assertGeometryProductDescriptorV1,
  encodeAssetRecordsV3,
  encodeGeometryProductPageRecordsV1,
  encodeGroupDirectoryV3,
  encodeVertexFormatsV3,
  GEOMETRY_PRODUCT_RUNTIME_PROFILE,
  type GeometryProductDescriptorV1,
  type GeometryProductProviderV1,
  type GeometryProductRevisionSourceV1,
  type GeometryPageProductV1
} from "./GeometryProductV1.js";

export class OegPackProductProvider implements GeometryProductProviderV1 {
  readonly #packPromise: Promise<OegPackV3>;
  #released = false;

  constructor(pack: OegPackV3 | Promise<OegPackV3>) { this.#packPromise = Promise.resolve(pack); }

  async *revisions(signal?: AbortSignal): AsyncIterable<GeometryProductRevisionSourceV1> {
    throwIfAborted(signal);
    if (this.#released) return;
    const pack = await this.#packPromise;
    throwIfAborted(signal);
    if (this.#released) return;
    const descriptor = descriptorFromOegPack(pack);
    assertGeometryProductDescriptorV1(descriptor);
    yield new OegPackProductRevisionSource(pack, descriptor);
  }

  release(): void { this.#released = true; }
}

export function descriptorFromOegPack(pack: OegPackV3): GeometryProductDescriptorV1 {
  const productId = fromHex(pack.header.packContentHash);
  const pageRecords = encodeGeometryProductPageRecordsV1(pack.pages.map(page => ({ decodedHash128: fromHexBytes(page.decodedContentHash128, 16), firstGroup: page.firstGroup, groupCount: page.groupCount, flags: 0, reserved: 0 })));
  const descriptor: GeometryProductDescriptorV1 = Object.freeze({
    schemaVersion: 1, productId, revision: 0, producerKind: "offline-native", producerId: "oengine-oegpack-v3", producerVersion: "3.0-adapter-v1",
    sourceIdentityKind: "content-sha256", sourceIdentityHash: productId.slice(), recipeHash: fromHex(pack.header.recipeHash), runtimeProfile: GEOMETRY_PRODUCT_RUNTIME_PROFILE,
    decodedPageBytes: OEGPACK_V3_PAGE_BYTES, assetRecords: encodeAssetRecordsV3(pack.assets), rootNodeIds: pack.rootNodeIndices.slice(), hierarchyNodes: pack.hierarchyBytes.slice(), groupDirectory: encodeGroupDirectoryV3(pack.groups), pageRecords,
    bootstrapPageIds: pack.bootstrapPageIds.slice(), vertexFormats: encodeVertexFormatsV3(pack.vertexFormats), activationPageIds: Uint32Array.from([...new Set(pack.bootstrapPageIds)].sort((a, b) => a - b))
  });
  return descriptor;
}

export class OegPackProductRevisionSource implements GeometryProductRevisionSourceV1 {
  #released = false;
  constructor(readonly pack: OegPackV3, readonly descriptor: GeometryProductDescriptorV1) {}
  async readPage(pageId: number, signal?: AbortSignal): Promise<GeometryPageProductV1> {
    throwIfAborted(signal);
    if (this.#released) throw new Error("OEGPACK Product revision has been released");
    const recordOffset = pageId * 32;
    if (!Number.isInteger(pageId) || pageId < 0 || recordOffset + 32 > this.descriptor.pageRecords.byteLength) throw new RangeError("Geometry Product pageId is out of range");
    const expectedHash = this.descriptor.pageRecords.slice(recordOffset, recordOffset + 16);
    const page = await this.pack.readPage(pageId);
    throwIfAborted(signal);
    const decoded = page.bytes;
    if (decoded.byteLength !== OEGPACK_V3_PAGE_BYTES) throw new Error("OEGPACK adapter returned a non-256 KiB page");
    const bytes = decoded.slice().buffer;
    return Object.freeze({ productId: this.descriptor.productId.slice(), revision: this.descriptor.revision, pageId, decodedHash128: expectedHash, decodedPageHash128: Uint8Array.from(page.decodedPageHash128.slice(0, 32).match(/../gu)!, value => Number.parseInt(value, 16)), bytes });
  }
  release(): void { this.#released = true; }
}

function fromHex(value: string): Uint8Array { return fromHexBytes(value, 32); }
function fromHexBytes(value: string, byteLength: number): Uint8Array { if (!new RegExp(`^[0-9a-f]{${byteLength * 2}}$`, "u").test(value)) throw new Error(`expected ${byteLength}-byte lowercase hex`); return Uint8Array.from({ length: byteLength }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)); }
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError"); }

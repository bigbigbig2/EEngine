import { decodeVertexFormatV4, geometryVertexPayloadBytes } from "./GeometryAbiV4.js";
import { decodeGeometryZstd } from "./codec/GeometryZstd.js";
import {
  OEGPACK_V4_ASSET_STRIDE,
  OEGPACK_V4_GROUP_DIRECTORY_STRIDE,
  OEGPACK_V4_GROUP_HEADER_BYTES,
  OEGPACK_V4_HEADER_BYTES,
  OEGPACK_V4_HIERARCHY_STRIDE,
  OEGPACK_V4_INVALID_ID,
  OEGPACK_V4_MESHLET_HEADER_BYTES,
  OEGPACK_V4_PAGE_BYTES,
  OEGPACK_V4_PAGE_DIRECTORY_STRIDE,
  OEGPACK_V4_PAGE_SHIFT,
  OEGPACK_V4_VERTEX_FORMAT_STRIDE,
  decodeHierarchyNodeV4,
  decodeGroupHeaderV4,
  decodeMeshletHeaderV4,
  hierarchyNodeChildCountV4,
  hierarchyNodeChildStartV4,
  hierarchyNodeGroupIdV4,
  hierarchyNodeIsGroupV4,
  type GeometryAssetRecordV4,
  type GeometryGroupDirectoryV4,
  type GeometryHierarchyNodeV4,
  type GeometryPageDirectoryV4,
  type VertexFormatRecordV4,
} from "./GeometryAbiV4.js";
import { loadAssetBatch } from "./AssetLoadBatch.js";

const MAGIC = new Uint8Array([79, 69, 71, 80, 65, 67, 75, 0]);
const DEFAULT_COALESCED_MAX_BLOCK_BYTES = 16 * 1024 * 1024;
const DEFAULT_COALESCED_MAX_GAP_BYTES = 64n * 1024n;
const DEFAULT_COALESCED_CONCURRENCY = 4;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let crc = index;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    table[index] = crc >>> 0;
  }
  return table;
})();

export class OegPackV4Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OegPackV4Error";
  }
}

export interface RangeReadablePackV4 {
  read(byteOffset: bigint, byteLength: number, signal?: AbortSignal): Promise<ArrayBuffer>;
}

export class MemoryRangeReadablePackV4 implements RangeReadablePackV4 {
  readonly #bytes: Uint8Array;
  constructor(bytes: ArrayBuffer | Uint8Array) {
    this.#bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  }
  async read(byteOffset: bigint, byteLength: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    signal?.throwIfAborted();
    const offset = safeNumber(byteOffset, "memory range offset");
    if (!Number.isInteger(byteLength) || byteLength < 0 || offset + byteLength > this.#bytes.byteLength) {
      throw new OegPackV4Error("memory range is outside pack bounds");
    }
    return this.#bytes.slice(offset, offset + byteLength).buffer;
  }
}

export class HttpRangeReadablePackV4 implements RangeReadablePackV4 {
  constructor(
    readonly url: string,
    readonly init: Omit<RequestInit, "headers"> = {},
  ) {}
  async read(byteOffset: bigint, byteLength: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (!Number.isInteger(byteLength) || byteLength <= 0)
      throw new OegPackV4Error("HTTP range length must be positive");
    const end = byteOffset + BigInt(byteLength) - 1n;
    const response = await fetch(this.url, {
      ...this.init,
      signal: signal ?? this.init.signal,
      headers: { Range: `bytes=${byteOffset}-${end}`, "Accept-Encoding": "identity" },
    });
    if (response.status !== 206) {
      await response.body?.cancel();
      throw new OegPackV4Error(`server did not honor byte range (${response.status})`);
    }
    const contentRange = response.headers.get("content-range");
    const expectedRange = `bytes ${byteOffset}-${end}/`;
    if (!contentRange?.startsWith(expectedRange) || !/^bytes \d+-\d+\/(?:\d+|\*)$/u.test(contentRange)) {
      await response.body?.cancel();
      throw new OegPackV4Error("HTTP Content-Range does not match the requested byte interval");
    }
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding !== "identity") {
      await response.body?.cancel();
      throw new OegPackV4Error(`oegpack range used forbidden Content-Encoding '${encoding}'`);
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) !== byteLength) {
      await response.body?.cancel();
      throw new OegPackV4Error("HTTP range response length mismatch");
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new OegPackV4Error("HTTP range response has no body");
    }
    const bytes = new Uint8Array(byteLength);
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        if (size + chunk.value.byteLength > byteLength) {
          throw new OegPackV4Error("HTTP range response exceeded its reserved byte domain");
        }
        bytes.set(chunk.value, size);
        size += chunk.value.byteLength;
      }
      if (size !== byteLength) {
        throw new OegPackV4Error("HTTP range response length mismatch");
      }
      return bytes.buffer;
    } finally {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
  }
}

export interface OegPackHeaderV4 {
  readonly formatMajor: 4;
  readonly formatMinor: 0;
  readonly pageShift: 18;
  readonly pageBytes: 262144;
  readonly flags: number;
  readonly defaultCodec: number;
  readonly assetCount: number;
  readonly rootNodeIndexCount: number;
  readonly hierarchyNodeCount: number;
  readonly groupCount: number;
  readonly pageCount: number;
  readonly vertexFormatCount: number;
  readonly bootstrapPageCount: number;
  readonly assetDirectoryOffset: bigint;
  readonly rootNodeIndexOffset: bigint;
  readonly hierarchyOffset: bigint;
  readonly groupDirectoryOffset: bigint;
  readonly pageDirectoryOffset: bigint;
  readonly vertexFormatOffset: bigint;
  readonly bootstrapPageOffset: bigint;
  readonly pageBlobOffset: bigint;
  readonly fileBytes: bigint;
  readonly recipeHash: string;
  readonly packContentHash: string;
  readonly querySectionOffset: bigint;
  readonly querySectionBytes: bigint;
}

export interface OegPackOpenOptionsV4 {
  readonly signal?: AbortSignal;
  /**
   * When false, skips redundant whole-page SHA-256 digest computation after
   * compressed CRC32 and 256 KiB structural validation succeed. Defaults to true.
   */
  readonly verifyPageSha256?: boolean;
}

export interface OegPackV4 {
  readonly source: RangeReadablePackV4;
  readonly header: OegPackHeaderV4;
  readonly assets: readonly GeometryAssetRecordV4[];
  readonly rootNodeIndices: Uint32Array;
  readonly hierarchy: readonly GeometryHierarchyNodeV4[];
  readonly hierarchyBytes: Uint8Array;
  readonly groups: readonly GeometryGroupDirectoryV4[];
  readonly pages: readonly GeometryPageDirectoryV4[];
  readonly vertexFormats: readonly VertexFormatRecordV4[];
  readonly bootstrapPageIds: Uint32Array;
  readonly querySection: Uint8Array;
  readPage(pageId: number, signal?: AbortSignal): Promise<OegPackDecodedPageV4>;
  readPages?(pageIds: ArrayLike<number>, signal?: AbortSignal): Promise<readonly OegPackDecodedPageV4[]>;
}

/** Decoded page plus the whole-page digest. The digest is an integrity probe for this transport,
 *  not the page identity carried by the page directory (which rolls up Group payloads). */
export interface OegPackDecodedPageV4 {
  readonly bytes: Uint8Array;
  readonly integrity: "decoded-sha256" | "encoded-crc32";
  /** Absent under the explicit encoded-CRC32 policy; never a Page identity. */
  readonly decodedPageHash128?: string;
}

export async function openOegPackV4(
  source: RangeReadablePackV4,
  options: OegPackOpenOptionsV4 = {},
): Promise<OegPackV4> {
  const verifyPageSha256 = options.verifyPageSha256 !== false;
  const headerBytes = new Uint8Array(await source.read(0n, OEGPACK_V4_HEADER_BYTES, options.signal));
  const header = parseHeader(headerBytes);
  const metadataBytesLength = safeNumber(header.pageBlobOffset, "metadata byte length");
  if (metadataBytesLength < OEGPACK_V4_HEADER_BYTES)
    throw new OegPackV4Error("metadata ends before fixed header");
  const metadata = new Uint8Array(metadataBytesLength);
  metadata.set(headerBytes);
  if (metadata.byteLength > OEGPACK_V4_HEADER_BYTES) {
    metadata.set(new Uint8Array(await source.read(256n, metadata.byteLength - 256, options.signal)), 256);
  }
  const expectedHash = header.packContentHash;
  metadata.fill(0, 176, 208);
  if ((await sha256Hex(metadata)) !== expectedHash) throw new OegPackV4Error("pack content hash mismatch");
  const view = new DataView(metadata.buffer);
  validateTableRanges(header, metadata.byteLength);
  const assets = Object.freeze(
    Array.from({ length: header.assetCount }, (_, index) =>
      parseAsset(view, offset(header.assetDirectoryOffset) + index * OEGPACK_V4_ASSET_STRIDE),
    ),
  );
  const rootNodeIndices = readU32Table(view, header.rootNodeIndexOffset, header.rootNodeIndexCount);
  const hierarchyOffset = offset(header.hierarchyOffset);
  const hierarchy = Object.freeze(
    Array.from({ length: header.hierarchyNodeCount }, (_, index) =>
      decodeHierarchyNodeV4(view, hierarchyOffset + index * OEGPACK_V4_HIERARCHY_STRIDE),
    ),
  );
  const hierarchyBytes = metadata.slice(
    hierarchyOffset,
    hierarchyOffset + header.hierarchyNodeCount * OEGPACK_V4_HIERARCHY_STRIDE,
  );
  const groups = Object.freeze(
    Array.from({ length: header.groupCount }, (_, index) =>
      parseGroupDirectory(
        view,
        offset(header.groupDirectoryOffset) + index * OEGPACK_V4_GROUP_DIRECTORY_STRIDE,
      ),
    ),
  );
  const pages = Object.freeze(
    Array.from({ length: header.pageCount }, (_, index) =>
      parsePageDirectory(view, offset(header.pageDirectoryOffset) + index * OEGPACK_V4_PAGE_DIRECTORY_STRIDE),
    ),
  );
  const vertexFormats = Object.freeze(
    Array.from({ length: header.vertexFormatCount }, (_, index) =>
      parseVertexFormat(view, offset(header.vertexFormatOffset) + index * OEGPACK_V4_VERTEX_FORMAT_STRIDE),
    ),
  );
  const bootstrapPageIds = readU32Table(view, header.bootstrapPageOffset, header.bootstrapPageCount);
  const querySection = metadata.slice(
    offset(header.querySectionOffset),
    offset(header.querySectionOffset + header.querySectionBytes),
  );
  validateMetadata(
    header,
    assets,
    rootNodeIndices,
    hierarchy,
    groups,
    pages,
    vertexFormats,
    bootstrapPageIds,
  );

  const decodeAndValidateEncodedPage = async (
    pageId: number,
    encoded: Uint8Array,
  ): Promise<OegPackDecodedPageV4> => {
    return decodeOegPackPageV4(pageId, encoded, pages[pageId]!, groups, vertexFormats, verifyPageSha256);
  };

  return Object.freeze({
    source,
    header,
    assets,
    rootNodeIndices,
    hierarchy,
    hierarchyBytes,
    groups,
    pages,
    vertexFormats,
    bootstrapPageIds,
    querySection,
    async readPage(pageId: number, signal?: AbortSignal): Promise<OegPackDecodedPageV4> {
      assertIndex(pageId, pages.length, "pageId");
      const page = pages[pageId]!;
      const encoded = new Uint8Array(
        await source.read(page.compressedFileOffset, page.compressedBytes, signal),
      );
      return decodeAndValidateEncodedPage(pageId, encoded);
    },
    async readPages(
      pageIds: ArrayLike<number>,
      signal?: AbortSignal,
    ): Promise<readonly OegPackDecodedPageV4[]> {
      if (signal?.aborted) throw signal.reason ?? new Error("OEGPACK batch page read was aborted");
      const count = pageIds.length;
      if (count === 0) return Object.freeze([]);
      const uniqueIds: number[] = [];
      const seen = new Set<number>();
      for (let i = 0; i < count; i++) {
        const pageId = pageIds[i]!;
        assertIndex(pageId, pages.length, "pageId");
        if (!seen.has(pageId)) {
          seen.add(pageId);
          uniqueIds.push(pageId);
        }
      }
      uniqueIds.sort((a, b) => {
        const left = pages[a]!.compressedFileOffset;
        const right = pages[b]!.compressedFileOffset;
        return left < right ? -1 : left > right ? 1 : a - b;
      });
      interface CoalescedSpan {
        readonly startOffset: bigint;
        readonly byteLength: number;
        readonly pageIds: number[];
      }
      const spans: CoalescedSpan[] = [];
      for (const pageId of uniqueIds) {
        const entry = pages[pageId]!;
        const start = entry.compressedFileOffset;
        const end = start + BigInt(entry.compressedBytes);
        const last = spans[spans.length - 1];
        if (last !== undefined) {
          const lastEnd = last.startOffset + BigInt(last.byteLength);
          const mergedBytes = Number(end - last.startOffset);
          if (
            start >= last.startOffset &&
            start <= lastEnd + DEFAULT_COALESCED_MAX_GAP_BYTES &&
            mergedBytes <= DEFAULT_COALESCED_MAX_BLOCK_BYTES
          ) {
            spans[spans.length - 1] = {
              startOffset: last.startOffset,
              byteLength: Math.max(last.byteLength, mergedBytes),
              pageIds: [...last.pageIds, pageId],
            };
            continue;
          }
        }
        spans.push({
          startOffset: start,
          byteLength: entry.compressedBytes,
          pageIds: [pageId],
        });
      }
      const decodedByPageId = new Map<number, OegPackDecodedPageV4>();
      await loadAssetBatch(
        spans,
        DEFAULT_COALESCED_CONCURRENCY,
        signal ?? new AbortController().signal,
        async (span, _index, batchSignal) => {
          // Release each encoded span after decoding instead of retaining every
          // transport block until the entire bootstrap read has completed.
          const block = new Uint8Array(await source.read(span.startOffset, span.byteLength, batchSignal));
          for (const pageId of span.pageIds) {
            batchSignal.throwIfAborted();
            const entry = pages[pageId]!;
            const localOffset = Number(entry.compressedFileOffset - span.startOffset);
            const encoded = block.subarray(localOffset, localOffset + entry.compressedBytes);
            decodedByPageId.set(pageId, await decodeAndValidateEncodedPage(pageId, encoded));
          }
        },
      );
      const results = new Array<OegPackDecodedPageV4>(count);
      for (let i = 0; i < count; i++) {
        results[i] = decodedByPageId.get(pageIds[i]!)!;
      }
      return Object.freeze(results);
    },
  });
}

/** Shared CPU kernel for custom sources and Dedicated Worker cooked preparation. */
export async function decodeOegPackPageV4(
  pageId: number,
  encoded: Uint8Array,
  page: GeometryPageDirectoryV4,
  groups: readonly GeometryGroupDirectoryV4[],
  formats: readonly VertexFormatRecordV4[],
  verifyPageSha256: boolean,
): Promise<OegPackDecodedPageV4> {
  if (encoded.byteLength !== page.compressedBytes || crc32(encoded) !== page.compressedChecksum) {
    throw new OegPackV4Error(`page ${pageId} compressed checksum mismatch`);
  }
  const decoded = page.codec === 0 ? encoded.slice() : await decodeGeometryZstd(encoded, page.decodedBytes);
  if (decoded.byteLength !== OEGPACK_V4_PAGE_BYTES) {
    throw new OegPackV4Error(`page ${pageId} did not decode to 256 KiB`);
  }
  validateDecodedPage(pageId, decoded, page, groups, formats);
  return {
    bytes: decoded,
    decodedPageHash128: verifyPageSha256 ? await sha256Hex(decoded) : undefined,
    integrity: verifyPageSha256 ? "decoded-sha256" : "encoded-crc32",
  };
}

function parseHeader(bytes: Uint8Array): OegPackHeaderV4 {
  if (bytes.byteLength !== 256 || !MAGIC.every((value, index) => bytes[index] === value))
    throw new OegPackV4Error("invalid OEGPACK V4 magic/header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (at: number) => view.getUint32(at, true);
  const u64 = (at: number) => view.getBigUint64(at, true);
  if (u32(8) !== 4 || u32(12) !== 0) {
    throw new OegPackV4Error("query geometry requires OEGPACK V4.0; recook source");
  }
  if (u32(16) !== 0x01020304 || u32(20) !== 256)
    throw new OegPackV4Error("invalid endian/header size marker");
  if (u32(24) !== OEGPACK_V4_PAGE_SHIFT || u32(28) !== OEGPACK_V4_PAGE_BYTES)
    throw new OegPackV4Error("V4 page size must be 256 KiB");
  if (u32(32) !== 0 || u32(36) !== 1 || u32(68) !== 0 || bytes.subarray(224).some((value) => value !== 0))
    throw new OegPackV4Error("V4 header flags/default codec/reserved bytes are invalid");
  return Object.freeze({
    formatMajor: 4,
    formatMinor: 0,
    pageShift: 18,
    pageBytes: 262144,
    flags: u32(32),
    defaultCodec: u32(36),
    assetCount: u32(40),
    rootNodeIndexCount: u32(44),
    hierarchyNodeCount: u32(48),
    groupCount: u32(52),
    pageCount: u32(56),
    vertexFormatCount: u32(60),
    bootstrapPageCount: u32(64),
    assetDirectoryOffset: u64(72),
    rootNodeIndexOffset: u64(80),
    hierarchyOffset: u64(88),
    groupDirectoryOffset: u64(96),
    pageDirectoryOffset: u64(104),
    vertexFormatOffset: u64(112),
    bootstrapPageOffset: u64(120),
    pageBlobOffset: u64(128),
    fileBytes: u64(136),
    recipeHash: hex(bytes.subarray(144, 176)),
    packContentHash: hex(bytes.subarray(176, 208)),
    querySectionOffset: u64(208),
    querySectionBytes: u64(216),
  });
}

function parseAsset(view: DataView, at: number): GeometryAssetRecordV4 {
  const f = (offset: number, count: number) =>
    Object.freeze(Array.from({ length: count }, (_, i) => view.getFloat32(at + offset + i * 4, true)));
  const u = (offset: number) => view.getUint32(at + offset, true);
  if (u(116) !== 0 || u(120) !== 0 || u(124) !== 0)
    throw new OegPackV4Error("asset flags/reserved fields are invalid");
  return Object.freeze({
    assetId: hex(new Uint8Array(view.buffer, view.byteOffset + at, 32)),
    boundsSphere: f(32, 4) as [number, number, number, number],
    boundsMin: f(48, 3) as [number, number, number],
    boundsMax: f(60, 3) as [number, number, number],
    rootNodeBegin: u(72),
    rootNodeCount: u(76),
    hierarchyBegin: u(80),
    hierarchyCount: u(84),
    groupBegin: u(88),
    groupCount: u(92),
    bootstrapPageBegin: u(96),
    bootstrapPageCount: u(100),
    sourceTriangleCount: u(104),
    leafMeshletCount: u(108),
    totalMeshletCount: u(112),
    flags: u(116),
  });
}

function parseGroupDirectory(view: DataView, at: number): GeometryGroupDirectoryV4 {
  return Object.freeze({
    pageId: view.getUint32(at, true),
    offsetInDecodedPage: view.getUint32(at + 4, true),
    payloadBytes: view.getUint32(at + 8, true),
    flags: view.getUint32(at + 12, true),
  });
}

function parsePageDirectory(view: DataView, at: number): GeometryPageDirectoryV4 {
  const codec = view.getUint32(at + 24, true);
  if (codec !== 0 && codec !== 1) throw new OegPackV4Error(`unsupported page codec ${codec}`);
  if (
    (view.getUint32(at + 28, true) & ~1) !== 0 ||
    view.getUint32(at + 52, true) !== 0 ||
    view.getBigUint64(at + 56, true) !== 0n
  )
    throw new OegPackV4Error("page flags/reserved fields are invalid");
  return Object.freeze({
    compressedFileOffset: view.getBigUint64(at, true),
    compressedBytes: view.getUint32(at + 8, true),
    decodedBytes: view.getUint32(at + 12, true),
    firstGroup: view.getUint32(at + 16, true),
    groupCount: view.getUint32(at + 20, true),
    codec,
    flags: view.getUint32(at + 28, true),
    decodedContentHash128: hex(new Uint8Array(view.buffer, view.byteOffset + at + 32, 16)),
    compressedChecksum: view.getUint32(at + 48, true),
  });
}

function parseVertexFormat(view: DataView, at: number): VertexFormatRecordV4 {
  return decodeVertexFormatV4(view, at);
}

function validateTableRanges(header: OegPackHeaderV4, metadataBytes: number): void {
  const tables: readonly [bigint, bigint, string][] = [
    [header.assetDirectoryOffset, BigInt(header.assetCount * OEGPACK_V4_ASSET_STRIDE), "asset"],
    [header.rootNodeIndexOffset, BigInt(header.rootNodeIndexCount * 4), "root"],
    [header.hierarchyOffset, BigInt(header.hierarchyNodeCount * OEGPACK_V4_HIERARCHY_STRIDE), "hierarchy"],
    [header.groupDirectoryOffset, BigInt(header.groupCount * OEGPACK_V4_GROUP_DIRECTORY_STRIDE), "group"],
    [header.pageDirectoryOffset, BigInt(header.pageCount * OEGPACK_V4_PAGE_DIRECTORY_STRIDE), "page"],
    [header.bootstrapPageOffset, BigInt(header.bootstrapPageCount * 4), "bootstrap"],
    [
      header.vertexFormatOffset,
      BigInt(header.vertexFormatCount * OEGPACK_V4_VERTEX_FORMAT_STRIDE),
      "vertex format",
    ],
    [header.querySectionOffset, header.querySectionBytes, "query section"],
  ];
  let previous = 256n;
  for (const [start, length, name] of tables) {
    if (start < previous || start + length > BigInt(metadataBytes))
      throw new OegPackV4Error(`${name} table range is invalid`);
    previous = start + length;
  }
  if (header.fileBytes < header.pageBlobOffset) throw new OegPackV4Error("fileBytes precedes page blob");
  if (header.querySectionBytes < 128n) throw new OegPackV4Error("query section is truncated");
}

function validateMetadata(
  header: OegPackHeaderV4,
  assets: readonly GeometryAssetRecordV4[],
  roots: Uint32Array,
  hierarchy: readonly GeometryHierarchyNodeV4[],
  groups: readonly GeometryGroupDirectoryV4[],
  pages: readonly GeometryPageDirectoryV4[],
  formats: readonly VertexFormatRecordV4[],
  bootstrap: Uint32Array,
): void {
  if (
    !assets.length ||
    !roots.length ||
    !hierarchy.length ||
    !groups.length ||
    !pages.length ||
    !formats.length ||
    !bootstrap.length
  )
    throw new OegPackV4Error("required V4 table is empty");
  for (const root of roots) assertIndex(root, hierarchy.length, "root node");
  const bootstrapSet = new Set(bootstrap);
  for (const pageId of bootstrap) assertIndex(pageId, pages.length, "bootstrap page");
  for (const asset of assets) {
    assertRange(asset.rootNodeBegin, asset.rootNodeCount, roots.length, "asset roots");
    assertRange(asset.hierarchyBegin, asset.hierarchyCount, hierarchy.length, "asset hierarchy");
    assertRange(asset.groupBegin, asset.groupCount, groups.length, "asset groups");
    assertRange(
      asset.bootstrapPageBegin,
      asset.bootstrapPageCount,
      bootstrap.length,
      "asset bootstrap pages",
    );
    if (!asset.rootNodeCount || !asset.bootstrapPageCount)
      throw new OegPackV4Error("asset has no root/bootstrap cut");
    const nodeEnd = asset.hierarchyBegin + asset.hierarchyCount;
    const groupEnd = asset.groupBegin + asset.groupCount;
    const reachedNodes = new Uint8Array(asset.hierarchyCount);
    const reachedGroups = new Uint8Array(asset.groupCount);
    const stack: number[] = [];
    for (let i = 0; i < asset.rootNodeCount; i++) {
      const root = roots[asset.rootNodeBegin + i]!;
      if (root < asset.hierarchyBegin || root >= nodeEnd)
        throw new OegPackV4Error("asset root escapes its hierarchy range");
      stack.push(root);
    }
    while (stack.length) {
      const nodeId = stack.pop()!;
      if (reachedNodes[nodeId - asset.hierarchyBegin]) continue;
      reachedNodes[nodeId - asset.hierarchyBegin] = 1;
      const packed = hierarchy[nodeId]!.packedNodeData;
      if (hierarchyNodeIsGroupV4(packed)) {
        const group = hierarchyNodeGroupIdV4(packed);
        if (group < asset.groupBegin || group >= groupEnd)
          throw new OegPackV4Error("asset hierarchy leaf escapes its group range");
        reachedGroups[group - asset.groupBegin] = 1;
      } else {
        const begin = hierarchyNodeChildStartV4(packed);
        const count = hierarchyNodeChildCountV4(packed);
        if (begin < asset.hierarchyBegin || begin + count > nodeEnd)
          throw new OegPackV4Error("asset hierarchy child escapes its hierarchy range");
        for (let child = begin; child < begin + count; child++) stack.push(child);
      }
    }
    if (reachedNodes.includes(0))
      throw new OegPackV4Error("asset contains a hierarchy node unreachable from its roots");
    if (reachedGroups.includes(0))
      throw new OegPackV4Error("asset contains a group unreachable from its roots");
    const assetBootstrap = new Set<number>();
    for (let i = 0; i < asset.bootstrapPageCount; i++)
      assetBootstrap.add(bootstrap[asset.bootstrapPageBegin + i]!);
    if (assetBootstrap.size !== asset.bootstrapPageCount)
      throw new OegPackV4Error("asset bootstrap page list contains duplicates");
    const requiredBootstrap = new Set<number>();
    for (let group = asset.groupBegin; group < groupEnd; group++)
      if (groups[group]!.flags & 1) requiredBootstrap.add(groups[group]!.pageId);
    if (
      !requiredBootstrap.size ||
      requiredBootstrap.size !== assetBootstrap.size ||
      [...requiredBootstrap].some((page) => !assetBootstrap.has(page))
    ) {
      throw new OegPackV4Error("asset bootstrap cut is incomplete or contains unrelated pages");
    }
  }
  for (let index = 0; index < hierarchy.length; index++) {
    const node = hierarchy[index]!;
    if (![...node.boundsSphere, ...node.bboxMin, ...node.bboxMax, node.maxParentError].every(Number.isFinite))
      throw new OegPackV4Error(`hierarchy node ${index} is non-finite`);
    if (node.packedNodeData & 1)
      assertIndex(hierarchyNodeGroupIdV4(node.packedNodeData), groups.length, "hierarchy group");
    else {
      const count = node.packedNodeData >>> 28;
      assertRange((node.packedNodeData >>> 1) & 0x7ffffff, count, hierarchy.length, "hierarchy children");
      if (count < 1 || count > 8) throw new OegPackV4Error("hierarchy child count is outside [1,8]");
    }
  }
  const pageCounts = new Uint32Array(pages.length);
  const pageMinimumGroups = new Uint32Array(pages.length);
  pageMinimumGroups.fill(OEGPACK_V4_INVALID_ID);
  const pageHasBootstrap = new Uint8Array(pages.length);
  for (let groupId = 0; groupId < groups.length; groupId++) {
    const group = groups[groupId]!;
    assertIndex(group.pageId, pages.length, "group page");
    if (
      group.offsetInDecodedPage & 15 ||
      !group.payloadBytes ||
      group.offsetInDecodedPage + group.payloadBytes > OEGPACK_V4_PAGE_BYTES
    )
      throw new OegPackV4Error("group is not wholly contained and 16-byte aligned in its page");
    if ((group.flags & ~0xff) !== 0) throw new OegPackV4Error("group flags contain unknown V4 bits");
    if ((group.flags & 0xc0) !== 0)
      throw new OegPackV4Error("Retired continuity payload requires recook with SoA v8");
    pageCounts[group.pageId] = pageCounts[group.pageId]! + 1;
    pageMinimumGroups[group.pageId] = Math.min(pageMinimumGroups[group.pageId]!, groupId);
    if (group.flags & 1) pageHasBootstrap[group.pageId] = 1;
    if (group.flags & 1 && !bootstrapSet.has(group.pageId))
      throw new OegPackV4Error("bootstrap group is not in bootstrap page set");
  }
  let previousEnd = header.pageBlobOffset;
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index]!;
    if (
      page.decodedBytes !== OEGPACK_V4_PAGE_BYTES ||
      (!page.compressedBytes || page.compressedBytes > OEGPACK_V4_PAGE_BYTES) ||
      page.groupCount !== pageCounts[index] ||
      page.firstGroup !== pageMinimumGroups[index]
    )
      throw new OegPackV4Error(`page ${index} directory is inconsistent`);
    if (((page.flags & 1) !== 0) !== (pageHasBootstrap[index] !== 0))
      throw new OegPackV4Error(`page ${index} bootstrap summary is inconsistent`);
    if (
      page.compressedFileOffset < previousEnd ||
      page.compressedFileOffset + BigInt(page.compressedBytes) > header.fileBytes
    )
      throw new OegPackV4Error(`page ${index} compressed range overlaps or exceeds file`);
    previousEnd = page.compressedFileOffset + BigInt(page.compressedBytes);
  }
  for (let index = 0; index < formats.length; index++) {
    const format = formats[index]!;
    if (
      (format.attributeMask & 3) !== 3 ||
      (format.attributeMask & ~0x3f) !== 0 ||
      !format.streamBytesPerVertex ||
      (format.positionOffset & 3) !== 0 ||
      
      format.positionOffset + 12 > format.streamBytesPerVertex ||
      format.normalOffset + 4 > format.streamBytesPerVertex
    )
      throw new OegPackV4Error(`vertex format ${index} is invalid`);
    const optionalAttributes: ReadonlyArray<readonly [number, number]> = [
      [format.tangentOffset, 4],
      [format.uv0Offset, 4],
      [format.uv1Offset, 4],
      [format.colorOffset, 4],
    ];
    for (const [attributeOffset, width] of optionalAttributes)
      if (attributeOffset !== 0xff && attributeOffset + width > format.streamBytesPerVertex)
        throw new OegPackV4Error(`vertex format ${index} optional attribute range is invalid`);
  }
  if (previousEnd !== header.fileBytes)
    throw new OegPackV4Error("page directory does not cover file tail exactly");
}

function validateDecodedPage(
  pageId: number,
  decoded: Uint8Array,
  page: GeometryPageDirectoryV4,
  groups: readonly GeometryGroupDirectoryV4[],
  formats: readonly VertexFormatRecordV4[],
): void {
  const view = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  const firstGroup = page.firstGroup;
  const groupEnd = firstGroup + page.groupCount;
  for (let groupId = firstGroup; groupId < groupEnd; groupId++) {
    const directory = groups[groupId]!;
    if (directory.pageId !== pageId) continue;
    if (directory.payloadBytes < OEGPACK_V4_GROUP_HEADER_BYTES)
      throw new OegPackV4Error(`group ${groupId} payload is too small`);
    const base = directory.offsetInDecodedPage;
    const group = decodeGroupHeaderV4(view, base);
    if (group.payloadBytes !== directory.payloadBytes || group.meshletCount < 1 || group.meshletCount > 128)
      throw new OegPackV4Error(`group ${groupId} header is invalid`);
    assertIndex(group.vertexFormatId, formats.length, `group ${groupId} vertex format`);
    if (
      ![...group.boundsSphere, ...group.bboxMin, ...group.bboxMax, group.parentError].every(Number.isFinite)
    )
      throw new OegPackV4Error(`group ${groupId} contains non-finite metadata`);
    const headersEnd = group.meshletHeaderOffset + group.meshletCount * OEGPACK_V4_MESHLET_HEADER_BYTES;
    if (
      group.meshletHeaderOffset !== OEGPACK_V4_GROUP_HEADER_BYTES ||
      headersEnd > group.triangleDataOffset ||
      group.triangleDataOffset > group.vertexDataOffset ||
      group.vertexDataOffset > group.payloadBytes
    ) {
      throw new OegPackV4Error(`group ${groupId} section offsets are invalid`);
    }
    const format = formats[group.vertexFormatId]!;
    for (let meshletIndex = 0; meshletIndex < group.meshletCount; meshletIndex++) {
      const meshlet = decodeMeshletHeaderV4(
        view,
        base + group.meshletHeaderOffset + meshletIndex * OEGPACK_V4_MESHLET_HEADER_BYTES,
      );
      if (
        meshlet.vertexCount < 1 ||
        meshlet.vertexCount > 128 ||
        meshlet.triangleCount < 1 ||
        meshlet.triangleCount > 128
      )
        throw new OegPackV4Error(`group ${groupId} meshlet ${meshletIndex} count is invalid`);
      if ((meshlet.flags & ~0x1f) !== 0)
        throw new OegPackV4Error(`group ${groupId} meshlet ${meshletIndex} flags are invalid`);
      if (meshlet.refineGroupId !== OEGPACK_V4_INVALID_ID)
        assertIndex(meshlet.refineGroupId, groups.length, `group ${groupId} refineGroupId`);
      const triangleEnd = meshlet.triangleByteOffset + meshlet.triangleCount * 3;
      const vertexEnd = meshlet.vertexByteOffset + geometryVertexPayloadBytes(meshlet.vertexCount, format);
      if (
        meshlet.triangleByteOffset < group.triangleDataOffset ||
        triangleEnd > group.vertexDataOffset ||
        meshlet.vertexByteOffset < group.vertexDataOffset ||
        vertexEnd > group.payloadBytes
      )
        throw new OegPackV4Error(`group ${groupId} meshlet ${meshletIndex} data range is invalid`);
      {
        for (let byte = meshlet.triangleByteOffset; byte < triangleEnd; byte++)
          if (decoded[base + byte]! >= meshlet.vertexCount)
            throw new OegPackV4Error(`group ${groupId} meshlet ${meshletIndex} has an invalid local index`);
      }
    }
  }
}

function readU32Table(view: DataView, start: bigint, count: number): Uint32Array {
  const result = new Uint32Array(count);
  const base = offset(start);
  for (let index = 0; index < count; index++) result[index] = view.getUint32(base + index * 4, true);
  return result;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.byteLength; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[i]!) & 0xff]!;
  }
  return ~crc >>> 0;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return hex(new Uint8Array(digest));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}
function offset(value: bigint): number {
  return safeNumber(value, "metadata offset");
}
function safeNumber(value: bigint, name: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new OegPackV4Error(`${name} exceeds exact JavaScript range`);
  return Number(value);
}
function assertIndex(value: number, length: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value >= length)
    throw new OegPackV4Error(`${name} ${value} is outside [0,${length})`);
}
function assertRange(begin: number, count: number, length: number, name: string): void {
  if (
    !Number.isInteger(begin) ||
    !Number.isInteger(count) ||
    count < 0 ||
    begin < 0 ||
    begin + count > length
  )
    throw new OegPackV4Error(`${name} range is invalid`);
}

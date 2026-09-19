import {
  OEGPACK_V3_ASSET_STRIDE,
  OEGPACK_V3_GROUP_DIRECTORY_STRIDE,
  OEGPACK_V3_GROUP_HEADER_BYTES,
  OEGPACK_V3_HEADER_BYTES,
  OEGPACK_V3_HIERARCHY_STRIDE,
  OEGPACK_V3_INVALID_ID,
  OEGPACK_V3_MESHLET_HEADER_BYTES,
  OEGPACK_V3_PAGE_BYTES,
  OEGPACK_V3_PAGE_DIRECTORY_STRIDE,
  OEGPACK_V3_PAGE_SHIFT,
  OEGPACK_V3_VERTEX_FORMAT_STRIDE,
  decodeHierarchyNodeV3,
  decodeGroupHeaderV3,
  decodeMeshletHeaderV3,
  hierarchyNodeChildCountV3,
  hierarchyNodeChildStartV3,
  hierarchyNodeGroupIdV3,
  hierarchyNodeIsGroupV3,
  type GeometryAssetRecordV3,
  type GeometryGroupDirectoryV3,
  type GeometryHierarchyNodeV3,
  type GeometryPageDirectoryV3,
  type VertexFormatRecordV3
} from "./GeometryAbiV3.js";

const MAGIC = new Uint8Array([79, 69, 71, 80, 65, 67, 75, 0]);

export class OegPackV3Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OegPackV3Error";
  }
}

export interface RangeReadablePackV3 {
  read(byteOffset: bigint, byteLength: number): Promise<ArrayBuffer>;
}

export class MemoryRangeReadablePackV3 implements RangeReadablePackV3 {
  readonly #bytes: Uint8Array;
  constructor(bytes: ArrayBuffer | Uint8Array) {
    this.#bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  }
  async read(byteOffset: bigint, byteLength: number): Promise<ArrayBuffer> {
    const offset = safeNumber(byteOffset, "memory range offset");
    if (!Number.isInteger(byteLength) || byteLength < 0 || offset + byteLength > this.#bytes.byteLength) {
      throw new OegPackV3Error("memory range is outside pack bounds");
    }
    return this.#bytes.slice(offset, offset + byteLength).buffer;
  }
}

export class HttpRangeReadablePackV3 implements RangeReadablePackV3 {
  constructor(readonly url: string, readonly init: Omit<RequestInit, "headers"> = {}) {}
  async read(byteOffset: bigint, byteLength: number): Promise<ArrayBuffer> {
    if (!Number.isInteger(byteLength) || byteLength <= 0) throw new OegPackV3Error("HTTP range length must be positive");
    const end = byteOffset + BigInt(byteLength) - 1n;
    const response = await fetch(this.url, {
      ...this.init,
      headers: { Range: `bytes=${byteOffset}-${end}`, "Accept-Encoding": "identity" }
    });
    if (response.status !== 206) throw new OegPackV3Error(`server did not honor byte range (${response.status})`);
    const contentRange = response.headers.get("content-range");
    const expectedRange = `bytes ${byteOffset}-${end}/`;
    if (!contentRange?.startsWith(expectedRange) || !/^bytes \d+-\d+\/(?:\d+|\*)$/u.test(contentRange)) throw new OegPackV3Error("HTTP Content-Range does not match the requested byte interval");
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding !== "identity") throw new OegPackV3Error(`oegpack range used forbidden Content-Encoding '${encoding}'`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== byteLength) throw new OegPackV3Error("HTTP range response length mismatch");
    return bytes;
  }
}

export interface OegPackHeaderV3 {
  readonly formatMajor: 3;
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
}

export interface OegPackV3 {
  readonly source: RangeReadablePackV3;
  readonly header: OegPackHeaderV3;
  readonly assets: readonly GeometryAssetRecordV3[];
  readonly rootNodeIndices: Uint32Array;
  readonly hierarchy: readonly GeometryHierarchyNodeV3[];
  readonly hierarchyBytes: Uint8Array;
  readonly groups: readonly GeometryGroupDirectoryV3[];
  readonly pages: readonly GeometryPageDirectoryV3[];
  readonly vertexFormats: readonly VertexFormatRecordV3[];
  readonly bootstrapPageIds: Uint32Array;
  readPage(pageId: number): Promise<OegPackDecodedPageV3>;
}

/** Decoded page plus the whole-page digest. The digest is an integrity probe for this transport,
 *  not the page identity carried by the page directory (which rolls up Group payloads). */
export interface OegPackDecodedPageV3 {
  readonly bytes: Uint8Array;
  readonly decodedPageHash128: string;
}

export async function openOegPackV3(source: RangeReadablePackV3): Promise<OegPackV3> {
  const headerBytes = new Uint8Array(await source.read(0n, OEGPACK_V3_HEADER_BYTES));
  const header = parseHeader(headerBytes);
  const metadataBytesLength = safeNumber(header.pageBlobOffset, "metadata byte length");
  if (metadataBytesLength < OEGPACK_V3_HEADER_BYTES) throw new OegPackV3Error("metadata ends before fixed header");
  const metadata = new Uint8Array(metadataBytesLength);
  metadata.set(headerBytes);
  if (metadata.byteLength > OEGPACK_V3_HEADER_BYTES) {
    metadata.set(new Uint8Array(await source.read(256n, metadata.byteLength - 256)), 256);
  }
  const expectedHash = header.packContentHash;
  metadata.fill(0, 176, 208);
  if ((await sha256Hex(metadata)) !== expectedHash) throw new OegPackV3Error("pack content hash mismatch");
  const view = new DataView(metadata.buffer);
  validateTableRanges(header, metadata.byteLength);
  const assets = Object.freeze(Array.from({ length: header.assetCount }, (_, index) =>
    parseAsset(view, offset(header.assetDirectoryOffset) + index * OEGPACK_V3_ASSET_STRIDE)));
  const rootNodeIndices = readU32Table(view, header.rootNodeIndexOffset, header.rootNodeIndexCount);
  const hierarchyOffset = offset(header.hierarchyOffset);
  const hierarchy = Object.freeze(Array.from({ length: header.hierarchyNodeCount }, (_, index) =>
    decodeHierarchyNodeV3(view, hierarchyOffset + index * OEGPACK_V3_HIERARCHY_STRIDE)));
  const hierarchyBytes = metadata.slice(hierarchyOffset, hierarchyOffset + header.hierarchyNodeCount * OEGPACK_V3_HIERARCHY_STRIDE);
  const groups = Object.freeze(Array.from({ length: header.groupCount }, (_, index) =>
    parseGroupDirectory(view, offset(header.groupDirectoryOffset) + index * OEGPACK_V3_GROUP_DIRECTORY_STRIDE)));
  const pages = Object.freeze(Array.from({ length: header.pageCount }, (_, index) =>
    parsePageDirectory(view, offset(header.pageDirectoryOffset) + index * OEGPACK_V3_PAGE_DIRECTORY_STRIDE)));
  const vertexFormats = Object.freeze(Array.from({ length: header.vertexFormatCount }, (_, index) =>
    parseVertexFormat(view, offset(header.vertexFormatOffset) + index * OEGPACK_V3_VERTEX_FORMAT_STRIDE)));
  const bootstrapPageIds = readU32Table(view, header.bootstrapPageOffset, header.bootstrapPageCount);
  validateMetadata(header, assets, rootNodeIndices, hierarchy, groups, pages, vertexFormats, bootstrapPageIds);
  return Object.freeze({
    source, header, assets, rootNodeIndices, hierarchy, hierarchyBytes, groups, pages, vertexFormats, bootstrapPageIds,
    async readPage(pageId: number): Promise<OegPackDecodedPageV3> {
      assertIndex(pageId, pages.length, "pageId");
      const page = pages[pageId]!;
      const encoded = new Uint8Array(await source.read(page.compressedFileOffset, page.compressedBytes));
      if (crc32(encoded) !== page.compressedChecksum) throw new OegPackV3Error(`page ${pageId} compressed checksum mismatch`);
      const decoded = page.codec === 0 ? encoded.slice() : decodeLz4Block(encoded, page.decodedBytes);
      if (decoded.byteLength !== OEGPACK_V3_PAGE_BYTES) throw new OegPackV3Error(`page ${pageId} did not decode to 256 KiB`);
      validateDecodedPage(pageId, decoded, groups, vertexFormats);
      // The page directory carries the page *identity* (rolled up from Group payloads), not a
      // digest of the whole page bytes. Whole-page digest is returned alongside so consumers that
      // want an integrity probe can compare it against a value they recorded at production time.
      return { bytes: decoded, decodedPageHash128: (await sha256Hex(decoded)) };
    }
  });
}

function parseHeader(bytes: Uint8Array): OegPackHeaderV3 {
  if (bytes.byteLength !== 256 || !MAGIC.every((value, index) => bytes[index] === value)) throw new OegPackV3Error("invalid OEGPACK V3 magic/header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (at: number) => view.getUint32(at, true);
  const u64 = (at: number) => view.getBigUint64(at, true);
  if (u32(8) !== 3 || u32(12) !== 0) throw new OegPackV3Error("only OEGPACK V3.0 is supported");
  if (u32(16) !== 0x01020304 || u32(20) !== 256) throw new OegPackV3Error("invalid endian/header size marker");
  if (u32(24) !== OEGPACK_V3_PAGE_SHIFT || u32(28) !== OEGPACK_V3_PAGE_BYTES) throw new OegPackV3Error("V3 page size must be 256 KiB");
  if (u32(32) !== 0 || u32(36) !== 1 || u32(68) !== 0 || bytes.subarray(208).some(value => value !== 0)) throw new OegPackV3Error("V3 header flags/default codec/reserved bytes are invalid");
  return Object.freeze({
    formatMajor: 3, formatMinor: 0, pageShift: 18, pageBytes: 262144,
    flags: u32(32), defaultCodec: u32(36), assetCount: u32(40), rootNodeIndexCount: u32(44),
    hierarchyNodeCount: u32(48), groupCount: u32(52), pageCount: u32(56),
    vertexFormatCount: u32(60), bootstrapPageCount: u32(64),
    assetDirectoryOffset: u64(72), rootNodeIndexOffset: u64(80), hierarchyOffset: u64(88),
    groupDirectoryOffset: u64(96), pageDirectoryOffset: u64(104), vertexFormatOffset: u64(112),
    bootstrapPageOffset: u64(120), pageBlobOffset: u64(128), fileBytes: u64(136),
    recipeHash: hex(bytes.subarray(144, 176)), packContentHash: hex(bytes.subarray(176, 208))
  });
}

function parseAsset(view: DataView, at: number): GeometryAssetRecordV3 {
  const f = (offset: number, count: number) => Object.freeze(Array.from({ length: count }, (_, i) => view.getFloat32(at + offset + i * 4, true)));
  const u = (offset: number) => view.getUint32(at + offset, true);
  if (u(116) !== 0 || u(120) !== 0 || u(124) !== 0) throw new OegPackV3Error("asset flags/reserved fields are invalid");
  return Object.freeze({
    assetId: hex(new Uint8Array(view.buffer, view.byteOffset + at, 32)),
    boundsSphere: f(32, 4) as [number, number, number, number], boundsMin: f(48, 3) as [number, number, number], boundsMax: f(60, 3) as [number, number, number],
    rootNodeBegin: u(72), rootNodeCount: u(76), hierarchyBegin: u(80), hierarchyCount: u(84),
    groupBegin: u(88), groupCount: u(92), bootstrapPageBegin: u(96), bootstrapPageCount: u(100),
    sourceTriangleCount: u(104), leafMeshletCount: u(108), totalMeshletCount: u(112), flags: u(116)
  });
}

function parseGroupDirectory(view: DataView, at: number): GeometryGroupDirectoryV3 {
  return Object.freeze({ pageId: view.getUint32(at, true), offsetInDecodedPage: view.getUint32(at + 4, true), payloadBytes: view.getUint32(at + 8, true), flags: view.getUint32(at + 12, true) });
}

function parsePageDirectory(view: DataView, at: number): GeometryPageDirectoryV3 {
  const codec = view.getUint32(at + 24, true);
  if (codec !== 0 && codec !== 1) throw new OegPackV3Error(`unsupported page codec ${codec}`);
  if ((view.getUint32(at + 28, true) & ~1) !== 0 || view.getUint32(at + 52, true) !== 0 || view.getBigUint64(at + 56, true) !== 0n) throw new OegPackV3Error("page flags/reserved fields are invalid");
  return Object.freeze({
    compressedFileOffset: view.getBigUint64(at, true), compressedBytes: view.getUint32(at + 8, true), decodedBytes: view.getUint32(at + 12, true),
    firstGroup: view.getUint32(at + 16, true), groupCount: view.getUint32(at + 20, true), codec, flags: view.getUint32(at + 28, true),
    decodedContentHash128: hex(new Uint8Array(view.buffer, view.byteOffset + at + 32, 16)), compressedChecksum: view.getUint32(at + 48, true)
  });
}

function parseVertexFormat(view: DataView, at: number): VertexFormatRecordV3 {
  if (new Uint8Array(view.buffer, view.byteOffset + at + 10, 6).some(value => value !== 0)) throw new OegPackV3Error("vertex format reserved bytes are invalid");
  return Object.freeze({ strideBytes: view.getUint16(at, true), attributeMask: view.getUint16(at + 2, true), positionOffset: view.getUint8(at + 4), normalOffset: view.getUint8(at + 5), tangentOffset: view.getUint8(at + 6), uv0Offset: view.getUint8(at + 7), uv1Offset: view.getUint8(at + 8), colorOffset: view.getUint8(at + 9) });
}

function validateTableRanges(header: OegPackHeaderV3, metadataBytes: number): void {
  const tables: readonly [bigint, bigint, string][] = [
    [header.assetDirectoryOffset, BigInt(header.assetCount * OEGPACK_V3_ASSET_STRIDE), "asset"],
    [header.rootNodeIndexOffset, BigInt(header.rootNodeIndexCount * 4), "root"],
    [header.hierarchyOffset, BigInt(header.hierarchyNodeCount * OEGPACK_V3_HIERARCHY_STRIDE), "hierarchy"],
    [header.groupDirectoryOffset, BigInt(header.groupCount * OEGPACK_V3_GROUP_DIRECTORY_STRIDE), "group"],
    [header.pageDirectoryOffset, BigInt(header.pageCount * OEGPACK_V3_PAGE_DIRECTORY_STRIDE), "page"],
    [header.bootstrapPageOffset, BigInt(header.bootstrapPageCount * 4), "bootstrap"],
    [header.vertexFormatOffset, BigInt(header.vertexFormatCount * OEGPACK_V3_VERTEX_FORMAT_STRIDE), "vertex format"]
  ];
  let previous = 256n;
  for (const [start, length, name] of tables) {
    if (start < previous || start + length > BigInt(metadataBytes)) throw new OegPackV3Error(`${name} table range is invalid`);
    previous = start + length;
  }
  if (header.fileBytes < header.pageBlobOffset) throw new OegPackV3Error("fileBytes precedes page blob");
}

function validateMetadata(
  header: OegPackHeaderV3, assets: readonly GeometryAssetRecordV3[], roots: Uint32Array,
  hierarchy: readonly GeometryHierarchyNodeV3[], groups: readonly GeometryGroupDirectoryV3[],
  pages: readonly GeometryPageDirectoryV3[], formats: readonly VertexFormatRecordV3[], bootstrap: Uint32Array
): void {
  if (!assets.length || !roots.length || !hierarchy.length || !groups.length || !pages.length || !formats.length || !bootstrap.length) throw new OegPackV3Error("required V3 table is empty");
  for (const root of roots) assertIndex(root, hierarchy.length, "root node");
  const bootstrapSet = new Set(bootstrap);
  for (const pageId of bootstrap) assertIndex(pageId, pages.length, "bootstrap page");
  for (const asset of assets) {
    assertRange(asset.rootNodeBegin, asset.rootNodeCount, roots.length, "asset roots");
    assertRange(asset.hierarchyBegin, asset.hierarchyCount, hierarchy.length, "asset hierarchy");
    assertRange(asset.groupBegin, asset.groupCount, groups.length, "asset groups");
    assertRange(asset.bootstrapPageBegin, asset.bootstrapPageCount, bootstrap.length, "asset bootstrap pages");
    if (!asset.rootNodeCount || !asset.bootstrapPageCount) throw new OegPackV3Error("asset has no root/bootstrap cut");
    const nodeEnd = asset.hierarchyBegin + asset.hierarchyCount;
    const groupEnd = asset.groupBegin + asset.groupCount;
    const reachedNodes = new Uint8Array(asset.hierarchyCount);
    const reachedGroups = new Uint8Array(asset.groupCount);
    const stack: number[] = [];
    for (let i = 0; i < asset.rootNodeCount; i++) {
      const root = roots[asset.rootNodeBegin + i]!;
      if (root < asset.hierarchyBegin || root >= nodeEnd) throw new OegPackV3Error("asset root escapes its hierarchy range");
      stack.push(root);
    }
    while (stack.length) {
      const nodeId = stack.pop()!;
      if (reachedNodes[nodeId - asset.hierarchyBegin]) continue;
      reachedNodes[nodeId - asset.hierarchyBegin] = 1;
      const packed = hierarchy[nodeId]!.packedNodeData;
      if (hierarchyNodeIsGroupV3(packed)) {
        const group = hierarchyNodeGroupIdV3(packed);
        if (group < asset.groupBegin || group >= groupEnd) throw new OegPackV3Error("asset hierarchy leaf escapes its group range");
        reachedGroups[group - asset.groupBegin] = 1;
      } else {
        const begin = hierarchyNodeChildStartV3(packed);
        const count = hierarchyNodeChildCountV3(packed);
        if (begin < asset.hierarchyBegin || begin + count > nodeEnd) throw new OegPackV3Error("asset hierarchy child escapes its hierarchy range");
        for (let child = begin; child < begin + count; child++) stack.push(child);
      }
    }
    if (reachedNodes.includes(0)) throw new OegPackV3Error("asset contains a hierarchy node unreachable from its roots");
    if (reachedGroups.includes(0)) throw new OegPackV3Error("asset contains a group unreachable from its roots");
    const assetBootstrap = new Set<number>();
    for (let i = 0; i < asset.bootstrapPageCount; i++) assetBootstrap.add(bootstrap[asset.bootstrapPageBegin + i]!);
    if (assetBootstrap.size !== asset.bootstrapPageCount) throw new OegPackV3Error("asset bootstrap page list contains duplicates");
    const requiredBootstrap = new Set<number>();
    for (let group = asset.groupBegin; group < groupEnd; group++) if (groups[group]!.flags & 1) requiredBootstrap.add(groups[group]!.pageId);
    if (!requiredBootstrap.size || requiredBootstrap.size !== assetBootstrap.size || [...requiredBootstrap].some(page => !assetBootstrap.has(page))) {
      throw new OegPackV3Error("asset bootstrap cut is incomplete or contains unrelated pages");
    }
  }
  for (let index = 0; index < hierarchy.length; index++) {
    const node = hierarchy[index]!;
    if (![...node.boundsSphere, ...node.bboxMin, ...node.bboxMax, node.maxParentError].every(Number.isFinite)) throw new OegPackV3Error(`hierarchy node ${index} is non-finite`);
    if (node.packedNodeData & 1) assertIndex(hierarchyNodeGroupIdV3(node.packedNodeData), groups.length, "hierarchy group");
    else {
      const count = node.packedNodeData >>> 28;
      assertRange((node.packedNodeData >>> 1) & 0x7ffffff, count, hierarchy.length, "hierarchy children");
      if (count < 1 || count > 8) throw new OegPackV3Error("hierarchy child count is outside [1,8]");
    }
  }
  const pageCounts = new Uint32Array(pages.length);
  const pageMinimumGroups = new Uint32Array(pages.length); pageMinimumGroups.fill(OEGPACK_V3_INVALID_ID);
  const pageHasBootstrap = new Uint8Array(pages.length);
  for (const group of groups) {
    assertIndex(group.pageId, pages.length, "group page");
    if ((group.offsetInDecodedPage & 15) || !group.payloadBytes || group.offsetInDecodedPage + group.payloadBytes > OEGPACK_V3_PAGE_BYTES) throw new OegPackV3Error("group is not wholly contained and 16-byte aligned in its page");
    if ((group.flags & ~0x3f) !== 0) throw new OegPackV3Error("group flags contain unknown V3 bits");
    pageCounts[group.pageId] = pageCounts[group.pageId]! + 1;
    const groupId = groups.indexOf(group);
    pageMinimumGroups[group.pageId] = Math.min(pageMinimumGroups[group.pageId]!, groupId);
    if (group.flags & 1) pageHasBootstrap[group.pageId] = 1;
    if ((group.flags & 1) && !bootstrapSet.has(group.pageId)) throw new OegPackV3Error("bootstrap group is not in bootstrap page set");
  }
  let previousEnd = header.pageBlobOffset;
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index]!;
    if (page.decodedBytes !== OEGPACK_V3_PAGE_BYTES || !page.compressedBytes || page.groupCount !== pageCounts[index] || page.firstGroup !== pageMinimumGroups[index]) throw new OegPackV3Error(`page ${index} directory is inconsistent`);
    if (((page.flags & 1) !== 0) !== (pageHasBootstrap[index] !== 0)) throw new OegPackV3Error(`page ${index} bootstrap summary is inconsistent`);
    if (page.compressedFileOffset < previousEnd || page.compressedFileOffset + BigInt(page.compressedBytes) > header.fileBytes) throw new OegPackV3Error(`page ${index} compressed range overlaps or exceeds file`);
    previousEnd = page.compressedFileOffset + BigInt(page.compressedBytes);
  }
  for (let index = 0; index < formats.length; index++) {
    const format = formats[index]!;
    if ((format.attributeMask & 3) !== 3 || (format.attributeMask & ~0x3f) !== 0 || !format.strideBytes || format.positionOffset + 6 > format.strideBytes || format.normalOffset + 4 > format.strideBytes) throw new OegPackV3Error(`vertex format ${index} is invalid`);
    const optionalAttributes: ReadonlyArray<readonly [number, number]> = [
      [format.tangentOffset, 6], [format.uv0Offset, 4], [format.uv1Offset, 4], [format.colorOffset, 4],
    ];
    for (const [attributeOffset, width] of optionalAttributes) if (attributeOffset !== 0xff && attributeOffset + width > format.strideBytes) throw new OegPackV3Error(`vertex format ${index} optional attribute range is invalid`);
  }
  if (previousEnd !== header.fileBytes) throw new OegPackV3Error("page directory does not cover file tail exactly");
}

function validateDecodedPage(
  pageId: number, decoded: Uint8Array, groups: readonly GeometryGroupDirectoryV3[], formats: readonly VertexFormatRecordV3[]
): void {
  const view = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  for (let groupId = 0; groupId < groups.length; groupId++) {
    const directory = groups[groupId]!;
    if (directory.pageId !== pageId) continue;
    if (directory.payloadBytes < OEGPACK_V3_GROUP_HEADER_BYTES) throw new OegPackV3Error(`group ${groupId} payload is too small`);
    const base = directory.offsetInDecodedPage;
    const group = decodeGroupHeaderV3(view, base);
    if (group.payloadBytes !== directory.payloadBytes || group.meshletCount < 1 || group.meshletCount > 128) throw new OegPackV3Error(`group ${groupId} header is invalid`);
    assertIndex(group.vertexFormatId, formats.length, `group ${groupId} vertex format`);
    if (![...group.boundsSphere, ...group.bboxMin, ...group.bboxMax, group.parentError].every(Number.isFinite)) throw new OegPackV3Error(`group ${groupId} contains non-finite metadata`);
    const headersEnd = group.meshletHeaderOffset + group.meshletCount * OEGPACK_V3_MESHLET_HEADER_BYTES;
    if (group.meshletHeaderOffset !== OEGPACK_V3_GROUP_HEADER_BYTES || headersEnd > group.triangleDataOffset || group.triangleDataOffset > group.vertexDataOffset || group.vertexDataOffset > group.payloadBytes) {
      throw new OegPackV3Error(`group ${groupId} section offsets are invalid`);
    }
    const format = formats[group.vertexFormatId]!;
    for (let meshletIndex = 0; meshletIndex < group.meshletCount; meshletIndex++) {
      const meshlet = decodeMeshletHeaderV3(view, base + group.meshletHeaderOffset + meshletIndex * OEGPACK_V3_MESHLET_HEADER_BYTES);
      if (meshlet.vertexCount < 1 || meshlet.vertexCount > 128 || meshlet.triangleCount < 1 || meshlet.triangleCount > 128) throw new OegPackV3Error(`group ${groupId} meshlet ${meshletIndex} count is invalid`);
      if ((meshlet.flags & ~0x1f) !== 0) throw new OegPackV3Error(`group ${groupId} meshlet ${meshletIndex} flags are invalid`);
      if (meshlet.refineGroupId !== OEGPACK_V3_INVALID_ID) assertIndex(meshlet.refineGroupId, groups.length, `group ${groupId} refineGroupId`);
      const triangleEnd = meshlet.triangleByteOffset + meshlet.triangleCount * 3;
      const vertexEnd = meshlet.vertexByteOffset + meshlet.vertexCount * format.strideBytes;
      if (meshlet.triangleByteOffset < group.triangleDataOffset || triangleEnd > group.vertexDataOffset || meshlet.vertexByteOffset < group.vertexDataOffset || vertexEnd > group.payloadBytes) throw new OegPackV3Error(`group ${groupId} meshlet ${meshletIndex} data range is invalid`);
      for (let byte = meshlet.triangleByteOffset; byte < triangleEnd; byte++) if (decoded[base + byte]! >= meshlet.vertexCount) throw new OegPackV3Error(`group ${groupId} meshlet ${meshletIndex} has an invalid local index`);
    }
  }
}

function readU32Table(view: DataView, start: bigint, count: number): Uint32Array {
  const result = new Uint32Array(count);
  const base = offset(start);
  for (let index = 0; index < count; index++) result[index] = view.getUint32(base + index * 4, true);
  return result;
}

function decodeLz4Block(source: Uint8Array, decodedBytes: number): Uint8Array {
  const output = new Uint8Array(decodedBytes);
  let input = 0, target = 0;
  while (input < source.length) {
    const token = source[input++]!;
    let literalLength = token >>> 4;
    if (literalLength === 15) { let value = 255; while (value === 255) { if (input >= source.length) throw new OegPackV3Error("truncated LZ4 literal length"); value = source[input++]!; literalLength += value; } }
    if (input + literalLength > source.length || target + literalLength > output.length) throw new OegPackV3Error("LZ4 literal exceeds block bounds");
    output.set(source.subarray(input, input + literalLength), target); input += literalLength; target += literalLength;
    if (input === source.length) break;
    if (input + 2 > source.length) throw new OegPackV3Error("truncated LZ4 match offset");
    const matchOffset = source[input]! | (source[input + 1]! << 8); input += 2;
    if (!matchOffset || matchOffset > target) throw new OegPackV3Error("invalid LZ4 match offset");
    let matchLength = token & 15;
    if (matchLength === 15) { let value = 255; while (value === 255) { if (input >= source.length) throw new OegPackV3Error("truncated LZ4 match length"); value = source[input++]!; matchLength += value; } }
    matchLength += 4;
    if (target + matchLength > output.length) throw new OegPackV3Error("LZ4 match exceeds decoded page");
    for (let i = 0; i < matchLength; i++) output[target + i] = output[target - matchOffset + i]!;
    target += matchLength;
  }
  if (target !== output.length) throw new OegPackV3Error(`LZ4 decoded ${target} bytes, expected ${output.length}`);
  return output;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return hex(new Uint8Array(digest));
}

function hex(bytes: Uint8Array): string { return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join(""); }
function offset(value: bigint): number { return safeNumber(value, "metadata offset"); }
function safeNumber(value: bigint, name: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new OegPackV3Error(`${name} exceeds exact JavaScript range`);
  return Number(value);
}
function assertIndex(value: number, length: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value >= length) throw new OegPackV3Error(`${name} ${value} is outside [0,${length})`);
}
function assertRange(begin: number, count: number, length: number, name: string): void {
  if (!Number.isInteger(begin) || !Number.isInteger(count) || count < 0 || begin < 0 || begin + count > length) throw new OegPackV3Error(`${name} range is invalid`);
}

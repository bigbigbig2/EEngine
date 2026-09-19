import {
  OEGPACK_V3_ASSET_STRIDE,
  OEGPACK_V3_GROUP_DIRECTORY_STRIDE,
  OEGPACK_V3_HIERARCHY_STRIDE,
  OEGPACK_V3_INVALID_ID,
  OEGPACK_V3_PAGE_BYTES,
  OEGPACK_V3_VERTEX_FORMAT_STRIDE,
  decodeHierarchyNodeV3,
  hierarchyNodeChildCountV3,
  hierarchyNodeChildStartV3,
  hierarchyNodeGroupIdV3,
  hierarchyNodeIsGroupV3,
  hierarchyNodeMeshletCountV3,
  type GeometryAssetRecordV3,
  type GeometryGroupDirectoryV3,
  type VertexFormatRecordV3
} from "../GeometryAbiV3.js";

export const GEOMETRY_PRODUCT_SCHEMA_VERSION = 1;
export const GEOMETRY_PRODUCT_RUNTIME_PROFILE = "oengine-vg-v1-v3-decoded" as const;
export const GEOMETRY_PRODUCT_PAGE_RECORD_STRIDE = 32;

export type GeometryProductProducerKind = "web-runtime" | "offline-native";
export type GeometryProductSourceIdentityKind = "content-sha256" | "strong-http-validator" | "session";

export interface GeometryProductRevisionKeyV1 {
  readonly productId: Uint8Array;
  readonly revision: number;
}

export interface GeometryProductDescriptorV1 {
  readonly schemaVersion: 1;
  readonly productId: Uint8Array;
  readonly revision: number;
  readonly replaces?: GeometryProductRevisionKeyV1;
  readonly producerKind: GeometryProductProducerKind;
  readonly producerId: string;
  readonly producerVersion: string;
  readonly sourceIdentityKind: GeometryProductSourceIdentityKind;
  readonly sourceIdentityHash: Uint8Array;
  readonly recipeHash: Uint8Array;
  readonly runtimeProfile: typeof GEOMETRY_PRODUCT_RUNTIME_PROFILE;
  readonly decodedPageBytes: typeof OEGPACK_V3_PAGE_BYTES;
  readonly assetRecords: Uint8Array;
  readonly rootNodeIds: Uint32Array;
  readonly hierarchyNodes: Uint8Array;
  readonly groupDirectory: Uint8Array;
  readonly pageRecords: Uint8Array;
  readonly bootstrapPageIds: Uint32Array;
  readonly vertexFormats: Uint8Array;
  readonly activationPageIds: Uint32Array;
}

export interface GeometryProductPageRecordV1 {
  readonly decodedHash128: Uint8Array;
  readonly firstGroup: number;
  readonly groupCount: number;
  readonly flags: 0;
  readonly reserved: 0;
}

export interface GeometryPageProductV1 {
  readonly productId: Uint8Array;
  readonly revision: number;
  readonly pageId: number;
  /**
   * Page identity rolled up from the page's Group payloads. This is the value
   * recorded in the descriptor page record and is what a consumer matches on.
   * It is computable before the page payload exists.
   */
  readonly decodedHash128: Uint8Array;
  /**
   * Digest of the whole decoded page buffer, used only to detect transport or
   * storage corruption. It is not page identity and is deliberately absent from
   * the descriptor, because it can only be computed once the payload exists.
   */
  readonly decodedPageHash128: Uint8Array;
  readonly bytes: ArrayBuffer;
}

export interface GeometryProductRevisionSourceV1 {
  readonly descriptor: GeometryProductDescriptorV1;
  /** Optional source-scene asset mapping for bounded shard Products. */
  readonly sceneAssetIndices?: readonly number[];
  readPage(pageId: number, signal?: AbortSignal): Promise<GeometryPageProductV1>;
  release(): void;
}

export interface GeometryProductProviderV1 {
  revisions(signal?: AbortSignal): AsyncIterable<GeometryProductRevisionSourceV1>;
}

export interface GeometryProductValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly table?: string;
  readonly index?: number;
}

export interface GeometryProductValidationReport {
  readonly valid: boolean;
  readonly issues: readonly GeometryProductValidationIssue[];
}

export class GeometryProductValidationError extends Error {
  constructor(readonly report: GeometryProductValidationReport) {
    super(report.issues.map(issue => issue.message).join("; "));
    this.name = "GeometryProductValidationError";
  }
}

export function validateGeometryProductDescriptorV1(descriptor: GeometryProductDescriptorV1): GeometryProductValidationReport {
  const issues: GeometryProductValidationIssue[] = [];
  const issue = (code: string, message: string, table?: string, index?: number): void => { issues.push({ code, message, ...(table === undefined ? {} : { table }), ...(index === undefined ? {} : { index }) }); };
  if (descriptor.schemaVersion !== 1) issue("version", "Geometry Product schemaVersion must be 1");
  if (descriptor.runtimeProfile !== GEOMETRY_PRODUCT_RUNTIME_PROFILE) issue("profile", "unsupported Geometry Product runtime profile");
  if (!Number.isInteger(descriptor.revision) || descriptor.revision < 0 || descriptor.revision === OEGPACK_V3_INVALID_ID) issue("revision", "revision must be a valid u32");
  for (const [name, value] of [["productId", descriptor.productId], ["sourceIdentityHash", descriptor.sourceIdentityHash], ["recipeHash", descriptor.recipeHash]] as const) {
    if (!(value instanceof Uint8Array) || value.byteLength !== 32) issue("identity", `${name} must be exactly 32 bytes`);
  }
  if (!descriptor.producerId || !/^[\x21-\x7e]+$/u.test(descriptor.producerId)) issue("producer", "producerId must be non-empty printable ASCII");
  if (!descriptor.producerVersion) issue("producer", "producerVersion must be non-empty");
  if (!["web-runtime", "offline-native"].includes(descriptor.producerKind)) issue("producer", "producerKind is invalid");
  if (!["content-sha256", "strong-http-validator", "session"].includes(descriptor.sourceIdentityKind)) issue("source", "sourceIdentityKind is invalid");
  if (descriptor.decodedPageBytes !== OEGPACK_V3_PAGE_BYTES) issue("page-size", "decodedPageBytes must be 256 KiB");
  checkByteTable(descriptor.assetRecords, OEGPACK_V3_ASSET_STRIDE, "assetRecords", issue);
  checkByteTable(descriptor.hierarchyNodes, OEGPACK_V3_HIERARCHY_STRIDE, "hierarchyNodes", issue);
  checkByteTable(descriptor.groupDirectory, OEGPACK_V3_GROUP_DIRECTORY_STRIDE, "groupDirectory", issue);
  checkByteTable(descriptor.pageRecords, GEOMETRY_PRODUCT_PAGE_RECORD_STRIDE, "pageRecords", issue);
  checkByteTable(descriptor.vertexFormats, OEGPACK_V3_VERTEX_FORMAT_STRIDE, "vertexFormats", issue);
  if (descriptor.rootNodeIds.some(value => value === OEGPACK_V3_INVALID_ID)) issue("id", "rootNodeIds contains invalid id", "rootNodeIds");
  if (descriptor.bootstrapPageIds.some(value => value === OEGPACK_V3_INVALID_ID)) issue("id", "bootstrapPageIds contains invalid id", "bootstrapPageIds");
  if (!isStrictlyIncreasingUnique(descriptor.activationPageIds)) issue("activation", "activationPageIds must be sorted and unique", "activationPageIds");

  const assetCount = descriptor.assetRecords.byteLength / OEGPACK_V3_ASSET_STRIDE;
  const hierarchyCount = descriptor.hierarchyNodes.byteLength / OEGPACK_V3_HIERARCHY_STRIDE;
  const groupCount = descriptor.groupDirectory.byteLength / OEGPACK_V3_GROUP_DIRECTORY_STRIDE;
  const pageCount = descriptor.pageRecords.byteLength / GEOMETRY_PRODUCT_PAGE_RECORD_STRIDE;
  const view = new DataView(descriptor.assetRecords.buffer, descriptor.assetRecords.byteOffset, descriptor.assetRecords.byteLength);
  const roots = descriptor.rootNodeIds;
  const hierarchyView = new DataView(descriptor.hierarchyNodes.buffer, descriptor.hierarchyNodes.byteOffset, descriptor.hierarchyNodes.byteLength);
  const groupView = new DataView(descriptor.groupDirectory.buffer, descriptor.groupDirectory.byteOffset, descriptor.groupDirectory.byteLength);
  const pageView = new DataView(descriptor.pageRecords.buffer, descriptor.pageRecords.byteOffset, descriptor.pageRecords.byteLength);
  const activation = new Set(descriptor.activationPageIds);
  const bootstrap = new Set(descriptor.bootstrapPageIds);
  const pageGroups = new Map<number, number[]>();
  for (let group = 0; group < groupCount; group++) {
    const page = groupView.getUint32(group * 16, true);
    if (page >= pageCount) issue("range", `group ${group} references page ${page}`, "groupDirectory", group);
    const offset = groupView.getUint32(group * 16 + 4, true), payload = groupView.getUint32(group * 16 + 8, true), flags = groupView.getUint32(group * 16 + 12, true);
    if ((offset & 15) !== 0 || payload < 64 || offset + payload > OEGPACK_V3_PAGE_BYTES) issue("payload-range", `group ${group} payload is not aligned and wholly contained in its page`, "groupDirectory", group);
    if ((flags & ~0x3f) !== 0) issue("flags", `group ${group} contains unknown flags`, "groupDirectory", group);
    const list = pageGroups.get(page) ?? []; list.push(group); pageGroups.set(page, list);
  }
  for (let page = 0; page < pageCount; page++) {
    const at = page * GEOMETRY_PRODUCT_PAGE_RECORD_STRIDE;
    if (pageView.getUint32(at + 24, true) !== 0 || pageView.getUint32(at + 28, true) !== 0) issue("reserved", `page ${page} flags/reserved must be zero`, "pageRecords", page);
    const first = pageView.getUint32(at + 16, true), count = pageView.getUint32(at + 20, true);
    const groups = pageGroups.get(page) ?? [];
    if (first + count > groupCount || groups.length !== count || groups.some((id, index) => id !== first + index)) issue("page-groups", `page ${page} group range is not contiguous`, "pageRecords", page);
  }
  for (let asset = 0; asset < assetCount; asset++) {
    const at = asset * OEGPACK_V3_ASSET_STRIDE;
    const rootBegin = view.getUint32(at + 72, true), rootCount = view.getUint32(at + 76, true);
    const hierarchyBegin = view.getUint32(at + 80, true), hierarchySpan = view.getUint32(at + 84, true);
    const groupBegin = view.getUint32(at + 88, true), groupSpan = view.getUint32(at + 92, true);
    const bootstrapBegin = view.getUint32(at + 96, true), bootstrapCount = view.getUint32(at + 100, true);
    if (view.getUint32(at + 116, true) !== 0) issue("reserved", `asset ${asset} flags/reserved must be zero`, "assetRecords", asset);
    if (!rootCount || rootBegin + rootCount > roots.length || !hierarchySpan || hierarchyBegin + hierarchySpan > hierarchyCount || !groupSpan || groupBegin + groupSpan > groupCount || !bootstrapCount || bootstrapBegin + bootstrapCount > descriptor.bootstrapPageIds.length) issue("asset-range", `asset ${asset} range is invalid`, "assetRecords", asset);
    const visitedNodes = new Set<number>(), visitedGroups = new Set<number>(), stack = Array.from(roots.slice(rootBegin, rootBegin + rootCount));
    while (stack.length) {
      const node = stack.pop()!;
      if (node < hierarchyBegin || node >= hierarchyBegin + hierarchySpan) { issue("tree-root", `asset ${asset} root/child escapes hierarchy range`, "hierarchyNodes", node); continue; }
      if (visitedNodes.has(node)) { issue("tree-cycle", `asset ${asset} hierarchy contains a cycle`, "hierarchyNodes", node); continue; }
      visitedNodes.add(node);
      const packed = hierarchyView.getUint32(node * 48 + 44, true);
      if (hierarchyNodeIsGroupV3(packed)) {
        const group = hierarchyNodeGroupIdV3(packed);
        if (group < groupBegin || group >= groupBegin + groupSpan) issue("tree-group", `asset ${asset} leaf escapes group range`, "hierarchyNodes", node); else visitedGroups.add(group);
      } else {
        const begin = hierarchyNodeChildStartV3(packed), count = hierarchyNodeChildCountV3(packed);
        if (!count || count > 8 || begin < hierarchyBegin || begin + count > hierarchyBegin + hierarchySpan) issue("tree-child", `asset ${asset} child range is invalid`, "hierarchyNodes", node);
        else for (let child = 0; child < count; child++) stack.push(begin + child);
      }
    }
    const declaredBootstrap = descriptor.bootstrapPageIds.slice(bootstrapBegin, bootstrapBegin + bootstrapCount), assetBootstrap = new Set<number>();
    for (const page of declaredBootstrap) { if (page >= pageCount) issue("bootstrap-page", `asset ${asset} bootstrap page is invalid`, "bootstrapPageIds", bootstrapBegin); else { assetBootstrap.add(page); bootstrap.add(page); } }
    for (let group = groupBegin; group < groupBegin + groupSpan; group++) {
      const flags = groupView.getUint32(group * 16 + 12, true), page = groupView.getUint32(group * 16, true);
      if ((flags & 1) !== 0) {
        if (!visitedGroups.has(group)) issue("bootstrap-cut", `asset ${asset} bootstrap group is unreachable from its roots`, "groupDirectory", group);
        if (!assetBootstrap.has(page)) issue("bootstrap-cut", `asset ${asset} bootstrap group page is not declared in its cut`, "groupDirectory", group);
      }
    }
  }
  for (const page of descriptor.bootstrapPageIds) { if (page >= pageCount) issue("bootstrap-page", `bootstrap page ${page} is outside page table`, "bootstrapPageIds"); if (!activation.has(page)) issue("activation-cut", `activation cut misses bootstrap page ${page}`, "activationPageIds"); }
  for (const page of descriptor.activationPageIds) if (page >= pageCount) issue("activation-page", `activation page ${page} is outside page table`, "activationPageIds");
  for (let node = 0; node < hierarchyCount; node++) {
    const decoded = decodeHierarchyNodeV3(hierarchyView, node * 48);
    if (![...decoded.boundsSphere, ...decoded.bboxMin, ...decoded.bboxMax, decoded.maxParentError].every(Number.isFinite)) issue("finite", `hierarchy node ${node} contains non-finite values`, "hierarchyNodes", node);
    const packed = decoded.packedNodeData;
    if (hierarchyNodeIsGroupV3(packed)) { if (hierarchyNodeGroupIdV3(packed) >= groupCount || hierarchyNodeMeshletCountV3(packed) < 1) issue("tree-leaf", `hierarchy node ${node} references an invalid group`, "hierarchyNodes", node); }
    else if (hierarchyNodeChildCountV3(packed) < 1 || hierarchyNodeChildCountV3(packed) > 8 || hierarchyNodeChildStartV3(packed) + hierarchyNodeChildCountV3(packed) > hierarchyCount) issue("tree-child", `hierarchy node ${node} has an invalid child range`, "hierarchyNodes", node);
  }
  return Object.freeze({ valid: issues.length === 0, issues: Object.freeze(issues) });
}

export function assertGeometryProductDescriptorV1(descriptor: GeometryProductDescriptorV1): void {
  const report = validateGeometryProductDescriptorV1(descriptor);
  if (!report.valid) throw new GeometryProductValidationError(report);
}

export function decodeGeometryProductPageRecordV1(descriptor: GeometryProductDescriptorV1, pageId: number): GeometryProductPageRecordV1 {
  if (!Number.isInteger(pageId) || pageId < 0 || pageId >= descriptor.pageRecords.byteLength / GEOMETRY_PRODUCT_PAGE_RECORD_STRIDE) throw new RangeError("Geometry Product pageId is out of range");
  const view = new DataView(descriptor.pageRecords.buffer, descriptor.pageRecords.byteOffset + pageId * GEOMETRY_PRODUCT_PAGE_RECORD_STRIDE, GEOMETRY_PRODUCT_PAGE_RECORD_STRIDE);
  return Object.freeze({ decodedHash128: descriptor.pageRecords.slice(pageId * 32, pageId * 32 + 16), firstGroup: view.getUint32(16, true), groupCount: view.getUint32(20, true), flags: 0, reserved: 0 });
}

export function encodeGeometryProductPageRecordsV1(records: readonly GeometryProductPageRecordV1[]): Uint8Array {
  const bytes = new Uint8Array(records.length * GEOMETRY_PRODUCT_PAGE_RECORD_STRIDE), view = new DataView(bytes.buffer);
  records.forEach((record, index) => { if (record.decodedHash128.byteLength !== 16) throw new RangeError("decodedHash128 must be 16 bytes"); bytes.set(record.decodedHash128, index * 32); view.setUint32(index * 32 + 16, record.firstGroup, true); view.setUint32(index * 32 + 20, record.groupCount, true); });
  return bytes;
}

export function cloneGeometryProductDescriptorV1(descriptor: GeometryProductDescriptorV1): GeometryProductDescriptorV1 {
  return Object.freeze({ ...descriptor, productId: descriptor.productId.slice(), sourceIdentityHash: descriptor.sourceIdentityHash.slice(), recipeHash: descriptor.recipeHash.slice(), assetRecords: descriptor.assetRecords.slice(), rootNodeIds: descriptor.rootNodeIds.slice(), hierarchyNodes: descriptor.hierarchyNodes.slice(), groupDirectory: descriptor.groupDirectory.slice(), pageRecords: descriptor.pageRecords.slice(), bootstrapPageIds: descriptor.bootstrapPageIds.slice(), vertexFormats: descriptor.vertexFormats.slice(), activationPageIds: descriptor.activationPageIds.slice(), ...(descriptor.replaces ? { replaces: { productId: descriptor.replaces.productId.slice(), revision: descriptor.replaces.revision } } : {}) });
}

export function encodeAssetRecordsV3(records: readonly GeometryAssetRecordV3[]): Uint8Array {
  const bytes = new Uint8Array(records.length * 128), view = new DataView(bytes.buffer);
  records.forEach((record, index) => { const at = index * 128; writeHex(view, at, record.assetId); writeF32(view, at + 32, record.boundsSphere); writeF32(view, at + 48, record.boundsMin); writeF32(view, at + 60, record.boundsMax); [record.rootNodeBegin, record.rootNodeCount, record.hierarchyBegin, record.hierarchyCount, record.groupBegin, record.groupCount, record.bootstrapPageBegin, record.bootstrapPageCount, record.sourceTriangleCount, record.leafMeshletCount, record.totalMeshletCount, record.flags].forEach((value, field) => view.setUint32(at + 72 + field * 4, value, true)); });
  return bytes;
}

export function encodeGroupDirectoryV3(records: readonly GeometryGroupDirectoryV3[]): Uint8Array { const bytes = new Uint8Array(records.length * 16), view = new DataView(bytes.buffer); records.forEach((record, index) => { const at = index * 16; view.setUint32(at, record.pageId, true); view.setUint32(at + 4, record.offsetInDecodedPage, true); view.setUint32(at + 8, record.payloadBytes, true); view.setUint32(at + 12, record.flags, true); }); return bytes; }
export function encodeVertexFormatsV3(records: readonly VertexFormatRecordV3[]): Uint8Array { const bytes = new Uint8Array(records.length * 16), view = new DataView(bytes.buffer); records.forEach((record, index) => { const at = index * 16; view.setUint16(at, record.strideBytes, true); view.setUint16(at + 2, record.attributeMask, true); [record.positionOffset, record.normalOffset, record.tangentOffset, record.uv0Offset, record.uv1Offset, record.colorOffset].forEach((value, field) => view.setUint8(at + 4 + field, value)); }); return bytes; }

function checkByteTable(bytes: Uint8Array, stride: number, name: string, issue: (code: string, message: string, table?: string) => void): void { if (!(bytes instanceof Uint8Array) || bytes.byteLength % stride !== 0) issue("stride", `${name} byte length must be a multiple of ${stride}`, name); }
function isStrictlyIncreasingUnique(values: Uint32Array): boolean { for (let index = 1; index < values.length; index++) if (values[index]! <= values[index - 1]!) return false; return true; }
function writeHex(view: DataView, at: number, hex: string): void { if (!/^[0-9a-f]{64}$/u.test(hex)) throw new RangeError("asset id must be 32-byte lowercase hex"); for (let index = 0; index < 32; index++) view.setUint8(at + index, Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)); }
function writeF32(view: DataView, at: number, values: readonly number[]): void { values.forEach((value, index) => view.setFloat32(at + index * 4, value, true)); }

export function hierarchyNodesFromBytes(bytes: Uint8Array): readonly ReturnType<typeof decodeHierarchyNodeV3>[] { const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); return Object.freeze(Array.from({ length: bytes.byteLength / 48 }, (_, index) => decodeHierarchyNodeV3(view, index * 48))); }

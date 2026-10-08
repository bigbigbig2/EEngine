// A real V3 triangle page, shared by CPU and browser oracles. Transport hashes
// are assigned by callers that exercise source integrity, not guessed here.
export const TRIANGLE_PRODUCT_PAYLOAD_BYTES = 176;

export function writeTriangleProductPage(page) {
  page.fill(0, 0, TRIANGLE_PRODUCT_PAYLOAD_BYTES);
  const view = new DataView(page.buffer, page.byteOffset, page.byteLength);
  view.setFloat32(12, 1, true);
  view.setUint16(44, 1, true);
  view.setUint32(48, 64, true);
  view.setUint32(52, 112, true);
  view.setUint32(56, 116, true);
  view.setUint32(60, TRIANGLE_PRODUCT_PAYLOAD_BYTES, true);
  view.setUint16(64, 3, true);
  view.setUint16(66, 1, true);
  view.setUint32(68, 116, true);
  view.setUint32(72, 112, true);
  view.setUint32(76, 0xffffffff, true);
  page.set([0, 1, 2], 112);
  for (const [index, position] of [
    [0, [-0.5, -0.5, 0]],
    [1, [0.5, -0.5, 0]],
    [2, [0, 0.5, 0]],
  ]) {
    for (let axis = 0; axis < 3; axis++) {
      view.setFloat32(116 + index * 16 + axis * 4, position[axis], true);
    }
  }
  return page;
}

export function triangleProductFixture() {
  const page = writeTriangleProductPage(new Uint8Array(262144));
  const assetRecords = new Uint8Array(128);
  const asset = new DataView(assetRecords.buffer);
  asset.setFloat32(44, 1, true);
  for (let axis = 0; axis < 3; axis++) {
    asset.setFloat32(48 + axis * 4, -0.5, true);
    asset.setFloat32(60 + axis * 4, 0.5, true);
  }
  for (const offset of [76, 84, 92, 100, 104, 108, 112]) {
    asset.setUint32(offset, 1, true);
  }
  const hierarchyNodes = new Uint8Array(48);
  const node = new DataView(hierarchyNodes.buffer);
  node.setFloat32(12, 1, true);
  node.setFloat32(40, 3.4028234663852886e38, true);
  node.setUint32(44, 1, true);
  const groupDirectory = new Uint8Array(16);
  const group = new DataView(groupDirectory.buffer);
  group.setUint32(8, TRIANGLE_PRODUCT_PAYLOAD_BYTES, true);
  group.setUint32(12, 1, true);
  const pageRecords = new Uint8Array(32);
  new DataView(pageRecords.buffer).setUint32(20, 1, true);
  const vertexFormats = new Uint8Array(16);
  const format = new DataView(vertexFormats.buffer);
  format.setUint16(0, 16, true);
  format.setUint16(2, 3, true);
  format.setUint8(5, 12);
  format.setUint8(10, 1);
  const descriptor = {
    schemaVersion: 1,
    productId: new Uint8Array(32).fill(2),
    revision: 0,
    producerKind: "web-runtime",
    producerId: "triangle-oracle",
    producerVersion: "1",
    sourceIdentityKind: "session",
    sourceIdentityHash: new Uint8Array(32).fill(3),
    recipeHash: new Uint8Array(32).fill(4),
    runtimeProfile: "oengine-vg-v1-v3-decoded",
    decodedPageBytes: 262144,
    assetRecords,
    rootNodeIds: new Uint32Array([0]),
    hierarchyNodes,
    groupDirectory,
    pageRecords,
    bootstrapPageIds: new Uint32Array([0]),
    vertexFormats,
    activationPageIds: new Uint32Array([0]),
  };
  return { descriptor, page };
}

// Scene-mapping tests still need a complete legal forest. Keep their authored
// bounds/material metadata, but give each asset its own triangle/root/page.
export function productDescriptorForAssetRecords(assetRecords) {
  const { descriptor } = triangleProductFixture();
  const count = assetRecords.byteLength / 128;
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError("Fixture requires complete asset records");
  }
  const originalNode = descriptor.hierarchyNodes;
  const originalGroup = descriptor.groupDirectory;
  const originalPage = descriptor.pageRecords;
  descriptor.assetRecords = assetRecords;
  descriptor.rootNodeIds = Uint32Array.from({ length: count }, (_, index) => index);
  descriptor.hierarchyNodes = new Uint8Array(count * 48);
  descriptor.groupDirectory = new Uint8Array(count * 16);
  descriptor.pageRecords = new Uint8Array(count * 32);
  descriptor.bootstrapPageIds = descriptor.rootNodeIds.slice();
  descriptor.activationPageIds = descriptor.rootNodeIds.slice();
  const records = new DataView(assetRecords.buffer, assetRecords.byteOffset, assetRecords.byteLength);
  for (let index = 0; index < count; index++) {
    descriptor.hierarchyNodes.set(originalNode, index * 48);
    descriptor.groupDirectory.set(originalGroup, index * 16);
    descriptor.pageRecords.set(originalPage, index * 32);
    new DataView(descriptor.hierarchyNodes.buffer).setUint32(index * 48 + 44, 1 | (index << 1), true);
    new DataView(descriptor.groupDirectory.buffer).setUint32(index * 16, index, true);
    new DataView(descriptor.pageRecords.buffer).setUint32(index * 32 + 16, index, true);
    for (const [offset, value] of [
      [72, index], [76, 1], [80, index], [84, 1], [88, index], [92, 1],
      [96, index], [100, 1], [104, 1], [108, 1], [112, 1], [116, 0]
    ]) {
      records.setUint32(index * 128 + offset, value, true);
    }
  }
  return descriptor;
}

// Each extra streamed page really owns a group and a terminal hierarchy node.
// Keep only page 0 pinned so eviction fixtures still exercise non-pinned pages.
export function addTriangleProductPages(descriptor, pageCount) {
  const asset = new DataView(descriptor.assetRecords.buffer);
  descriptor.hierarchyNodes = new Uint8Array(pageCount * 48);
  descriptor.rootNodeIds = Uint32Array.from({ length: pageCount }, (_, index) => index);
  descriptor.groupDirectory = new Uint8Array(pageCount * 16);
  const nodes = new DataView(descriptor.hierarchyNodes.buffer);
  const groups = new DataView(descriptor.groupDirectory.buffer);
  const pages = new DataView(descriptor.pageRecords.buffer);
  for (let index = 0; index < pageCount; index++) {
    nodes.setFloat32(index * 48 + 12, 1, true);
    nodes.setFloat32(index * 48 + 40, 3.4028234663852886e38, true);
    nodes.setUint32(index * 48 + 44, 1 | (index << 1), true);
    groups.setUint32(index * 16, index, true);
    groups.setUint32(index * 16 + 8, TRIANGLE_PRODUCT_PAYLOAD_BYTES, true);
    groups.setUint32(index * 16 + 12, index === 0 ? 1 : 0, true);
    pages.setUint32(index * 32 + 16, index, true);
    pages.setUint32(index * 32 + 20, 1, true);
  }
  for (const offset of [76, 84, 92, 104, 108, 112]) {
    asset.setUint32(offset, pageCount, true);
  }
  return descriptor;
}

// Independent spatial forest: each internal node has a terminal left child
// and a continuing right child. Refinement groups occur at different depths.
export function deepProductFixture(depth) {
  const { descriptor, page } = triangleProductFixture();
  descriptor.hierarchyNodes = new Uint8Array((2 * depth + 1) * 48);
  descriptor.groupDirectory = new Uint8Array((depth + 1) * 16);
  const nodes = new DataView(descriptor.hierarchyNodes.buffer);
  for (let index = 0; index <= 2 * depth; index++) {
    nodes.setFloat32(index * 48 + 12, 1, true);
    nodes.setFloat32(index * 48 + 40, 3.4028234663852886e38, true);
    const branch = index % 2 === 0 && index < 2 * depth;
    nodes.setUint32(
      index * 48 + 44,
      branch
        ? ((2 << 28) | ((index + 1) << 1)) >>> 0
        : 1 | ((index === 2 * depth ? depth : (index - 1) / 2) << 1),
      true,
    );
  }
  const asset = new DataView(descriptor.assetRecords.buffer);
  asset.setUint32(84, 2 * depth + 1, true);
  asset.setUint32(92, depth + 1, true);
  asset.setUint32(112, depth + 1, true);
  const groups = new DataView(descriptor.groupDirectory.buffer);
  const triangle = page.slice(0, TRIANGLE_PRODUCT_PAYLOAD_BYTES);
  for (let group = 0; group <= depth; group++) {
    groups.setUint32(group * 16 + 4, group * TRIANGLE_PRODUCT_PAYLOAD_BYTES, true);
    groups.setUint32(group * 16 + 8, TRIANGLE_PRODUCT_PAYLOAD_BYTES, true);
    groups.setUint32(group * 16 + 12, 1, true);
    page.set(triangle, group * TRIANGLE_PRODUCT_PAYLOAD_BYTES);
  }
  new DataView(descriptor.pageRecords.buffer).setUint32(20, depth + 1, true);
  return { descriptor, page };
}

// Coarse -> fine refine chain. All spatial leaves remain independent BVH roots;
// the payload refine IDs, not BVH parents, provide the replacement coverage.
export async function streamingProductFixture(pageCount = 4, revision = 0) {
  const { descriptor } = triangleProductFixture();
  descriptor.revision = revision;
  descriptor.pageRecords = new Uint8Array(pageCount * 32);
  addTriangleProductPages(descriptor, pageCount);
  const pages = [];
  for (let pageId = 0; pageId < pageCount; pageId++) {
    const page = writeTriangleProductPage(new Uint8Array(262144));
    const view = new DataView(page.buffer);
    view.setUint32(76, pageId + 1 < pageCount ? pageId + 1 : 0xffffffff, true);
    const error = pageId === 0 ? 3.4028234663852886e38 : 1 / pageId;
    view.setFloat32(40, error, true);
    new DataView(descriptor.hierarchyNodes.buffer).setFloat32(pageId * 48 + 40, error, true);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", page));
    descriptor.pageRecords.set(digest.subarray(0, 16), pageId * 32);
    pages.push({ page, hash: digest.subarray(0, 16) });
  }
  let releases = 0;
  let reads = 0;
  const source = {
    descriptor,
    async readPage(pageId, signal) {
      if (signal?.aborted) throw signal.reason;
      reads++;
      const { page, hash } = pages[pageId];
      return { productId: descriptor.productId.slice(), revision, pageId,
        bytes: page.slice().buffer, decodedHash128: hash.slice(), decodedPageHash128: hash.slice() };
    },
    release() { releases++; },
  };
  return { descriptor, source, get releases() { return releases; }, get reads() { return reads; } };
}

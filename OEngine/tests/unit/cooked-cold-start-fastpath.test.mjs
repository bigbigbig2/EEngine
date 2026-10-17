import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { attachTriangleQuerySection } from "../helpers/geometry-query-fixture.mjs";
import { openTextureProduct, saveTextureProduct } from "../../.test-dist/assets/TextureProduct.js";
import { textureProduct } from "../fixtures/texture-product.mjs";
import { MemoryRangeReadablePackV3, openOegPackV3 } from "../../.test-dist/assets/OegPackV3.js";
import {
  descriptorFromOegPack,
  OegPackProductRevisionSource,
} from "../../.test-dist/assets/geometry-product/OegPackProductProvider.js";
import { VirtualGeometryResidency } from "../../.test-dist/gpu/VirtualGeometryResidency.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { compileCanonicalMaterial } from "../../.test-dist/material/CanonicalMaterial.js";
import {
  writeTriangleProductPage,
  TRIANGLE_PRODUCT_PAYLOAD_BYTES,
} from "../helpers/geometry-product-fixture.mjs";

globalThis.GPUBufferUsage ??= Object.freeze({ COPY_DST: 8, STORAGE: 128 });

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/** Synthesizes a valid 2-bootstrap-page raw OEGPACK V3 archive in memory. */
async function buildTwoPageOegPackV3() {
  const page0 = writeTriangleProductPage(new Uint8Array(262144));
  const page1 = writeTriangleProductPage(new Uint8Array(262144));

  const headerSize = 256;
  const assetOffset = 256;
  const assetBytes = 128;
  const rootOffset = assetOffset + assetBytes;
  const rootBytes = 8; // 2 roots
  const hierarchyOffset = rootOffset + rootBytes;
  const hierarchyBytes = 96; // 2 leaf nodes
  const groupOffset = hierarchyOffset + hierarchyBytes;
  const groupBytes = 32; // 2 groups
  const pageDirOffset = groupOffset + groupBytes;
  const pageDirBytes = 128; // 2 pages
  const bootstrapOffset = pageDirOffset + pageDirBytes;
  const bootstrapBytes = 8; // 2 bootstrap page IDs
  const formatOffset = bootstrapOffset + bootstrapBytes;
  const formatBytes = 16; // 1 vertex format
  const queryOffset = formatOffset + formatBytes;
  const queryBytes = 128 + 32 + 2 * 80 + 3 * 2 * 4;
  const pageBlobOffset = queryOffset + queryBytes;
  const fileBytes = pageBlobOffset + page0.byteLength + page1.byteLength;

  const pack = new Uint8Array(fileBytes);
  const view = new DataView(pack.buffer);
  // Magic "OEGPACK\0"
  pack.set([79, 69, 71, 80, 65, 67, 75, 0], 0);
  view.setUint32(8, 3, true); // major
  view.setUint32(12, 1, true); // minor
  view.setUint32(16, 0x01020304, true); // endian
  view.setUint32(20, headerSize, true);
  view.setUint32(24, 18, true); // pageShift
  view.setUint32(28, 262144, true); // pageBytes
  view.setUint32(32, 0, true); // flags
  view.setUint32(36, 1, true); // defaultCodec
  view.setUint32(40, 1, true); // assetCount
  view.setUint32(44, 2, true); // rootNodeIndexCount
  view.setUint32(48, 2, true); // hierarchyNodeCount
  view.setUint32(52, 2, true); // groupCount
  view.setUint32(56, 2, true); // pageCount
  view.setUint32(60, 1, true); // vertexFormatCount
  view.setUint32(64, 2, true); // bootstrapPageCount
  view.setBigUint64(72, BigInt(assetOffset), true);
  view.setBigUint64(80, BigInt(rootOffset), true);
  view.setBigUint64(88, BigInt(hierarchyOffset), true);
  view.setBigUint64(96, BigInt(groupOffset), true);
  view.setBigUint64(104, BigInt(pageDirOffset), true);
  view.setBigUint64(112, BigInt(formatOffset), true);
  view.setBigUint64(120, BigInt(bootstrapOffset), true);
  view.setBigUint64(128, BigInt(pageBlobOffset), true);
  view.setBigUint64(136, BigInt(fileBytes), true);
  pack.fill(0xaa, 144, 176); // recipeHash

  // Asset 0
  pack.fill(0x11, assetOffset, assetOffset + 32);
  view.setFloat32(assetOffset + 44, 1, true); // radius
  view.setUint32(assetOffset + 72, 0, true); // rootNodeBegin
  view.setUint32(assetOffset + 76, 2, true); // rootNodeCount
  view.setUint32(assetOffset + 80, 0, true); // hierarchyBegin
  view.setUint32(assetOffset + 84, 2, true); // hierarchyCount
  view.setUint32(assetOffset + 88, 0, true); // groupBegin
  view.setUint32(assetOffset + 92, 2, true); // groupCount
  view.setUint32(assetOffset + 96, 0, true); // bootstrapPageBegin
  view.setUint32(assetOffset + 100, 2, true); // bootstrapPageCount
  view.setUint32(assetOffset + 104, 2, true); // sourceTriangleCount
  view.setUint32(assetOffset + 108, 2, true); // leafMeshletCount
  view.setUint32(assetOffset + 112, 2, true); // totalMeshletCount

  // Roots: [0, 1]
  view.setUint32(rootOffset, 0, true);
  view.setUint32(rootOffset + 4, 1, true);

  // Hierarchy node 0 -> group 0 (1 meshlet), node 1 -> group 1 (1 meshlet)
  for (let i = 0; i < 2; i++) {
    const at = hierarchyOffset + i * 48;
    view.setFloat32(at + 12, 1, true);
    view.setUint32(at + 44, (i << 1) | 1, true);
  }

  // Group directory: group 0 in page 0, group 1 in page 1 (both bootstrap flag=1)
  for (let i = 0; i < 2; i++) {
    const at = groupOffset + i * 16;
    view.setUint32(at, i, true); // pageId
    view.setUint32(at + 4, 0, true); // offsetInDecodedPage
    view.setUint32(at + 8, TRIANGLE_PRODUCT_PAYLOAD_BYTES, true);
    view.setUint32(at + 12, 1, true); // bootstrap flag
  }

  // Page directory
  const pages = [page0, page1];
  for (let i = 0; i < 2; i++) {
    const at = pageDirOffset + i * 64;
    const pOffset = pageBlobOffset + i * 262144;
    view.setBigUint64(at, BigInt(pOffset), true);
    view.setUint32(at + 8, 262144, true); // compressedBytes
    view.setUint32(at + 12, 262144, true); // decodedBytes
    view.setUint32(at + 16, i, true); // firstGroup
    view.setUint32(at + 20, 1, true); // groupCount
    view.setUint32(at + 24, 0, true); // codec = 0 (raw)
    view.setUint32(at + 28, 1, true); // flags = bootstrap
    const hash = createHash("sha256").update(pages[i]).digest();
    pack.set(hash.subarray(0, 16), at + 32);
    view.setUint32(at + 48, crc32(pages[i]), true);
    pack.set(pages[i], pOffset);
  }

  // Bootstrap page IDs: [0, 1]
  view.setUint32(bootstrapOffset, 0, true);
  view.setUint32(bootstrapOffset + 4, 1, true);

  // Vertex format 0
  view.setUint16(formatOffset, 16, true); // strideBytes
  view.setUint16(formatOffset + 2, 3, true); // attributeMask (pos + normal)
  view.setUint8(formatOffset + 4, 0); // positionOffset
  view.setUint8(formatOffset + 5, 12); // normalOffset
  view.setUint8(formatOffset + 6, 0xff);
  view.setUint8(formatOffset + 7, 0xff);
  view.setUint8(formatOffset + 8, 0xff);
  view.setUint8(formatOffset + 9, 0xff);
  view.setUint8(formatOffset + 10, 1); // Float32x3

  view.setBigUint64(208, BigInt(queryOffset), true);
  view.setBigUint64(216, BigInt(queryBytes), true);
  const descriptor = attachTriangleQuerySection({
    recipeHash: pack.subarray(144, 176),
    assetRecords: pack.subarray(assetOffset, assetOffset + assetBytes),
    groupDirectory: pack.subarray(groupOffset, groupOffset + groupBytes),
    hierarchyNodes: pack.subarray(hierarchyOffset, hierarchyOffset + hierarchyBytes),
  }, pages);
  assert.equal(descriptor.querySection.byteLength, queryBytes);
  pack.set(descriptor.querySection, queryOffset);

  // Compute metadata packContentHash
  pack.fill(0, 176, 208);
  const metadataDigest = createHash("sha256").update(pack.subarray(0, pageBlobOffset)).digest();
  pack.set(metadataDigest, 176);
  return pack;
}

test("openTextureProduct verifyHashes=false matches strict mode and still enforces identity/manifest contracts", async () => {
  const authored = await textureProduct();
  const archive = await saveTextureProduct(authored);

  const strictProduct = await openTextureProduct(archive, { verifyHashes: true });
  const fastProduct = await openTextureProduct(archive, { verifyHashes: false });

  assert.equal(fastProduct.identity, strictProduct.identity);
  assert.equal(fastProduct.recipeHash, strictProduct.recipeHash);
  assert.deepEqual(fastProduct.metadata, strictProduct.metadata);
  assert.deepEqual(fastProduct.evidence, strictProduct.evidence);
  for (const [id, chunk] of strictProduct.chunks) {
    assert.deepEqual(fastProduct.chunks.get(id), chunk);
  }
});

test("OegPackV3 coalesced readPages merges contiguous bootstrap page reads and catches CRC32 corruption", async () => {
  const packBytes = await buildTwoPageOegPackV3();
  const rangeCalls = [];
  const inner = new MemoryRangeReadablePackV3(packBytes);
  const countingSource = {
    async read(byteOffset, byteLength) {
      rangeCalls.push({ byteOffset: Number(byteOffset), byteLength });
      return inner.read(byteOffset, byteLength);
    },
  };

  const opened = await openOegPackV3(countingSource, { verifyPageSha256: false });
  const readsBeforeActivation = rangeCalls.length;

  const deviceWrites = [];
  const device = {
    limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024 },
    createBuffer(d) {
      return { d, destroy() {} };
    },
    queue: {
      writeBuffer(buffer, offset, data) {
        deviceWrites.push({ buffer, offset, bytes: data.byteLength });
      },
    },
  };

  const revisionSource = new OegPackProductRevisionSource(opened, descriptorFromOegPack(opened));
  const residency = await VirtualGeometryResidency.create(device, revisionSource, 1);

  // Two contiguous 256 KiB bootstrap pages must be fetched in ONE coalesced range read, not two!
  const activationRangeReads = rangeCalls.length - readsBeforeActivation;
  assert.equal(activationRangeReads, 1, "two contiguous bootstrap pages must coalesce into 1 range read");
  assert.equal(rangeCalls.at(-1).byteLength, 2 * 262144);
  assert.equal(residency.evidence().residentPages, 2);
  residency.destroy();

  // Corrupting a byte inside page 1 still fails CRC32 even when verifyPageSha256 is false
  const corrupted = packBytes.slice();
  corrupted[corrupted.byteLength - 64] ^= 0xff;
  const openedCorrupted = await openOegPackV3(new MemoryRangeReadablePackV3(corrupted), {
    verifyPageSha256: false,
  });
  await assert.rejects(openedCorrupted.readPages([0, 1]), /checksum/i);
});

test("compileCanonicalMaterial caches unchanged materials and invalidates on mutation", () => {
  const material = new StandardShadeMaterial();
  material.roughness_factor = 0.42;
  const first = compileCanonicalMaterial(material);
  const second = compileCanonicalMaterial(material);
  assert.equal(first, second, "unchanged StandardShadeMaterial must return cached CanonicalMaterial");

  material.clearcoat_factor = 0.5;
  const third = compileCanonicalMaterial(material);
  assert.notEqual(third, first, "mutated StandardShadeMaterial must invalidate cache");
  assert.equal(third.coatFactor, 0.5);
});

test("canonical cache distinguishes legal hash collisions and validates nonfinite edits", () => {
  const material = new StandardShadeMaterial();
  material.roughness_factor = 0;
  material.metallic_factor = 0;
  const hash = material.hash();
  const first = compileCanonicalMaterial(material);
  material.roughness_factor = 1;
  material.metallic_factor = (4294967295 - 30) / 4294967295;
  assert.equal(material.hash(), hash, "regression requires an actual legal-value hash collision");
  assert.notEqual(compileCanonicalMaterial(material), first);
  material.roughness_factor = 0;
  compileCanonicalMaterial(material);
  material.roughness_factor = NaN;
  assert.throws(() => compileCanonicalMaterial(material), /finite/);
});

test("canonical cache observes every sampler field captured by the appearance compiler", () => {
  const material = new StandardShadeMaterial();
  const texture = new ShadeTexture();
  material.texture_albedo = texture;
  const fields = [
    "flags",
    "minFilter",
    "magFilter",
    "mipmapFilter",
    "wrapS",
    "wrapT",
    "wrapR",
    "dimensions",
    "mipmapGenerationFilter",
  ];
  for (const [index, field] of fields.entries()) {
    const before = compileCanonicalMaterial(material);
    texture[field]++;
    const after = compileCanonicalMaterial(material);
    assert.notEqual(after, before, `${field} must invalidate the snapshot`);
    assert.equal(after.appearance.samples[0].binding.sampler[index], texture[field]);
    assert.equal(compileCanonicalMaterial(material), after);
  }
});

test("CRC-only pages declare their verification policy without inventing a decoded digest", async () => {
  const bytes = await buildTwoPageOegPackV3();
  const pack = await openOegPackV3(new MemoryRangeReadablePackV3(bytes), { verifyPageSha256: false });
  const decoded = await pack.readPage(0);
  assert.equal(decoded.integrity, "encoded-crc32");
  assert.equal(decoded.decodedPageHash128, undefined);
  const source = new OegPackProductRevisionSource(
    { ...pack, readPage: async () => decoded },
    descriptorFromOegPack(pack),
  );
  const page = await source.readPage(0);
  assert.equal(page.integrity, "encoded-crc32");
  assert.equal(page.decodedPageHash128, undefined);
  decoded.bytes.fill(255);
  assert.notEqual(new Uint8Array(page.bytes)[0], 255, "published page must not alias public pack views");
});

test("dense multi-meshlet page uses compact shared payload without CPU attribute expansion", async () => {
  const { frameGeometrySourceWgsl } = await import("../../.test-dist/shaders/geometry_source_decode.js");
  const { frameGeometryVerticesWgsl } = await import("../../.test-dist/shaders/frame_geometry_vertices.js");
  const { surfaceGeometryCompletionWgsl } =
    await import("../../.test-dist/shaders/surface_geometry_completion.js");

  const decodeWgsl = frameGeometrySourceWgsl(true);
  assert.match(
    decodeWgsl,
    /frame_vertex_load_format\(asset\.vertex_format_word_offset \+ header\.vertex_format_id \* 4u\)/u,
  );
  assert.match(decodeWgsl, /fn frame_vertex_u32\(bank: u32, byte: u32\) -> u32/u);
  assert.doesNotMatch(decodeWgsl, /frame_vertex_resident\(/u);

  const verticesWgsl = frameGeometryVerticesWgsl(true);
  assert.match(verticesWgsl, /vertex_indices = product_source_format_word;/u);

  const surfaceWgsl = surfaceGeometryCompletionWgsl(true, true);
  assert.match(surfaceWgsl, /product_frame_vertex_load_format\(cached\.vertex_indices\)/u);

  // Build a dense 64-meshlet page (64 meshlets * 64 vertices = 4,096 vertices).
  // Previously, 4,096 * 96B = 393,216 bytes of expanded CPU attributes required 3 physical bank slots!
  // Now it occupies strictly 1 physical slot (256 KiB) with 1 bank writeBuffer call.
  const meshletCount = 64;
  const vertexCount = 64;
  const triangleCount = 32;
  const strideBytes = 16;
  const headerBytes = 64;
  const meshletHeadersBytes = meshletCount * 48;
  const triangleBytesPerMeshlet = triangleCount * 3;
  const vertexBytesPerMeshlet = vertexCount * strideBytes;
  const totalTriangleBytes = (meshletCount * triangleBytesPerMeshlet + 3) & ~3;
  const triangleDataOffset = headerBytes + meshletHeadersBytes;
  const vertexDataOffset = triangleDataOffset + totalTriangleBytes;
  const payloadBytes = (vertexDataOffset + meshletCount * vertexBytesPerMeshlet + 15) & ~15;

  const pageBytes = new Uint8Array(262144);
  const pv = new DataView(pageBytes.buffer);
  // Group header
  pv.setFloat32(12, 10, true); // sphere radius
  pv.setFloat32(40, 0, true); // parentError
  pv.setUint16(44, meshletCount, true);
  pv.setUint8(46, 0); // lodLevel
  pv.setUint8(47, 0); // vertexFormatId
  pv.setUint32(48, headerBytes, true);
  pv.setUint32(52, triangleDataOffset, true);
  pv.setUint32(56, vertexDataOffset, true);
  pv.setUint32(60, payloadBytes, true);

  for (let m = 0; m < meshletCount; m++) {
    const mh = headerBytes + m * 48;
    pv.setUint16(mh, vertexCount, true);
    pv.setUint16(mh + 2, triangleCount, true);
    const vOff = vertexDataOffset + m * vertexBytesPerMeshlet;
    const tOff = triangleDataOffset + m * triangleBytesPerMeshlet;
    pv.setUint32(mh + 4, vOff, true);
    pv.setUint32(mh + 8, tOff, true);
    pv.setUint32(mh + 12, 0xffffffff, true); // refineGroupId
    pv.setFloat32(mh + 36, 1, true); // boundsMax.x
    pv.setFloat32(mh + 40, 1, true); // boundsMax.y
    pv.setFloat32(mh + 44, 1, true); // boundsMax.z
    for (let t = 0; t < triangleCount; t++) {
      pageBytes[tOff + t * 3] = 0;
      pageBytes[tOff + t * 3 + 1] = 1;
      pageBytes[tOff + t * 3 + 2] = 2;
    }
    for (let v = 0; v < vertexCount; v++) {
      const va = vOff + v * strideBytes;
      pv.setFloat32(va, v * 0.25, true);
      pv.setFloat32(va + 4, m * 0.5, true);
      pv.setFloat32(va + 8, 1.0, true);
      pv.setInt16(va + 12, 0, true);
      pv.setInt16(va + 14, 0, true);
    }
  }

  const hash = createHash("sha256").update(pageBytes).digest();
  const assetRecords = new Uint8Array(128);
  const av = new DataView(assetRecords.buffer);
  assetRecords.fill(1, 0, 32);
  av.setFloat32(44, 10, true);
  av.setUint32(76, 1, true);
  av.setUint32(84, 1, true);
  av.setUint32(92, 1, true);
  av.setUint32(100, 1, true);
  av.setUint32(104, meshletCount * triangleCount, true);
  av.setUint32(108, meshletCount, true);
  av.setUint32(112, meshletCount, true);

  const hierarchyNodes = new Uint8Array(48);
  const hv = new DataView(hierarchyNodes.buffer);
  hv.setFloat32(12, 10, true);
  hv.setUint32(44, ((meshletCount - 1) << 25) | 1, true);

  const groupDirectory = new Uint8Array(16);
  const gv = new DataView(groupDirectory.buffer);
  gv.setUint32(0, 0, true);
  gv.setUint32(4, 0, true);
  gv.setUint32(8, payloadBytes, true);
  gv.setUint32(12, 1, true);

  const pageRecords = new Uint8Array(32);
  pageRecords.set(hash.subarray(0, 16), 0);
  new DataView(pageRecords.buffer).setUint32(20, 1, true);

  const vertexFormats = new Uint8Array(16);
  const fv = new DataView(vertexFormats.buffer);
  fv.setUint16(0, strideBytes, true);
  fv.setUint16(2, 3, true);
  fv.setUint8(4, 0);
  fv.setUint8(5, 12);
  fv.setUint8(10, 1);

  const descriptor = {
    schemaVersion: 2,
    productId: new Uint8Array(32).fill(9),
    revision: 0,
    producerKind: "offline-native",
    producerId: "dir-a-test",
    producerVersion: "1",
    sourceIdentityKind: "session",
    sourceIdentityHash: new Uint8Array(32).fill(3),
    recipeHash: new Uint8Array(32).fill(4),
    runtimeProfile: "oengine-vg-v2-v3-decoded-query2",
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

  attachTriangleQuerySection(descriptor, pageBytes);
  const bankWrites = [];
  const device = {
    limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024 },
    createBuffer(d) {
      return { d, label: d.label, destroy() {} };
    },
    queue: {
      writeBuffer(buffer, offset, data) {
        if (String(buffer.label).includes(" bank ")) {
          bankWrites.push({ offset, bytes: data.byteLength });
        }
      },
    },
  };

  const source = {
    descriptor,
    async readPage(pageId) {
      return {
        productId: descriptor.productId.slice(),
        revision: 0,
        pageId,
        decodedHash128: hash.subarray(0, 16),
        decodedPageHash128: hash.subarray(0, 16),
        bytes: pageBytes.slice().buffer,
      };
    },
    release() {},
  };

  const residency = await VirtualGeometryResidency.create(device, source, 1);
  assert.equal(residency.evidence().residentPages, 1);
  assert.equal(
    residency.evidence().residentBytes,
    Math.ceil(payloadBytes / 16) * 16,
    "compact byte-pool allocation retains the complete payload with 16-byte alignment",
  );
  assert.equal(residency.evidence().uploadedBytes, payloadBytes, "only raw page payload bytes are uploaded");
  assert.equal(bankWrites.length, 1, "exactly 1 writeBuffer call per page");
  residency.destroy();
});
